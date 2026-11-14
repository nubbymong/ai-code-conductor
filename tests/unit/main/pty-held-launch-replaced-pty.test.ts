// A held launch that replaced a running session says why it did not start,
// and the window is told the session ended exactly once.
//
// A Restart or a Switch Account starts a launch for a session id whose
// process is still ending. On an account, that launch is held inside the PTY
// manager (a sign-in refresh, then the check of the project settings), and
// the process it replaced reports its end either while the launch is held or
// after the hold has ended. When the held launch is then refused (its
// assistant was switched off meanwhile, or the project settings refuse the
// account), the terminal shows the reason before the exit, and one pty:exit
// reaches the window whichever order the two events arrive in: the end of the
// replaced process is the session's end, so it carries the exit, and the
// refusal adds none of its own while that end is still to come.
//
// The real spawnPty, the real launch rule and the real session liveness
// record; only the accounts service's answer and the project check's verdict
// are scripted. An account is a folder under this test's own root; the Claude
// Code package is the app's own with a stand-in session; node-pty records
// (each stand-in process reports its end when the test says so), nothing is
// started, and any other program a child-process call asks for is recorded
// and refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Refusal = { code: string; providerId: string; message: string }
interface StandInPty { file: string; killed: number; exit: (code: number) => void }
const h = vi.hoisted(() => ({
  root: '',
  ptys: [] as StandInPty[],
  otherChildren: [] as string[],
  /** What the accounts service answers for a launch now (null: it may start). */
  refusal: null as Refusal | null,
  /** A refresh wait's end, held open by a case that needs to act meanwhile. */
  folderCheck: null as Promise<void> | null,
  /** The project check's verdict for the next launch. */
  gate: { status: 'clean' } as { status: 'clean' } | { status: 'refused'; keys: string[] },
}))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    let onExit: ((e: { exitCode: number }) => void) | null = null
    const standIn: StandInPty = { file, killed: 0, exit: (code) => onExit?.({ exitCode: code }) }
    h.ptys.push(standIn)
    return { pid: 4343, cols: 80, rows: 24, process: file,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; return { dispose() {} } },
      write() {}, resize() {}, kill() { standIn.killed++ }, pause() {}, resume() {}, clear() {} }
  },
}))
// No program is started here: every child-process call is recorded and refused
// (afterEach checks there was none).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const refuse = (file: unknown): never => { h.otherChildren.push(String(file)); throw new Error('no program is started in this test') }
  return {
    ...real,
    execFile: ((file: string, _args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string) => void) => {
      h.otherChildren.push(String(file))
      setTimeout(() => cb?.(new Error('no program is started in this test'), ''), 0)
      return { on() {}, kill() {}, unref() {} }
    }) as unknown as typeof real.execFile,
    spawn: refuse as unknown as typeof real.spawn,
    spawnSync: refuse as unknown as typeof real.spawnSync,
    execFileSync: refuse as unknown as typeof real.execFileSync,
    execSync: refuse as unknown as typeof real.execSync,
    exec: refuse as unknown as typeof real.exec,
    fork: refuse as unknown as typeof real.fork,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.root, getDataDirectory: () => h.root, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
// No Claude CLI is asked for its version.
vi.mock('../../../src/main/claude-cli-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-version')>()),
  ensureClaudeCliVersion: () => {},
  probeClaudeCliVersion: async () => null,
}))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
// The session liveness record (session-registry.ts) is the real one: whether a
// process of the session has still to report its end is read from it.
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))
vi.mock('../../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunchDirs: async () => h.gate,
}))
// An account is a folder under the test's root, named by an id of the real
// shape; nothing of a real account is read or changed. The account's launch
// environment stands in for the real one in one respect only: it refuses a
// launch whose project check refused, in the real refusal's opening words.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  const nodePath = require('path') as typeof import('path')
  return {
    ...real,
    getProfileConfigDir: (id: string) => {
      if (!real.isValidProfileId(id)) throw new Error('invalid profile id')
      return nodePath.join(h.root, 'profiles', id)
    },
    getPrimaryProfileId: () => null,
    setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
    checkProfileCredentialFolders: () => h.folderCheck ?? Promise.resolve(),
    withProfileHome: (env: Record<string, string>, _home: unknown, context?: { projectGate?: { status: string; keys?: string[] } | null }) => {
      if (context?.projectGate?.status === 'refused') {
        throw new Error(`${real.MANAGED_LAUNCH_REFUSAL}: the project's own settings could redirect this account -- ${(context.projectGate.keys ?? []).join(', ')}.`)
      }
      return { ...env }
    },
  }
})
// The accounts service's answer is the only thing scripted; the rule that asks
// it (provider-launch-gate.ts) is the real one.
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ launchRefusal: () => h.refusal, localLaunchRefusal: () => null }),
}))

