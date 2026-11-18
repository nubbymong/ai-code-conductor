<#
.SYNOPSIS
Probe P16 (ADR-030): what does starting one helper process per hook event cost
on Windows?

.DESCRIPTION
Hooks through the holder would start one short-lived helper process for every
hook event. This probe measures what that costs, with Windows Defender as it is
shipped, and gives a PASS or FAIL against a pass line fixed before measuring.

Step 0  How Claude Code starts a command hook. With -Claude, it runs that
        claude.exe once with --settings whose SessionStart hook records its own
        parent chain, in a fresh environment (built from an allow-list, with
        HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and TEMP
        in a folder of its own, so any other CLI home falls back to its
        default under that HOME; a placeholder API key and an API address on a
        closed local port, so nothing is signed in and nothing leaves the
        machine). The process
        between claude.exe and the hook command is the launcher, and a console
        host under it means the launcher gets a console of its own. Without
        -Claude, or with -Launcher, the launcher is the one named and the result
        says "documented, not observed".
Step 1  One holder in a throwaway store:
        aicc-helper hold --store <Store> --session <sid> --away 600 --detach
        Nothing is launched in it.
Step 2  The stand-in for one hook event, behind the launcher from step 0:
        aicc-helper list --store <Store>
        It starts the signed program, reads the record, checks the holder's
        process, connects to its pipe and checks the hello's nonce, then exits:
        all a hook mode does except send one frame. -Paced runs at -PerSecond,
        then -BackToBack runs one after another. Each run is started suspended
        in a job object of its own, so every process in the chain is counted,
        the console host included. Wall time runs from just before the launcher
        is created to the moment the last process of the chain has ended. CPU
        time is taken two ways: cpu_ms adds each process's CPU cycles, converted
        to milliseconds at the rate measured on this machine (precise); and
        cpu_tick_ms is the job's own user and kernel time, which Windows charges
        in clock ticks of about 15.6 ms (coarse for one run, fair on average).
        A run fails when it times out, exits non-zero, its listing does not
        show the holder as live, or any process the job counted has no cycle
        count (one that could not be opened, a lost start notice, or a failed
        read would leave cpu_ms short). One limit of the stand-in: `list` keeps
        the record of a running holder when the hello gives no clear answer (a
        read error), so a run cannot prove its nonce check completed; the hook
        mode reports its handshake itself. Defender's own process (MsMpEng.exe) is
        outside the chain: its CPU over step 2, net of its rate over 20 idle
        seconds before, is reported per event beside the verdict, not in it.
Step 3  Reference only: today's HTTP hook is a loopback POST from inside the
        CLI's own process. One node process times -HttpPosts POSTs to a local
        HTTP server in a second node process, at -PerSecond. It runs twice in a
        job, with no POSTs and then with all of them, and the difference in
        the two processes' CPU cycles, divided by the POSTs, is the CPU per POST.

Pass line (ADR-030 sets none; the beta 8 plan set this before any measuring):
with Defender real-time protection on, over all step 2 runs, p95 wall time at
most 150 ms, longest at most 750 ms, mean CPU time at most 50 ms per event, and
no failed run. Anything else is FAIL. p95 is the nearest-rank value: the
ceil(0.95 * n)-th smallest. The mean CPU judged is the larger of the mean of
cpu_ms and the mean of cpu_tick_ms. A Defender exclusion that covers the
helper, the store or a program of the chain also makes it a FAIL, since
Defender is then not as shipped; so does an exclusion list that cannot be
read, since that is then not verified (run from an administrator session).

The script refuses to run when the store folder already exists, its parent
folder does not, or the output folder is inside it; when step 2 could outlast
the holder's 600-second away clock; and when the helper's Authenticode
signature is not valid (P16 measures the signed per-user copy, not a dev
build). It makes the store folder itself, in one step that fails if the folder
exists, before anything else; only a store it made is removed, and results are
written only to an output folder that passed its checks. Each chain's output
is read while it runs. In a finally block it ends the holder (only the process
its record names, and only while that process runs this helper as the holder
of this store and session), removes the store and its own temporary folder,
and reports any process of the probe still running.

Writes p16-runs.csv, p16-http.csv, p16-step0.json and p16-result.json to
-OutDir. The last line is "P16 RESULT: PASS" or "P16 RESULT: FAIL - <reasons>".
Exit code 0 pass, 1 fail, 2 could not run.

.EXAMPLE
.\p16-windows-hook-cost.ps1 -Helper "$env:LOCALAPPDATA\AI Code Conductor\helper\<version>-<12 hex>\aicc-helper.exe" -Store "$env:TEMP\p16-store" -Claude <path to claude.exe>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Helper,
    [Parameter(Mandatory = $true)] [string] $Store,
    [string] $Claude = '',
    [ValidateSet('observe', 'gitbash', 'cmd', 'direct')] [string] $Launcher = 'observe',
    [string] $GitBash = '',
    [ValidateRange(1, 100000)] [int] $Paced = 300,
    [ValidateRange(0.1, 100)] [double] $PerSecond = 2,
    [ValidateRange(0, 100000)] [int] $BackToBack = 50,
    [ValidateRange(0, 100000)] [int] $HttpPosts = 300,
    [string] $Node = 'node',
    [string] $OutDir = '.'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# The pass line. Fixed before measuring; never moved after seeing numbers.
$PassP95Ms = 150
$PassMaxMs = 750
$PassMeanCpuMs = 50
$PassFailedRuns = 0

$RunTimeoutMs = 30000
$Inv = [Globalization.CultureInfo]::InvariantCulture

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class P16Run
{
    public double WallMs;
    public double TopExitMs = -1;
    public double CpuMs;
    public double CpuTickMs;
    public int Processes;
    public int ExitCode = -1;
    public bool TimedOut;
    public bool StoppedEarly;
    public bool ZeroByPoll;
    public int Missed;
    public string Chain = "";
    public string Paths = "";
    public string Output = "";
}

