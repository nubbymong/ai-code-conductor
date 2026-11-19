<#
.SYNOPSIS
Probe P18 (ADR-030): how do Claude Code and Codex start a tool server over
standard input and output on Windows, and is it gone when the CLI ends?

.DESCRIPTION
The helper's relay mode (aicc_planning #338) will be a program that a CLI
starts as a tool server: one JSON message per line on its standard input and
output. This probe registers a stand-in for it (p18-stand-in.cjs, beside this
script, run by a copy of this machine's own node.exe) with each CLI's own
command for adding a tool server, has the CLI start it, and records how.

Each CLI runs in a fresh environment: the system's own variables, with HOME,
USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR, CODEX_HOME and TEMP in
the probe's own temporary folder, so no real config is read or written. No
account is signed in and no API key is given. Claude Code's API address is a
closed local port. Codex's model provider is a stand-in on a local port that
refuses every request at once (on a closed port Codex waits for the network
and never ends). Every API address the probe sets is on this machine; other
traffic is not checked. Each CLI is attached to the probe's console, but its
own input and output are pipes, not a console as in the app's terminal.

For each CLI (Claude Code; Codex when one is installed):
1. Register the stand-in from a folder with no space in its path, with the
   CLI's own add command, and run the CLI's connection check -Runs times. The
   check is `claude mcp list` for Claude Code. Codex has no check of its own
   (`codex mcp list` only reads its config), so a `codex exec` run stands in
   for it: it starts its tool servers, its turn is refused, and it ends. The
   CLI ends by itself.
2. The same once with node.exe and the stand-in in a folder whose path has a
   space in it, as the helper's own folder has ("AI Code Conductor").
3. Once more from that folder with the stand-in holding its first request
   unanswered (and, for Codex, which does not wait for it, the model stand-in
   holding its model request, so Codex stays up). When the stand-in has read
   that request, the CLI's own process (the nearest process above the
   stand-in that is not a shell or a console host) is ended from outside with
   Stop-Process, after its name and start time are checked; nothing else is
   stopped.
After each end, the run's processes still running are listed at 2 s and 10 s.

Recorded for each CLI: whether the stand-in was started at all; whether it is
the CLI's direct child or goes through a shell; whether a console host was made
for it; how its input and output are connected; the time from its start, and
from the CLI's start, to its first answer; whether it ended itself at end of
input or was ended by another process; and whether it was gone after the CLI's
end. Which process started which is read from Win32_ProcessStartTrace and
Win32_ProcessStopTrace (an administrator session; without one the result says
so and relies on the process lists, and a console host it did not see is
recorded as not seen, not as absent) and a process list at each check. Times
never come from the trace, whose events arrive a second or more late: the
stand-in's start is its own first log line's time less node's uptime, so the
time before node's clock starts (process creation and load) is not counted;
its answers and its end are the times it logged.

Decision lines (the 2.1.3-beta.10 plan, section B1, written before measuring):
PASS for a CLI when the stand-in is started from a path with a space, answers
its first request within 5 s, and is gone within 10 s of the CLI's end in 3 of
3 runs. Read here as: in the run from the path with a space, and in each of
the 3 runs before it, the CLI starts the stand-in and ends by itself, the
stand-in answers its first request within 5 s of its own start, and no
stand-in is left 10 s after the CLI's end.
CANNOT MEASURE when no run started the stand-in and the CLI's words ask for a
sign-in; any other run that started nothing is FAIL, with the CLI's words. The
CLI's words are what each run printed, what its add command printed, and why a
run was not run; a sign-in is read from them with $SignInWords. Anything else
is FAIL, with its reasons. The end from outside (step 3) is recorded beside the
verdict, not in it. Only -Runs 3 can give PASS; any other count that meets the
line is a CHECK RUN.

It refuses to run when the temporary folder's path has a space (the runs from
a path with no space would then have one), when the stand-in is missing beside
it, or when the stand-in alone does not answer two requests and end at end of
input. It reads a process's output for at most 5 s after the process has
ended, so a process left behind that holds it open cannot hang the probe.

In a finally block it stops what it started and is still running: each process
it started itself, each process it saw in a run, and every process started since
it began that runs a program from its temporary folder or names that folder,
each only after its name and start time are checked. Then it removes its
temporary folder and lists anything of its own still running.

Writes p18-result.json and p18-messages.jsonl to -OutDir, with the temporary
folder, node, the CLIs and the user profile written as <temp>, <node>,
<claude>, <codex> and <home>. The last line is "P18 RESULT: Claude Code <...>;
Codex <...>" (or "P18 RESULT: COULD NOT RUN - <reason>"), each PASS, FAIL -
<reasons>, CANNOT MEASURE - <reason>, CHECK RUN or NOT RUN - <reason>, with
"; clean-up incomplete: <what>" added when something was left. Exit code 0
when no CLI failed and at least one passed, 1 any FAIL, 2 could not run or
clean-up incomplete, 3 otherwise.

