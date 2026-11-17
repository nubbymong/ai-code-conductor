# Performance harness (scripts/perf, see README.md): sample the processes that matter on the Windows
# test VM every -IntervalSec seconds for -DurationSec seconds, as JSON lines appended to -Out.
#
# Read-only: it starts, stops and changes nothing (it only opens each sampled process to read its
# cycle count). Per process and tick: CPU (user and kernel time, 100 ns units, which Windows charges
# at the clock tick), the CPU cycle count (QueryProcessCycleTime, charged exactly), private bytes,
# working set, handles, threads and the cumulative read and write operation counts (Win32_Process),
# with the command line on a process's first tick only. The header holds the cycles per second of the
# cycle counter, measured here on a spinning thread, so the report can turn cycles into time.
# Each row is stamped at the middle of the query that read it (t), and its cycle count at the middle
# of the pass that read those (tc). The report (lib/aggregate.cjs) turns the cumulative figures into
# rates, and tells a reused pid apart by its start time. run-matrix.cjs starts it once per window.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sample-processes.ps1 -Out <file> [-IntervalSec 5] [-DurationSec 180] [-Tag <name>]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$IntervalSec = 5,
  [int]$DurationSec = 180,
  [string]$Tag = '',
  [string[]]$Names = @('AI Code Conductor.exe', 'aicc-helper.exe', 'conhost.exe', 'OpenConsole.exe', 'node.exe',
    'powershell.exe', 'pwsh.exe', 'cmd.exe', 'chrome.exe', 'MsMpEng.exe', 'WmiPrvSE.exe')
)
$ErrorActionPreference = 'Stop'
if ($IntervalSec -lt 1) { throw 'IntervalSec must be at least 1' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Emit([string[]]$lines) { [System.IO.File]::AppendAllText($Out, (($lines -join "`n") + "`n"), $utf8) }
function Ms([datetime]$d) { [DateTimeOffset]::new($d.ToUniversalTime()).ToUnixTimeMilliseconds() }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class CccPerfCycles {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryProcessCycleTime(IntPtr process, out ulong cycles);
  [DllImport("kernel32.dll")] static extern bool QueryThreadCycleTime(IntPtr thread, out ulong cycles);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  const uint QueryLimitedInformation = 0x1000;
  // The process's CPU cycles so far (every thread, user and kernel), or -1 when it cannot be opened.
  public static long Of(int pid) {
    IntPtr h = OpenProcess(QueryLimitedInformation, false, pid);
    if (h == IntPtr.Zero) return -1;
    try { ulong c; return QueryProcessCycleTime(h, out c) ? (long)c : -1; } finally { CloseHandle(h); }
  }
  // The counter's cycles per second: this thread spins for ms milliseconds, rounds times, and the
  // fastest round wins (a round the scheduler took the core from reads slower, never faster).
  public static double PerSecond(int rounds, int ms) {
    double best = 0;
    IntPtr t = GetCurrentThread();
    for (int i = 0; i < rounds; i++) {
      ulong c0, c1;
      Stopwatch sw = Stopwatch.StartNew();
      QueryThreadCycleTime(t, out c0);
      while (sw.ElapsedMilliseconds < ms) { }
      QueryThreadCycleTime(t, out c1);
      double s = sw.Elapsed.TotalSeconds;
      double r = (c1 - c0) / s;
      if (r > best) best = r;
    }
    return best;
  }
}
'@

$filter = ($Names | ForEach-Object { "Name='" + ($_ -replace "'", "''") + "'" }) -join ' OR '
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$mhz = $null
try { $mhz = [int](Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -Name '~MHz').'~MHz' } catch { $mhz = $null }
$cyclesPerSec = [CccPerfCycles]::PerSecond(5, 100)
Emit @((@{
  kind = 'header'; tag = $Tag; t = (Now); samplerPid = $PID; intervalSec = $IntervalSec; durationSec = $DurationSec
  logicalCpus = [int]$cs.NumberOfLogicalProcessors; memMb = [math]::Round($cs.TotalPhysicalMemory / 1MB)
  os = "$($os.Caption) $($os.BuildNumber)"; model = "$($cs.Model)"
  cyclesPerSec = [math]::Round($cyclesPerSec); mhz = $mhz
} | ConvertTo-Json -Compress))

$seen = @{}
$start = Now
$last = [math]::Floor($DurationSec / $IntervalSec)
for ($k = 0; $k -le $last; $k++) {
  $wait = ($start + $k * $IntervalSec * 1000) - (Now)
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  $q0 = Now
  $rows = @(Get-CimInstance Win32_Process -Filter $filter)
  $q1 = Now
  $cycles = @{}
  foreach ($p in $rows) { $cycles[[int]$p.ProcessId] = [CccPerfCycles]::Of([int]$p.ProcessId) }
  $c1 = Now
  # The counters were read somewhere inside the query: its middle is the best time for them.
  $t = [long][math]::Round(($q0 + $q1) / 2)
  $tc = [long][math]::Round(($q1 + $c1) / 2)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add((@{ kind = 'tick'; t = $t; k = $k; n = $rows.Count; queryMs = $q1 - $q0; cycleMs = $c1 - $q1 } | ConvertTo-Json -Compress))
  foreach ($p in $rows) {
    $created = if ($p.CreationDate) { Ms $p.CreationDate } else { 0 }
    $o = [ordered]@{
      kind = 'p'; t = $t; pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name; created = $created
      user = [uint64]$p.UserModeTime; kernel = [uint64]$p.KernelModeTime
      priv = [uint64]$p.PrivatePageCount; ws = [uint64]$p.WorkingSetSize
      handles = [int]$p.HandleCount; threads = [int]$p.ThreadCount
      rops = [uint64]$p.ReadOperationCount; wops = [uint64]$p.WriteOperationCount
    }
    $c = $cycles[[int]$p.ProcessId]
    if ($c -ge 0) { $o.cyc = $c; $o.tc = $tc }
    $key = "$($p.ProcessId)@$created"
    if (-not $seen.ContainsKey($key)) { $o.cmd = "$($p.CommandLine)"; $seen[$key] = $true }
    $lines.Add(($o | ConvertTo-Json -Compress))
  }
  Emit $lines.ToArray()
}
