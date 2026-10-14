// A local Claude launch names its session to the launch line's builder, so
// the one line the log gets when a fresh session's resume list is skipped
// for want of Node.js says which session it was. The real
// spawnPty and the real builder, watched; node-pty records the line, and the
// Windows node.exe lookup is answered here (none found), never by this
// runner's PATH. No process starts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  writes: [] as string[], logs: [] as string[], builds: [] as Array<{ sessionId?: string }>,
  files: { settings: '', mcp: '', plugin: '' }, res: '', bin: 'claude',
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7602, process: 'x',
    onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.logs.push(String(m)) }, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
// No node.exe in any folder PATH names, as on a computer without Node.js.
// Every other program is looked up as before.
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const isNode = (names: readonly string[]): boolean => names.length === 1 && names[0] === 'node.exe'
  return {
    ...actual,
    findOnWindowsPath: (...a: Parameters<typeof actual.findOnWindowsPath>) => (isNode(a[0]) ? null : actual.findOnWindowsPath(...a)),
    findOnWindowsPathAsync: async (...a: Parameters<typeof actual.findOnWindowsPathAsync>) => (isNode(a[0]) ? null : actual.findOnWindowsPathAsync(...a)),
  }
})
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()
  return {
    ...actual,
    resolveResumeLaunch: () => null,
    buildClaudeLaunchCommand: (o: Parameters<typeof actual.buildClaudeLaunchCommand>[0]) => {
      h.builds.push({ ...o })
      return actual.buildClaudeLaunchCommand(o)
    },
  }
})
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({ resolveBinary: () => ({ cmd: h.bin, source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: h.bin, source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => h.files.plugin }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => h.files.settings, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => h.files.mcp, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: (key: string) => ({ value: key === 'settings' ? {} : {}, outcome: 'ok' }),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { CLAUDE_RESUME_LIST_SKIPPED_NO_NODE, _resetPickerNodeFoundForTest } = await import('../../../src/main/spawn-claude-command')
const { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests } = await import('../../../src/main/script-folders')

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const WIN = process.platform === 'win32'
let tmp = ''
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `nonode${String(++seq).padStart(18, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-launch-sid-')))
  h.files.settings = path.join(tmp, 'settings-x.json')
  h.files.mcp = path.join(tmp, 'mcp-x.json')
  h.files.plugin = path.join(tmp, 'plugin')
  h.res = path.join(tmp, 'res')
  fs.writeFileSync(h.files.settings, '{}')
  fs.writeFileSync(h.files.mcp, '{}')
  fs.mkdirSync(h.files.plugin)
  // The resume list is deployed, so a fresh session asks for it, in a
  // scripts folder this run made the user's alone (as the start does).
  fs.mkdirSync(path.join(h.res, 'scripts'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(h.res, 'scripts', 'resume-picker.js'), '// picker\n', { mode: 0o600 })
  __markScriptFoldersCheckedForTests(h.res)
  h.bin = WIN ? 'C:\\Users\\u\\.local\\bin\\claude.exe' : 'claude'
  h.writes = []
  h.logs = []
  h.builds = []
  _resetPickerNodeFoundForTest()
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  __resetScriptFoldersForTests()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Waits for the Claude launch line to be written into the PTY. */
const launched = async (): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('--settings')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(h.writes.some((w) => w.includes('--settings'))).toBe(true)
}

describe('a fresh local Claude session', () => {
  // Mutation to prove this can fail: drop `sessionId` from the buildClaudeLaunchCommand call in pty-manager.ts.
  it("hands its session id to the launch line's builder", async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, useResumePicker: true })
    await launched()
    expect(h.builds).toHaveLength(1)
    expect(h.builds[0].sessionId).toBe(SID)
  })

  // Windows only: elsewhere the session's own shell decides about node, and the app writes no line.
  it.runIf(WIN)('Windows, no Node.js: the log line about the skipped resume list names the session', async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, useResumePicker: true })
    await launched()
    expect(h.logs).toContain(`[spawn-claude] ${SID}: ${CLAUDE_RESUME_LIST_SKIPPED_NO_NODE}`)
    expect(h.logs).not.toContain(`[spawn-claude] ${CLAUDE_RESUME_LIST_SKIPPED_NO_NODE}`)
  })
})