public static class P16Runner
{
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint HANDLE_FLAG_INHERIT = 1;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectAssociateCompletionPortInformation = 7;
    const uint MSG_ACTIVE_PROCESS_ZERO = 4;
    const uint MSG_NEW_PROCESS = 6;
    const uint MSG_EXIT_PROCESS = 7;
    const uint MSG_ABNORMAL_EXIT_PROCESS = 8;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint SYNCHRONIZE = 0x00100000;

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT { public IntPtr CompletionKey; public IntPtr CompletionPort; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr h, byte[] buf, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr h, byte[] buf, int count, out int read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryProcessCycleTime(IntPtr process, out ulong cycles);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryThreadCycleTime(IntPtr thread, out ulong cycles);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateDirectoryW(string path, IntPtr attrs);

    // Make a folder that must not exist yet, in one step: false when it
    // already exists, so a folder someone else made is never taken as ours.
    public static bool Reserve(string path)
    {
        if (CreateDirectoryW(path, IntPtr.Zero)) return true;
        int e = Marshal.GetLastWin32Error();
        if (e == 183) return false; // ERROR_ALREADY_EXISTS
        throw new Win32Exception(e, "CreateDirectory " + path);
    }

    // CPU cycles per millisecond of this machine's cycle counter: the fastest
    // of five 100 ms busy loops (a loop that was descheduled counts fewer
    // cycles, so the fastest is the truest, and a slower one would only make
    // the probe's CPU figures larger).
    public static double CyclesPerMs()
    {
        double best = 0;
        IntPtr me = GetCurrentThread();
        for (int i = 0; i < 5; i++)
        {
            ulong c0, c1;
            QueryThreadCycleTime(me, out c0);
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalMilliseconds < 100) { }
            QueryThreadCycleTime(me, out c1);
            double rate = (c1 - c0) / sw.Elapsed.TotalMilliseconds;
            if (rate > best) best = rate;
        }
        return best;
    }

    public static double CycleRate = 0;

    // The CPU time, from cycles, a running process has used so far; -1 when
    // it cannot be read.
    public static double ProcessCpuMs(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return -1;
        ulong cycles;
        bool ok = QueryProcessCycleTime(h, out cycles);
        CloseHandle(h);
        return ok && CycleRate > 0 ? cycles / CycleRate : -1;
    }

    static string ShortName(string full)
    {
        // "Git/bash" and "usr/bash" tell Git for Windows' two bash programs
        // apart; no user name or other personal part of a path is kept.
        string name = Path.GetFileNameWithoutExtension(full);
        string dir = Path.GetDirectoryName(full);
        string up = dir == null ? null : Path.GetDirectoryName(dir);
        return up == null ? name : Path.GetFileName(up) + "/" + name;
    }

    static string ImagePath(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(1024);
        int size = sb.Capacity;
        return QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : "?";
    }

    static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION Accounting(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out a, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject");
        }
        return a;
    }

    // Start commandLine suspended in a job of its own, let it run, and report
    // the wall time until the last process of the job ended, the CPU time of
    // every process in the job, and the first process's exit code and output.
    // doneFile: when it appears, the job is ended 2 seconds later (step 0).
    public static P16Run Run(string commandLine, string envBlock, string cwd, bool newConsole, string stdinText, int timeoutMs, string doneFile)
    {
        P16Run r = new P16Run();
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        if (port == IntPtr.Zero) { CloseHandle(job); throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateIoCompletionPort"); }
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT assoc = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
        assoc.CompletionKey = job;
        assoc.CompletionPort = port;
        if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, ref assoc, Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT))))
        {
            int e = Marshal.GetLastWin32Error();
            CloseHandle(port); CloseHandle(job);
            throw new Win32Exception(e, "SetInformationJobObject");
        }

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = 1;
        IntPtr outRead, outWrite, inRead, inWrite;
        if (!CreatePipe(out outRead, out outWrite, ref sa, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
        if (!CreatePipe(out inRead, out inWrite, ref sa, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);

        // Drain the output while the job runs, so a chain that writes more
        // than the pipe holds never stalls. The reader starts before the clock.
        MemoryStream outBytes = new MemoryStream();
        IntPtr readEnd = outRead;
        System.Threading.Thread reader = new System.Threading.Thread(delegate ()
        {
            byte[] chunk = new byte[8192];
            int got;
            while (ReadFile(readEnd, chunk, chunk.Length, out got, IntPtr.Zero) && got > 0)
            {
                lock (outBytes) { outBytes.Write(chunk, 0, got); }
            }
        });
        reader.IsBackground = true;
        reader.Start();

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = inRead;
        si.hStdOutput = outWrite;
        si.hStdError = outWrite;
        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | (newConsole ? CREATE_NO_WINDOW : 0);
        IntPtr env = envBlock == null ? IntPtr.Zero : Marshal.StringToHGlobalUni(envBlock);
        StringBuilder cmd = new StringBuilder(commandLine);
        PROCESS_INFORMATION pi;
        Dictionary<int, IntPtr> handles = new Dictionary<int, IntPtr>();
        Dictionary<int, string> names = new Dictionary<int, string>();
        List<int> order = new List<int>();

        Stopwatch sw = Stopwatch.StartNew();
        bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref si, out pi);
        int err = Marshal.GetLastWin32Error();
        CloseHandle(outWrite);
        CloseHandle(inRead);
        if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
        if (!ok)
        {
            // No writer is left, so the reader ends; let it before closing.
            reader.Join(2000);
            CloseHandle(outRead); CloseHandle(inWrite); CloseHandle(port); CloseHandle(job);
            throw new Win32Exception(err, "CreateProcess: " + commandLine);
        }
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int e = Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1);
            reader.Join(2000);
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(outRead); CloseHandle(inWrite); CloseHandle(port); CloseHandle(job);
            throw new Win32Exception(e, "AssignProcessToJobObject");
        }
        handles[pi.dwProcessId] = pi.hProcess;
        names[pi.dwProcessId] = ImagePath(pi.hProcess);
        order.Add(pi.dwProcessId);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        if (stdinText != null)
        {
            byte[] b = Encoding.UTF8.GetBytes(stdinText);
            int written;
            WriteFile(inWrite, b, b.Length, out written, IntPtr.Zero);
        }
        CloseHandle(inWrite);

        double doneSeen = -1;
        while (true)
        {
            uint msg; UIntPtr key; IntPtr ov;
            bool got = GetQueuedCompletionStatus(port, out msg, out key, out ov, 20);
            double now = sw.Elapsed.TotalMilliseconds;
            if (got)
            {
                int pid = (int)ov.ToInt64();
                if (msg == MSG_NEW_PROCESS)
                {
                    if (!handles.ContainsKey(pid))
                    {
                        // The image name can only be read while the process
                        // runs; its cycle count can be read after it ends.
                        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
                        if (h != IntPtr.Zero) { handles[pid] = h; names[pid] = ImagePath(h); order.Add(pid); }
                    }
                }
                else if (msg == MSG_EXIT_PROCESS || msg == MSG_ABNORMAL_EXIT_PROCESS)
                {
                    if (pid == pi.dwProcessId && r.TopExitMs < 0) r.TopExitMs = now;
                }
                else if (msg == MSG_ACTIVE_PROCESS_ZERO)
                {
                    r.WallMs = now;
                    break;
                }
            }
            else if (Accounting(job).ActiveProcesses == 0)
            {
                // Job messages may be lost; the job's own count is the truth.
                r.WallMs = now;
                r.ZeroByPoll = true;
                break;
            }
            if (doneFile != null && !r.StoppedEarly && File.Exists(doneFile))
            {
                if (doneSeen < 0) doneSeen = now;
                else if (now - doneSeen > 2000) { TerminateJobObject(job, 1); r.StoppedEarly = true; }
            }
            if (now > timeoutMs && !r.TimedOut)
            {
                TerminateJobObject(job, 1);
                r.TimedOut = true;
            }
            if (now > timeoutMs + 10000)
            {
                r.WallMs = now;
                break;
            }
        }

        // Two CPU figures. CpuTickMs is the job's own count over every process
        // it ever held, in clock ticks of about 15.6 ms (coarse per run, fair
        // on average). CpuMs adds each process's CPU cycles, converted with
        // CycleRate (precise, but only for processes this saw start).
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a = Accounting(job);
        r.CpuTickMs = (a.TotalUserTime + a.TotalKernelTime) / 10000.0;
        r.Processes = (int)a.TotalProcesses;
        int code;
        if (GetExitCodeProcess(pi.hProcess, out code)) r.ExitCode = code;

        List<string> parts = new List<string>();
        List<string> paths = new List<string>();
        double total = 0;
        int counted = 0;
        foreach (int pid in order)
        {
            IntPtr h = handles[pid];
            ulong cycles;
            double cpu = -1;
            if (CycleRate > 0 && QueryProcessCycleTime(h, out cycles))
            {
                cpu = cycles / CycleRate;
                total += cpu;
                counted++;
            }
            string full = names[pid];
            parts.Add((full == "?" ? "?" : ShortName(full)) + ":" + cpu.ToString("0.00", CultureInfo.InvariantCulture));
            paths.Add(full);
            CloseHandle(h);
        }
        r.Paths = string.Join("|", paths.ToArray());
        // Every process the job ever held, less those whose cycles were read:
        // a process that could not be opened, a lost start notice, or a
        // failed cycle read all leave CpuMs short, and the run then fails.
        r.Missed = Math.Max(0, (int)a.TotalProcesses - counted);
        r.CpuMs = total;
        r.Chain = string.Join("|", parts.ToArray());

        // Every process of the job has ended, so the reader reaches the end of
        // the pipe. If something outside the job still holds its write end,
        // the reader is left (it is a background thread) with its handle open,
        // and the output read so far is used.
        if (reader.Join(5000)) CloseHandle(outRead);
        lock (outBytes) { r.Output = Encoding.UTF8.GetString(outBytes.ToArray()); }
        CloseHandle(port);
        CloseHandle(job);
        return r;
    }
}
'@

