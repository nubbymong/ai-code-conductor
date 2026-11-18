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
        machine). The process between claude.exe and the hook command is the
        launcher, and a console host under it means the launcher gets a
        console of its own. With -Launcher gitbash, cmd or direct (required
        when -Claude is not given), the launcher is the one named and the
        result says "documented, not observed".
Step 1  One holder in a throwaway store:
        aicc-helper hold --store <Store> --session <sid> --away 600 --detach
        Nothing is launched in it. Then, for reference only, the stand-in below
        runs once from a fresh copy of the helper in a new folder: the first
        start of that copy (Defender has seen the same bytes at the per-user
        path, so this is not a first start of bytes it has never seen).
Step 2  The stand-in for one hook event, behind the launcher from step 0:
        aicc-helper list --store <Store>
        It starts the signed program, reads the record, checks the holder's
        process, connects to its pipe and checks the hello's nonce, then exits:
        all a hook mode does except send one frame. -Paced runs at -PerSecond,
        then -BackToBack runs one after another. Each run is started suspended
        in a job object of its own, so every process in the chain is counted,
        the console host included; the job ends every process still in it when
        it is closed, so a chain never outlives its run or the probe. Wall time
        runs from just before the launcher is created to the moment the last
        process of the chain has ended. CPU time is taken two ways: cpu_ms adds
        each process's CPU cycles, converted to milliseconds at the rate
        measured on this machine (precise); and cpu_tick_ms is the job's own
        user and kernel time, which Windows charges in clock ticks of about
        15.6 ms and which under-counts short bursts (the verdict uses it only
        when its mean is larger than the cycle figure's). creator_ms is the
        probe's own thread creating the launcher, starting it and handing it
        the event (what claude.exe pays in real use), from cycles.
        A run fails when it times out, exits non-zero, its listing does not
        show the holder as live, or any process the job counted has no cycle
        count (one that could not be opened, a lost start notice, or a failed
        read would leave cpu_ms short). One limit of the stand-in: `list` keeps
        the record of a running holder when the hello gives no clear answer (a
        read error), so a run cannot prove its nonce check completed; the hook
        mode reports its handshake itself.
        Outside the chain, beside the verdict and not in it: the CPU of
        Defender's own process (MsMpEng.exe), of the holder, of the probe's own
        process, and of the whole machine (from the processors' idle cycles,
        and from GetSystemTimes). Each is read after a 10-second settle, after
        20 idle seconds, after step 2 and after 20 more idle seconds; it is
        reported per event, net of the lower of the two idle rates, over step 2
        alone or step 2 and the 20 seconds after it, whichever is larger.
Step 3  Reference only: today's HTTP hook is a loopback POST from inside the
        CLI's own process. One node process times -HttpPosts POSTs to a local
        HTTP server in a second node process, at -PerSecond, taken the way the
        hooks gateway takes them: a new connection for each (the gateway
        answers every POST with Connection: close), a per-session token header
        checked in constant time before the body is read, and the body parsed
        as JSON. What the gateway does with the event after that is not in it.
        It runs twice in a job on the same schedule, once without sending and
        once with all the POSTs, and the difference in the two processes' CPU
        cycles, divided by the POSTs, is the CPU per POST (client and server);
        each run must count both node processes. A failure here is recorded
        and does not change the verdict.

Pass line (ADR-030 sets none; the beta 8 plan set this before any measuring):
with Defender real-time protection on, over all step 2 runs, p95 wall time at
most 150 ms, longest at most 750 ms, mean CPU time at most 50 ms per event
(the CPU of the chain's own processes), and no failed run. Anything else is
FAIL. p95 is the nearest-rank value: the ceil(0.95 * n)-th smallest. The mean
CPU judged is the larger of the mean of cpu_ms and the mean of cpu_tick_ms.
The values are compared unrounded. A Defender exclusion that covers the
helper, the store, a program of the chain or the probe's own program (which
starts each chain, as claude.exe does in real use) also makes it a FAIL, since
Defender is then not as shipped; so does an exclusion list that cannot be read,
since that is then not verified (run from an administrator session). Only the
plan's schedule (-Paced 300 at -PerSecond 2, then -BackToBack 50) gives a P16
verdict; any other schedule is a CHECK RUN.

The script refuses to run when the helper is not the signed per-user copy of
the installed app's helper (in %LOCALAPPDATA%\AI Code Conductor\helper\
<version>-<first 12 hex of its sha256>\, Authenticode valid, the same file as
the installed app's resources\helper\aicc-helper.exe, and signed by the same
signer as the app's own program); when node is needed for step 3 and not
found; when the store folder already exists, its parent folder does not, or
the output folder is inside it; when the helper, store or temporary path holds
a character the launcher's shell would change (" $ ` % ^ & | < >); and when
step 2 could outlast the holder's 600-second away clock. It makes the store
folder itself, in one step that fails
if the folder exists, after those checks and before anything else; only a store
it made is removed, and results are written only to an output folder that
passed its checks. Each chain's output is read while it runs. In a finally
block it ends the holder (only the process its record names, and only while
that process runs this helper as the holder of this store and session),
removes the store and its own temporary folder, and looks for any process
started since the probe began that runs this helper or a program from its
temporary folder, or names its store or temporary folder.

Writes p16-runs.csv, p16-http.csv, p16-step0.json and p16-result.json to
-OutDir, with the helper, store, claude.exe, temporary folder and user profile
paths written as <helper>, <store>, <claude>, <temp> and <home>. The last line
is "P16 RESULT: PASS", "P16 RESULT: FAIL - <reasons>", "P16 RESULT: CHECK RUN -
<...>" or "P16 RESULT: COULD NOT RUN - <reason>", with "; clean-up incomplete:
<what>" added when something was left behind or could not be checked.
Exit code 0 pass, 1 fail, 2 could not run or clean-up incomplete, 3 check run.

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
# The plan's schedule. Any other gives a check run, not a P16 verdict.
$PlanPaced = 300
$PlanPerSecond = 2
$PlanBackToBack = 50

$RunTimeoutMs = 30000
$SettleSeconds = 10
$IdleSeconds = 20
$ColdStartSeconds = 5
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
    public double CreatorMs = -1;
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
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint MSG_ACTIVE_PROCESS_ZERO = 4;
    const uint MSG_NEW_PROCESS = 6;
    const uint MSG_EXIT_PROCESS = 7;
    const uint MSG_ABNORMAL_EXIT_PROCESS = 8;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

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

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryIdleProcessorCycleTime(ref uint bufferLength, [Out] ulong[] buffer);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
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

    // CPU cycles per millisecond of this machine's cycle counter, from five
    // 100 ms busy loops on this thread. A loop that was descheduled for part
    // of its time counts fewer cycles, so a loop's rate can only come out too
    // low; the fastest of the five is the closest to the counter's true rate.
    // It is also the least conservative choice (the highest rate gives the
    // smallest CPU figures), so all five rates are recorded in
    // p16-result.json (cpuCyclesPerMs and cpuCyclesPerMsLoops) to show the
    // spread.
    public static double[] LoopRates = new double[0];

    public static double CyclesPerMs()
    {
        double best = 0;
        List<double> rates = new List<double>();
        IntPtr me = GetCurrentThread();
        for (int i = 0; i < 5; i++)
        {
            ulong c0, c1;
            QueryThreadCycleTime(me, out c0);
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalMilliseconds < 100) { }
            QueryThreadCycleTime(me, out c1);
            double rate = (c1 - c0) / sw.Elapsed.TotalMilliseconds;
            rates.Add(rate);
            if (rate > best) best = rate;
        }
        LoopRates = rates.ToArray();
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

    // The idle cycles of every processor so far, added up; -1 when they
    // cannot be read. A busy processor is not idle, so what step 2 takes away
    // from the idle rate is what the whole machine spent on it.
    public static double IdleCycles()
    {
        ulong[] buf = new ulong[Math.Max(1, Environment.ProcessorCount)];
        uint len = (uint)(8 * buf.Length);
        if (!QueryIdleProcessorCycleTime(ref len, buf))
        {
            // Too small: len is the size needed, in bytes; a buffer of len
            // elements is larger than that, and the unused ones stay 0.
            buf = new ulong[Math.Max(len, (uint)buf.Length)];
            len = (uint)(8 * buf.Length);
            if (!QueryIdleProcessorCycleTime(ref len, buf)) return -1;
        }
        double sum = 0;
        foreach (ulong c in buf) sum += c;
        return sum;
    }

    // The busy time of every processor so far, from GetSystemTimes (kernel
    // and user time less idle time, which Windows keeps in clock ticks), in
    // milliseconds; -1 when it cannot be read.
    public static double SystemBusyMs()
    {
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return -1;
        return (kernel + user - idle) / 10000.0;
    }

    // "Git/bash" and "usr/bash" tell Git for Windows' two bash programs
    // apart. A folder directly under the user profiles' folder (a user's
    // own profile) is written as <user>, so no user name is kept.
    public static string ShortName(string full)
    {
        string name = Path.GetFileNameWithoutExtension(full);
        string dir = Path.GetDirectoryName(full);
        string up = dir == null ? null : Path.GetDirectoryName(dir);
        if (up == null) return name;
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(profile))
        {
            string profiles = Path.GetDirectoryName(profile.TrimEnd('\\'));
            string upParent = Path.GetDirectoryName(up.TrimEnd('\\'));
            if (profiles != null && upParent != null && string.Equals(upParent.TrimEnd('\\'), profiles.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                return "<user>/" + name;
            }
        }
        return Path.GetFileName(up) + "/" + name;
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
    // Whatever happens, the job is ended and every handle closed on the way
    // out, and closing the job ends any process still in it, so a chain never
    // outlives this call, nor the probe's own process.
    public static P16Run Run(string commandLine, string envBlock, string cwd, bool newConsole, string stdinText, int timeoutMs, string doneFile)
    {
        P16Run r = new P16Run();
        IntPtr job = IntPtr.Zero, port = IntPtr.Zero, env = IntPtr.Zero, top = IntPtr.Zero;
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
        Dictionary<int, IntPtr> handles = new Dictionary<int, IntPtr>();
        Dictionary<int, string> names = new Dictionary<int, string>();
        List<int> order = new List<int>();
        MemoryStream outBytes = new MemoryStream();
        System.Threading.Thread reader = null;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject (kill on close)");
            }
            port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            if (port == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateIoCompletionPort");
            JOBOBJECT_ASSOCIATE_COMPLETION_PORT assoc = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
            assoc.CompletionKey = job;
            assoc.CompletionPort = port;
            if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, ref assoc, Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject (port)");
            }

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = 1;
            if (!CreatePipe(out outRead, out outWrite, ref sa, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
            if (!CreatePipe(out inRead, out inWrite, ref sa, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
            SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);

            // Drain the output while the job runs, so a chain that writes more
            // than the pipe holds never stalls. The reader starts before the clock.
            IntPtr readEnd = outRead;
            reader = new System.Threading.Thread(delegate ()
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
            env = envBlock == null ? IntPtr.Zero : Marshal.StringToHGlobalUni(envBlock);
            StringBuilder cmd = new StringBuilder(commandLine);
            PROCESS_INFORMATION pi;
            IntPtr me = GetCurrentThread();
            ulong c0, c1, c2, c3;

            Stopwatch sw = Stopwatch.StartNew();
            QueryThreadCycleTime(me, out c0);
            bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref si, out pi);
            int err = Marshal.GetLastWin32Error();
            QueryThreadCycleTime(me, out c1);
            CloseHandle(outWrite); outWrite = IntPtr.Zero;
            CloseHandle(inRead); inRead = IntPtr.Zero;
            if (env != IntPtr.Zero) { Marshal.FreeHGlobal(env); env = IntPtr.Zero; }
            if (!ok) throw new Win32Exception(err, "CreateProcess: " + commandLine);
            top = pi.hProcess;
            if (!AssignProcessToJobObject(job, pi.hProcess))
            {
                int e = Marshal.GetLastWin32Error();
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                throw new Win32Exception(e, "AssignProcessToJobObject");
            }
            handles[pi.dwProcessId] = pi.hProcess;
            names[pi.dwProcessId] = ImagePath(pi.hProcess);
            order.Add(pi.dwProcessId);
            QueryThreadCycleTime(me, out c2);
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
            if (stdinText != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(stdinText);
                int written;
                WriteFile(inWrite, b, b.Length, out written, IntPtr.Zero);
            }
            CloseHandle(inWrite); inWrite = IntPtr.Zero;
            QueryThreadCycleTime(me, out c3);
            // What the starting program pays: creating the launcher, starting
            // it and handing it the event. Joining the job and reading the
            // image name are the probe's own and are left out.
            r.CreatorMs = CycleRate > 0 ? ((c1 - c0) + (c3 - c2)) / CycleRate : -1;

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
                            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
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

            // Two CPU figures. CpuTickMs is the job's own count over every
            // process it ever held, in clock ticks of about 15.6 ms; it
            // under-counts short bursts, and the verdict uses it only when its
            // mean is larger than the cycle figure's. CpuMs adds each
            // process's CPU cycles, converted with CycleRate (precise, but
            // only for processes this saw start).
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
                ulong cycles;
                double cpu = -1;
                if (CycleRate > 0 && QueryProcessCycleTime(handles[pid], out cycles))
                {
                    cpu = cycles / CycleRate;
                    total += cpu;
                    counted++;
                }
                string full = names[pid];
                parts.Add((full == "?" ? "?" : ShortName(full)) + ":" + cpu.ToString("0.00", CultureInfo.InvariantCulture));
                paths.Add(full);
            }
            r.Paths = string.Join("|", paths.ToArray());
            // Every process the job ever held, less those whose cycles were read:
            // a process that could not be opened, a lost start notice, or a
            // failed cycle read all leave CpuMs short, and the run then fails.
            r.Missed = Math.Max(0, (int)a.TotalProcesses - counted);
            r.CpuMs = total;
            r.Chain = string.Join("|", parts.ToArray());

            // Every process of the job has ended, so the reader reaches the end
            // of the pipe. If something outside the job still holds its write
            // end, the reader is left (it is a background thread) with its
            // handle open, and the output read so far is used.
            if (reader.Join(5000)) { CloseHandle(outRead); outRead = IntPtr.Zero; }
            lock (outBytes) { r.Output = Encoding.UTF8.GetString(outBytes.ToArray()); }
            return r;
        }
        finally
        {
            if (job != IntPtr.Zero) TerminateJobObject(job, 1);
            foreach (IntPtr h in handles.Values) CloseHandle(h);
            if (top != IntPtr.Zero && !handles.ContainsValue(top)) CloseHandle(top);
            if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
            if (inRead != IntPtr.Zero) CloseHandle(inRead);
            if (inWrite != IntPtr.Zero) CloseHandle(inWrite);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            // The write ends are closed (ours above, the chain's with its
            // processes), so the reader ends; its pipe end is closed once it has.
            if (outRead != IntPtr.Zero && (reader == null || reader.Join(5000))) CloseHandle(outRead);
            if (port != IntPtr.Zero) CloseHandle(port);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
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

# Personal paths written as placeholders, in both slash forms, so the result
# files can be posted as they are: the helper, the store, claude.exe, the
# probe's temporary folder, then anything else under the user profile.
function Hide-Personal([string] $s) {
    if (-not $s) { return $s }
    $pairs = @(@($helperFull, '<helper>'), @($storeFull, '<store>'), @($claudeFull, '<claude>'), @($tempRoot, '<temp>'), @($env:USERPROFILE, '<home>'))
    foreach ($p in $pairs) {
        $v = [string]$p[0]
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        foreach ($form in @($v, (ConvertTo-ForwardPath $v))) {
            $s = [regex]::Replace($s, [regex]::Escape($form), $p[1], [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    return $s
}

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

# The installed AI Code Conductor whose bundled helper is this very file, and
# whether its own program is validly signed by the helper's signer. Nothing
# about it is recorded but its version and those two answers: no path, and no
# signer name.
function Find-InstalledApp([string] $hash, [string] $thumb) {
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    foreach ($k in $keys) {
        $entries = @(Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and ([string]$_.DisplayName) -like 'AI Code Conductor*' })
        foreach ($e in $entries) {
            $dir = ''
            if ($e.PSObject.Properties['InstallLocation'] -and $e.InstallLocation) { $dir = [string]$e.InstallLocation }
            elseif ($e.PSObject.Properties['UninstallString'] -and ([string]$e.UninstallString) -match '^\s*"([^"]+)"') { $dir = Split-Path -Parent $Matches[1] }
            if (-not $dir) { continue }
            $bundled = Join-Path $dir 'resources\helper\aicc-helper.exe'
            $appExe = Join-Path $dir 'AI Code Conductor.exe'
            if (-not (Test-Path -LiteralPath $bundled -PathType Leaf) -or -not (Test-Path -LiteralPath $appExe -PathType Leaf)) { continue }
            if ((Get-FileHash -LiteralPath $bundled -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { continue }
            $appSig = Get-AuthenticodeSignature -LiteralPath $appExe
            $sameSigner = ($appSig.Status -eq 'Valid') -and $appSig.SignerCertificate -and ($appSig.SignerCertificate.Thumbprint -eq $thumb)
            return [ordered]@{
                version = $(if ($e.PSObject.Properties['DisplayVersion']) { [string]$e.DisplayVersion } else { '' })
                bundledHelperIsThisFile = $true
                appSignature = [string]$appSig.Status
                signerIsTheApps = [bool]$sameSigner
            }
        }
    }
    return $null
}

# Whether a Defender exclusion covers the probe: a path exclusion (a folder or
# a file) over the helper, the store or a program; a process exclusion naming
# a program by full path or file name; or an extension exclusion matching one.
# Rules may hold environment variables and wildcards. Reading exclusions can
# need an elevated session; then this says so instead of guessing.
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

# The reasons a measured step 2 is not a PASS, from the unrounded values: a
# p95 of 150.004 ms is over a line of 150 ms.
function Get-P16Reasons($m) {
    $why = @()
    if (-not $m.realTimeBefore -or -not $m.realTimeAfter) { $why += 'Defender real-time protection was not on throughout' }
    if ($m.excluded -eq 'yes') { $why += 'a Defender exclusion covers the helper, the store, a program of the chain or the probe''s own program, so Defender was not as shipped' }
    if ($m.excluded -eq 'unknown') { $why += 'Defender''s exclusions could not be read (run from an administrator session), so Defender as shipped is not verified' }
    if ($m.p95 -gt $PassP95Ms) { $why += "p95 wall $($m.p95.ToString('0.###', $Inv)) ms is over $PassP95Ms ms" }
    if ($m.max -gt $PassMaxMs) { $why += "longest wall $($m.max.ToString('0.###', $Inv)) ms is over $PassMaxMs ms" }
    if ($m.meanCpu -gt $PassMeanCpuMs) { $why += "mean CPU $($m.meanCpu.ToString('0.###', $Inv)) ms is over $PassMeanCpuMs ms" }
    if ($m.failed -gt $PassFailedRuns) { $why += "$($m.failed) of $($m.runs) runs failed" }
    return $why
}

# CPU a counter shows over step 2, per event, net of idle. $v and $t are the
# counter and the clock (ms) at the start of the idle window, the start of
# step 2, its end, and the end of the 20 seconds after it. The idle rate is
# the lower of the two windows' (a window may hold the tail of earlier work);
# the net is over step 2 alone or step 2 and the window after it, whichever
# is larger (the second catches work that runs on after the last event).
function Get-NetPerEvent([double[]] $v, [double[]] $t, [int] $runs) {
    if (@($v | Where-Object { $_ -lt 0 }).Count -gt 0) { return 'not readable' }
    $rateBefore = ($v[1] - $v[0]) / ($t[1] - $t[0])
    $rateAfter = ($v[3] - $v[2]) / ($t[3] - $t[2])
    $base = [math]::Min($rateBefore, $rateAfter)
    $alone = (($v[2] - $v[1]) - $base * ($t[2] - $t[1])) / $runs
    $withAfter = (($v[3] - $v[1]) - $base * ($t[3] - $t[1])) / $runs
    return [ordered]@{
        idleBeforeMsPerSecond = [math]::Round($rateBefore * 1000, 3)
        idleAfterMsPerSecond = [math]::Round($rateAfter * 1000, 3)
        stepTwoGrossMs = [math]::Round($v[2] - $v[1], 2)
        grossPerEventMs = [math]::Round(($v[2] - $v[1]) / $runs, 2)
        perEventMsStepTwoAlone = [math]::Round($alone, 2)
        perEventMsWithTheWindowAfter = [math]::Round($withAfter, 2)
        perEventMsNetOfIdle = [math]::Round([math]::Max($alone, $withAfter), 2)
    }
}

# The same for the whole machine, from the processors' idle cycles: the idle
# rate is the higher of the two windows' (the quieter one), and what step 2
# takes away from it is what the machine spent on step 2, all processes, the
# kernel and the probe's own bookkeeping included.
function Get-MachineNetPerEvent([double[]] $idle, [double[]] $t, [int] $runs) {
    if (@($idle | Where-Object { $_ -lt 0 }).Count -gt 0 -or [P16Runner]::CycleRate -le 0) { return 'not readable' }
    $rateBefore = ($idle[1] - $idle[0]) / ($t[1] - $t[0])
    $rateAfter = ($idle[3] - $idle[2]) / ($t[3] - $t[2])
    $rate = [math]::Max($rateBefore, $rateAfter)
    $alone = ($rate * ($t[2] - $t[1]) - ($idle[2] - $idle[1])) / [P16Runner]::CycleRate / $runs
    $withAfter = ($rate * ($t[3] - $t[1]) - ($idle[3] - $idle[1])) / [P16Runner]::CycleRate / $runs
    return [ordered]@{
        perEventMsStepTwoAlone = [math]::Round($alone, 2)
        perEventMsWithTheWindowAfter = [math]::Round($withAfter, 2)
        perEventMsNetOfIdle = [math]::Round([math]::Max($alone, $withAfter), 2)
    }
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

# Step 3's two node processes: a server that takes a POST the way the hooks
# gateway does (Connection: close on every response, the token header checked
# in constant time before the body is read, the body parsed as JSON; not what
# the gateway then does with the event), and a client like the CLI's HTTP
# hook, on a new connection for each POST, which prints one line per POST.
# With "idle" the client keeps the same schedule and sends nothing: the
# baseline.
$HttpReference = @'
'use strict';
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
if (process.argv[2] === 'server') {
  const expected = Buffer.from(process.argv[3]);
  const srv = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    const presented = Buffer.from(String(req.headers['x-ccc-hook-token'] || ''));
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let status = 200;
      try { JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { status = 400; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  srv.listen(0, '127.0.0.1', () => process.stdout.write(srv.address().port + '\n'));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  const count = Number(process.argv[3]);
  const perSecond = Number(process.argv[4]);
  const send = process.argv[5] !== 'idle';
  const token = crypto.randomBytes(16).toString('hex');
  const agent = new http.Agent({ keepAlive: false });
  const body = JSON.stringify({ session_id: 'p16-probe-http', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo p16' }, tool_response: { stdout: 'p16', stderr: '' }, cwd: 'C:/work', transcript_path: 'C:/work/t.jsonl' });
  const request = (port, data) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/hook/p16-probe-http', method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ccc-hook-token': token } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = spawn(process.execPath, [__filename, 'server', token], { stdio: ['pipe', 'pipe', 'inherit'] });
  let portText = '';
  const onData = (c) => {
    portText += c;
    if (!portText.includes('\n')) return;
    server.stdout.off('data', onData);
    run(Number(portText.trim())).then(() => { server.stdin.end(); }, (e) => { console.error(String(e)); server.kill(); process.exit(2); });
  };
  server.stdout.on('data', onData);
  async function run(port) {
    const start = Date.now();
    for (let i = 1; i <= count; i++) {
      const due = start + (i - 1) * (1000 / perSecond);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (!send) continue;
      const t0 = process.hrtime.bigint();
      const status = await request(port, body);
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`${i},${wall.toFixed(3)},${status}`);
    }
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
$claudeFull = ''
$outFull = ''
$nodeExe = ''
$started = Get-Date

# The holder's away clock (step 1) runs from its start and a listing does not
# reset it, so step 2 and the idle window after it must end well inside it.
$HolderAwaySeconds = 600

# End the probe's holder: only the process its record names, and only while
# that process runs this helper as the holder of this store and session. Says
# what happened. When WMI cannot be used, the process's own program path and
# start time (which need no WMI) stand in for the command line.
function Stop-ProbeHolder {
    if ($holderPid -le 0) { return 'not started' }
    $w = $null
    $wmiError = ''
    try {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId=$holderPid" -ErrorAction Stop
    } catch {
        $wmiError = $_.Exception.Message
    }
    if ($wmiError) {
        $p = Get-Process -Id $holderPid -ErrorAction SilentlyContinue
        if (-not $p) { return 'already ended' }
        $path = $null; $start = $null
        try { $path = $p.Path; $start = $p.StartTime } catch { }
        if (-not ($path -and $path -ieq $helperFull -and $start -and $start -ge $started)) { return "not checked: WMI failed ($wmiError) and the process could not be confirmed as the probe's" }
    } elseif (-not $w) {
        return 'already ended'
    } elseif (-not ($w.ExecutablePath -and ($w.ExecutablePath -ieq $helperFull) -and $w.CommandLine -and
            $w.CommandLine.Contains($storeFull) -and $w.CommandLine.Contains($holderSid))) {
        return 'already ended (its process id now names another process, left alone)'
    }
    try { Stop-Process -Id $holderPid -Force -ErrorAction Stop } catch { return "not stopped: $($_.Exception.Message)" }
    try { Wait-Process -Id $holderPid -Timeout 5 -ErrorAction Stop } catch { }
    if (Get-Process -Id $holderPid -ErrorAction SilentlyContinue) { return 'still running' }
    return $(if ($wmiError) { 'stopped (confirmed by its program path and start time; WMI failed)' } else { 'stopped' })
}

# Any process started since the probe began that runs this helper or a
# program from the probe's temporary folder, or names the store this run made
# or that temporary folder. Independent of how the holder was ended.
function Get-ProbeLeftovers {
    $storeFwd = ConvertTo-ForwardPath $storeFull
    $leaf = $(if ($tempRoot) { Split-Path -Leaf $tempRoot } else { '' })
    $ic = [StringComparison]::OrdinalIgnoreCase
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    return @($all | Where-Object {
            $exe = [string]$_.ExecutablePath
            $line = [string]$_.CommandLine
            ($_.ProcessId -ne $PID) -and $_.CreationDate -and ($_.CreationDate -ge $started) -and (
                ($helperFull -and $exe -and ($exe -ieq $helperFull)) -or
                ($tempRoot -and $exe -and $exe.StartsWith($tempRoot + [char]92, $ic)) -or
                ($storeMade -and $line -and (($line.IndexOf($storeFull, $ic) -ge 0) -or ($line.IndexOf($storeFwd, $ic) -ge 0))) -or
                ($leaf -and $line -and ($line.IndexOf($leaf, $ic) -ge 0)))
        } | ForEach-Object { "$($_.Name) $($_.ProcessId)" })
}

# The stand-in command line for one hook event, behind the launcher.
function New-StandIn([string] $helperPath) {
    if ($quoteStyle -eq 'direct') { return (ConvertTo-Arg $helperPath) + ' list --store ' + (ConvertTo-Arg $storeFull) }
    $h = $helperPath; $s = $storeFull
    if ($forward) { $h = ConvertTo-ForwardPath $h; $s = ConvertTo-ForwardPath $s }
    $hookCmd = '"' + $h + '" list --store "' + $s + '"'
    if ($quoteStyle -eq 'arg') { return $prefix + (ConvertTo-Arg $hookCmd) }
    return $prefix + '"' + $hookCmd + '"'
}

# Whether a run's listing shows the probe's holder as live, with nothing removed.
function Test-Listed([string] $output) {
    try {
        $listing = $output.Trim() | ConvertFrom-Json
        return (@($listing.sessions | Where-Object { $_.session -eq $holderSid -and $_.pid -eq $holderPid }).Count -eq 1) -and ($listing.removed -eq 0)
    } catch {
        return $false
    }
}

$result = [ordered]@{ probe = 'P16'; started = $started.ToUniversalTime().ToString('o') }

try {
    # --- Checks before anything is made or started ---------------------------
    if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw "could not run: no helper at $Helper" }
    $helperFull = (Resolve-Path -LiteralPath $Helper).ProviderPath
    $storeFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Store).TrimEnd([char]92)
    $outWanted = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir).TrimEnd([char]92)
    if ($outWanted -ieq $storeFull -or $outWanted.StartsWith($storeFull + [char]92, [StringComparison]::OrdinalIgnoreCase)) {
        throw "could not run: the output folder $outWanted is inside the store folder, which the probe removes at the end"
    }
    # From the holder's start at the slowest: the cold-start run, the settle
    # and idle seconds, every paced slot, up to a second for each
    # back-to-back run, the idle window after, and a minute to spare.
    $needSeconds = $ColdStartSeconds + $SettleSeconds + $IdleSeconds + $Paced / $PerSecond + $BackToBack + $IdleSeconds + 60
    if ($needSeconds -gt $HolderAwaySeconds) {
        throw "could not run: step 2 could end $([math]::Ceiling($needSeconds)) seconds after the holder starts, later than the holder's $HolderAwaySeconds-second away clock; use fewer runs or a higher -PerSecond"
    }
    if ($Launcher -eq 'observe') {
        if (-not $Claude) { throw 'could not run: -Launcher observe needs -Claude; or name the launcher with -Launcher and the result says "documented, not observed"' }
        if (-not (Test-Path -LiteralPath $Claude -PathType Leaf)) { throw "could not run: no claude.exe at $Claude" }
        $claudeFull = (Resolve-Path -LiteralPath $Claude).ProviderPath
    }
    # The helper, store and temporary paths go into the launcher's command
    # line inside double quotes, where Git Bash expands $ and ` and cmd reads
    # % ^ & | < >. A path holding one would be changed on the way, and the
    # runs would then fail for that, not for what they cost: refused here.
    $shellChars = [char[]]@('"', '$', '`', '%', '^', '&', '|', '<', '>')
    foreach ($named in @(@('the helper', $helperFull), @('the store', $storeFull), @('the temporary folder', [IO.Path]::GetTempPath()))) {
        if (([string]$named[1]).IndexOfAny($shellChars) -ge 0) {
            throw ('could not run: the path of ' + $named[0] + ' holds a character the launcher''s shell would change (one of " $ ` % ^ & | < >); use a path without them')
        }
    }
    # P16 measures the signed per-user copy of the installed app's helper:
    # in the app's per-user helper folder, in a folder named for this file,
    # validly signed, the same file the installed app bundles, and signed by
    # the app's own signer.
    $perUserRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AI Code Conductor\helper')).TrimEnd([char]92)
    $folderFull = Split-Path -Parent $helperFull
    $folder = Split-Path -Leaf $folderFull
    if (-not ((Split-Path -Parent $folderFull) -ieq $perUserRoot)) {
        throw "could not run: the helper is not in the app's per-user helper folder ($perUserRoot\<version>-<12 hex>); P16 measures the signed per-user copy"
    }
    $hash = (Get-FileHash -LiteralPath $helperFull -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $folder.ToLowerInvariant().EndsWith('-' + $hash.Substring(0, 12))) {
        throw "could not run: the helper's folder $folder does not name this file (the app names each copy <version>-<first 12 hex of its sha256>)"
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $helperFull
    if ($sig.Status -ne 'Valid') { throw "could not run: the helper's signature is $($sig.Status), not Valid; P16 measures the signed per-user copy" }
    $thumb = [string]$sig.SignerCertificate.Thumbprint
    $app = Find-InstalledApp $hash $thumb
    if (-not $app) { throw 'could not run: no installed AI Code Conductor bundles this helper (resources\helper\aicc-helper.exe of each installed copy has another sha256); P16 measures the per-user copy of the installed app''s helper' }
    if (-not $app.signerIsTheApps) { throw 'could not run: the installed app''s own program is not validly signed by the helper''s signer' }
    if ($HttpPosts -gt 0) {
        $nodeCmd = @(Get-Command $Node -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
        if (-not $nodeCmd) { throw "could not run: no node program '$Node' for the step 3 reference; give -Node, or -HttpPosts 0 to leave the reference out" }
        $nodeExe = $nodeCmd.Source
    }
    if (Test-Path -LiteralPath $storeFull) { throw "could not run: the store folder $storeFull already exists; give a folder that does not" }
    $storeParent = Split-Path -Parent $storeFull
    if (-not $storeParent -or -not (Test-Path -LiteralPath $storeParent -PathType Container)) {
        throw "could not run: the store folder's parent $storeParent does not exist; the probe makes only the store itself"
    }
    # Reserve the store before anything else is made or started: only a
    # folder this run made is ever removed at the end.
    if (-not [P16Runner]::Reserve($storeFull)) { throw "could not run: the store folder $storeFull already exists; give a folder that does not" }
    $storeMade = $true
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
    $result.helper = [ordered]@{
        folder = $folder
        inThePerUserFolder = $true
        folderNamesThisFile = $true
        version = ((& $helperFull version) -join ' ').Trim()
        sha256 = $hash
        signature = [string]$sig.Status
        signerThumbprint = $thumb
        installedApp = $app
    }
    $probeHost = (Get-Process -Id $PID).Path
    $result.probeProgram = Hide-Personal $probeHost
    [P16Runner]::CycleRate = [P16Runner]::CyclesPerMs()
    if ([P16Runner]::CycleRate -le 0) { throw 'could not run: no CPU cycle count on this machine' }
    $result.machine.cpuCyclesPerMs = [math]::Round([P16Runner]::CycleRate, 0)
    $result.machine.cpuCyclesPerMsLoops = @([P16Runner]::LoopRates | ForEach-Object { [math]::Round($_, 0) })
    $result.defenderBefore = Get-Defender
    $result.passLine = [ordered]@{ p95WallMs = $PassP95Ms; maxWallMs = $PassMaxMs; meanCpuMs = $PassMeanCpuMs; failedRuns = $PassFailedRuns; defenderRealTime = 'on'; cpuCounted = 'the chain''s own processes' }
    $result.schedule = [ordered]@{ paced = $Paced; perSecond = $PerSecond; backToBack = $BackToBack; thePlans = ($Paced -eq $PlanPaced -and $PerSecond -eq $PlanPerSecond -and $BackToBack -eq $PlanBackToBack) }
    Write-Host "P16: helper $($result.helper.version) ($($result.helper.folder)), signature $($result.helper.signature), bundled by the installed app $($app.version)"
    Write-Host "P16: Defender real-time protection $($result.defenderBefore.realTimeProtection)"

    # --- Step 0: how Claude Code starts a command hook -----------------------
    $step0 = [ordered]@{ how = 'documented, not observed' }
    $prefix = $null
    $quoteStyle = $null
    $newConsole = $true
    $forward = $false
    if ($Launcher -eq 'observe') {
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
        $ver = Invoke-Fresh $claudeFull @('--version') $claudeEnv $work 60000
        $step0.claudeVersion = $ver.Out.Trim()
        $line = (ConvertTo-Arg $claudeFull) + ' -p p16 --settings ' + (ConvertTo-Arg $settings)
        $r0 = [P16Runner]::Run($line, (ConvertTo-EnvBlock $claudeEnv), $work, $false, $null, 90000, $chainOut)
        $step0.claudeStoppedAfterHook = $r0.StoppedEarly
        if (Test-Path -LiteralPath $chainOut) {
            $seen = Get-Content -LiteralPath $chainOut -Raw | ConvertFrom-Json
            $chain = @($seen.chain)
            $step0.chain = @($chain | ForEach-Object { [ordered]@{ pid = $_.pid; ppid = $_.ppid; name = $_.name; cmd = (Hide-Personal ([string]$_.cmd)) } })
            $step0.children = @($seen.children | ForEach-Object { [ordered]@{ pid = $_.pid; ppid = $_.ppid; name = $_.name } })
            $step0.hookStdinBytes = $seen.stdinBytes
            if ($chain.Count -ge 2 -and $chain[$chain.Count - 1].name -ieq 'claude.exe') {
                $top = $chain[$chain.Count - 2]
                $topCmd = [string]$top.cmd
                $step0.launcherProgram = $top.name
                $step0.launcherCommandLine = Hide-Personal $topCmd
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

    $standIn = New-StandIn $helperFull
    $result.standInCommandLine = Hide-Personal $standIn
    $hookStdin = '{"session_id":"' + $sid + '","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo p16"},"cwd":"C:/work"}'
    $mpPid = 0
    $mp = Get-Process -Name MsMpEng -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($mp) { $mpPid = $mp.Id }

    # Reference only: the first start of a fresh copy of the helper, in a new
    # folder, with Defender's CPU from just before the copy was written.
    $coldDir = Join-Path $tempRoot 'cold'
    New-Item -ItemType Directory -Path $coldDir | Out-Null
    $coldHelper = Join-Path $coldDir 'aicc-helper.exe'
    $mpCold0 = $(if ($mpPid) { [P16Runner]::ProcessCpuMs($mpPid) } else { -1 })
    Copy-Item -LiteralPath $helperFull -Destination $coldHelper
    $rc = [P16Runner]::Run((New-StandIn $coldHelper), $freshBlock, $work, $newConsole, $hookStdin, $RunTimeoutMs, $null)
    $mpCold1 = $(if ($mpPid) { [P16Runner]::ProcessCpuMs($mpPid) } else { -1 })
    $result.coldStart = [ordered]@{
        note = 'reference only, not in the verdict: the first start of a fresh copy of the same signed file in a new folder (Defender had seen these bytes at the per-user path; a first start of bytes it has never seen was not measured)'
        wallMs = [math]::Round($rc.WallMs, 2)
        cpuMs = [math]::Round($rc.CpuMs, 2)
        processes = $rc.Processes
        withoutACpuCount = $rc.Missed
        exit = $rc.ExitCode
        listed = (Test-Listed $rc.Output)
        defenderMsFromCopyToEnd = $(if ($mpCold0 -ge 0 -and $mpCold1 -ge 0) { [math]::Round($mpCold1 - $mpCold0, 2) } else { 'not readable' })
    }
    Write-Host "P16 step 1, cold-start reference: $($result.coldStart.wallMs) ms wall, exit $($rc.ExitCode)"

    # --- Step 2: the stand-in, behind the launcher ----------------------------
    # CPU outside the chain is read at four moments: after a settle, after
    # the idle seconds before step 2, after step 2, and after the idle seconds
    # after it.
    $sampleClock = [Diagnostics.Stopwatch]::StartNew()
    function Get-Sample {
        return [pscustomobject]@{
            t = $sampleClock.Elapsed.TotalMilliseconds
            idleCycles = [P16Runner]::IdleCycles()
            busyMs = [P16Runner]::SystemBusyMs()
            defender = $(if ($mpPid) { [P16Runner]::ProcessCpuMs($mpPid) } else { -1 })
            holder = [P16Runner]::ProcessCpuMs($holderPid)
            probe = [P16Runner]::ProcessCpuMs($PID)
        }
    }
    Start-Sleep -Seconds $SettleSeconds
    $s0 = Get-Sample
    Start-Sleep -Seconds $IdleSeconds
    $s1 = Get-Sample

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
        $listed = Test-Listed $r.Output
        $why = @()
        if ($r.TimedOut) { $why += 'timed out' }
        if ($r.ExitCode -ne 0) { $why += "exit $($r.ExitCode)" }
        if (-not $listed) { $why += 'holder not listed as live' }
        if ($r.Missed -gt 0) { $why += "$($r.Missed) process(es) without a CPU count" }
        $ok = $why.Count -eq 0
        $rows.Add([pscustomobject]@{
            run = $n; phase = $phase; at = $at; wall = $r.WallMs; topExit = $r.TopExitMs; cpu = $r.CpuMs; tick = $r.CpuTickMs; creator = $r.CreatorMs; procs = $r.Processes
            exit = $r.ExitCode; ok = $ok; poll = $r.ZeroByPoll; missed = $r.Missed; chain = $r.Chain
            note = $(if ($ok) { '' } else { (Hide-Personal (($why -join '; ') + ': ' + $r.Output.Trim())) -replace '[\r\n,]+', ' ' })
        })
        if (-not $ok) { Write-Host "P16 step 2: run $n failed: $($why -join '; '); output: $(Hide-Personal $r.Output.Trim())" }
    }
    $s2 = Get-Sample
    Start-Sleep -Seconds $IdleSeconds
    $s3 = Get-Sample
    $samples = @($s0, $s1, $s2, $s3)
    $times = [double[]]@($samples | ForEach-Object { $_.t })
    $creators = [double[]]@($rows | ForEach-Object { $_.creator })
    $result.outsideTheChain = [ordered]@{
        note = 'CPU spent outside the chain during step 2, per event, beside the verdict and not in it'
        creatorMeanMs = [math]::Round(($creators | Measure-Object -Average).Average, 2)
        holder = Get-NetPerEvent ([double[]]@($samples | ForEach-Object { $_.holder })) $times $rows.Count
        defender = Get-NetPerEvent ([double[]]@($samples | ForEach-Object { $_.defender })) $times $rows.Count
        probeItself = Get-NetPerEvent ([double[]]@($samples | ForEach-Object { $_.probe })) $times $rows.Count
        machineFromIdleCycles = Get-MachineNetPerEvent ([double[]]@($samples | ForEach-Object { $_.idleCycles })) $times $rows.Count
        machineFromSystemTimes = Get-NetPerEvent ([double[]]@($samples | ForEach-Object { $_.busyMs })) $times $rows.Count
        windowsSeconds = [ordered]@{
            settle = $SettleSeconds
            idleBefore = [math]::Round(($times[1] - $times[0]) / 1000, 1)
            stepTwo = [math]::Round(($times[2] - $times[1]) / 1000, 1)
            idleAfter = [math]::Round(($times[3] - $times[2]) / 1000, 1)
        }
    }
    if (-not $mpPid -or -not (Get-Process -Id $mpPid -ErrorAction SilentlyContinue)) { $result.outsideTheChain.defender = 'not readable' }

    $csv = New-Object Collections.Generic.List[string]
    $csv.Add('run,phase,start_ms,wall_ms,top_exit_ms,cpu_ms,cpu_tick_ms,creator_ms,procs,exit,ok,zero_by_poll,missed,chain_cpu_ms,note')
    foreach ($x in $rows) {
        $csv.Add(('{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13},{14}' -f $x.run, $x.phase, (Format-Num $x.at), (Format-Num $x.wall), (Format-Num $x.topExit), (Format-Num $x.cpu), (Format-Num $x.tick), (Format-Num $x.creator), $x.procs, $x.exit, [int]$x.ok, [int]$x.poll, $x.missed, $x.chain, $x.note))
    }
    [IO.File]::WriteAllLines((Join-Path $outFull 'p16-runs.csv'), $csv)

    # The holder is no longer needed; end it now so step 3 runs alone.
    $result.holderStoppedAfterStepTwo = Stop-ProbeHolder

    # Is Defender as shipped for everything measured? Checked against the
    # programs the chains really ran (so a folder exclusion over Git, or a
    # process exclusion by full path, is caught) and the probe's own program,
    # which opens the launcher's image to start it, as claude.exe does.
    $result.chainPrograms = @($chainPaths | Sort-Object | ForEach-Object { Hide-Personal $_ })
    $result.defenderExcludesProbe = Test-Excluded @($helperFull, $storeFull) (@($helperFull, $probeHost) + @($chainPaths))
    Write-Host "P16: programs in the chains: $($result.chainPrograms -join '; '); with the probe's own: $($result.probeProgram); exclusion covering the probe: $($result.defenderExcludesProbe)"

    # --- The answer, from step 2 alone ----------------------------------------
    $result.defenderAfter = Get-Defender
    $walls = [double[]]@($rows | ForEach-Object { $_.wall })
    $cpus = [double[]]@($rows | ForEach-Object { $_.cpu })
    $ticks = [double[]]@($rows | ForEach-Object { $_.tick })
    $p95 = Get-P95 $walls
    $max = ($walls | Measure-Object -Maximum).Maximum
    $meanCycles = ($cpus | Measure-Object -Average).Average
    $meanTicks = ($ticks | Measure-Object -Average).Average
    # The pass line is judged on the larger of the two means.
    $meanCpu = [math]::Max($meanCycles, $meanTicks)
    $failed = @($rows | Where-Object { -not $_.ok }).Count
    $summary = [ordered]@{
        runs = $rows.Count
        failed = $failed
        p95WallMs = [math]::Round($p95, 2)
        maxWallMs = [math]::Round($max, 2)
        meanWallMs = [math]::Round(($walls | Measure-Object -Average).Average, 2)
        meanCpuMsFromCycles = [math]::Round($meanCycles, 2)
        meanCpuMsFromTicks = [math]::Round($meanTicks, 2)
        meanCpuMs = [math]::Round($meanCpu, 2)
        meanCreatorMs = $result.outsideTheChain.creatorMeanMs
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
    $why = @(Get-P16Reasons ([pscustomobject]@{
                realTimeBefore = $result.defenderBefore.realTimeProtection; realTimeAfter = $result.defenderAfter.realTimeProtection
                excluded = $result.defenderExcludesProbe; p95 = [double]$p95; max = [double]$max; meanCpu = [double]$meanCpu
                failed = $failed; runs = $rows.Count
            }))
    $measured = $(if ($why.Count -eq 0) { 'PASS' } else { 'FAIL - ' + ($why -join '; ') })
    if ($result.schedule.thePlans) {
        $result.verdict = $measured
        $exitCode = $(if ($why.Count -eq 0) { 0 } else { 1 })
    } else {
        $result.verdict = "CHECK RUN - not the plan's schedule ($Paced paced at $($PerSecond.ToString($Inv)) a second, then $BackToBack back to back; the plan's is $PlanPaced at $PlanPerSecond a second, then $PlanBackToBack), so not a P16 verdict; measured against the pass line: $measured"
        $exitCode = 3
    }

    # --- Step 3: reference, today's HTTP hook ---------------------------------
    # Reference only: a failure is recorded and leaves the verdict as it is.
    if ($HttpPosts -gt 0) {
        try {
            $js = Join-Path $tempRoot 'p16-http.js'
            [IO.File]::WriteAllText($js, $HttpReference)
            # Twice in a job on the same schedule: without sending, then with
            # the POSTs. The two node processes' CPU, from cycles, differs by
            # what the POSTs cost.
            $nodeBase = (ConvertTo-Arg $nodeExe) + ' ' + (ConvertTo-Arg $js) + ' client ' + $HttpPosts + ' ' + $PerSecond.ToString($Inv)
            $httpTimeout = [int](($HttpPosts / $PerSecond) * 1000 + 60000)
            $h0 = [P16Runner]::Run($nodeBase + ' idle', $freshBlock, $work, $false, $null, $httpTimeout, $null)
            $hr = [P16Runner]::Run($nodeBase + ' send', $freshBlock, $work, $false, $null, $httpTimeout, $null)
            if ($h0.ExitCode -ne 0 -or $hr.ExitCode -ne 0) { throw "the HTTP reference exited $($h0.ExitCode) and $($hr.ExitCode): $($hr.Output.Trim())" }
            # The CPU per POST is a difference of two sums, so each must count
            # both node processes (the client and its server), as step 2's
            # runs must count every process.
            if ($h0.Processes -ne 2 -or $hr.Processes -ne 2 -or $h0.Missed -gt 0 -or $hr.Missed -gt 0) {
                throw "the HTTP reference's runs held $($h0.Processes) and $($hr.Processes) processes, $($h0.Missed) and $($hr.Missed) of them without a CPU count, not 2 and 2 with none missed, so its CPU per POST would be wrong"
            }
            $lines = @($hr.Output -split "`r?`n" | Where-Object { $_ -match '^\d+,' })
            $postRows = @($lines | ForEach-Object { $f = $_ -split ','; [pscustomobject]@{ wall = [double]::Parse($f[1], $Inv); status = [int]$f[2] } })
            if ($postRows.Count -eq 0) { throw "the HTTP reference printed no POSTs: $($hr.Output.Trim())" }
            [IO.File]::WriteAllLines((Join-Path $outFull 'p16-http.csv'), [string[]](@('post,wall_ms,status') + $lines))
            $pw = [double[]]@($postRows | ForEach-Object { $_.wall })
            $result.httpReference = [ordered]@{
                takenAs = 'a new connection for each POST, the token header checked and the body parsed, as the hooks gateway does; not what the gateway then does with the event'
                posts = $postRows.Count
                failed = @($postRows | Where-Object { $_.status -ne 200 }).Count
                p95WallMs = [math]::Round((Get-P95 $pw), 2)
                maxWallMs = [math]::Round(($pw | Measure-Object -Maximum).Maximum, 2)
                meanWallMs = [math]::Round(($pw | Measure-Object -Average).Average, 2)
                baselineRun = [ordered]@{ wallMs = [math]::Round($h0.WallMs, 0); cpuMsFromCycles = [math]::Round($h0.CpuMs, 2); processes = $h0.Processes; withoutACpuCount = $h0.Missed }
                postsRun = [ordered]@{ wallMs = [math]::Round($hr.WallMs, 0); cpuMsFromCycles = [math]::Round($hr.CpuMs, 2); processes = $hr.Processes; withoutACpuCount = $hr.Missed }
                cpuMsPerPostFromCycles = [math]::Round(($hr.CpuMs - $h0.CpuMs) / $postRows.Count, 3)
            }
        } catch {
            $result.httpReference = [ordered]@{ error = (Hide-Personal $_.Exception.Message) }
            Write-Host "P16 step 3 (reference only) did not complete: $(Hide-Personal $_.Exception.Message)"
        }
    }
} catch {
    $result.error = Hide-Personal $_.Exception.Message
    $result.verdict = 'could not run'
    $exitCode = 2
} finally {
    # Nothing here may stop the rest: each step records what it could not do.
    $clean = [ordered]@{ storeMadeByThisRun = $storeMade }
    $incomplete = @()
    # End the holder (Stop-ProbeHolder checks it is this run's). Nothing was
    # launched in it, so nothing is left behind it.
    $clean.holder = Stop-ProbeHolder
    if ($clean.holder -match '^(not checked|not stopped|still running)') { $incomplete += "holder $($clean.holder)" }
    if ($holderPid -gt 0) { Start-Sleep -Milliseconds 300 }
    if ($storeMade) {
        if ([string]::IsNullOrWhiteSpace($storeFull)) {
            $clean.storeRemoved = $false
            $incomplete += 'store not removed: its path was empty'
        } else {
            try { if (Test-Path -LiteralPath $storeFull) { Remove-Item -LiteralPath $storeFull -Recurse -Force -ErrorAction Stop } } catch { }
            $clean.storeRemoved = -not (Test-Path -LiteralPath $storeFull)
            if (-not $clean.storeRemoved) { $incomplete += 'store not removed' }
        }
    }
    if ($tempRoot) {
        if (-not ((Split-Path -Leaf $tempRoot) -like 'p16-*')) {
            $clean.tempRemoved = $false
            $incomplete += 'temporary folder not removed: its path is not the probe''s'
        } else {
            try { if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop } } catch { }
            $clean.tempRemoved = -not (Test-Path -LiteralPath $tempRoot)
            if (-not $clean.tempRemoved) { $incomplete += 'temporary folder not removed' }
        }
    } else {
        $clean.tempRemoved = $true
    }
    # Nothing is started before the temporary folder is made.
    if ($tempRoot -or $storeMade) {
        try {
            $left = @(Get-ProbeLeftovers)
            $clean.processesLeft = $left
            if ($left.Count -gt 0) { $incomplete += "still running: $($left -join ', ')" }
        } catch {
            $clean.processesLeft = "not checked: $($_.Exception.Message)"
            $incomplete += "processes not checked ($($_.Exception.Message))"
        }
    } else {
        $clean.processesLeft = @()
    }
    $clean.complete = $incomplete.Count -eq 0
    if (-not $clean.complete) {
        $clean.incomplete = $incomplete -join '; '
        $exitCode = 2
    }
    $result.cleanUp = $clean
    $result.exitCode = $exitCode
    $result.finished = (Get-Date).ToUniversalTime().ToString('o')
    # Written only to an output folder that passed its checks.
    if ($outFull -and (Test-Path -LiteralPath $outFull)) {
        try { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outFull 'p16-result.json') -Encoding UTF8 } catch { Write-Host "P16: p16-result.json not written: $($_.Exception.Message)" }
    }
}

$result | ConvertTo-Json -Depth 8 | Write-Host
if ($result.verdict -eq 'could not run') {
    $last = 'P16 RESULT: COULD NOT RUN - ' + ([string]$result.error -replace '^could not run: ', '')
} else {
    $last = "P16 RESULT: $($result.verdict)"
}
if (-not $result.cleanUp.complete) { $last += "; clean-up incomplete: $($result.cleanUp.incomplete)" }
Write-Host $last
exit $exitCode