const consumers = await import('../../../src/main/profile-consumers')
const { spawnPty, killPty, isSessionWritable } = await import('../../../src/main/pty-manager')
const { isPtySessionLive } = await import('../../../src/main/session-registry')
const { PROVIDER_IDS, providerOffMessage } = await import('../../../src/shared/providers')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

// Claude Code is the first provider id in the app's own list.
const [CLAUDE] = PROVIDER_IDS
const OFF: Refusal = { code: 'provider-off', providerId: CLAUDE, message: providerOffMessage('Claude Code') }
const SHELL = 'stand-in-shell'

const payloads: Array<[string, unknown]> = []
const win = {
  webContents: { send: (channel: string, payload?: unknown) => { payloads.push([channel, payload]) } },
  isDestroyed: () => false,
} as never
const sent = (channel: string): unknown[] => payloads.filter(([c]) => c === channel).map(([, p]) => p)
const terminal = (id: string): string => sent(`pty:data:${id}`).map(String).join('')
const until = async (cond: () => boolean, why: string): Promise<void> => {
  const deadline = Date.now() + 8000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}
/** Long enough for a held launch whose wait has ended to have run. */
const aMoment = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)) }

const ids = ['replaced-exit-first', 'replaced-exit-later', 'replaced-gate', 'replaced-gate-later', 'replaced-lands', 'never-ran', 'held-then-refused']
let project = ''
let seq = 0

/** An account set up here: its folder exists. */
const account = (): string => {
  const id = `profile-test${String(++seq).padStart(4, '0')}-abcdef`
  fs.mkdirSync(path.join(h.root, 'profiles', id), { recursive: true })
  return id
}
/** A sign-in refresh of `id` that is under way until the returned function is called. */
const refreshUnderWay = (id: string): (() => void) => {
  let done!: () => void
  consumers.noteProfileRefreshInFlight(id, new Promise<void>((resolve) => { done = resolve }))
  return done
}
/** A session running on `profileId`: its launch was held for the project
 *  check, as every launch on an account is, and has landed. */
const running = async (sessionId: string, profileId: string): Promise<StandInPty> => {
  spawnPty(win, sessionId, { profileId, cwd: project })
  await until(() => h.ptys.length === 1, `${sessionId} to start`)
  expect(isPtySessionLive(sessionId)).toBe(true)
  expect(sent(`pty:exit:${sessionId}`)).toEqual([])
  return h.ptys[0]
}

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-held-replaced-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  consumers._resetProfileConsumersForTest()
  h.ptys.length = 0; h.otherChildren.length = 0; payloads.length = 0
  h.refusal = null
  h.folderCheck = null
  h.gate = { status: 'clean' }
  registerFakeClaudePackage({
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: SHELL, args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
  })
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  // Every stand-in process reports its end, so no session outlives its case.
  for (const p of h.ptys) p.exit(0)
  consumers._resetProfileConsumersForTest()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(h.root).startsWith('pty-held-replaced-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a held launch that replaced a running session and is refused when its wait ends (the assistant was switched off)', () => {
  // Mutation to prove this can fail: end the session through the handed-over
  // teardown without writing the reason first.
  it('the replaced process ended while the launch was held: the terminal says why, then one exit', async () => {
    const id = account()
    const old = await running('replaced-exit-first', id)
    // A Restart: the same session id is started again while a refresh is under way.
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'replaced-exit-first', { profileId: id, cwd: project })
    expect(old.killed, 'the session\'s process was ended for the new launch').toBe(1)
    expect(h.ptys, 'held: nothing new has started').toHaveLength(1)
    old.exit(0)
    expect(sent('pty:exit:replaced-exit-first'), 'the end of the replaced process is left to the held launch').toEqual([])
    h.refusal = OFF
    refreshDone()
    await until(() => sent('pty:exit:replaced-exit-first').length > 0, 'the refused launch to end the session')
    await aMoment()
    expect(h.ptys, 'nothing started').toHaveLength(1)
    expect(terminal('replaced-exit-first')).toContain(OFF.message)
    expect(payloads.findIndex(([c]) => c === 'pty:data:replaced-exit-first')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:replaced-exit-first'))
    expect(sent('pty:exit:replaced-exit-first'), 'exactly one exit').toHaveLength(1)
    expect(isPtySessionLive('replaced-exit-first')).toBe(false)
    expect(consumers.profileConsumerCount(id), 'the hold on the account was released').toBe(0)
  })

  // Mutation to prove this can fail: send the refusal's own exit while the
  // replaced process has still to report its end.
  it('the replaced process ends after the refusal: the terminal says why at once, and its end is the one exit', async () => {
    const id = account()
    const old = await running('replaced-exit-later', id)
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'replaced-exit-later', { profileId: id, cwd: project })
    expect(old.killed).toBe(1)
    h.refusal = OFF
    refreshDone()
    await until(() => terminal('replaced-exit-later').includes(OFF.message), 'the refusal to be written to the terminal')
    await aMoment()
    expect(h.ptys, 'nothing started').toHaveLength(1)
    expect(sent('pty:exit:replaced-exit-later'), 'the exit is left to the end of the replaced process').toEqual([])
    expect(consumers.profileConsumerCount(id), 'the hold on the account was released').toBe(0)
    old.exit(3)
    expect(sent('pty:exit:replaced-exit-later'), 'exactly one exit, the replaced process\'s own').toEqual([3])
    expect(payloads.findIndex(([c]) => c === 'pty:data:replaced-exit-later')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:replaced-exit-later'))
    expect(isPtySessionLive('replaced-exit-later')).toBe(false)
    expect(isSessionWritable('replaced-exit-later')).toBe(false)
  })
})

