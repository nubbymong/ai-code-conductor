// [CI] aicc_planning#368: real-CLI conformance for Claude Code, with no sign-in,
// against the version the CI job installs into its own prefix (ci.yml's
// `claude-conformance`: the app's floor, and the version a dispatch asked for).
//
// HOST QUARANTINE: this suite starts the REAL Claude Code CLI. It runs only in
// CI's `claude-conformance` job, which installs the CLI and sets
// CCC_CLAUDE_CONFORMANCE_BIN; without it every case is skipped. Never on the
// owner's workstation. Every run gets a fresh, empty CLAUDE_CONFIG_DIR of the
// job's making and an environment of its own (no variable of the caller's that
// names an account, a key or a Claude folder reaches it): nothing reads or writes
// a user's ~/.claude, no sign-in, no network request of ours is needed (--version
// and --help). The job holds no secrets. The CLI's output is captured in files of
// the run's own, never pipes (see `run`: a pipe cut Claude Code 2.1.278's --help
// short on macOS).
//
// What it checks (the checks themselves are in claude-conformance-lib.mjs, tried on
// help text by claude-conformance-lib.test.ts):
//   1. the install answers `claude --version` with the version asked for; the
//      app's own reader reads it; the app's managed-launch floor check accepts it;
//   2. `claude --help` lists every switch of the reviewer's command line: its
//      constant (CLAUDE_REVIEW_ARGS) and the two a chosen model and effort add
//      (--model, --effort; claudeReviewArgs, ADR-031), and --output-format
//      still offers json;
//   3. --permission-mode offers every mode the launch picker writes;
//   4. `claude auth --help` lists login, logout and status; `claude auth login
//      --help` lists one flag per sign-in method, and --email.
//
// CCC_CLAUDE_CONFORMANCE_PROVE_RED=1 (the dispatch input conformance_prove_red)
// adds to each expectation one that no CLI can meet, so the job goes red once,
// with each check named.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseClaudeVersion } from '../../src/main/sentinel/sentinel-version'
import { claudeReviewArgs } from '../../src/main/providers/claude/review'
import { CLAUDE_MIN_MANAGED_CLI_VERSION, claudeManagedCliCompatibility } from '../../src/main/providers/claude/managed-launch'
import { CLI_AUTH_METHODS } from '../../src/shared/account-web-session'
import { PERMISSION_MODES } from '../../src/renderer/lib/claude-cli-options'
import {
  expectedVersion, reviewerFlagProblems, choiceProblems, authProblems, withProveRed, declaredSwitches, linesNaming, flagListed, flagsOfArgs,
} from './claude-conformance-lib.mjs'

const BIN = process.env.CCC_CLAUDE_CONFORMANCE_BIN ?? ''
const LIVE = BIN.length > 0
const PROVE_RED = process.env.CCC_CLAUDE_CONFORMANCE_PROVE_RED === '1'
const CONFIG_DIR = process.env.CCC_CLAUDE_CONFORMANCE_CONFIG_DIR ?? ''
const RUN_MS = 60_000
const CASE_MS = 120_000

const want = expectedVersion(process.env.CCC_CLAUDE_CONFORMANCE_KIND, process.env.CCC_CLAUDE_CONFORMANCE_VERSION, { minimum: CLAUDE_MIN_MANAGED_CLI_VERSION })

// The same expectations the app holds, less the picker's `default` (it writes no
// flag for it), with one nobody can meet added when proving the job can go red.
// The reviewer's flags with a model and an effort chosen: the constant's, then
// --model and --effort (nubbymong/aicc_planning#446).
const reviewArgs = claudeReviewArgs({ model: 'opus', effort: 'high' })
const base = {
  // A refusal here could only be a fault of this file: a flag no CLI lists makes it red.
  flags: Array.isArray(reviewArgs) ? reviewArgs : ['--ccc-review-args-refused'],
  modes: PERMISSION_MODES.map((m) => m.value).filter((v) => v !== 'default'),
  commands: ['login', 'logout', 'status'],
  methods: [...CLI_AUTH_METHODS],
  version: 'version' in want ? want.version : '',
}
const expectations = PROVE_RED ? withProveRed(base) : base

/** What the CLI gets of this process's environment: the paths and temp folders
 *  it needs to start, a Claude folder of its own, and nothing else. */
function probeEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']
  const env: Record<string, string> = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k] as string
  return { ...env, CLAUDE_CONFIG_DIR: CONFIG_DIR, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_COLOR: '1', TERM: 'dumb' }
}

const OUT_PREFIX = 'ccc-claude-conformance-out-'

/** One no-sign-in run of the real CLI: no shell, a constant argv. Its output goes to
 *  FILES of the run's own, not pipes: Claude Code 2.1.278 on macOS ends the process
 *  before a pipe is drained, and a long --help was cut short (231 of 303 lines, no
 *  --tools), while a file is written in full. The folder is removed after the run. */
function run(args: readonly string[]): { exit: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), OUT_PREFIX))
  const outFile = path.join(dir, 'stdout.txt')
  const errFile = path.join(dir, 'stderr.txt')
  const fdOut = fs.openSync(outFile, 'w')
  const fdErr = fs.openSync(errFile, 'w')
  try {
    const r = spawnSync(BIN, [...args], { stdio: ['ignore', fdOut, fdErr], timeout: RUN_MS, env: probeEnv(), windowsHide: true, shell: false })
    if (r.error) throw new Error(`could not run ${args.join(' ') || '(no arguments)'}: ${r.error.message}`)
    fs.closeSync(fdOut)
    fs.closeSync(fdErr)
    return { exit: r.status, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') }
  } finally {
    for (const fd of [fdOut, fdErr]) { try { fs.closeSync(fd) } catch { /* already closed */ } }
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith(OUT_PREFIX)) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* a leftover temp folder is harmless */ } }
  }
}

const maybe = LIVE ? describe : describe.skip

maybe('integration: the real Claude Code CLI, with no sign-in', () => {
  let help = ''
  let authHelp = ''
  let loginHelp = ''
  const printed: Record<string, { exit: number | null; stdout: string }> = {}

  beforeAll(() => {
    expect(CONFIG_DIR, 'the job did not give the CLI a folder of its own (CCC_CLAUDE_CONFORMANCE_CONFIG_DIR)').not.toBe('')
    expect('problem' in want ? want.problem : '', 'the leg was started with no usable version').toBe('')
    for (const [key, args] of [['version', ['--version']], ['help', ['--help']], ['auth', ['auth', '--help']], ['login', ['auth', 'login', '--help']]] as const) {
      printed[key] = run(args)
      console.log(`[claude-conformance] claude ${args.join(' ')}: exit ${printed[key].exit}, ${printed[key].stdout.split('\n').length} lines, ${Buffer.byteLength(printed[key].stdout)} bytes`)
    }
    help = printed.help.stdout
    authHelp = printed.auth.stdout
    loginHelp = printed.login.stdout
    console.log(`[claude-conformance] switches claude --help declares: ${declaredSwitches(help).join(' ')}`)
  }, CASE_MS)

  it('the install answers --version with the version asked for, which the app reads and accepts', () => {
    expect(printed.version.exit).toBe(0)
    const version = parseClaudeVersion(printed.version.stdout)
    console.log(`[claude-conformance] version ${version} (asked for ${'version' in want ? want.version : '?'}, kind ${'kind' in want ? want.kind : '?'})`)
    expect(version).toBe(expectations.version)
    expect(claudeManagedCliCompatibility(version).state).toBe('supported')
  }, CASE_MS)

  it('--help lists every switch of the reviewer\'s command line, and --output-format still offers json', () => {
    expect(printed.help.exit).toBe(0)
    const problems = reviewerFlagProblems(help, expectations.flags)
    // A red run says what the help did hold about each switch it could not find.
    for (const flag of flagsOfArgs(expectations.flags)) if (!flagListed(help, flag)) console.log(`[claude-conformance] ${flag} is not declared; the help lines that name it: ${JSON.stringify(linesNaming(help, flag.replace(/^-+/, '')))}`)
    expect(problems).toEqual([])
  }, CASE_MS)

  it('--permission-mode still offers every mode the launch picker writes', () => {
    expect(choiceProblems(help, '--permission-mode', expectations.modes)).toEqual([])
  }, CASE_MS)

  it('auth lists login, logout and status, and auth login lists one flag per sign-in method and --email', () => {
    expect(printed.auth.exit).toBe(0)
    expect(printed.login.exit).toBe(0)
    expect(authProblems(authHelp, loginHelp, expectations.methods, expectations.commands)).toEqual([])
  }, CASE_MS)
})