function Format-Num([double] $v) { return $v.ToString('0.00', $Inv) }

# One argument quoted the way the C runtime and libuv read it back.
function ConvertTo-Arg([string] $s) {
    if ($s -eq '') { return '""' }
    if ($s.IndexOfAny([char[]]@(' ', "`t", '"')) -lt 0) { return $s }
    $bs = [string][char]92
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    $slashes = 0
    foreach ($c in $s.ToCharArray()) {
        if ($c -eq [char]92) { $slashes++; continue }
        if ($c -eq '"') { [void]$sb.Append($bs * (2 * $slashes + 1)).Append('"'); $slashes = 0; continue }
        [void]$sb.Append($bs * $slashes).Append($c)
        $slashes = 0
    }
    [void]$sb.Append($bs * (2 * $slashes)).Append('"')
    return $sb.ToString()
}

function ConvertTo-ForwardPath([string] $p) { return $p.Replace([string][char]92, '/') }

# A fresh environment: the system's own variables, and every per-user
# folder a CLI reads inside this probe's temporary folder.
function New-FreshEnv([string] $root, [hashtable] $extra) {
    $keep = 'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
        'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PSModulePath'
    $envs = @{}
    foreach ($k in $keep) {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $envs[$k] = $v }
    }
    $envs['HOME'] = Join-Path $root 'home'
    $envs['USERPROFILE'] = Join-Path $root 'home'
    $envs['APPDATA'] = Join-Path $root 'appdata'
    $envs['LOCALAPPDATA'] = Join-Path $root 'localappdata'
    $envs['CLAUDE_CONFIG_DIR'] = Join-Path $root 'claude'
    $envs['TEMP'] = Join-Path $root 'tmp'
    $envs['TMP'] = Join-Path $root 'tmp'
    if ($extra) { foreach ($k in $extra.Keys) { $envs[$k] = $extra[$k] } }
    return $envs
}

function ConvertTo-EnvBlock([hashtable] $envs) {
    $sb = New-Object Text.StringBuilder
    foreach ($k in ($envs.Keys | Sort-Object)) { [void]$sb.Append($k).Append('=').Append($envs[$k]).Append([char]0) }
    [void]$sb.Append([char]0)
    return $sb.ToString()
}

# Run a program in the fresh environment and return its exit code and output.
function Invoke-Fresh([string] $exe, [string[]] $argList, [hashtable] $envs, [string] $cwd, [int] $timeoutMs) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = (($argList | ForEach-Object { ConvertTo-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.WorkingDirectory = $cwd
    $psi.EnvironmentVariables.Clear()
    foreach ($k in $envs.Keys) { $psi.EnvironmentVariables[$k] = $envs[$k] }
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeoutMs)) {
        try { $p.Kill() } catch { }
        throw "$exe did not finish in $timeoutMs ms"
    }
    return [pscustomobject]@{ Code = $p.ExitCode; Out = $outTask.Result; Err = $errTask.Result }
}

function Get-Defender {
    try {
        $mp = Get-MpComputerStatus
        return [ordered]@{
            realTimeProtection = [bool]$mp.RealTimeProtectionEnabled
            antivirus = [bool]$mp.AntivirusEnabled
            onAccess = [bool]$mp.OnAccessProtectionEnabled
            behaviorMonitor = [bool]$mp.BehaviorMonitorEnabled
            ioav = [bool]$mp.IoavProtectionEnabled
            tamperProtected = [bool]$mp.IsTamperProtected
            engine = [string]$mp.AMEngineVersion
        }
    } catch {
        return [ordered]@{ realTimeProtection = $false; error = $_.Exception.Message }
    }
}

