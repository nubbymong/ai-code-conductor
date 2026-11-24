/**
 * aicc_planning#371 (2.1.3-beta.16, B1F): an app-launched Codex shows no
 * warning count of the app's making. Each `-c` key the app sets runs Codex
 * without its shared background server (embedded), and from 0.156.0 Codex,
 * while its automatic server start is on (the default from 0.157.0), then also
 * warns about that on its hint row, a row the app's screen reader refused
 * until 2.1.3-beta.17 C7, so nothing was typed into the tab. The launch
 * now carries `-c features.daemon_auto_start=false`
 * (src/main/providers/codex/spawn.ts, codexDaemonAutoStartOffArgs): Codex
 * runs embedded as before, without the warning. These cases read the argv on every route the builder has: direct,
 * the npm launcher's cmd.exe line, Ask Conductor's question on argv, an exact
 * resume, the resume list (picker), and a launch the session helper holds.
 *
 * No process is started. The exact-resume and picker cases make one folder
 * each in the run's temp folder and remove it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as { __dasResDir?: string }).__dasResDir ?? '',
  getDataDirectory: () => '',
}))
// The picker's node lookup on macOS and Linux, answered without starting anything.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => { cb(null, '/usr/local/bin/node\n', ''); return { stdin: { end: () => {} } } }) }
})
// The picker's node lookup on Windows: one fixed node.exe answers as a file.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: vi.fn((p: unknown, o?: unknown) => {
      if (p === 'C:\\ccc-test-only\\nodejs\\node.exe') return { isFile: () => true } as import('fs').Stats
      return (actual.statSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
  }
})
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as { __dasPort?: number }).__dasPort ?? 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/conductor-tools-switch', () => ({
  readConductorToolSwitches: () => ({ master: true, switches: {} }),
}))
vi.mock('../../../../src/main/config-manager', () => ({ readConfig: () => ({}), readConfigChecked: () => ({ outcome: 'absent', value: null }), getConfigDir: () => '/cfg' }))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { buildCodexSpawn, codexDaemonAutoStartOffArgs, CODEX_DAEMON_AUTO_START_OFF, warmNodeExeOnPosix } = await import('../../../../src/main/providers/codex/spawn')
const { codexHeldToolLaunch } = await import('../../../../src/main/providers/codex/held-tool-launch')
const { __markScriptFoldersCheckedForTests } = await import('../../../../src/main/script-folders')
await warmNodeExeOnPosix({ platform: 'linux' })

const KEY = 'features.daemon_auto_start=false'
const SID = 'abcdef0123456789abcdef60'
const linuxLaunch = { executable: '/mock/path/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }, sessionsDir: '/home/u/.codex/sessions' }
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\Users\\u\\.codex' }
const SHIM = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd'
const EXE = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe'
/** A launch with one app `-c` (its reasoning effort) and no tool server. */
const EFFORT = { model: 'gpt-5.5', reasoningEffort: 'high', permissionsPreset: 'standard' as const }
/** A launch with no app `-c` at all: no effort, no tool server, no hooks, not Ask. */
const PLAIN = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }

function withWin32<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
/** The value after each `-c` in a launch's arguments. */
const cValues = (args: readonly string[]): string[] => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))
/** Where the key's `-c` sits, after checking it is there exactly once. */
function keyAt(args: readonly string[]): number {
  expect(cValues(args).filter((v) => v === KEY)).toHaveLength(1)
  const at = args.indexOf(KEY) - 1
  expect(args[at]).toBe('-c')
  return at
}

beforeEach(() => { (globalThis as { __dasPort?: number }).__dasPort = 0 })
afterEach(() => { delete (globalThis as { __dasPort?: number }).__dasPort })

