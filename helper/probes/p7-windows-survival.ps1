<#
.SYNOPSIS
  Probe P7: does a detached holder, and the terminal child it holds, survive the
  app quitting and the installer running over the app, on Windows?

.DESCRIPTION
  Decision it feeds: ADR-030 (probe table), and with it how beta 6 starts the
  helper holding local sessions. The helper is dormant today; this probe uses
  the skeleton's holder with the fake CLI as the held child, so no real CLI,
  no sign-in and no network are involved.

  Steps (each is reported):
    1. A stand-in "app" (a hidden PowerShell process) starts the holder with
       `aicc-helper hold --detach`, and stays running like the app does.
    2. The probe records the holder and the child (process id and start time),
       whether the holder is in a job object, and attaches once to see output.
    3. The stand-in "app" is quit the hard way: its whole process tree is
       killed (what a crash or an updater that ends the tree does).
       -> did the holder survive? did the child?
    4. The given installer runs silently over the app and the probe waits for it.
       -> did the holder survive? did the child?
    5. A new process attaches from the offset it last saw, types into the
       terminal and reads the answer; another attaches from offset 0.
       -> does re-attach replay, and does live input still reach the child?
    6. The holder is ended and the probe checks nothing is left running.

  It writes p7-result.json next to the session folder and prints one verdict
  line, "P7 RESULT: PASS" or "P7 RESULT: FAIL", with the reasons. Exit code 0
  on pass, 1 on fail, 2 when the probe could not run.

  Run it on the Windows test VM (never on the owner's own session), in the same
  kind of session the app is installed from (elevated for a per-machine
  install). It starts and stops only the processes it started itself.

.PARAMETER HelperDir
  Folder holding aicc-helper.exe and aicc-fake-cli.exe: the unpacked
  `helper-windows` artifact of the Helper (windows-2025) CI job.

.PARAMETER Installer
  The app installer to run silently over the installed app.

.PARAMETER InstallerArgs
  Arguments that make the installer silent. Default: /S (NSIS).

.PARAMETER PlaceUnder
  Optional folder to copy the two programs into and run them from. Pass a
  folder inside the app's install folder to see what the installer does to a
  holder that runs from there; leave empty to run from a folder of the probe's
  own.

.PARAMETER WorkDir
  Where the session folder and the result file go. Default: a new folder under
  the temp folder.

.PARAMETER InstallerTimeoutSec
  How long to wait for the installer to finish. Default 600.

.PARAMETER KeepHolder
  Leave the holder running at the end (for a second look); the default ends it.

.EXAMPLE
  .\p7-windows-survival.ps1 -HelperDir C:\p7\helper-windows -Installer C:\p7\AI-Code-Conductor-Setup.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$HelperDir,
  [Parameter(Mandatory = $true)][string]$Installer,
  [string[]]$InstallerArgs = @('/S'),
  [string]$PlaceUnder = '',
  [string]$WorkDir = '',
  [int]$InstallerTimeoutSec = 600,
  [switch]$KeepHolder
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host ('[P7] ' + $text) }

function Stop-Probe([string]$why) {
  Write-Host ('P7 RESULT: COULD NOT RUN - ' + $why)
  exit 2
}

if (-not (Test-Path -LiteralPath $HelperDir -PathType Container)) { Stop-Probe "HelperDir not found: $HelperDir" }
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { Stop-Probe "Installer not found: $Installer" }
$HelperDir = (Resolve-Path -LiteralPath $HelperDir).Path
$Installer = (Resolve-Path -LiteralPath $Installer).Path
foreach ($name in @('aicc-helper.exe', 'aicc-fake-cli.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $HelperDir $name) -PathType Leaf)) { Stop-Probe "$name is not in $HelperDir" }
}

if ($WorkDir -eq '') { $WorkDir = Join-Path $env:TEMP ('aicc-p7-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$SessionDir = Join-Path $WorkDir 'session'
$RunDir = $HelperDir
if ($PlaceUnder -ne '') {
  $RunDir = Join-Path $PlaceUnder 'aicc-p7'
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $HelperDir 'aicc-helper.exe') -Destination $RunDir -Force
  Copy-Item -LiteralPath (Join-Path $HelperDir 'aicc-fake-cli.exe') -Destination $RunDir -Force
}
$Helper = Join-Path $RunDir 'aicc-helper.exe'
$Fake = Join-Path $RunDir 'aicc-fake-cli.exe'
$Sid = 'p7-' + [guid]::NewGuid().ToString('N').Substring(0, 8)

# ---- small helpers ----------------------------------------------------------

Add-Type -Namespace P7 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool IsProcessInJob(System.IntPtr process, System.IntPtr job, out bool result);
'@

function Get-InJob([int]$procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $r = $false
    if ([P7.Native]::IsProcessInJob($p.Handle, [System.IntPtr]::Zero, [ref]$r)) { return $r }
    return $null
  } catch { return $null }
}

function Get-Identity([int]$procId) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }
  return [pscustomobject]@{ Pid = $procId; Start = $p.StartTime.ToUniversalTime().ToString('o') }
}