# Whether a Defender exclusion covers the probe: a path exclusion (a folder or
# a file) over the helper, the store or a program of the chain; a process
# exclusion naming a program of the chain by full path or file name; or an
# extension exclusion matching one. Rules may hold environment variables and
# wildcards. Reading exclusions can need an elevated session; then this says
# so instead of guessing.
function Test-Excluded([string[]] $paths, [string[]] $programs) {
    try {
        $pref = Get-MpPreference
        $list = @($pref.ExclusionPath | Where-Object { $_ })
        $procs = @($pref.ExclusionProcess | Where-Object { $_ })
        $exts = @($pref.ExclusionExtension | Where-Object { $_ })
    } catch {
        return 'unknown'
    }
    foreach ($l in @(, $list) + @(, $procs) + @(, $exts)) {
        if ($l.Count -gt 0 -and $l[0] -like 'N/A*') { return 'unknown' }
    }
    $wild = [char[]]@('*', '?')
    foreach ($p in @($paths) + @($programs)) {
        foreach ($x in $list) {
            $rule = [Environment]::ExpandEnvironmentVariables($x).TrimEnd([char]92)
            if ($rule.IndexOfAny($wild) -ge 0) {
                if (($p -like $rule) -or ($p -like ($rule + [char]92 + '*'))) { return 'yes' }
            } elseif (($p -ieq $rule) -or $p.StartsWith($rule + [char]92, [StringComparison]::OrdinalIgnoreCase)) {
                return 'yes'
            }
        }
    }
    foreach ($p in $programs) {
        $leaf = Split-Path -Leaf $p
        foreach ($x in $procs) {
            $rule = [Environment]::ExpandEnvironmentVariables($x)
            if (($rule -ieq $p) -or ($rule -ieq $leaf)) { return 'yes' }
            if ($rule.IndexOfAny($wild) -ge 0 -and (($p -like $rule) -or ($leaf -like $rule))) { return 'yes' }
        }
        foreach ($x in $exts) {
            if ([IO.Path]::GetExtension($p).TrimStart('.') -ieq $x.TrimStart('.', '*')) { return 'yes' }
        }
    }
    return 'no'
}

function Get-P95([double[]] $values) {
    $sorted = @($values | Sort-Object)
    $i = [int][math]::Ceiling(0.95 * $sorted.Count) - 1
    return $sorted[[math]::Max(0, $i)]
}

# The SessionStart hook of step 0: write this process's parent chain, and
# the other processes started under it (a console host among them), to a file.
$ChainRecorder = @'
param([string]$Out)
$all = Get-CimInstance Win32_Process
$byPid = @{}
foreach ($w in $all) { $byPid[[int]$w.ProcessId] = $w }
$rows = @()
$pids = @()
$p = $PID
for ($i = 0; $i -lt 12 -and $p; $i++) {
    $w = $byPid[[int]$p]
    if (-not $w) { break }
    $rows += [pscustomobject]@{ pid = [int]$w.ProcessId; ppid = [int]$w.ParentProcessId; name = $w.Name; cmd = $w.CommandLine }
    $pids += [int]$w.ProcessId
    if ($w.Name -ieq 'claude.exe') { break }
    $p = $w.ParentProcessId
}
# A process whose parent id names a chain member only counts when it started
# after that member: process ids are reused.
$kids = @($all | Where-Object { $pids -contains [int]$_.ParentProcessId -and $pids -notcontains [int]$_.ProcessId -and $_.CreationDate -ge $byPid[[int]$_.ParentProcessId].CreationDate } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name } })
$stdin = [Console]::In.ReadToEnd()
$json = [pscustomobject]@{ chain = $rows; children = $kids; stdinBytes = $stdin.Length } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($Out + '.tmp', $json)
Move-Item -LiteralPath ($Out + '.tmp') -Destination $Out
'@

