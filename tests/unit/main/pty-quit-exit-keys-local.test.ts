// Quitting the app, local sessions.
//
// A quit types the exit keys (Escape, Ctrl-C, /exit) only into a terminal the
// app itself started a CLI in. A local Claude Code session is one, and so is a
// local Codex session: each is ended the way it always was. A terminal tab (and a session's partner
// terminal, which is one too) runs whatever the user started in it: it is
// closed, and nothing is typed into it. The SSH side of the same rule is in
// pty-ssh-terminal-only.test.ts.
//
// The real spawnPty and gracefulExitPty over the real registry, with the
// Claude Code package as the app ships it and a stand-in session that hands
// back a fixed shell (the mock stack of pty-local-launch-registry.test.ts),
// and the Codex package the same way, with a stand-in for its prepared launch.
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
    return { pid: 4747, cols: 80, rows: 24, process: file,
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
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
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
// A Codex launch stages no canvas skills and designates no worktree here.
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))

const { spawnPty, killPty, gracefulExitPty } = await import('../../../src/main/pty-manager')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const { createClaudePackage } = await import('../../../src/main/providers/claude')
const { createCodexPackage } = await import('../../../src/main/providers/codex')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const EXIT_KEYS = ['\x1b', '\x03', '/exit\r']
const ids = ['quit-claude', 'quit-codex', 'quit-tab', 'quit-tab-command']
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

/** The Codex package as the app ships it, beside Claude Code's, with a
 *  stand-in session. Its home is this test's own folder and it is handed no
 *  environment: nothing of the real one is read. */
function registerCodex(): void {
  const real = createCodexPackage({ hostHome: { env: {}, homeDir: h.root } })
  const session = Object.assign(Object.create(Object.getPrototypeOf(real.session) as object), real.session, {
    buildSpawnCommand: () => ({ cmd: 'stand-in-cli', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
    runScreen: undefined,
  })
  registerProviderPackage({ ...real, session, capabilities: { ...real.capabilities, 'session.launch': { state: 'supported' } } })
}

/** What pty:spawn prepares for a Codex session, as a stand-in: a lease that
 *  only records its release, an executable that is never started, and an
 *  explicit environment. */
function preparedLaunch(): { lease: { accountId: string; release: () => void }; executable: string; env: Record<string, string>; sessionsDir: string; home: string } {
  const home = path.join(h.root, 'cli-home')
  return { lease: { accountId: 'stand-in-account', release: () => {} }, executable: 'stand-in-cli', env: { CODEX_HOME: home }, sessionsDir: path.join(home, 'sessions'), home }
}

/** Ask for the quit-time exit of `id`, let its timers run, and report what
 *  was typed into its terminal and how often it was told to end. */
function quit(id: string): { typed: string[]; kills: number } {
  const pty = h.ptys[h.ptys.length - 1]
  pty.writes.length = 0
  void gracefulExitPty(id, 5000)
  vi.advanceTimersByTime(500)
  const seen = { typed: [...pty.writes], kills: pty.kills }
  // The PTY reports its end, which is what settles the quit.
  for (const cb of pty.exits.slice()) cb({ exitCode: 0 })
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-quit-keys-')))
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
  if (path.basename(h.root).startsWith('pty-quit-keys-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('quitting the app with local sessions open', () => {
  // Mutation to prove this can fail: close every session without the keys.
  it('a local Claude Code session still gets Escape, Ctrl-C and /exit', () => {
    spawnPty(win, 'quit-claude', { cwd: project })
    vi.advanceTimersByTime(1000)
    expect(h.ptys).toHaveLength(1)
    const { typed, kills } = quit('quit-claude')
    expect(typed).toEqual(EXIT_KEYS)
    expect(kills).toBe(0)
  })

  it('a local Codex session still gets Escape, Ctrl-C and /exit', () => {
    registerCodex()
    spawnPty(win, 'quit-codex', { cwd: project, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: preparedLaunch() } as never)
    vi.advanceTimersByTime(1000)
    expect(h.ptys).toHaveLength(1)
    const { typed, kills } = quit('quit-codex')
    expect(typed).toEqual(EXIT_KEYS)
    expect(kills).toBe(0)
  })

  // Mutation to prove these can fail: type the exit keys into every session,
  // as before this change.
  it('a terminal tab gets nothing typed into it: it is closed', () => {
    spawnPty(win, 'quit-tab', { shellOnly: true, cwd: project })
    vi.advanceTimersByTime(1000)
    expect(h.ptys).toHaveLength(1)
    const { typed, kills } = quit('quit-tab')
    expect(typed).toEqual([])
    expect(kills).toBe(1)
  })

  it('a terminal tab that ran the user\'s own first command is closed the same way', () => {
    spawnPty(win, 'quit-tab-command', { shellOnly: true, cwd: project, terminalOptions: { command: 'htop' } } as never)
    vi.advanceTimersByTime(1000)
    expect(h.ptys).toHaveLength(1)
    const { typed, kills } = quit('quit-tab-command')
    expect(typed).toEqual([])
    expect(kills).toBe(1)
  })
})