describe('which launches carry the key (codexDaemonAutoStartOffArgs)', () => {
  it('is the entry Codex reads as daemon_auto_start off', () => {
    expect(CODEX_DAEMON_AUTO_START_OFF).toBe(KEY)
  })

  it.each([
    ['its reasoning effort', 'model_reasoning_effort=high'],
    ['Ask Conductor\'s instruction-file bound', 'project_doc_max_bytes=65536'],
    ['Ask Conductor\'s root markers', 'project_root_markers=[]'],
    ['its tool server', 'mcp_servers.conductor.url=http://localhost:19333/mcp?cccSessionId=s'],
    ['its tool timeout', 'mcp_servers.conductor.tool_timeout_sec=1000.0'],
    ['a tool approval', 'mcp_servers.conductor.tools.canvas_snapshot.approval_mode=approve'],
    ['its hooks', 'hooks.SessionStart=[{hooks=[]}]'],
  ])('one app key that runs Codex embedded (%s) adds it', (_name, entry) => {
    expect(codexDaemonAutoStartOffArgs(['-m', 'gpt-5.5', '-c', entry, '--sandbox', 'read-only'], undefined)).toEqual(['-c', KEY])
  })

  it.each([
    ['no -c at all', ['-m', 'gpt-5.5', '--sandbox', 'read-only', '--ask-for-approval', 'on-request']],
    ['only the fullscreen transcript', ['-c', 'tui.fullscreen_transcript=true']],
    ['only the unstable-features notice', ['-c', 'suppress_unstable_features_warning=true']],
    ['only feature switches', ['-c', 'features.worktrees=true', '-c', 'features.daemon_auto_start=true']],
    ['the tui table', ['-c', 'tui={fullscreen_transcript=true}']],
  ])('a launch Codex may still run with its server (%s) gets nothing', (_name, flags) => {
    expect(codexDaemonAutoStartOffArgs(flags, undefined)).toEqual([])
  })

  it.each(['--strict-config', '--STRICT-CONFIG', '--strict\\-config', '--strict-config=true'])('the user\'s own %s leaves it off (0.153.4 to 0.155.1 refuse an unknown key under it)', (flag) => {
    expect(codexDaemonAutoStartOffArgs(['-c', 'model_reasoning_effort=high'], `--add-dir=/x ${flag}`)).toEqual([])
  })

  it('any other extra arguments keep it', () => {
    expect(codexDaemonAutoStartOffArgs(['-c', 'model_reasoning_effort=high'], '--add-dir=/x --search')).toEqual(['-c', KEY])
    expect(codexDaemonAutoStartOffArgs(['-c', 'model_reasoning_effort=high'], 42)).toEqual(['-c', KEY])
  })
})

describe('the direct route', () => {
  it('an app -c: the key once, after every app -c and before the user\'s arguments', () => {
    const out = buildCodexSpawn({ sessionId: SID, realmLaunch: linuxLaunch, codexOptions: { ...EFFORT, extraArgs: '--add-dir=/srv/shared --search' } })
    const at = keyAt(out.args)
    expect(out.args.lastIndexOf('-c')).toBe(at)
    expect(out.args.slice(at + 2)).toEqual(['--add-dir=/srv/shared', '--search'])
    expect(out.logLine).toContain(`-c ${KEY}`)
  })

  it('the tool server on: the key once, after its entries', () => {
    ;(globalThis as { __dasPort?: number }).__dasPort = 19333
    const out = buildCodexSpawn({ sessionId: SID, realmLaunch: linuxLaunch, codexOptions: PLAIN })
    const at = keyAt(out.args)
    expect(out.args.indexOf('mcp_servers.conductor.enabled=true')).toBeLessThan(at)
    expect(out.args.lastIndexOf('-c')).toBe(at)
  })

  it('no app -c: the launch is as before, with no key (Codex keeps whatever it does with its server)', () => {
    const out = buildCodexSpawn({ sessionId: SID, realmLaunch: linuxLaunch, codexOptions: PLAIN })
    expect(out.args).toEqual(['-m', 'gpt-5.5', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'])
  })

  it('the user\'s --strict-config: no key, and their arguments as given', () => {
    const out = buildCodexSpawn({ sessionId: SID, realmLaunch: linuxLaunch, codexOptions: { ...EFFORT, extraArgs: '--strict-config' } })
    expect(out.args).not.toContain(KEY)
    expect(out.args[out.args.length - 1]).toBe('--strict-config')
  })

  it('a Windows codex.exe started directly carries it the same way', () => {
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: SID, realmLaunch: { ...linuxLaunch, executable: EXE, env: winEnv }, codexOptions: EFFORT })
      expect(out.commandLine).toBeUndefined()
      keyAt(out.args)
    })
  })
})

describe('the npm launcher\'s cmd.exe line', () => {
  it('carries the key as plain words, before the user\'s arguments', () => {
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: SID, realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv }, codexOptions: { ...EFFORT, extraArgs: '--search' } })
      expect(out.args).toEqual([])
      expect(out.commandLine).toContain(`-c model_reasoning_effort=high --sandbox workspace-write --ask-for-approval on-request -c ${KEY} --search"`)
      expect(out.commandLine!.split(` -c ${KEY}`)).toHaveLength(2)
    })
  })
})

describe('Ask Conductor', () => {
  it('its question on argv: the key among the flags, before `--`', () => {
    const help = process.platform === 'win32' ? 'C:\\res\\help' : '/res/help'
    const out = buildCodexSpawn({ sessionId: SID, cwd: help, realmLaunch: linuxLaunch, codexOptions: PLAIN, askPrompt: 'how do I add an account?', askProjectDocMaxBytes: 65536 })
    expect(out.askPromptOnArgv).toBe(true)
    const at = keyAt(out.args)
    expect(out.args.slice(at + 2)).toEqual(['--', 'how do I add an account?'])
    expect(out.logLine).toContain(`-c ${KEY}`)
  })
})

