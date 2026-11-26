// 2.1.3-beta.19 section 2 (aicc_planning#439): a third provider starts as
// itself, never as Codex. At cc36c7f3 the PTY manager's direct branch was any
// provider's in name and Codex's in body (it asked for a Codex account,
// stamped the session Codex's and bound it as Codex's), and a provider was
// direct only by a row in the PTY manager. Now a provider whose package has a
// local launch group (SessionProvider.localLaunch) is direct, and the branch
// runs that group, naming no provider.
//
// Its lifecycle object (SessionProvider.lifecycle) is asked for its kept
// session's take-over, its serving while its tab is not shown and the first
// part of its teardown: never Claude Code's in its place (at cc36c7f3 the
// take-over and the serving read "not direct" as Claude Code's).
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
  /** What each lifecycle object was asked, by whose: [whose, what, session]. */
  asked: [] as Array<[string, string, string]>,
  mcpPort: 0,
  /** Each started terminal's end, as node-pty would report it. */
  exits: [] as Array<() => void>,
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
    const ends: Array<(e: { exitCode: number }) => void> = []
    h.exits.push(() => { for (const end of [...ends]) end({ exitCode: 0 }) })
    return { pid: 4545, cols: 80, rows: 24, process: file, onData: () => ({ dispose() {} }), onExit: (end: (e: { exitCode: number }) => void) => { ends.push(end); return { dispose() {} } }, write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => path.join(h.root, 'resources'), getDataDirectory: () => path.join(h.root, 'resources'), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => h.mcpPort }))
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
const { setKeptTakeOver, serveKeptLaunch, unserveKeptLaunch } = await import('../../../src/main/sessions/kept-launches')
const { createClaudePackage } = await import('../../../src/main/providers/claude')
const { createCodexPackage } = await import('../../../src/main/providers/codex')
type Pkg = Parameters<typeof registerProviderPackage>[0]
type Group = NonNullable<Pkg['session']['localLaunch']>
type Lifecycle = NonNullable<Pkg['session']['lifecycle']>

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

/** A lifecycle object that records what it is asked, under `whose`. */
function recordingLifecycle(whose: string): Lifecycle {
  return {
    bind: () => { h.asked.push([whose, 'bind', '']) },
    keptAccount: (take) => { h.asked.push([whose, 'keptAccount', take.sessionId]); return {} },
    takeOver: (take) => { h.asked.push([whose, 'takeOver', take.sessionId]); return undefined },
    serveUnseen: (kept) => { h.asked.push([whose, 'serveUnseen', kept.sessionId]) },
    unbind: (sessionId) => { h.asked.push([whose, 'unbind', sessionId]) },
    describe: (sessionId) => { h.asked.push([whose, 'describe', sessionId]); return {} },
  }
}

/** The third provider's group, binding an account lease through the core
 *  as a Codex launch does (core.bindCodexLease), before it starts. */
const leaseHeld = { released: 0 }
const leasingGroup: Group = {
  start(request, core) {
    core.bindCodexLease(request.sessionId, { accountId: 'acct-third', release: () => { leaseHeld.released++ } } as never)
    return thirdGroup.start(request, core)
  },
}

/** A third provider's package, registered as any package is: `group` its
 *  local launch group, `lifecycle` its lifecycle object; either may be none. */
function thirdPackage(group: Group | undefined, lifecycle?: Lifecycle): Pkg {
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
    ...(lifecycle ? { lifecycle } : {}),
  }
  return { id: THIRD, session, capabilities, ambientAuthVariables: [], ownedLaunchVariables: [] } as unknown as Pkg
}

/** The real packages, Claude Code's with a lifecycle object that records
 *  (so a lookup that falls back to Claude Code's shows), and the third. */
function register(group: Group | undefined, lifecycle?: Lifecycle): void {
  _resetProviderRegistryForTest()
  const claude = createClaudePackage()
  const claudeSession = Object.create(Object.getPrototypeOf(claude.session) as object) as typeof claude.session
  Object.defineProperties(claudeSession, Object.getOwnPropertyDescriptors(claude.session))
  Object.defineProperty(claudeSession, 'lifecycle', { value: recordingLifecycle('claude'), enumerable: true })
  registerProviderPackage({ ...claude, session: claudeSession })
  registerProviderPackage(createCodexPackage())
  registerProviderPackage(thirdPackage(group, lifecycle))
}

