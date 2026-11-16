# Performance harness (scripts/perf, see README.md): sample the processes that matter on the Windows
# test VM every -IntervalSec seconds for -DurationSec seconds, as JSON lines appended to -Out.
#
# Read-only: it starts, stops and changes nothing. Per process and tick: CPU (user and kernel time,
# 100 ns units), private bytes, working set, handles, threads and the cumulative read, write and other
# I/O operation counts (Win32_Process), with the command line on a process's first tick only. The
# report (lib/aggregate.cjs) turns the cumulative figures into rates, and tells a reused pid apart by
# its start time. run-matrix.cjs starts it once per measured window.
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

$filter = ($Names | ForEach-Object { "Name='" + ($_ -replace "'", "''") + "'" }) -join ' OR '
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
Emit @((@{
  kind = 'header'; tag = $Tag; t = (Now); samplerPid = $PID; intervalSec = $IntervalSec; durationSec = $DurationSec
  logicalCpus = [int]$cs.NumberOfLogicalProcessors; memMb = [math]::Round($cs.TotalPhysicalMemory / 1MB)
  os = "$($os.Caption) $($os.BuildNumber)"
} | ConvertTo-Json -Compress))

$seen = @{}
$start = Now
$last = [math]::Floor($DurationSec / $IntervalSec)
for ($k = 0; $k -le $last; $k++) {
  $wait = ($start + $k * $IntervalSec * 1000) - (Now)
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  $t = Now
  $rows = @(Get-CimInstance Win32_Process -Filter $filter)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add((@{ kind = 'tick'; t = $t; k = $k; n = $rows.Count; queryMs = (Now) - $t } | ConvertTo-Json -Compress))
  foreach ($p in $rows) {
    $created = if ($p.CreationDate) { Ms $p.CreationDate } else { 0 }
    $o = [ordered]@{
      kind = 'p'; t = $t; pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name; created = $created
      user = [uint64]$p.UserModeTime; kernel = [uint64]$p.KernelModeTime
      priv = [uint64]$p.PrivatePageCount; ws = [uint64]$p.WorkingSetSize
      handles = [int]$p.HandleCount; threads = [int]$p.ThreadCount
      rops = [uint64]$p.ReadOperationCount; wops = [uint64]$p.WriteOperationCount; oops = [uint64]$p.OtherOperationCount
    }
    $key = "$($p.ProcessId)@$created"
    if (-not $seen.ContainsKey($key)) { $o.cmd = "$($p.CommandLine)"; $seen[$key] = $true }
    $lines.Add(($o | ConvertTo-Json -Compress))
  }
  Emit $lines.ToArray()
}