.EXAMPLE
.\p18-windows-tool-server-start.ps1 -ClaudePath "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" -CodexPath "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" -OutDir C:\p18-out
(the two programs the 2026-11-19 run used: the claude.exe that npm's claude.cmd
runs, and the codex.exe of OpenAI's own installer, first on PATH there)
#>
[CmdletBinding()]
param(
    [string] $ClaudePath = '',
    [string] $CodexPath = '',
    [string] $NodePath = '',
    [ValidateRange(1, 10)] [int] $Runs = 3,
    [string] $OutDir = '.'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# The decision lines. Fixed before measuring; never moved after seeing numbers.
$PassFirstAnswerMs = 5000
$PassGoneMs = 10000
$PlanRuns = 3
# The plan keeps CANNOT MEASURE for a CLI that will not start a tool server
# without a sign-in. Words that ask for one (read case-insensitively, by -match):
$SignInWords = '\b(sign(ed|ing)?|log(ged|ging)?) ?in\b|authenticat|api[ _-]?key|credential|unauthori[sz]ed'

# Codex's model provider in this probe: a local server that refuses every
# request at once with HTTP 400. On a closed port Codex waits for the network
# and never ends; refused, its turn fails and it ends by itself. Codex does not
# wait for a held tool server before its turn, so for the end from outside the
# probe writes "hold" to this server's input, and it then leaves requests
# unanswered (Codex stays up) until "refuse". It prints its port and ends at
# end of input.
$ModelStandIn = @'
'use strict';
const http = require('http');
let hold = false;
const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (hold) return;
    res.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: { message: 'p18 probe: no model here', type: 'invalid_request_error', code: 'p18_probe' } }));
  });
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(srv.address().port + '\n'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (d.includes('hold')) hold = true; if (d.includes('refuse')) hold = false; });
process.stdin.on('end', () => process.exit(0));
'@

$ShellNames = @('cmd.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe')
$CliTimeoutMs = 90000
$HoldWaitMs = 30000
$Inv = [Globalization.CultureInfo]::InvariantCulture

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

