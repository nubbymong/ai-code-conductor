// Quitting the app with Close sessions leaves no per-session file
// (aicc_planning#385).
//
// A local Claude Code session's ~/.claude/settings-<sid>.json, mcp-<sid>.json
// and ccc-status-<sid>.url were removed only by the session's exit handler.
// When the quit's wait for /exit runs out, or the quit's teardown (and an
// update) kills every PTY, the app exits before node-pty reports those ends,
// so the handler never ran and the files stayed for the next start. Here no
// end is ever reported, as at a real quit: the files must go with the kill.
//
// The real spawnPty, gracefulExitPty and killAllPty over the real registry,
// with the Claude Code package as the app ships it and a stand-in session that
// hands back a fixed shell (the mock stack of pty-quit-exit-keys-local.test.ts).
// The per-session files are plain files in this test's own home folder.
// node-pty records, nothing is started, and any other program a child-process
// call asks for is recorded and refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface StandInPty { writes: string[]; kills: number; exits: Array<(e: { exitCode: number }) => void> }
const h = vi.hoisted(() => ({
  root: '',
  ptys: [] as StandInPty[],
  /** Any program a child-process call asked for (refused, never run). */
  otherChildren: [] as string[],
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
    const rec: StandInPty = { writes: [], kills: 0, exits: [] }
    h.ptys.push(rec)
    return { pid: 4848, cols: 80, rows: 24, process: file,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exits.push(cb); return { dispose() {} } },
      write(d: string) { rec.writes.push(String(d)) }, resize() {}, kill() { rec.kills++ }, pause() {}, resume() {}, clear() {} }
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
// The per-session files as plain files in this test's home: written at the
// launch, removed by the same three removals the app makes.
vi.mock('../../../src/main/hooks/per-session-settings', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const file = (name: string): string => nodePath.join(h.root, 'home', '.claude', name)
  const write = (p: string): string => { nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true }); nodeFs.writeFileSync(p, '{}'); return p }
  const remove = (p: string): void => { try { nodeFs.unlinkSync(p) } catch { /* not there */ } }
  return {
    writeLocalSessionSettings: (sid: string) => { write(file(`ccc-status-${sid}.url`)); return write(file(`settings-${sid}.json`)) },
    writeLocalSessionMcpConfig: (sid: string) => write(file(`mcp-${sid}.json`)),
    removeLocalSessionSettings: (sid: string) => remove(file(`settings-${sid}.json`)),
    removeLocalSessionMcpConfig: (sid: string) => remove(file(`mcp-${sid}.json`)),
    removeLocalSessionStatusUrl: (sid: string) => remove(file(`ccc-status-${sid}.url`)),
  }
})
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))
// No account: these launches run outside any account's folders, and nothing of
// a real account is read or changed.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
  checkProfileCredentialFolders: () => Promise.resolve(),
  withProfileHome: (env: Record<string, string>) => ({ ...env }),
}))
// Main's accounts service: none.
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { spawnPty, killPty, killAllPty, gracefulExitPty } = await import('../../../src/main/pty-manager')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const { createClaudePackage } = await import('../../../src/main/providers/claude')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const ids = ['quit-files-a', 'quit-files-b']
let project = ''

/** The Claude Code package as the app ships it, with a stand-in session. */
function registerClaude(): void {
  const real = createClaudePackage()
  const session = Object.assign(Object.create(Object.getPrototypeOf(real.session) as object), real.session, {
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: 'stand-in-shell', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
  })
  _resetProviderRegistryForTest()
  registerProviderPackage({ ...real, session, capabilities: { ...real.capabilities, 'session.launch': { state: 'supported' } } })
}

/** The per-session files in this test's home, sorted. */
function sessionFiles(): string[] {
  const dir = path.join(h.root, 'home', '.claude')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}
const filesOf = (sid: string): string[] => [`ccc-status-${sid}.url`, `mcp-${sid}.json`, `settings-${sid}.json`]

/** Start a local Claude Code session and check its three files are there. */
function launch(sid: string): StandInPty {
  spawnPty(win, sid, { cwd: project })
  vi.advanceTimersByTime(1000)
  for (const f of filesOf(sid)) expect(sessionFiles()).toContain(f)
  return h.ptys[h.ptys.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-quit-files-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  h.ptys.length = 0
  h.otherChildren.length = 0
  registerClaude()
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  _resetProviderRegistryForTest()
  vi.clearAllTimers()
  vi.useRealTimers()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(h.root).startsWith('pty-quit-files-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a quit with Close sessions leaves no per-session file', () => {
  // Mutation to prove this can fail: drop the removal after the forced kill.
  it('a session whose wait for /exit runs out: its files go with the forced kill, the other session\'s stay', async () => {
    const a = launch('quit-files-a')
    launch('quit-files-b')
    const quit = gracefulExitPty('quit-files-a', 5000)
    vi.advanceTimersByTime(5000)
    await quit
    // Killed, and its end never reported (no exit callback was called).
    expect(a.kills).toBe(1)
    expect(sessionFiles()).toEqual(filesOf('quit-files-b'))
  })

  // Mutation to prove this can fail: drop the removal in killAllPty.
  it('the quit\'s teardown (and an update) killing every PTY: the files go with the kill', () => {
    const a = launch('quit-files-a')
    const b = launch('quit-files-b')
    killAllPty()
    expect([a.kills, b.kills]).toEqual([1, 1])
    expect(sessionFiles()).toEqual([])
  })

  it('a session that ends at /exit still has its files removed by its own exit, as before', async () => {
    const a = launch('quit-files-a')
    const quit = gracefulExitPty('quit-files-a', 5000)
    vi.advanceTimersByTime(500)
    expect(sessionFiles()).toEqual(filesOf('quit-files-a'))
    for (const cb of a.exits.slice()) cb({ exitCode: 0 })
    await quit
    expect(a.kills).toBe(0)
    expect(sessionFiles()).toEqual([])
  })
})