describe('a Restart whose project settings refuse the account', () => {
  // Mutation to prove this can fail: as above, the handed-over teardown alone.
  it('the replaced process ended while the project was checked: the refusal\'s sentence, then one exit', async () => {
    const id = account()
    const old = await running('replaced-gate', id)
    h.gate = { status: 'refused', keys: ['settings.json: apiKeyHelper'] }
    spawnPty(win, 'replaced-gate', { profileId: id, cwd: project })
    expect(old.killed).toBe(1)
    old.exit(0)
    await until(() => sent('pty:exit:replaced-gate').length > 0, 'the refused launch to end the session')
    await aMoment()
    expect(h.ptys, 'nothing started').toHaveLength(1)
    expect(terminal('replaced-gate')).toContain('settings.json: apiKeyHelper')
    expect(payloads.findIndex(([c]) => c === 'pty:data:replaced-gate')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:replaced-gate'))
    expect(sent('pty:exit:replaced-gate'), 'exactly one exit').toHaveLength(1)
    expect(consumers.profileConsumerCount(id)).toBe(0)
  })

  it('the replaced process ends after the refusal: the sentence at once, and its end is the one exit', async () => {
    const id = account()
    const old = await running('replaced-gate-later', id)
    h.gate = { status: 'refused', keys: ['settings.json: apiKeyHelper'] }
    spawnPty(win, 'replaced-gate-later', { profileId: id, cwd: project })
    await until(() => terminal('replaced-gate-later').includes('settings.json: apiKeyHelper'), 'the refusal to be written to the terminal')
    await aMoment()
    expect(sent('pty:exit:replaced-gate-later')).toEqual([])
    old.exit(0)
    expect(sent('pty:exit:replaced-gate-later'), 'exactly one exit').toEqual([0])
  })
})

describe('a launch that is refused before it starts anything, for a session whose earlier launch is held', () => {
  // Mutation to prove this can fail: let the refused launch take the held
  // launch's place before its provider is looked up.
  it('the held launch is left in place: it starts when its wait ends, and no exit is sent', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'held-then-refused', { profileId: id, cwd: project })
    expect(h.ptys).toEqual([])
    // A second launch of the session names an assistant the app does not know.
    expect(() => spawnPty(win, 'held-then-refused', { provider: 'elsewhere', profileId: id, cwd: project } as never)).toThrow(/is not one this app can start/)
    expect(consumers.profileConsumerCount(id), 'the held launch still holds the account').toBeGreaterThan(0)
    expect(sent('pty:exit:held-then-refused')).toEqual([])
    refreshDone()
    await until(() => h.ptys.length === 1, 'the held launch to start')
    expect(h.ptys[0].file).toBe(SHELL)
    expect(sent('pty:exit:held-then-refused')).toEqual([])
  })
})

describe('what is unchanged', () => {
  it('a held launch that replaced a running session and may start: it starts, and the replaced process\'s end is not the session\'s', async () => {
    const id = account()
    const old = await running('replaced-lands', id)
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'replaced-lands', { profileId: id, cwd: project })
    refreshDone()
    await until(() => h.ptys.length === 2, 'the held launch to start')
    old.exit(0)
    expect(sent('pty:exit:replaced-lands'), 'the new process is the session').toEqual([])
    expect(terminal('replaced-lands')).toBe('')
    h.ptys[1].exit(0)
    expect(sent('pty:exit:replaced-lands')).toEqual([0])
  })

  it('a held launch of a session that had no process: refused, the terminal says why and the exit follows at once', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'never-ran', { profileId: id, cwd: project })
    h.refusal = OFF
    refreshDone()
    await until(() => sent('pty:exit:never-ran').length > 0, 'the refused launch to say it did not start')
    expect(h.ptys).toEqual([])
    expect(terminal('never-ran')).toContain(OFF.message)
    expect(payloads.findIndex(([c]) => c === 'pty:data:never-ran')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:never-ran'))
    expect(sent('pty:exit:never-ran')).toEqual([-1])
  })
})