# Personal paths written as placeholders, in both slash forms and JSON's
# doubled backslashes, so the result files can be posted as they are.
function Hide-Personal([string] $s) {
    if (-not $s) { return $s }
    $pairs = @(@($tempRoot, '<temp>'), @($nodeSource, '<node>'), @($claudeExe, '<claude>'), @($codexExe, '<codex>'), @($env:USERPROFILE, '<home>'))
    foreach ($p in $pairs) {
        $v = [string]$p[0]
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        foreach ($form in @($v, $v.Replace('\', '/'), $v.Replace('\', '\\'))) {
            $s = [regex]::Replace($s, [regex]::Escape($form), $p[1], [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    return $s
}

# A fresh environment: the system's own variables, and every per-user folder a
# CLI reads inside the probe's temporary folder.
function New-FreshEnv([hashtable] $extra) {
    $keep = 'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
        'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME'
    $envs = @{}
    foreach ($k in $keep) {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $envs[$k] = $v }
    }
    foreach ($pair in @(@('HOME', 'home'), @('USERPROFILE', 'home'), @('APPDATA', 'appdata'), @('LOCALAPPDATA', 'localappdata'),
            @('CLAUDE_CONFIG_DIR', 'claude'), @('CODEX_HOME', 'codex'), @('TEMP', 'tmp'), @('TMP', 'tmp'))) {
        $envs[$pair[0]] = Join-Path $tempRoot $pair[1]
    }
    if ($extra) { foreach ($k in $extra.Keys) { $envs[$k] = $extra[$k] } }
    return $envs
}

# Every process the probe starts (the CLIs, node, the stand-in's self-test and
# the model stand-in) runs in the probe's work folder with only the variables
# given, never with what the probe's own session holds.
function Set-FreshStart($psi, [hashtable] $envs) {
    $psi.WorkingDirectory = $work
    $psi.Environment.Clear()
    foreach ($k in $envs.Keys) { $psi.Environment[$k] = $envs[$k] }
}

# Start a program in a fresh environment, sharing the probe's console, with its
# input closed and its output read. Every process started is kept for clean-up.
function Start-Fresh([string] $exe, [string[]] $argList, [hashtable] $envs) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = (($argList | ForEach-Object { ConvertTo-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    Set-FreshStart $psi $envs
    $proc = [Diagnostics.Process]::Start($psi)
    # A .cmd runs as cmd.exe: the process's own name is the one checked later.
    $name = [IO.Path]::GetFileName($exe)
    try { $name = $proc.ProcessName + '.exe' } catch { }
    $start = $proc.StartTime.ToUniversalTime()
    [void]$startedProcs.Add([pscustomobject]@{ Proc = $proc; Name = $name; Start = $start })
    $proc.StandardInput.Close()
    return [pscustomobject]@{ Proc = $proc; Name = $name; Start = $start; Out = $proc.StandardOutput.ReadToEndAsync(); Err = $proc.StandardError.ReadToEndAsync() }
}

# The text a process wrote, waiting at most 5 s for its output to close: a
# process left behind that holds that output open must not hang the probe
# before its clean-up.
function Get-TaskText($task) {
    if ($task.Wait(5000)) { return [string]$task.Result }
    return '(output still open 5 s after the process ended)'
}

# Run a short command of a CLI (add, remove, version) and return its exit code and words.
function Invoke-Fresh([string] $exe, [string[]] $argList, [hashtable] $envs) {
    $r = Start-Fresh $exe $argList $envs
    if (-not $r.Proc.WaitForExit(60000)) {
        Stop-Checked $r.Proc.Id $r.Name $r.Start | Out-Null
        throw "$([IO.Path]::GetFileName($exe)) $($argList[0]) did not finish in 60 s"
    }
    return [pscustomobject]@{ Code = $r.Proc.ExitCode; Text = (Hide-Personal ((Get-TaskText $r.Out) + (Get-TaskText $r.Err))).Trim() }
}

# Stop one process, only when it still has the name and start time it was seen with.
function Stop-Checked([int] $procId, [string] $name, [datetime] $createdUtc) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return 'already ended' }
    $start = $null
    try { $start = $p.StartTime.ToUniversalTime() } catch { return 'not checked: its start time could not be read' }
    if (($p.ProcessName + '.exe') -ine $name -and $p.ProcessName -ine $name) { return "left alone: the id now names $($p.ProcessName)" }
    if ([math]::Abs(($start - $createdUtc).TotalSeconds) -gt 1) { return 'left alone: the id now names a newer process' }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { return "not stopped: $($_.Exception.Message)" }
    return 'stopped'
}

# Whether the process seen with this id and start time still runs. One whose
# start time cannot be read counts as running.
function Test-Alive([int] $procId, [datetime] $createdUtc) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    try { return ([math]::Abs(($p.StartTime.ToUniversalTime() - $createdUtc).TotalSeconds) -le 1) } catch { return $true }
}

function ConvertTo-Utc($v) {
    if ($v -is [datetime]) { return $v.ToUniversalTime() }
    return [datetime]::Parse([string]$v, $Inv, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
}

function Get-Prop($o, [string] $name) {
    if ($null -ne $o -and $o.PSObject.Properties[$name]) { return $o.$name }
    return $null
}

# The process trace, drained into $trace.
function Read-Trace {
    if (-not $traceOn) { return }
    foreach ($src in 'P18Start', 'P18Stop') {
        foreach ($ev in @(Get-Event -SourceIdentifier $src -ErrorAction SilentlyContinue)) {
            $n = $ev.SourceEventArgs.NewEvent
            [void]$trace.Add([pscustomobject]@{
                    kind = $(if ($src -eq 'P18Start') { 'start' } else { 'stop' })
                    procId = [int]$n.ProcessID; parentId = [int]$n.ParentProcessID; name = [string]$n.ProcessName
                    at = [datetime]::FromFileTimeUtc([long]$n.TIME_CREATED)
                    exitStatus = $(if ($src -eq 'P18Stop') { [long]$n.ExitStatus } else { $null })
                })
            Remove-Event -EventIdentifier $ev.EventIdentifier
        }
    }
}

function Get-Snapshot {
    return @(Get-CimInstance Win32_Process | ForEach-Object {
            [pscustomobject]@{
                procId = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; name = [string]$_.Name
                exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine
                at = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime() } else { [datetime]::MinValue })
            }
        })
}

# Every process started since $since, from the trace and a process list, by id.
function Get-Seen([datetime] $since, $snap) {
    Read-Trace
    $seen = @{}
    foreach ($r in @($trace | Where-Object { $_.kind -eq 'start' -and $_.at -ge $since })) { $seen[$r.procId] = $r }
    foreach ($r in @($snap | Where-Object { $_.at -ge $since })) { $seen[$r.procId] = $r }
    return $seen
}

# The run's processes: the seeds, and every process started since the run
# began whose parent is one of them.
function Get-RunIds([int[]] $seeds, $seen) {
    $known = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($s in $seeds) { if ($s -gt 0) { [void]$known.Add($s) } }
    do {
        $grew = $false
        foreach ($r in $seen.Values) { if (-not $known.Contains($r.procId) -and $known.Contains($r.parentId)) { [void]$known.Add($r.procId); $grew = $true } }
    } while ($grew)
    return , $known
}

# The run's processes still running, as "name id".
function Get-Left([int[]] $seeds, [datetime] $since) {
    $snap = Get-Snapshot
    $ids = Get-RunIds $seeds (Get-Seen $since $snap)
    return @($snap | Where-Object { $ids.Contains($_.procId) -and $_.at -ge $since.AddSeconds(-1) } | ForEach-Object { "$($_.name) $($_.procId)" })
}

function Read-StandInLog([string] $file) {
    $rows = @()
    if (Test-Path -LiteralPath $file) {
        foreach ($line in [IO.File]::ReadAllLines($file)) {
            if (-not $line.Trim()) { continue }
            try { $rows += ($line | ConvertFrom-Json) } catch { }
        }
    }
    return , $rows
}

# One start of a CLI: its connection check, ended by itself or from outside.
function Invoke-Run($cli, [string] $label, [string] $logFile, [bool] $fromOutside) {
    if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile }
    $row = [ordered]@{ run = $label; endedBy = ''; cliExitCode = $null }
    $since = [datetime]::UtcNow
    $r = Start-Fresh $cli.Exe $cli.Check $cli.Env
    $cliStart = $r.Start
    $rootId = $r.Proc.Id
    $held = $null
    $cliEnd = $null
    if ($fromOutside) {
        $deadline = [datetime]::UtcNow.AddMilliseconds($HoldWaitMs)
        while ([datetime]::UtcNow -lt $deadline -and -not $r.Proc.HasExited) {
            if ((Test-Path -LiteralPath $logFile) -and ([IO.File]::ReadAllText($logFile) -match '"event":"in"')) { break }
            Start-Sleep -Milliseconds 100
        }
        Start-Sleep -Milliseconds 1000
        $log0 = Read-StandInLog $logFile
        $st0 = @($log0 | Where-Object { $_.event -eq 'start' } | Select-Object -First 1)
        if ($r.Proc.HasExited) {
            $row.endedBy = 'itself, before it could be ended from outside'
        } elseif (-not $st0) {
            $row.endedBy = 'the probe: the stand-in was not started in 30 s'
        } else {
            # The live chain, from the stand-in up to the process the probe started.
            $snap = Get-Snapshot
            $byId = @{}
            foreach ($s in $snap) { $byId[$s.procId] = $s }
            $held = @()
            $cur = [int]$st0[0].ppid
            for ($i = 0; $i -lt 10 -and $byId.ContainsKey($cur); $i++) {
                $w = $byId[$cur]
                $held += [pscustomobject]@{ procId = $w.procId; name = $w.name; at = $w.at; cmd = (Hide-Personal $w.cmd) }
                if ($cur -eq $rootId) { break }
                $cur = $w.parentId
            }
            $target = @($held | Where-Object { $ShellNames -notcontains $_.name.ToLowerInvariant() } | Select-Object -First 1)
            if (-not $target) {
                $row.endedBy = 'the probe: no CLI process was found above the stand-in'
            } elseif ($target[0].at -lt $since.AddSeconds(-1)) {
                $row.endedBy = "the probe: $($target[0].name) above the stand-in started before this run, left alone"
            } else {
                $how = Stop-Checked $target[0].procId $target[0].name $target[0].at
                $cliEnd = [datetime]::UtcNow
                $row.endedBy = "Stop-Process on $($target[0].name) ($how)"
            }
            $row.chainWhileHeld = @($held | ForEach-Object { [ordered]@{ name = $_.name; commandLine = $_.cmd } })
        }
        if (-not $cliEnd -and -not $r.Proc.HasExited) {
            [void](Stop-Checked $rootId $r.Name $cliStart)
            $cliEnd = [datetime]::UtcNow
        }
        [void]$r.Proc.WaitForExit(10000)
    } elseif ($r.Proc.WaitForExit($CliTimeoutMs)) {
        $row.endedBy = 'itself'
    } else {
        $row.endedBy = "the probe, after $($CliTimeoutMs / 1000) s"
        [void](Stop-Checked $rootId $r.Name $cliStart)
        $cliEnd = [datetime]::UtcNow
        [void]$r.Proc.WaitForExit(10000)
    }
    if ($r.Proc.HasExited) {
        $row.cliExitCode = $r.Proc.ExitCode
        if (-not $cliEnd) { $cliEnd = $r.Proc.ExitTime.ToUniversalTime() }
    }
    if (-not $cliEnd) { $cliEnd = [datetime]::UtcNow }

    # What is left of the run at 2 s and 10 s after the CLI's end.
    $st = @((Read-StandInLog $logFile) | Where-Object { $_.event -eq 'start' } | Select-Object -First 1)
    $standInId = $(if ($st) { [int]$st[0].pid } else { 0 })
    $seeds = @($rootId, $standInId)
    $wait = ($cliEnd.AddSeconds(2) - [datetime]::UtcNow).TotalMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
    $row.leftAt2s = @(Get-Left $seeds $since)
    $wait = ($cliEnd.AddMilliseconds($PassGoneMs) - [datetime]::UtcNow).TotalMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
    $snap10 = Get-Snapshot
    $seen = Get-Seen $since $snap10
    $ids = Get-RunIds $seeds $seen
    $row.leftAt10s = @($snap10 | Where-Object { $ids.Contains($_.procId) -and $_.at -ge $since.AddSeconds(-1) } | ForEach-Object { "$($_.name) $($_.procId)" })
    # Every process of the run, by name and start time, for the clean-up.
    foreach ($id in $ids) { if ($seen.ContainsKey($id)) { [void]$runProcs.Add([pscustomobject]@{ procId = $id; name = $seen[$id].name; at = $seen[$id].at }) } }

    # The log is read again now: the stand-in writes its last line after the CLI's end.
    $log1 = Read-StandInLog $logFile
    $outText = Get-TaskText $r.Out
    $errText = Get-TaskText $r.Err
    $row.cliOutputClosed = $r.Out.IsCompleted -and $r.Err.IsCompleted
    $words = (Hide-Personal ($outText + "`n" + $errText))
    $row.cliSaid = @($words -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 8 | ForEach-Object { $s = $_.Trim(); if ($s.Length -gt 300) { $s.Substring(0, 300) } else { $s } })
    foreach ($line in $log1) { [void]$messages.Add((Hide-Personal (([pscustomobject]@{ cli = $cli.Name; run = $label; line = $line }) | ConvertTo-Json -Compress -Depth 6))) }

    $row.started = [bool]$st
    if (-not $st) { return $row }
    $s0 = $st[0]
    # Its start: its own start line's time less node's uptime; the time before
    # node's clock starts (process creation and load) is not counted. The
    # trace's times are never used: WMI delivers its events a second or more late.
    $created = (ConvertTo-Utc $s0.t).AddMilliseconds(-[double]$s0.up)

    # Its parents, up to the process the probe started.
    $chain = @()
    $cur = [int]$s0.ppid
    for ($i = 0; $i -lt 10; $i++) {
        $name = $(if ($seen.ContainsKey($cur)) { $seen[$cur].name } elseif ($cur -eq $rootId) { $r.Name } else { '(ended before it was seen)' })
        $chain += [pscustomobject]@{ procId = $cur; name = $name }
        if ($cur -eq $rootId -or -not $seen.ContainsKey($cur)) { break }
        $cur = $seen[$cur].parentId
    }
    $between = @()
    foreach ($c in $chain) { if ($ShellNames -contains $c.name.ToLowerInvariant()) { $between += $c } else { break } }
    $cliProc = @($chain | Where-Object { $ShellNames -notcontains $_.name.ToLowerInvariant() } | Select-Object -First 1)
    $row.parents = @($chain | ForEach-Object { $_.name })
    $row.startedBy = $(if ($cliProc) { $cliProc[0].name } else { '(not seen)' })
    $row.directChild = ($between.Count -eq 0) -and [bool]$cliProc -and ($chain[0].name -ne '(ended before it was seen)')
    $own = @($standInId) + @($between | ForEach-Object { $_.procId })
    # A console host that has ended is seen only by the process trace: with the
    # trace off, one not seen is recorded as not seen, never as absent.
    $madeForIt = [bool]@($seen.Values | Where-Object { $_.name -ieq 'conhost.exe' -and $own -contains $_.parentId }).Count
    $ofItsOwn = [bool]@($seen.Values | Where-Object { $_.name -ieq 'conhost.exe' -and $_.parentId -eq $rootId }).Count
    $row.consoleHostMadeForIt = $(if ($madeForIt -or $traceOn) { $madeForIt } else { 'not seen: process trace off' })
    $row.cliHasConsoleHostOfItsOwn = $(if ($ofItsOwn -or $traceOn) { $ofItsOwn } else { 'not seen: process trace off' })
    $row.input = $s0.stdin; $row.output = $s0.stdout; $row.errorOutput = $s0.stderr
    $row.workingFolder = Hide-Personal ([string]$s0.cwd)
    $row.arguments = @($s0.argv | ForEach-Object { Hide-Personal ([string]$_) })
    $row.environmentNames = @($s0.envNames)
    $row.messagesIn = @($log1 | Where-Object { $_.event -eq 'in' } | ForEach-Object { [string](Get-Prop $_ 'method') })
    $out1 = @($log1 | Where-Object { $_.event -eq 'out' } | Select-Object -First 1)
    $init = @($log1 | Where-Object { $_.event -eq 'out' -and (Get-Prop $_ 'method') -eq 'initialize' } | Select-Object -First 1)
    $row.firstAnswerTo = $(if ($out1) { [string](Get-Prop $out1[0] 'method') } else { $null })
    $row.firstAnswerMs = $(if ($out1) { [math]::Round(((ConvertTo-Utc $out1[0].t) - $created).TotalMilliseconds) } else { $null })
    $row.firstAnswerFromCliStartMs = $(if ($out1) { [math]::Round(((ConvertTo-Utc $out1[0].t) - $cliStart).TotalMilliseconds) } else { $null })
    $row.initializeAnsweredMs = $(if ($init) { [math]::Round(((ConvertTo-Utc $init[0].t) - $created).TotalMilliseconds) } else { $null })
    $last = @($log1 | Where-Object { @('end-of-input', 'signal', 'output-error') -contains $_.event } | Select-Object -First 1)
    $stop = @($trace | Where-Object { $_.kind -eq 'stop' -and $_.procId -eq $standInId } | Select-Object -Last 1)
    $row.standInEnded = $(if ($last) { $last[0].event } elseif ($row.leftAt10s -contains "node.exe $standInId") { 'still running' } else { 'ended by another process (no end of input seen)' })
    $row.standInEndedMsAfterCliEnd = $(if ($last) { [math]::Round(((ConvertTo-Utc $last[0].t) - $cliEnd).TotalMilliseconds) } else { $null })
    $row.standInExitStatus = $(if ($stop) { $stop[0].exitStatus } else { $null })
    $row.goneWithin10s = -not ($row.leftAt10s -contains "node.exe $standInId")
    return $row
}

function Get-Verdict($c) {
    if ($c.Contains('notRun')) { return "NOT RUN - $($c.notRun)" }
    $normal = @($c.runs | Where-Object { $_.run -ne 'from outside' })
    if (-not @($c.runs | Where-Object { $_.Contains('started') -and $_.started }).Count) {
        # The CLI's words: why a run was not run, what its add command said,
        # and what each run printed. The plan keeps CANNOT MEASURE for a CLI
        # that asks for a sign-in; any other reason is FAIL.
        $words = @(@(@($c.runs | Where-Object { $_.endedBy -like 'not run*' } | ForEach-Object { $_.endedBy }) +
                @($c.Keys | Where-Object { $_ -like 'registered: *' } | ForEach-Object { $c[$_].said }) +
                @($c.runs | ForEach-Object { $_['cliSaid'] })) | Where-Object { $_ } | Select-Object -Unique)
        $signIn = @($words | Where-Object { $_ -match $SignInWords })
        if ($signIn.Count) { return "CANNOT MEASURE - no run started the stand-in; the CLI asked for a sign-in: $(@($signIn | Select-Object -Last 3) -join ' | ')" }
        return "FAIL - no run started the stand-in, and the CLI asked for no sign-in; it said: $(@($words | Select-Object -Last 3) -join ' | ')"
    }
    $reasons = @()
    if (-not @($normal | Where-Object { $_.run -like 'path with a space*' }).Count) { $reasons += 'the stand-in was not registered from a path with a space' }
    foreach ($n in $normal) {
        if ($n.endedBy -ne 'itself') { $reasons += "$($n.run): the CLI did not end by itself ($($n.endedBy))" }
        if (-not ($n.Contains('started') -and $n.started)) { $reasons += "$($n.run): not started"; continue }
        if ($null -eq $n.firstAnswerMs) { $reasons += "$($n.run): no answer" }
        elseif ($n.firstAnswerMs -gt $PassFirstAnswerMs) { $reasons += "$($n.run): first answer after $($n.firstAnswerMs) ms" }
        if (-not $n.goneWithin10s) { $reasons += "$($n.run): the stand-in was still running 10 s after the CLI's end" }
    }
    if ($reasons.Count) { return 'FAIL - ' + ($reasons -join '; ') }
    if ($Runs -ne $PlanRuns) { return "CHECK RUN - $Runs runs, not the plan's $PlanRuns" }
    return 'PASS'
}

$started = [datetime]::UtcNow
$tempRoot = ''
$work = ''
$nodeSource = ''
$claudeExe = ''
$codexExe = ''
$traceOn = $false
$trace = New-Object System.Collections.ArrayList
$messages = New-Object System.Collections.ArrayList
$startedProcs = New-Object System.Collections.ArrayList
$runProcs = New-Object System.Collections.ArrayList
$result = [ordered]@{ probe = 'P18'; at = $started.ToString('o') }
$verdicts = @()
$exitCode = 2
$failure = ''
$outFull = ''
$model = $null

# A CLI on PATH as a program or a .cmd launcher (never npm's .ps1, which a
# process cannot be started from).
function Find-Cli([string] $given, [string] $name) {
    if ($given) { return (Resolve-Path -LiteralPath $given).Path }
    $found = @(Get-Command "$name.exe", "$name.cmd" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($found) { return $found[0].Source }
    return ''
}

try {
    $outFull = (Resolve-Path -LiteralPath $OutDir).Path
    $standInSource = Join-Path $PSScriptRoot 'p18-stand-in.cjs'
    if (-not (Test-Path -LiteralPath $standInSource)) { throw "could not run: $standInSource is missing" }
    $nodeSource = $(if ($NodePath) { (Resolve-Path -LiteralPath $NodePath).Path } else { (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source })
    $claudeExe = Find-Cli $ClaudePath 'claude'
    $codexExe = Find-Cli $CodexPath 'codex'
    if (-not $claudeExe) { throw 'could not run: no Claude Code found (give -ClaudePath)' }

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('p18-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    if ($tempRoot.Contains(' ')) {
        $tempRoot = ''
        throw 'could not run: the temporary folder''s path has a space, so the runs from a path with no space would have one; set TEMP to a folder without a space for this run'
    }
    [void](New-Item -ItemType Directory -Path $tempRoot)
    foreach ($d in 'home', 'appdata', 'localappdata', 'claude', 'codex', 'tmp', 'work') { [void](New-Item -ItemType Directory -Path (Join-Path $tempRoot $d)) }
    $work = Join-Path $tempRoot 'work'
    $folders = [ordered]@{ plain = (Join-Path $tempRoot 'plain'); space = (Join-Path $tempRoot 'p18 with space') }
    foreach ($f in $folders.Values) {
        [void](New-Item -ItemType Directory -Path $f)
        Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $f 'node.exe')
        Copy-Item -LiteralPath $standInSource -Destination (Join-Path $f 'p18-stand-in.cjs')
    }

    try {
        Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier P18Start -ErrorAction Stop
        Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier P18Stop -ErrorAction Stop
        $traceOn = $true
        $result.processTrace = 'on'
    } catch {
        $result.processTrace = "off: $($_.Exception.Message)"
    }

    # The stand-in alone: two requests in, two answers out, ended at end of input.
    $selfLog = Join-Path $tempRoot 'self-test.jsonl'
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $folders.space 'node.exe'
    $psi.Arguments = (ConvertTo-Arg (Join-Path $folders.space 'p18-stand-in.cjs')) + ' ' + (ConvertTo-Arg $selfLog)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    Set-FreshStart $psi (New-FreshEnv $null)
    $self = [Diagnostics.Process]::Start($psi)
    [void]$startedProcs.Add([pscustomobject]@{ Proc = $self; Name = 'node.exe'; Start = $self.StartTime.ToUniversalTime() })
    $self.StandardInput.Write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' + "`n" + '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' + "`n")
    $self.StandardInput.Close()
    $selfOut = $self.StandardOutput.ReadToEndAsync()
    if (-not $self.WaitForExit(15000)) { throw 'could not run: the stand-in did not end at end of input' }
    $answers = @((Get-TaskText $selfOut) -split "`n" | Where-Object { $_.Trim() -like '{*' } | ForEach-Object { $_ | ConvertFrom-Json })
    if ($self.ExitCode -ne 0 -or $answers.Count -ne 2 -or $answers[0].id -ne 1 -or $answers[1].id -ne 2) { throw "could not run: the stand-in's self-test gave $($answers.Count) answers, exit $($self.ExitCode)" }
    $result.standInSelfTest = 'two answers, ended at end of input'
    $result.node = (Invoke-Fresh $nodeSource @('--version') (New-FreshEnv $null)).Text

    $closed = 'http://127.0.0.1:9'
    $clis = @()
    $clis += [pscustomobject]@{
        Name = 'Claude Code'; Exe = $claudeExe
        Env = (New-FreshEnv @{ ANTHROPIC_BASE_URL = $closed; DISABLE_AUTOUPDATER = '1'; DISABLE_TELEMETRY = '1'; DISABLE_ERROR_REPORTING = '1'; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1' })
        Add = @('mcp', 'add', '--scope', 'user', 'p18', '--'); Remove = @('mcp', 'remove', '--scope', 'user', 'p18')
        Check = @('mcp', 'list')
        Stored = { $j = Join-Path $tempRoot 'claude\.claude.json'; if (Test-Path -LiteralPath $j) { $o = Get-Content -LiteralPath $j -Raw | ConvertFrom-Json; ((Get-Prop (Get-Prop $o 'mcpServers') 'p18') | ConvertTo-Json -Compress -Depth 6) } else { '(no .claude.json)' } }
    }
    if ($codexExe) {
        # The model stand-in, and a provider that names it, so `codex exec`
        # fails its turn at once and needs no sign-in. Written before `codex mcp
        # add`, which keeps what the file already holds.
        $modelJs = Join-Path $tempRoot 'p18-model.cjs'
        [IO.File]::WriteAllText($modelJs, $ModelStandIn)
        $mpsi = New-Object Diagnostics.ProcessStartInfo
        $mpsi.FileName = Join-Path $folders.plain 'node.exe'
        $mpsi.Arguments = ConvertTo-Arg $modelJs
        $mpsi.UseShellExecute = $false
        $mpsi.RedirectStandardInput = $true
        $mpsi.RedirectStandardOutput = $true
        Set-FreshStart $mpsi (New-FreshEnv $null)
        $model = [Diagnostics.Process]::Start($mpsi)
        [void]$startedProcs.Add([pscustomobject]@{ Proc = $model; Name = 'node.exe'; Start = $model.StartTime.ToUniversalTime() })
        $portTask = $model.StandardOutput.ReadLineAsync()
        if (-not $portTask.Wait(15000)) { throw 'could not run: the model stand-in gave no port' }
        $modelUrl = "http://127.0.0.1:$([int]$portTask.Result.Trim())/v1"
        $toml = "model = `"p18-probe`"`nmodel_provider = `"p18probe`"`n`n[model_providers.p18probe]`nname = `"p18 probe`"`nbase_url = `"$modelUrl`"`nenv_key = `"P18_PROBE_KEY`"`nwire_api = `"responses`"`nrequest_max_retries = 0`nstream_max_retries = 0`n"
        [IO.File]::WriteAllText((Join-Path $tempRoot 'codex\config.toml'), $toml)
        $clis += [pscustomobject]@{
            Name = 'Codex'; Exe = $codexExe
            Env = (New-FreshEnv @{ P18_PROBE_KEY = 'p18-probe-placeholder-not-a-key' })
            Add = @('mcp', 'add', 'p18', '--'); Remove = @('mcp', 'remove', 'p18')
            Check = @('exec', '--skip-git-repo-check', 'p18 probe')
            Stored = { $t = Join-Path $tempRoot 'codex\config.toml'; if (Test-Path -LiteralPath $t) { (Get-Content -LiteralPath $t) -join "`n" } else { '(no config.toml)' } }
        }
    }

    $result.clis = @()
    foreach ($cli in $clis) {
        $c = [ordered]@{ name = $cli.Name }
        $v = Invoke-Fresh $cli.Exe @('--version') $cli.Env
        $c.version = $v.Text
        $c.runs = @()
        $phases = @(
            @{ folder = $folders.plain; extra = @(); labels = @(1..$Runs | ForEach-Object { "plain path $_" }); outside = $false },
            @{ folder = $folders.space; extra = @(); labels = @('path with a space'); outside = $false },
            @{ folder = $folders.space; extra = @('--hold'); labels = @('from outside'); outside = $true })
        $registered = $false
        foreach ($ph in $phases) {
            $logFile = Join-Path $ph.folder 'p18-log.jsonl'
            if ($registered) { [void](Invoke-Fresh $cli.Exe $cli.Remove $cli.Env) }
            $addArgs = @($cli.Add) + @((Join-Path $ph.folder 'node.exe'), (Join-Path $ph.folder 'p18-stand-in.cjs'), $logFile) + $ph.extra
            $add = Invoke-Fresh $cli.Exe $addArgs $cli.Env
            $registered = $true
            $c["registered: $($ph.labels[0])"] = [ordered]@{ exitCode = $add.Code; said = $add.Text; stored = (Hide-Personal ([string](& $cli.Stored))) }
            if ($add.Code -ne 0) { $c.runs += [ordered]@{ run = $ph.labels[0]; endedBy = "not run: the add command exited $($add.Code)" }; continue }
            $holdModel = $ph.outside -and $cli.Name -eq 'Codex' -and $model
            if ($holdModel) { $model.StandardInput.WriteLine('hold'); $model.StandardInput.Flush() }
            foreach ($label in $ph.labels) {
                Write-Host "P18 $($cli.Name): $label"
                $c.runs += (Invoke-Run $cli $label $logFile $ph.outside)
                $last = $c.runs[$c.runs.Count - 1]
                Write-Host ("P18 {0}: {1}: started {2}, first answer {3} ms, ended by {4}, left at 10 s: {5}" -f $cli.Name, $label, $last['started'], $last['firstAnswerMs'], $last['endedBy'], (@($last['leftAt10s']) -join ', '))
            }
            if ($holdModel) { $model.StandardInput.WriteLine('refuse'); $model.StandardInput.Flush() }
        }
        $c.verdict = Get-Verdict $c
        $result.clis += $c
        $verdicts += "$($cli.Name) $($c.verdict)"
    }
    if (-not $codexExe) {
        $c = [ordered]@{ name = 'Codex'; notRun = 'no Codex CLI on this machine' }
        $c.verdict = Get-Verdict $c
        $result.clis += $c
        $verdicts += "Codex $($c.verdict)"
    }
    $all = @($result.clis | ForEach-Object { $_.verdict })
    $exitCode = $(if (@($all | Where-Object { $_ -like 'FAIL*' }).Count) { 1 } elseif (@($all | Where-Object { $_ -eq 'PASS' }).Count) { 0 } else { 3 })
} catch {
    $failure = Hide-Personal $_.Exception.Message
    $exitCode = 2
} finally {
    # Stop what this probe started and is still running, each only after its
    # name and start time are checked.
    # Candidates: each process it started that still runs, each process seen
    # in a run, and any process that runs a program from its temporary folder
    # or names that folder, each by name and start time.
    $cleanup = @()
    if ($model -and -not $model.HasExited) { try { $model.StandardInput.Close(); [void]$model.WaitForExit(5000) } catch { } }
    try {
        $cands = New-Object System.Collections.ArrayList
        foreach ($sp in $startedProcs) { if (-not $sp.Proc.HasExited) { [void]$cands.Add([pscustomobject]@{ procId = $sp.Proc.Id; name = $sp.Name; at = $sp.Start }) } }
        foreach ($rp in $runProcs) { [void]$cands.Add($rp) }
        $ic = [StringComparison]::OrdinalIgnoreCase
        $namesTemp = { param($w) $tempRoot -and $w.procId -ne $PID -and $w.at -ge $started -and (($w.exe -and $w.exe.StartsWith($tempRoot + '\', $ic)) -or ($w.cmd -and $w.cmd.IndexOf($tempRoot, $ic) -ge 0)) }
        foreach ($w in @(Get-Snapshot | Where-Object { & $namesTemp $_ })) { [void]$cands.Add($w) }
        $done = @{}
        foreach ($cd in $cands) {
            $key = "$($cd.procId)/$($cd.at.Ticks)"
            if ($done.ContainsKey($key)) { continue }
            $done[$key] = $true
            $how = Stop-Checked $cd.procId $cd.name $cd.at
            if ($how -ne 'already ended') { $cleanup += "$($cd.name) $($cd.procId): $how" }
        }
        Start-Sleep -Seconds 2
        $left = @($cands | Where-Object { Test-Alive $_.procId $_.at } | ForEach-Object { "$($_.name) $($_.procId)" })
        $left += @(Get-Snapshot | Where-Object { & $namesTemp $_ } | ForEach-Object { "$($_.name) $($_.procId)" })
        $left = @($left | Sort-Object -Unique)
        if ($left.Count) { $result.cleanupIncomplete = "still running: $($left -join ', ')" }
    } catch {
        $result.cleanupIncomplete = "not checked: $($_.Exception.Message)"
    }
    if ($traceOn) {
        foreach ($src in 'P18Start', 'P18Stop') {
            Unregister-Event -SourceIdentifier $src -ErrorAction SilentlyContinue
            Get-Event -SourceIdentifier $src -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
        }
    }
    $result.stopped = $cleanup
    # Remove the temporary folder: only the one this run made.
    if ($tempRoot -and (Split-Path -Leaf $tempRoot) -like 'p18-*' -and $tempRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $tempRoot)) {
        for ($i = 0; $i -lt 3; $i++) {
            try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Seconds 2 }
        }
        if (Test-Path -LiteralPath $tempRoot) {
            $result.cleanupIncomplete = (@($result['cleanupIncomplete'], 'the temporary folder could not be removed') | Where-Object { $_ }) -join '; '
        }
    }
    if ($failure) { $result.couldNotRun = $failure }
    if ($result.Contains('cleanupIncomplete')) { $exitCode = 2 }
    try {
        if ($outFull) {
            $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outFull 'p18-result.json') -Encoding UTF8
            $messages | Set-Content -LiteralPath (Join-Path $outFull 'p18-messages.jsonl') -Encoding UTF8
        }
    } catch {
        Write-Host "P18: the result files could not be written: $($_.Exception.Message)"
    }
    $line = $(if ($failure) { "P18 RESULT: COULD NOT RUN - $failure" } else { 'P18 RESULT: ' + ($verdicts -join '; ') })
    if ($result.Contains('cleanupIncomplete')) { $line += "; clean-up incomplete: $($result.cleanupIncomplete)" }
    Write-Host $line
}
exit $exitCode
