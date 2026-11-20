import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Probe P18 (helper/probes/p18-windows-tool-server-start.ps1) cannot run in
 * CI: it needs a Windows machine, an administrator session and the real CLIs.
 * What is checked here, by reading the script's text, is three mistakes a
 * review found in it, each of which records a wrong answer:
 *  - a CLI that started no tool server was CANNOT MEASURE whatever the reason.
 *    The plan keeps that verdict for a CLI that asks for a sign-in; any other
 *    reason is FAIL, and the add command's own words count as the CLI's words.
 *  - two of the probe's own node processes ran in the probe's whole
 *    environment and current folder, not in a fresh environment.
 *  - with the process trace off, a console host the probe never saw was
 *    recorded as absent.
 *
 * Not checked here: what the probe measures (only a run on a real machine
 * does); sign-in wording other than the samples below; a process started by
 * another route than a ProcessStartInfo (Start-Process, `& <program>`), apart
 * from node's own version check; the second check option the probe had for
 * its second CLI (removed, since that check starts no tool server).
 */

const ROOT = resolve(__dirname, '../../..')
const script = readFileSync(resolve(ROOT, 'helper/probes/p18-windows-tool-server-start.ps1'), 'utf-8').replace(/\r\n/g, '\n')

/** One function's text, from its `function` line to its closing brace at column 0. */
function fnText(name: string): string {
  const start = script.indexOf(`\nfunction ${name}(`)
  if (start < 0) throw new Error(`function ${name} was not found`)
  const end = script.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`function ${name} has no closing brace at column 0`)
  return script.slice(start, end + 3)
}

/** The script's sign-in words, read as PowerShell's -match reads them (case-insensitive). */
function signInWords(): RegExp {
  const m = /^\$SignInWords = '([^']+)'$/m.exec(script)
  if (!m) throw new Error('$SignInWords was not found')
  return new RegExp(m[1], 'i')
}

describe('probe P18: a CLI that started no tool server', () => {
  it('is CANNOT MEASURE only when its words ask for a sign-in, and FAIL otherwise', () => {
    const verdict = fnText('Get-Verdict')
    const from = verdict.indexOf("if (-not @($c.runs | Where-Object { $_.Contains('started') -and $_.started }).Count) {")
    expect(from, 'the branch for no run started').toBeGreaterThan(0)
    const branch = verdict.slice(from, verdict.indexOf('\n    }\n', from))
    expect(branch).toContain('$SignInWords')
    const cannot = branch.split('\n').filter((l) => l.includes('"CANNOT MEASURE'))
    expect(cannot, 'one CANNOT MEASURE, behind the sign-in words').toHaveLength(1)
    expect(cannot[0].trim()).toMatch(/^if \(/)
    expect(branch).toMatch(/\n\s*return "FAIL - no run started the stand-in/)
    // CANNOT MEASURE is returned nowhere else in the verdict.
    expect(verdict.split('"CANNOT MEASURE').length - 1).toBe(1)
  })

  it("counts the add command's words and the reason a run was not run among the CLI's words", () => {
    const verdict = fnText('Get-Verdict')
    expect(verdict).toMatch(/\$c\.Keys \| Where-Object \{ \$_ -like 'registered: \*' \} \| ForEach-Object \{ \$c\[\$_\]\.said \}/)
    expect(verdict).toMatch(/\$_\.endedBy -like 'not run\*'/)
  })

  it('reads sign-in wording as a sign-in, and other failures as not', () => {
    const re = signInWords()
    for (const s of [
      'Not logged in - Please run /login',
      'Invalid API key - Please run /login',
      'Error: authentication required',
      'Please sign in to continue',
      'You are not signed in',
      'Login required',
      '401 Unauthorized',
      'No credentials were found',
      'Set the API_KEY variable first',
    ]) expect(re.test(s), s).toBe(true)
    for (const s of [
      'not run: the add command exited 1',
      "error: unexpected argument '--scope' found",
      'Added stdio MCP server p18 with command: <temp>\\plain\\node.exe <temp>\\plain\\p18-stand-in.cjs <temp>\\plain\\p18-log.jsonl to user config',
      'the probe: the stand-in was not started in 30 s',
      'p18: <temp>\\plain\\node.exe - Failed to connect',
      'the port assigned in its config',
      'a plugin was skipped',
      'p18 probe: no model here',
    ]) expect(re.test(s), s).toBe(false)
  })
})

describe("probe P18: the probe's own processes start in a fresh environment", () => {
  it('gives each ProcessStartInfo a fresh environment and the work folder before it starts', () => {
    const made = [...script.matchAll(/(\$\w+) = New-Object Diagnostics\.ProcessStartInfo\n/g)]
    // Start-Fresh (each CLI and node), the stand-in's self-test, the model stand-in.
    expect(made.length).toBeGreaterThanOrEqual(3)
    for (const m of made) {
      const v = m[1]
      const from = (m.index ?? 0) + m[0].length
      const startAt = script.indexOf(`[Diagnostics.Process]::Start(${v})`, from)
      expect(startAt, `${v} is started`).toBeGreaterThan(from)
      expect(script.slice(from, startAt), `${v} at offset ${m.index}`).toMatch(new RegExp(`\\n\\s*Set-FreshStart \\${v} `))
    }
  })

  it('clears what the probe inherited and sets the work folder', () => {
    const f = fnText('Set-FreshStart')
    expect(f).toMatch(/\$psi\.WorkingDirectory = \$work\n/)
    expect(f).toMatch(/\$psi\.Environment\.Clear\(\)\n/)
  })

  it('asks node its version through the fresh start, not by calling it directly', () => {
    expect(script).not.toMatch(/&\s*\$nodeSource\b/)
  })
})

describe('probe P18: a console host the probe could not see', () => {
  it('is recorded as absent only with the process trace on', () => {
    for (const field of ['consoleHostMadeForIt', 'cliHasConsoleHostOfItsOwn']) {
      const lines = script.split('\n').filter((l) => l.includes(`$row.${field} =`))
      expect(lines, field).toHaveLength(1)
      expect(lines[0], field).toMatch(/\$traceOn/)
      expect(lines[0], field).toContain("'not seen: process trace off'")
    }
  })
})