# Step 3's two node processes: a server like the hooks gateway, and a
# client like the CLI's HTTP hook, which prints one line per POST.
$HttpReference = @'
'use strict';
const http = require('http');
const { spawn } = require('child_process');
if (process.argv[2] === 'server') {
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/cpu') {
      const u = process.cpuUsage();
      res.end(JSON.stringify({ cpuMs: (u.user + u.system) / 1000 }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  srv.listen(0, '127.0.0.1', () => process.stdout.write(srv.address().port + '\n'));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  const count = Number(process.argv[3]);
  const perSecond = Number(process.argv[4]);
  const agent = new http.Agent({ keepAlive: true });
  const body = JSON.stringify({ session_id: 'p16-probe-http', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo p16' }, tool_response: { stdout: 'p16', stderr: '' }, cwd: 'C:/work', transcript_path: 'C:/work/t.jsonl' });
  const request = (port, method, path, data) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers: { 'content-type': 'application/json', 'content-length': data ? Buffer.byteLength(data) : 0 } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = spawn(process.execPath, [__filename, 'server'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let portText = '';
  const onData = (c) => {
    portText += c;
    if (!portText.includes('\n')) return;
    server.stdout.off('data', onData);
    run(Number(portText.trim())).then(() => { server.stdin.end(); }, (e) => { console.error(String(e)); server.kill(); process.exit(2); });
  };
  server.stdout.on('data', onData);
  async function run(port) {
    const before = JSON.parse((await request(port, 'GET', '/cpu')).text).cpuMs;
    const start = Date.now();
    for (let i = 1; i <= count; i++) {
      const due = start + (i - 1) * (1000 / perSecond);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const cpu0 = process.cpuUsage();
      const t0 = process.hrtime.bigint();
      const res = await request(port, 'POST', '/hook/p16-probe-http', body);
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      const cpu = process.cpuUsage(cpu0);
      console.log(`${i},${wall.toFixed(3)},${((cpu.user + cpu.system) / 1000).toFixed(3)},${res.status}`);
    }
    const after = JSON.parse((await request(port, 'GET', '/cpu')).text).cpuMs;
    console.log(`server_cpu_ms,${(after - before).toFixed(3)}`);
  }
}
'@

$exitCode = 2
$holderPid = 0
$holderSid = ''
$storeMade = $false
$tempRoot = ''
$storeFull = ''
$helperFull = ''
$outFull = ''
$started = Get-Date

# The holder's away clock (step 1) runs from its start and a listing does not
# reset it, so step 2 must end well inside it.
$HolderAwaySeconds = 600

# End the probe's holder: only the process its record names, and only while
# that process runs this helper as the holder of this store and session.
function Stop-ProbeHolder {
    if ($holderPid -le 0) { return }
    $w = Get-CimInstance Win32_Process -Filter "ProcessId=$holderPid" -ErrorAction SilentlyContinue
    if ($w -and $w.ExecutablePath -and ($w.ExecutablePath -ieq $helperFull) -and $w.CommandLine -and
        $w.CommandLine.Contains($storeFull) -and $w.CommandLine.Contains($holderSid)) {
        Stop-Process -Id $holderPid -Force -ErrorAction SilentlyContinue
    }
}
$result = [ordered]@{ probe = 'P16'; started = $started.ToUniversalTime().ToString('o') }

try {
    # --- Checks before anything runs ---------------------------------------
    if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw "could not run: no helper at $Helper" }
    $helperFull = (Resolve-Path -LiteralPath $Helper).ProviderPath
    $storeFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Store).TrimEnd([char]92)
    $outWanted = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir).TrimEnd([char]92)
    if ($outWanted -ieq $storeFull -or $outWanted.StartsWith($storeFull + [char]92, [StringComparison]::OrdinalIgnoreCase)) {
        throw "could not run: the output folder $outWanted is inside the store folder, which the probe removes at the end"
    }
    # Step 2 at the slowest: the 20 idle seconds before it, every paced slot,
    # up to a second for each back-to-back run, and a minute to spare.
    $needSeconds = 20 + $Paced / $PerSecond + $BackToBack + 60
    if ($needSeconds -gt $HolderAwaySeconds) {
        throw "could not run: step 2 could take $([math]::Ceiling($needSeconds)) seconds, longer than the holder's $HolderAwaySeconds-second away clock; use fewer runs or a higher -PerSecond"
    }
    if (Test-Path -LiteralPath $storeFull) { throw "could not run: the store folder $storeFull already exists; give a folder that does not" }
    $storeParent = Split-Path -Parent $storeFull
    if (-not $storeParent -or -not (Test-Path -LiteralPath $storeParent -PathType Container)) {
        throw "could not run: the store folder's parent $storeParent does not exist; the probe makes only the store itself"
    }
    # Reserve the store before anything else: only a folder this run made is
    # ever removed at the end.
    if (-not [P16Runner]::Reserve($storeFull)) { throw "could not run: the store folder $storeFull already exists; give a folder that does not" }
    $storeMade = $true
    $sig = Get-AuthenticodeSignature -LiteralPath $helperFull
    if ($sig.Status -ne 'Valid') { throw "could not run: the helper's signature is $($sig.Status), not Valid; P16 measures the signed per-user copy" }
    if (-not (Test-Path -LiteralPath $outWanted)) { New-Item -ItemType Directory -Path $outWanted | Out-Null }
    # Results are written only once the output folder has passed its checks.
    $outFull = (Resolve-Path -LiteralPath $outWanted).ProviderPath

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('p16-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    foreach ($d in 'home', 'appdata', 'localappdata', 'claude', 'tmp', 'work') { New-Item -ItemType Directory -Path (Join-Path $tempRoot $d) | Out-Null }
    $work = Join-Path $tempRoot 'work'
    $freshEnv = New-FreshEnv $tempRoot $null
    $freshBlock = ConvertTo-EnvBlock $freshEnv

    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = @(Get-CimInstance Win32_Processor)[0]
    $result.machine = [ordered]@{
        os = "$($os.Caption) $($os.Version)"
        model = [string]$cs.Model
        cpu = ([string]$cpu.Name).Trim()
        logicalProcessors = [int]$cs.NumberOfLogicalProcessors
        memoryGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    }
    $hash = (Get-FileHash -LiteralPath $helperFull -Algorithm SHA256).Hash.ToLowerInvariant()
    $folder = Split-Path -Leaf (Split-Path -Parent $helperFull)
    $result.helper = [ordered]@{
        folder = $folder
        # The app names each per-user copy <version>-<first 12 hex of its sha256>.
        folderNamesThisFile = $folder.ToLowerInvariant().EndsWith('-' + $hash.Substring(0, 12))
        version = ((& $helperFull version) -join ' ').Trim()
        sha256 = $hash
        signature = [string]$sig.Status
        signerThumbprint = [string]$sig.SignerCertificate.Thumbprint
    }
    [P16Runner]::CycleRate = [P16Runner]::CyclesPerMs()
    if ([P16Runner]::CycleRate -le 0) { throw 'could not run: no CPU cycle count on this machine' }
    $result.machine.cpuCyclesPerMs = [math]::Round([P16Runner]::CycleRate, 0)
    $result.defenderBefore = Get-Defender
    $result.passLine = [ordered]@{ p95WallMs = $PassP95Ms; maxWallMs = $PassMaxMs; meanCpuMs = $PassMeanCpuMs; failedRuns = $PassFailedRuns; defenderRealTime = 'on' }
    Write-Host "P16: helper $($result.helper.version) ($($result.helper.folder)), signature $($result.helper.signature)"
    Write-Host "P16: Defender real-time protection $($result.defenderBefore.realTimeProtection)"

    # --- Step 0: how Claude Code starts a command hook -----------------------
    $step0 = [ordered]@{ how = 'documented, not observed' }
    $prefix = $null
    $quoteStyle = $null
    $newConsole = $true
    $forward = $false
    if ($Launcher -eq 'observe') {
        if (-not $Claude) { throw 'could not run: -Launcher observe needs -Claude; or name the launcher with -Launcher and the result says "documented, not observed"' }
        $recorder = Join-Path $tempRoot 'chain.ps1'
        [IO.File]::WriteAllText($recorder, $ChainRecorder)
        $chainOut = Join-Path $tempRoot 'chain.json'
        $recorderCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (ConvertTo-ForwardPath $recorder) + '" "' + (ConvertTo-ForwardPath $chainOut) + '"'
        $settings = Join-Path $tempRoot 'settings.json'
        $settingsJson = @{ hooks = @{ SessionStart = @(@{ hooks = @(@{ type = 'command'; command = $recorderCmd; timeout = 30 }) }) } } | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($settings, $settingsJson)
        $claudeEnv = New-FreshEnv $tempRoot @{
            ANTHROPIC_API_KEY = 'p16-probe-placeholder-not-a-key'
            ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
            DISABLE_AUTOUPDATER = '1'
            DISABLE_TELEMETRY = '1'
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
        }
        $claudeFull = (Resolve-Path -LiteralPath $Claude).ProviderPath
        $ver = Invoke-Fresh $claudeFull @('--version') $claudeEnv $work 60000
        $step0.claudeVersion = $ver.Out.Trim()
        $line = (ConvertTo-Arg $claudeFull) + ' -p p16 --settings ' + (ConvertTo-Arg $settings)
        $r0 = [P16Runner]::Run($line, (ConvertTo-EnvBlock $claudeEnv), $work, $false, $null, 90000, $chainOut)
        $step0.claudeStoppedAfterHook = $r0.StoppedEarly
        if (Test-Path -LiteralPath $chainOut) {
            $seen = Get-Content -LiteralPath $chainOut -Raw | ConvertFrom-Json
            $chain = @($seen.chain)
            $step0.chain = @($chain | ForEach-Object { [ordered]@{ pid = $_.pid; ppid = $_.ppid; name = $_.name; cmd = $_.cmd } })
            $step0.children = @($seen.children | ForEach-Object { [ordered]@{ pid = $_.pid; ppid = $_.ppid; name = $_.name } })
            $step0.hookStdinBytes = $seen.stdinBytes
            if ($chain.Count -ge 2 -and $chain[$chain.Count - 1].name -ieq 'claude.exe') {
                $top = $chain[$chain.Count - 2]
                $topCmd = [string]$top.cmd
                $step0.launcherProgram = $top.name
                $step0.launcherCommandLine = $topCmd
                $step0.launcherConsoleOfItsOwn = [bool](@($seen.children | Where-Object { $_.name -ieq 'conhost.exe' -and $_.ppid -eq $top.pid }).Count)
                $asArg = ConvertTo-Arg $recorderCmd
                if ($top.name -ieq 'powershell.exe') {
                    $quoteStyle = 'direct'
                } elseif ($topCmd.EndsWith(' ' + $asArg)) {
                    $prefix = $topCmd.Substring(0, $topCmd.Length - $asArg.Length)
                    $quoteStyle = 'arg'
                } elseif ($topCmd.EndsWith(' "' + $recorderCmd + '"')) {
                    $prefix = $topCmd.Substring(0, $topCmd.Length - $recorderCmd.Length - 2)
                    $quoteStyle = 'verbatim'
                }
                if ($quoteStyle) {
                    $step0.how = 'observed'
                    $newConsole = $step0.launcherConsoleOfItsOwn
                    $forward = $top.name -ieq 'bash.exe'
                }
            }
        }
        if ($step0.how -ne 'observed') {
            $result.step0 = $step0
            throw 'could not run: step 0 did not see how claude starts a hook; run again with -Launcher gitbash, cmd or direct (the result then says "documented, not observed")'
        }
    } else {
        $step0.named = $Launcher
        switch ($Launcher) {
            'gitbash' {
                if (-not $GitBash) {
                    $git = (Get-Command git.exe -ErrorAction Stop).Source
                    $GitBash = Join-Path (Split-Path -Parent (Split-Path -Parent $git)) 'bin\bash.exe'
                }
                $prefix = (ConvertTo-Arg $GitBash) + ' -c '
                $quoteStyle = 'arg'
                $forward = $true
            }
            'cmd' { $prefix = (ConvertTo-Arg $env:ComSpec) + ' /d /s /c '; $quoteStyle = 'verbatim' }
            'direct' { $quoteStyle = 'direct' }
        }
    }
    $step0.standInStartsWithAConsoleOfItsOwn = $newConsole
    $result.step0 = $step0
    $step0 | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outFull 'p16-step0.json') -Encoding UTF8
    $launcherName = $(if ($step0.Contains('launcherProgram')) { $step0['launcherProgram'] } else { $Launcher })
    Write-Host "P16 step 0: $($step0.how); launcher $launcherName; a console of its own: $newConsole"

    # --- Step 1: one holder in a throwaway store -----------------------------
    $sid = 'p16-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $holderSid = $sid
    $hold = Invoke-Fresh $helperFull @('hold', '--store', $storeFull, '--session', $sid, '--away', [string]$HolderAwaySeconds, '--detach') $freshEnv $work 30000
    if ($hold.Code -ne 0) { throw "could not run: hold --detach exited $($hold.Code): $($hold.Err.Trim())" }
    $rec = $hold.Out.Trim() | ConvertFrom-Json
    $holderPid = [int]$rec.pid
    $result.holder = [ordered]@{ session = $sid; pid = $holderPid; child = $rec.child }
    Write-Host "P16 step 1: holder $holderPid holds $sid"

    # --- Step 2: the stand-in, behind the launcher ----------------------------
    if ($quoteStyle -eq 'direct') {
        $standIn = (ConvertTo-Arg $helperFull) + ' list --store ' + (ConvertTo-Arg $storeFull)
    } else {
        $h = $helperFull; $s = $storeFull
        if ($forward) { $h = ConvertTo-ForwardPath $h; $s = ConvertTo-ForwardPath $s }
        $hookCmd = '"' + $h + '" list --store "' + $s + '"'
        if ($quoteStyle -eq 'arg') { $standIn = $prefix + (ConvertTo-Arg $hookCmd) } else { $standIn = $prefix + '"' + $hookCmd + '"' }
    }
    $result.standInCommandLine = $standIn.Replace($helperFull, '<helper>').Replace((ConvertTo-ForwardPath $helperFull), '<helper>').Replace($storeFull, '<store>').Replace((ConvertTo-ForwardPath $storeFull), '<store>')
    $hookStdin = '{"session_id":"' + $sid + '","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo p16"},"cwd":"C:/work"}'

    # Defender scans each program a run starts, in its own process, outside
    # the chain. Its CPU is reported beside the verdict, not in it: first its
    # rate over 20 idle seconds, then its use over step 2.
    $mpPid = 0
    $mp = Get-Process -Name MsMpEng -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($mp) { $mpPid = $mp.Id }
    $mpIdle = -1
    if ($mpPid) {
        $a0 = [P16Runner]::ProcessCpuMs($mpPid)
        $w0 = [Diagnostics.Stopwatch]::StartNew()
        Start-Sleep -Seconds 20
        $a1 = [P16Runner]::ProcessCpuMs($mpPid)
        if ($a0 -ge 0 -and $a1 -ge 0) { $mpIdle = ($a1 - $a0) / $w0.Elapsed.TotalMilliseconds }
    }
    $mpStart = $(if ($mpPid) { [P16Runner]::ProcessCpuMs($mpPid) } else { -1 })
    $mpClock = [Diagnostics.Stopwatch]::StartNew()

    $rows = New-Object Collections.Generic.List[object]
    # Every program the chains ran, by full path, for the exclusion check.
    $chainPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $interval = 1000.0 / $PerSecond
    $plan = @()
    for ($i = 1; $i -le $Paced; $i++) { $plan += 'paced' }
    for ($i = 1; $i -le $BackToBack; $i++) { $plan += 'back-to-back' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $pacedStart = 0.0
    $n = 0
    foreach ($phase in $plan) {
        $n++
        if ($phase -eq 'paced') {
            $due = $pacedStart + ($n - 1) * $interval
            $wait = $due - $clock.Elapsed.TotalMilliseconds
            if ($wait -gt 0) { Start-Sleep -Milliseconds ([int][math]::Ceiling($wait)) }
        }
        $at = $clock.Elapsed.TotalMilliseconds
        $r = [P16Runner]::Run($standIn, $freshBlock, $work, $newConsole, $hookStdin, $RunTimeoutMs, $null)
        foreach ($cp in $r.Paths.Split('|')) { if ($cp -and $cp -ne '?') { [void]$chainPaths.Add($cp) } }
        $listed = $false
        try {
            $listing = $r.Output.Trim() | ConvertFrom-Json
            $listed = (@($listing.sessions | Where-Object { $_.session -eq $sid -and $_.pid -eq $holderPid }).Count -eq 1) -and ($listing.removed -eq 0)
        } catch { $listed = $false }
        $why = @()
        if ($r.TimedOut) { $why += 'timed out' }
        if ($r.ExitCode -ne 0) { $why += "exit $($r.ExitCode)" }
        if (-not $listed) { $why += 'holder not listed as live' }
        if ($r.Missed -gt 0) { $why += "$($r.Missed) process(es) without a CPU count" }
        $ok = $why.Count -eq 0
        $rows.Add([pscustomobject]@{
            run = $n; phase = $phase; at = $at; wall = $r.WallMs; topExit = $r.TopExitMs; cpu = $r.CpuMs; tick = $r.CpuTickMs; procs = $r.Processes
            exit = $r.ExitCode; ok = $ok; poll = $r.ZeroByPoll; missed = $r.Missed; chain = $r.Chain
            note = $(if ($ok) { '' } else { (($why -join '; ') + ': ' + $r.Output.Trim()) -replace '[\r\n,]+', ' ' })
        })
        if (-not $ok) { Write-Host "P16 step 2: run $n failed: $($why -join '; '); output: $($r.Output.Trim())" }
    }
    $mpEnd = $(if ($mpPid) { [P16Runner]::ProcessCpuMs($mpPid) } else { -1 })
    $mpSpan = $mpClock.Elapsed.TotalMilliseconds
    if ($mpStart -ge 0 -and $mpEnd -ge 0 -and $mpIdle -ge 0 -and (Get-Process -Id $mpPid -ErrorAction SilentlyContinue)) {
        $result.defenderCpu = [ordered]@{
            note = 'Defender''s own process, outside the chain; not part of the pass line'
            idleMsPerSecond = [math]::Round($mpIdle * 1000, 3)
            stepTwoMs = [math]::Round($mpEnd - $mpStart, 2)
            stepTwoSeconds = [math]::Round($mpSpan / 1000, 1)
            perEventMsNetOfIdle = [math]::Round((($mpEnd - $mpStart) - $mpIdle * $mpSpan) / [math]::Max(1, $rows.Count), 2)
        }
    } else {
        $result.defenderCpu = 'not readable'
    }
    $csv = New-Object Collections.Generic.List[string]
    $csv.Add('run,phase,start_ms,wall_ms,top_exit_ms,cpu_ms,cpu_tick_ms,procs,exit,ok,zero_by_poll,missed,chain_cpu_ms,note')
    foreach ($x in $rows) {
        $csv.Add(('{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13}' -f $x.run, $x.phase, (Format-Num $x.at), (Format-Num $x.wall), (Format-Num $x.topExit), (Format-Num $x.cpu), (Format-Num $x.tick), $x.procs, $x.exit, [int]$x.ok, [int]$x.poll, $x.missed, $x.chain, $x.note))
    }
    [IO.File]::WriteAllLines((Join-Path $outFull 'p16-runs.csv'), $csv)

    # The holder is no longer needed; end it now so step 3 runs alone.
    Stop-ProbeHolder

    # Is Defender as shipped for everything measured? Checked against the
    # programs the chains really ran, so a folder exclusion over Git, or a
    # process exclusion by full path, is caught.
    $result.chainPrograms = @($chainPaths | Sort-Object | ForEach-Object { $_.Replace($helperFull, '<helper>') })
    $result.defenderExcludesProbe = Test-Excluded @($helperFull, $storeFull) (@($helperFull) + @($chainPaths))
    Write-Host "P16: programs in the chains: $($result.chainPrograms -join '; '); exclusion covering the probe: $($result.defenderExcludesProbe)"

    # --- Step 3: reference, today's HTTP hook ---------------------------------
    if ($HttpPosts -gt 0) {
        $js = Join-Path $tempRoot 'p16-http.js'
        [IO.File]::WriteAllText($js, $HttpReference)
        $nodeExe = (Get-Command $Node -ErrorAction Stop).Source
        # Twice in a job: with no POSTs, then with all of them. The CPU of
        # the two node processes, from cycles, differs by what the POSTs cost.
        $nodeLine0 = (ConvertTo-Arg $nodeExe) + ' ' + (ConvertTo-Arg $js) + ' client 0 ' + $PerSecond.ToString($Inv)
        $nodeLine = (ConvertTo-Arg $nodeExe) + ' ' + (ConvertTo-Arg $js) + ' client ' + $HttpPosts + ' ' + $PerSecond.ToString($Inv)
        $h0 = [P16Runner]::Run($nodeLine0, $freshBlock, $work, $false, $null, 60000, $null)
        $hr = [P16Runner]::Run($nodeLine, $freshBlock, $work, $false, $null, [int](($HttpPosts / $PerSecond) * 1000 + 60000), $null)
        if ($h0.ExitCode -ne 0 -or $hr.ExitCode -ne 0) { throw "could not run: the HTTP reference exited $($h0.ExitCode) and $($hr.ExitCode): $($hr.Output.Trim())" }
        $lines = @($hr.Output -split "`r?`n" | Where-Object { $_ })
        $postRows = @($lines | Where-Object { $_ -match '^\d+,' } | ForEach-Object { $f = $_ -split ','; [pscustomobject]@{ wall = [double]::Parse($f[1], $Inv); cpu = [double]::Parse($f[2], $Inv); status = [int]$f[3] } })
        $serverCpu = [double]::Parse((($lines | Where-Object { $_ -like 'server_cpu_ms,*' }) -split ',')[1], $Inv)
        [IO.File]::WriteAllLines((Join-Path $outFull 'p16-http.csv'), [string[]](@('post,wall_ms,client_cpu_ms,status') + @($lines | Where-Object { $_ -match '^\d+,' })))
        $pw = [double[]]@($postRows | ForEach-Object { $_.wall })
        $result.httpReference = [ordered]@{
            posts = $postRows.Count
            failed = @($postRows | Where-Object { $_.status -ne 200 }).Count
            p95WallMs = [math]::Round((Get-P95 $pw), 2)
            maxWallMs = [math]::Round(($pw | Measure-Object -Maximum).Maximum, 2)
            meanWallMs = [math]::Round(($pw | Measure-Object -Average).Average, 2)
            meanCpuMsFromCycles = [math]::Round(($hr.CpuMs - $h0.CpuMs) / [math]::Max(1, $postRows.Count), 3)
            meanCpuMsFromTicks = [math]::Round((($postRows | Measure-Object cpu -Sum).Sum + $serverCpu) / [math]::Max(1, $postRows.Count), 3)
        }
    }

    # --- The answer ------------------------------------------------------------
    $result.defenderAfter = Get-Defender
    $walls = [double[]]@($rows | ForEach-Object { $_.wall })
    $cpus = [double[]]@($rows | ForEach-Object { $_.cpu })
    $ticks = [double[]]@($rows | ForEach-Object { $_.tick })
    $meanCycles = ($cpus | Measure-Object -Average).Average
    $meanTicks = ($ticks | Measure-Object -Average).Average
    $summary = [ordered]@{
        runs = $rows.Count
        failed = @($rows | Where-Object { -not $_.ok }).Count
        p95WallMs = [math]::Round((Get-P95 $walls), 2)
        maxWallMs = [math]::Round(($walls | Measure-Object -Maximum).Maximum, 2)
        meanWallMs = [math]::Round(($walls | Measure-Object -Average).Average, 2)
        meanCpuMsFromCycles = [math]::Round($meanCycles, 2)
        meanCpuMsFromTicks = [math]::Round($meanTicks, 2)
        # The pass line is judged on the larger of the two.
        meanCpuMs = [math]::Round([math]::Max($meanCycles, $meanTicks), 2)
        processesPerEvent = (@($rows | Group-Object procs | Sort-Object Count -Descending)[0]).Name
        runsWithAProcessNotCounted = @($rows | Where-Object { $_.missed -gt 0 }).Count
    }
    foreach ($ph in 'paced', 'back-to-back') {
        $sub = @($rows | Where-Object { $_.phase -eq $ph })
        if ($sub.Count -gt 0) {
            $w = [double[]]@($sub | ForEach-Object { $_.wall })
            $summary[$ph] = [ordered]@{
                runs = $sub.Count
                p95WallMs = [math]::Round((Get-P95 $w), 2)
                maxWallMs = [math]::Round(($w | Measure-Object -Maximum).Maximum, 2)
                meanCpuMsFromCycles = [math]::Round((@($sub | ForEach-Object { $_.cpu }) | Measure-Object -Average).Average, 2)
                meanCpuMsFromTicks = [math]::Round((@($sub | ForEach-Object { $_.tick }) | Measure-Object -Average).Average, 2)
            }
        }
    }
    $result.stepTwo = $summary
    $why = @()
    if (-not $result.defenderBefore.realTimeProtection -or -not $result.defenderAfter.realTimeProtection) { $why += 'Defender real-time protection was not on throughout' }
    if ($result.defenderExcludesProbe -eq 'yes') { $why += 'a Defender exclusion covers the helper, the store or a program of the chain, so Defender was not as shipped' }
    if ($result.defenderExcludesProbe -eq 'unknown') { $why += 'Defender''s exclusions could not be read (run from an administrator session), so Defender as shipped is not verified' }
    if ($summary.p95WallMs -gt $PassP95Ms) { $why += "p95 wall $($summary.p95WallMs) ms is over $PassP95Ms ms" }
    if ($summary.maxWallMs -gt $PassMaxMs) { $why += "longest wall $($summary.maxWallMs) ms is over $PassMaxMs ms" }
    if ($summary.meanCpuMs -gt $PassMeanCpuMs) { $why += "mean CPU $($summary.meanCpuMs) ms is over $PassMeanCpuMs ms" }
    if ($summary.failed -gt $PassFailedRuns) { $why += "$($summary.failed) of $($summary.runs) runs failed" }
    $result.verdict = $(if ($why.Count -eq 0) { 'PASS' } else { 'FAIL - ' + ($why -join '; ') })
    $exitCode = $(if ($why.Count -eq 0) { 0 } else { 1 })
} catch {
    $result.error = $_.Exception.Message
    $result.verdict = 'could not run'
    $exitCode = 2
} finally {
    # End the holder (Stop-ProbeHolder checks it is this run's). Nothing was
    # launched in it, so nothing is left behind it.
    if ($holderPid -gt 0) {
        Stop-ProbeHolder
        Start-Sleep -Milliseconds 300
    }
    if ($storeMade) {
        if ([string]::IsNullOrWhiteSpace($storeFull)) { throw 'the store path is empty; nothing removed' }
        if (Test-Path -LiteralPath $storeFull) { Remove-Item -LiteralPath $storeFull -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($tempRoot) {
        if ([string]::IsNullOrWhiteSpace($tempRoot) -or -not ((Split-Path -Leaf $tempRoot) -like 'p16-*')) { throw 'the temporary folder path is not the probe''s; nothing removed' }
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # Only what this run made is looked for: a store it did not make may be
    # another run's, with that run's holder in it.
    $left = @()
    if ($storeMade) {
        $left += @(Get-CimInstance Win32_Process -Filter "Name='aicc-helper.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($storeFull) } | ForEach-Object { "aicc-helper.exe $($_.ProcessId)" })
    }
    if ($tempRoot) {
        $left += @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains((Split-Path -Leaf $tempRoot)) } | ForEach-Object { "$($_.Name) $($_.ProcessId)" })
    }
    $result.cleanUp = [ordered]@{
        storeMadeByThisRun = $storeMade
        storeRemoved = $storeMade -and -not (Test-Path -LiteralPath $storeFull)
        tempRemoved = -not ($tempRoot -and (Test-Path -LiteralPath $tempRoot))
        processesLeft = $left
    }
    $result.finished = (Get-Date).ToUniversalTime().ToString('o')
    # Written only to an output folder that passed its checks.
    if ($outFull -and (Test-Path -LiteralPath $outFull)) {
        $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outFull 'p16-result.json') -Encoding UTF8
    }
    if ($left.Count -gt 0) { Write-Host "P16: still running after clean-up: $($left -join ', ')" }
}

$result | ConvertTo-Json -Depth 8 | Write-Host
if ($exitCode -eq 2) {
    Write-Host "P16 RESULT: COULD NOT RUN - $($result.error)"
} else {
    Write-Host "P16 RESULT: $($result.verdict)"
}
exit $exitCode