describe('an exact resume and the resume list', () => {
  it('an exact resume: `resume <id>`, then the flags with the key once', () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-das-resume-')))
    try {
      const uuid = '019dd000-0001-7000-8000-0000000000b2'
      const at = new Date(Date.now() - 2 * 24 * 3600 * 1000)
      const day = path.join(home, 'sessions', String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
      fs.mkdirSync(day, { recursive: true })
      const cwd = fs.realpathSync.native(os.tmpdir())
      const meta = { timestamp: at.toISOString(), type: 'session_meta', payload: { id: uuid, cwd, cli_version: '0.157.1' } }
      fs.writeFileSync(path.join(day, `rollout-2026-11-21T10-00-00-${uuid}.jsonl`), JSON.stringify(meta) + '\n')
      const realm = { ...linuxLaunch, sessionsDir: path.join(home, 'sessions'), env: { ...linuxLaunch.env, CODEX_HOME: home } }
      const out = buildCodexSpawn({ sessionId: SID, realmLaunch: realm, cwd, codexOptions: EFFORT, resume: { uuid, cwd } })
      expect(out.resumeId).toBe(uuid)
      expect(out.args.slice(0, 2)).toEqual(['resume', uuid])
      expect(out.args.lastIndexOf('-c')).toBe(keyAt(out.args))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('the resume list: the picker gets the flags with the key once, and hands them on as they are', () => {
    const res = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-das-picker-')))
    let pickDir: string | null = null
    try {
      fs.mkdirSync(path.join(res, 'scripts'), { mode: 0o700 })
      const script = path.join(res, 'scripts', 'codex-resume-picker.js')
      fs.writeFileSync(script, '// staged for the test\n', { mode: 0o600 })
      __markScriptFoldersCheckedForTests(res)
      ;(globalThis as { __dasResDir?: string }).__dasResDir = res
      const pickerLaunch = { ...linuxLaunch, env: { ...linuxLaunch.env, PATH: process.platform === 'win32' ? 'C:\\ccc-test-only\\nodejs' : '/usr/bin' } }
      const out = buildCodexSpawn({ sessionId: SID, realmLaunch: pickerLaunch, codexOptions: EFFORT, useResumePicker: true })
      pickDir = out.pickFile ? path.dirname(out.pickFile) : null
      expect(out.args[0]).toBe(script)
      expect(out.args.lastIndexOf('-c')).toBe(keyAt(out.args))
    } finally {
      delete (globalThis as { __dasResDir?: string }).__dasResDir
      if (pickDir) {
        try { fs.rmSync(path.join(pickDir, 'pick.json'), { force: true }); fs.rmdirSync(pickDir) } catch { /* left for the OS */ }
      }
      fs.rmSync(res, { recursive: true, force: true })
    }
  })
})

describe('a launch the session helper holds (its tool server as the helper\'s relay)', () => {
  const RELAY = { helperPath: 'C:\\aicc\\helper\\0.1.0-0123456789ab\\aicc-helper.exe', store: 'C:\\aicc\\helper\\store', sid: 'ag0123456789abcdef0123456789abcd' }
  const POSIX_RELAY = { helperPath: '/home/u/.ai-code-conductor/helper/0.1.0-0123456789ab/aicc-helper', store: '/home/u/.ai-code-conductor/helper/store', sid: 'ag0123456789abcdef0123456789abcd' }

  it('an argument list: the relay in place of the loopback entries, and the key kept once, last of the app\'s -c', () => {
    ;(globalThis as { __dasPort?: number }).__dasPort = 19333
    const b = buildCodexSpawn({ sessionId: SID, realmLaunch: linuxLaunch, codexOptions: PLAIN })
    const answer = codexHeldToolLaunch(SID, { file: b.cmd, args: b.args, env: b.env }, POSIX_RELAY, 'linux') as { args: string[] }
    expect(Array.isArray(answer.args)).toBe(true)
    expect(answer.args.some((a) => a.startsWith('mcp_servers.conductor.command='))).toBe(true)
    expect(answer.args.lastIndexOf('-c')).toBe(keyAt(answer.args))
  })

  it('the npm launcher\'s one cmd.exe line: rewritten with the key kept once', () => {
    ;(globalThis as { __dasPort?: number }).__dasPort = 19333
    withWin32(() => {
      const b = buildCodexSpawn({ sessionId: SID, realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv }, codexOptions: PLAIN })
      const answer = codexHeldToolLaunch(SID, { file: b.cmd, args: b.commandLine!, env: b.env }, RELAY, 'win32') as { args: string }
      expect(typeof answer.args).toBe('string')
      expect(answer.args).toContain('mcp_servers.conductor.command=')
      expect(answer.args.split(` -c ${KEY}`)).toHaveLength(2)
    })
  })
})
