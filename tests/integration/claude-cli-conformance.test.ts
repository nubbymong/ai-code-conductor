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
// and --help). The job holds no secrets.
//
// What it checks (the checks themselves are in claude-conformance-lib.mjs, tried on
// help text by claude-conformance-lib.test.ts):
//   1. the install answers `claude --version` with the version asked for; the
//      app's own reader reads it; the app's managed-launch floor check accepts it;
//   2. `claude --help` lists every switch of the reviewer's constant command line
//      (CLAUDE_REVIEW_ARGS), and --output-format still offers json;
//   3. --permission-mode offers every mode the launch picker writes;
//   4. `claude auth --help` lists login, logout and status; `claude auth login
//      --help` lists one flag per sign-in method, and --email.
//
// CCC_CLAUDE_CONFORMANCE_PROVE_RED=1 (the dispatch input conformance_prove_red)
// adds to each expectation one that no CLI can meet, so the job goes red once,
// with each check named.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { parseClaudeVersion } from '../../src/main/sentinel/sentinel-version'
import { CLAUDE_REVIEW_ARGS } from '../../src/main/providers/claude/review'
import { CLAUDE_MIN_MANAGED_CLI_VERSION, claudeManagedCliCompatibility } from '../../src/main/providers/claude/managed-launch'
import { CLI_AUTH_METHODS } from '../../src/shared/account-web-session'
import { PERMISSION_MODES } from '../../src/renderer/lib/claude-cli-options'
import {
  expectedVersion, reviewerFlagProblems, choiceProblems, authProblems, withProveRed,
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
const base = {
  flags: CLAUDE_REVIEW_ARGS,
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

/** One no-sign-in run of the real CLI: no shell, a constant argv. */
function run(args: readonly string[]): { exit: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BIN, [...args], { encoding: 'utf8', timeout: RUN_MS, env: probeEnv(), windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 })
  if (r.error) throw new Error(`could not run ${args.join(' ') || '(no arguments)'}: ${r.error.message}`)
  return { exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
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
      console.log(`[claude-conformance] claude ${args.join(' ')}: exit ${printed[key].exit}, ${printed[key].stdout.split('\n').length} lines`)
    }
    help = printed.help.stdout
    authHelp = printed.auth.stdout
    loginHelp = printed.login.stdout
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
    expect(reviewerFlagProblems(help, expectations.flags)).toEqual([])
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