# True only when the same process (same id AND same start time) is still running.
function Test-Alive($identity) {
  if ($null -eq $identity) { return $false }
  $p = Get-Process -Id $identity.Pid -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $false }
  return ($p.StartTime.ToUniversalTime().ToString('o') -eq $identity.Start)
}

function Invoke-Helper([string[]]$helperArgs) {
  # Native stderr must not become a terminating error here: a failing helper
  # command is an answer (its exit code), not a crash of the probe.
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $Helper @helperArgs 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $saved
  }
  return [pscustomobject]@{ Code = $code; Text = $text }
}

function Read-AttachJson($ran) {
  try { return ($ran.Text.Trim() | ConvertFrom-Json) } catch { return $null }
}

$result = [ordered]@{
  probe = 'P7'
  started_utc = (Get-Date).ToUniversalTime().ToString('o')
  os = [System.Environment]::OSVersion.VersionString
  helper_dir = $RunDir
  session = $Sid
  installer = $Installer
  installer_args = ($InstallerArgs -join ' ')
}
$failures = New-Object System.Collections.Generic.List[string]
function Require([bool]$condition, [string]$reason) {
  if (-not $condition) { $failures.Add($reason); Write-Step ('FAIL: ' + $reason) }
}

$parent = $null
$holderId = $null
$childId = $null
try {
  # ---- 1. the stand-in app starts the holder --------------------------------
  Write-Step 'starting the stand-in app, which starts the detached holder'
  $parentCommand = "& '$Helper' hold --detach --dir '$SessionDir' --session $Sid -- '$Fake' | Out-File -Encoding ascii -FilePath '$WorkDir\parent-hold.txt'; Start-Sleep -Seconds 3600"
  $parent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $parentCommand) -WindowStyle Hidden -PassThru
  $parentId = Get-Identity $parent.Id
  $holderFile = Join-Path $SessionDir 'holder.json'
  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Path -LiteralPath $holderFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path -LiteralPath $holderFile)) { Stop-Probe 'the holder never wrote holder.json (see parent-hold.txt in the work folder)' }
  $info = Get-Content -LiteralPath $holderFile -Raw | ConvertFrom-Json
  $holderId = Get-Identity ([int]$info.holder_pid)
  $childId = Get-Identity ([int]$info.child_pid)
  Require ($null -ne $holderId) 'the holder is not running right after it started'
  Require ($null -ne $childId) 'the held child is not running right after it started'
  $result.holder_pid = [int]$info.holder_pid
  $result.child_pid = [int]$info.child_pid
  $result.holder_in_job = Get-InJob ([int]$info.holder_pid)
  $holderParent = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$info.holder_pid) -ErrorAction SilentlyContinue)
  $result.holder_parent_pid = if ($null -ne $holderParent) { [int]$holderParent.ParentProcessId } else { $null }
  Write-Step ("holder pid {0}, child pid {1}, holder in a job object: {2}" -f $info.holder_pid, $info.child_pid, $result.holder_in_job)

  # ---- 2. one attach before anything happens --------------------------------
  $first = Read-AttachJson (Invoke-Helper @('attach', '--dir', $SessionDir, '--from', '0', '--wait-ms', '2000'))
  $banner = ($null -ne $first) -and ((($first.replay + $first.live) -match 'FAKE-CLI READY'))
  Require $banner 'the first attach did not see the fake CLI banner'
  $seen = if ($null -ne $first) { [uint64]$first.ring_end } else { [uint64]0 }
  $result.offset_seen_before = $seen

  # ---- 3. the app quits, hard: its whole process tree is killed -------------
  Write-Step 'quitting the stand-in app (whole process tree)'
  & taskkill.exe /PID $parent.Id /T /F | Out-Null
  Start-Sleep -Seconds 3
  $result.parent_gone = -not (Test-Alive $parentId)
  $result.holder_alive_after_app_quit = Test-Alive $holderId
  $result.child_alive_after_app_quit = Test-Alive $childId
  Write-Step ("after the app quit: holder alive {0}, child alive {1}" -f $result.holder_alive_after_app_quit, $result.child_alive_after_app_quit)
  Require $result.holder_alive_after_app_quit 'the holder did not survive the app quitting'
  Require $result.child_alive_after_app_quit 'the held child did not survive the app quitting'

  # ---- 4. the installer runs silently over the app --------------------------
  Write-Step ("running the installer silently: {0} {1}" -f $Installer, ($InstallerArgs -join ' '))
  $installer = Start-Process -FilePath $Installer -ArgumentList $InstallerArgs -PassThru
  $finished = $installer.WaitForExit($InstallerTimeoutSec * 1000)
  $result.installer_finished = $finished
  $result.installer_exit_code = if ($finished) { $installer.ExitCode } else { $null }
  if (-not $finished) {
    try { $installer.Kill() } catch { }
    Require $false ("the installer did not finish within $InstallerTimeoutSec seconds")
  }
  Start-Sleep -Seconds 3
  $result.holder_alive_after_installer = Test-Alive $holderId
  $result.child_alive_after_installer = Test-Alive $childId
  Write-Step ("after the installer: exit code {0}, holder alive {1}, child alive {2}" -f $result.installer_exit_code, $result.holder_alive_after_installer, $result.child_alive_after_installer)
  Require ($finished -and ($installer.ExitCode -eq 0)) 'the installer did not finish with exit code 0 (the survival answer below is not about a clean install)'
  Require $result.holder_alive_after_installer 'the holder did not survive the installer'
  Require $result.child_alive_after_installer 'the held child did not survive the installer'
  $result.helper_file_still_there = (Test-Path -LiteralPath $Helper)

  # ---- 5. re-attach: live input, and replay ---------------------------------
  Write-Step 're-attaching from a new process'
  $second = Read-AttachJson (Invoke-Helper @('attach', '--dir', $SessionDir, '--from', "$seen", '--send', 'after-install', '--wait-ms', '8000'))
  $liveOk = ($null -ne $second) -and ($second.live -match 'echo: after-install')
  $result.reattach_live_input_ok = [bool]$liveOk
  Require $liveOk 'typing into the terminal after the installer got no answer from the child'
  $third = Read-AttachJson (Invoke-Helper @('attach', '--dir', $SessionDir, '--from', '0'))
  $replayOk = ($null -ne $third) -and ($third.replay -match 'FAKE-CLI READY') -and ($third.replay -match 'echo: after-install')
  $result.reattach_replay_ok = [bool]$replayOk
  Require $replayOk 're-attaching from offset 0 did not replay the output from before the app quit and the installer ran'
  Write-Step ("re-attach: live input ok {0}, replay ok {1}" -f $result.reattach_live_input_ok, $result.reattach_replay_ok)
}
catch {
  $failures.Add('the probe stopped on an error: ' + $_.Exception.Message)
  Write-Step ('ERROR: ' + $_.Exception.Message)
}
finally {
  # ---- 6. clean up only what the probe started ------------------------------
  if ($null -ne $parent) { try { & taskkill.exe /PID $parent.Id /T /F 2>&1 | Out-Null } catch { } }
  if (-not $KeepHolder -and (Test-Path -LiteralPath $SessionDir)) {
    try {
      $ended = Invoke-Helper @('end', '--dir', $SessionDir)
      $result.holder_ended_cleanly = ($ended.Code -eq 0)
    } catch { $result.holder_ended_cleanly = $false }
    Start-Sleep -Seconds 1
    foreach ($identity in @($holderId, $childId)) {
      if ($null -ne $identity -and (Test-Alive $identity)) {
        $failures.Add("a process the probe started is still running after end: $($identity.Pid)")
        try { Stop-Process -Id $identity.Pid -Force } catch { }
      }
    }
  }
}

$result.failures = @($failures)
$result.verdict = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL' }
$result.finished_utc = (Get-Date).ToUniversalTime().ToString('o')
$resultFile = Join-Path $WorkDir 'p7-result.json'
($result | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $resultFile -Encoding ascii
Write-Step ("result written to $resultFile")
if ($failures.Count -eq 0) {
  Write-Host 'P7 RESULT: PASS - holder and child survived the app quitting and the installer, and re-attach replays'
  exit 0
}
Write-Host ('P7 RESULT: FAIL - ' + ($failures -join '; '))
exit 1