/** The kept terminal the session helper hands back for the third provider's tab. */
function keptTerminal(): unknown {
  return { pid: 4646, cols: 120, rows: 30, process: 'standin', onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
}
const takeOverAsked: Array<{ sid: string; provider: string }> = []

let project = ''
beforeEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-launch-third-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(h.root, 'resources'), { recursive: true })
  h.spawns.length = 0
  h.starts.length = 0
  h.asked.length = 0
  h.mcpPort = 0
  h.exits.length = 0
  leaseHeld.released = 0
  takeOverAsked.length = 0
  setKeptTakeOver((sid, provider) => { takeOverAsked.push({ sid, provider }); return null })
})
afterAll(() => {
  try { killPty(SID) } catch { /* not started */ }
  setKeptTakeOver(null)
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

describe('a third provider\'s lifecycle object is the one its session\'s take-over, serving and unbind ask', () => {
  // Mutation to prove this can fail (red at cc36c7f3, where the take-over read
  // "not direct" as Claude Code's and the stand-in had no way to start): the
  // lookup falls back to Claude Code's lifecycle object.
  it('its kept session is taken over by its own lifecycle object: its group starts nothing, and Claude Code\'s is not asked', () => {
    register(thirdGroup, recordingLifecycle(THIRD))
    setKeptTakeOver((sid, provider) => { takeOverAsked.push({ sid, provider }); return provider === THIRD ? { pty: keptTerminal() as never, kept: { conversation: null, account: null, hookFolder: null, folder: null, at: 0 } } : null })
    spawnPty(win, SID, { provider: THIRD, cwd: project } as never)
    expect(takeOverAsked).toEqual([{ sid: SID, provider: THIRD }])
    // (The teardown before the launch, of a session with no launch known yet,
    // asks every registered provider's unbind, each a no-op here.)
    expect(h.asked.filter(([, what]) => what !== 'unbind')).toEqual([[THIRD, 'keptAccount', SID], [THIRD, 'takeOver', SID]])
    expect(h.starts, 'a launch was started for a session taken over').toEqual([])
  })

  // Mutation to prove this can fail: unbind by Claude Code's lifecycle object,
  // or by none (skipped for a provider whose launch is known).
  it('its session\'s teardown asks its own lifecycle object\'s unbind, and no other', () => {
    register(thirdGroup, recordingLifecycle(THIRD))
    spawnPty(win, SID, { provider: THIRD, cwd: project } as never)
    h.asked.length = 0
    killPty(SID)
    expect(h.asked).toEqual([[THIRD, 'unbind', SID]])
  })

  it('its kept session, its tab not shown, is served by its own lifecycle object', () => {
    register(thirdGroup, recordingLifecycle(THIRD))
    h.mcpPort = 4747
    expect(serveKeptLaunch({ sessionId: SID, provider: THIRD, hookFolder: null, folder: null } as never, project)).toBe(true)
    expect(h.asked).toEqual([[THIRD, 'serveUnseen', SID]])
    unserveKeptLaunch(SID)
  })

  // Mutation to prove this can fail: a provider with no lifecycle object taken
  // over (or served) by Claude Code's in its place.
  it('a provider with no lifecycle object: not taken over and not served (its tab launches as before), and Claude Code\'s is not asked', () => {
    register(thirdGroup)
    setKeptTakeOver((sid, provider) => { takeOverAsked.push({ sid, provider }); return { pty: keptTerminal() as never, kept: { conversation: null, account: null, hookFolder: null, folder: null, at: 0 } } })
    spawnPty(win, SID, { provider: THIRD, cwd: project } as never)
    expect(takeOverAsked, 'the session helper was asked for a take-over no lifecycle object can make').toEqual([])
    expect(h.starts).toHaveLength(1)
    h.mcpPort = 4747
    expect(serveKeptLaunch({ sessionId: 'tp0000000000000000000002', provider: THIRD, hookFolder: null, folder: null } as never, project)).toBe(false)
    expect(h.asked.filter(([whose, what]) => whose === 'claude' && what !== 'unbind')).toEqual([])
  })

  // Mutation to prove this can fail: unbind skipped for a provider with no
  // lifecycle object. What its launch bound through the core (an account
  // lease) is let go by every registered provider's unbind instead, at the
  // teardown of its session's own end (a kill keeps a lease until the
  // process has ended, as a Codex one's).
  it('a provider with no lifecycle object: what its launch bound through the core still goes at its teardown', () => {
    register(leasingGroup)
    spawnPty(win, SID, { provider: THIRD, cwd: project } as never)
    expect(leaseHeld.released).toBe(0)
    h.exits.at(-1)!()
    expect(leaseHeld.released).toBe(1)
  })
})
