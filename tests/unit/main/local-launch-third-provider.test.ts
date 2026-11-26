// 2.1.3-beta.19 section 2 (aicc_planning#439): a third provider starts as
// itself, never as Codex. At cc36c7f3 the PTY manager's direct branch was any
// provider's in name and Codex's in body (it asked for a Codex account,
// stamped the session Codex's and bound it as Codex's), and a provider was
// direct only by a row in the PTY manager. Now a provider whose package has a
// local launch group (SessionProvider.localLaunch) is direct, and the branch
// runs that group, naming no provider.
//
// The stand-in third provider is registered as a package and nothing else: no
// row, no test hook of the PTY manager (_setLocalLaunchStylesForTest is never
// called here), no file under src/main changed for it. The one thing mocked
// beside the stand-ins below is the app's list of provider ids, which a real
// third provider adds its id to (src/shared/providers/ids.ts, outside
// src/main). The REAL spawnPty, the REAL registry and the REAL Claude Code and
// Codex packages; node-pty records, nothing is started.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const THIRD = 'standin'
const h = vi.hoisted(() => ({
  root: '',
  spawns: [] as Array<{ file: string; args: unknown; cwd: string }>,
  starts: [] as Array<{ id: unknown; provider: unknown; sessionId: string; resolvedCwd: string; cols: number; rows: number; core: string[] }>,
}))

vi.mock('../../../src/shared/providers/ids', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/shared/providers/ids')>()
  const PROVIDER_IDS = [...real.PROVIDER_IDS, 'standin'] as typeof real.PROVIDER_IDS
  return { ...real, PROVIDER_IDS, isProviderId: (v: unknown) => typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v) }
})
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, args: unknown, opts: { cwd: string }) => {
    h.spawns.push({ file, args, cwd: opts.cwd })
    return { pid: 4545, cols: 80, rows: 24, process: file, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => path.join(h.root, 'resources'), getDataDirectory: () => path.join(h.root, 'resources'), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null, getClaudeProfileId: () => undefined,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => path.join(h.root, 'resources'),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ localLaunchRefusal: () => null, launchRefusal: () => null }) }))

const { spawnPty, killPty, launchStyleOf, LOCAL_LAUNCH_STYLE } = await import('../../../src/main/pty-manager')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const { CAPABILITY_KEYS } = await import('../../../src/shared/providers')
const { createClaudePackage } = await import('../../../src/main/providers/claude')
const { createCodexPackage } = await import('../../../src/main/providers/codex')
type Pkg = Parameters<typeof registerProviderPackage>[0]
type Group = NonNullable<Pkg['session']['localLaunch']>

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SID = 'tp0000000000000000000001'

/** The third provider's own local launch group: its program, from its own
 *  folder, through the PTY manager's spawn of an agent's terminal. */
const thirdGroup: Group = {
  start(request, core) {
    h.starts.push({ id: request.id, provider: request.provider, sessionId: request.sessionId, resolvedCwd: request.resolvedCwd, cols: request.cols, rows: request.rows, core: Object.keys(core).sort() })
    const ptyProcess = core.spawnAgentPty({ sessionId: request.sessionId, kind: request.id }, '/opt/standin/bin/standin', ['--session', request.sessionId], { name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd: request.resolvedCwd, env: { TERM: 'xterm-256color' } })
    return { ptyProcess, launchedAt: Date.now() }
  },
}

/** A third provider's package, registered as any package is: `group` its local launch group, or none. */
function thirdPackage(group: Group | undefined): Pkg {
  const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, { state: 'unknown' }])) as Pkg['capabilities']
  const session = {
    id: THIRD,
    displayName: 'Stand-in',
    exitKeys: [],
    resolveBinary: () => null,
    buildSpawnCommand: () => { throw new Error('the stand-in builds no command: its group starts it') },
    detectUiRunning: () => false,
    ingestSessionTelemetry: () => ({ stop() {} }),
    listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: 'standin', args: [] }),
    configureMcpServer: async () => {},
    ...(group ? { localLaunch: group } : {}),
  }
  return { id: THIRD, session, capabilities, ambientAuthVariables: [], ownedLaunchVariables: [] } as unknown as Pkg
}

function register(group: Group | undefined): void {
  _resetProviderRegistryForTest()
  registerProviderPackage(createClaudePackage())
  registerProviderPackage(createCodexPackage())
  registerProviderPackage(thirdPackage(group))
}

let project = ''
beforeEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-launch-third-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(h.root, 'resources'), { recursive: true })
  h.spawns.length = 0
  h.starts.length = 0
})
afterAll(() => {
  try { killPty(SID) } catch { /* not started */ }
  _resetProviderRegistryForTest()
})

describe('a third provider registered as a package with a local launch group starts as itself', () => {
  // Mutation to prove this can fail (red at cc36c7f3, where the id had no row
  // and was refused, and a row would have started Codex's launch for it):
  // run the direct branch's Codex body, or look the style up in rows only.
  it('its own program starts, from its own group, and nothing of Codex\'s is asked for', () => {
    register(thirdGroup)
    expect(() => spawnPty(win, SID, { provider: THIRD, cwd: project } as never)).not.toThrow()
    expect(h.spawns).toEqual([{ file: '/opt/standin/bin/standin', args: ['--session', SID], cwd: project }])
    expect(h.starts).toHaveLength(1)
  })

  // Mutation to prove this can fail: the neutral branch stamps a fixed id
  // (`id: 'codex'`) or hands the group another provider than the lookup's.
  it('the group is handed the session\'s own provider: its id and the provider the registry holds for it', () => {
    register(thirdGroup)
    spawnPty(win, SID, { provider: THIRD, cwd: project } as never)
    const [start] = h.starts
    expect(start.id).toBe(THIRD)
    expect((start.provider as { id: string }).id).toBe(THIRD)
    expect(start.sessionId).toBe(SID)
    expect(start.resolvedCwd).toBe(project)
  })

  it('it is direct by its package alone: no row names it, and the app\'s own rows are the ones asked', () => {
    register(thirdGroup)
    expect(Object.hasOwn(LOCAL_LAUNCH_STYLE, THIRD)).toBe(false)
    expect(launchStyleOf(THIRD)).toBe('direct')
  })

  // Mutation to prove this can fail: start a direct provider with no group by
  // any other branch (Codex's body, or Claude Code's shell).
  it('registered with no local launch group: refused, nothing starts', () => {
    register(undefined)
    expect(launchStyleOf(THIRD)).toBeUndefined()
    expect(() => spawnPty(win, SID, { provider: THIRD, cwd: project } as never)).toThrow(/is not one this app can start/)
    expect(h.spawns).toEqual([])
    expect(h.starts).toEqual([])
  })
})
