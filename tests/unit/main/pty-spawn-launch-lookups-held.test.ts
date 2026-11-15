/**
 * 2.1.3-beta.5: two holds pty:spawn puts on a launch while a look for a
 * program is made off the event loop, through the REAL pty:spawn handler.
 *
 * 1. An elevated terminal on Windows starts gsudo by its full path. With no
 *    answer about gsudo.exe kept (and main started), it is held as a prepared
 *    spawn for the look (gsudo-lookup.ts gsudoLookAnswered), so PATH is not
 *    walked for it in place. With an answer kept, or for a terminal that is
 *    not elevated, nothing is held.
 * 2. On macOS and Linux a Codex launch that opens the resume list waits, before
 *    it starts, for the question to the login shell about node
 *    (providers/codex/spawn.ts warmNodeExeOnPosix), asked off the event loop. A
 *    launch that opens no resume list does not ask it.
 *
 * The look itself and the warm-up are covered where they live
 * (launch-lookups-off-main-thread.test.ts); here they are stand-ins the test
 * answers, so what is checked is the handler's wiring: if either hold is
 * removed, the launch starts before the look has ended and these fail.
 * pty-manager and the accounts service are faked, so nothing spawns. The
 * platform is a stand-in, so the cases run on every host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))
const live = new Set<string>()
const pending = new Set<string>()
const spawnPty = vi.fn((_win: unknown, sid: string, _o: unknown) => { live.add(sid) })
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => {
  pending.add(sid)
  return { get current() { return pending.has(sid) }, spawn: (o: unknown) => { pending.delete(sid); spawnPty(win, sid, o) }, abandon: () => { pending.delete(sid) } }
})
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (w: unknown, s: string, o: unknown) => spawnPty(w, s, o),
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); pending.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (w: unknown, s: string) => beginSpawnPreparation(w, s),
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || pending.has(id),
  endAgentRunsInFolder: async () => true,
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
vi.mock('../../../src/main/script-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/script-folders')>()),
  scriptFoldersPending: () => false,
  awaitScriptFolders: () => Promise.resolve(),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn(() => '/res/help'), helpWorkspaceDir: (dir: string) => `${dir}/help` }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    remoteLaunchRefusal: () => null,
    prepareLaunch: async () => ({ ok: true, lease: { accountId: 'acct-1', release: () => {} }, executable: '/proven/codex', env: {}, sessionsDir: '/realm/sessions', home: '/realm' }),
    snapshot: () => ({ accounts: [] }),
  }),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: () => Promise.resolve(),
}))

// The two looks, answered by the test: whether an answer is kept, and the
// look's end (a promise the test settles), counted.
const looks = vi.hoisted(() => ({
  gsudoKept: false,
  gsudoAsked: 0,
  gsudoEnds: Promise.resolve(true) as Promise<boolean>,
  nodeAsked: 0,
  nodeEnds: Promise.resolve() as Promise<void>,
}))
vi.mock('../../../src/main/gsudo-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/gsudo-lookup')>()),
  gsudoAnswerKept: () => looks.gsudoKept,
  gsudoLookAnswered: () => { looks.gsudoAsked++; return looks.gsudoEnds },
}))
// The handler loads this module only when a launch needs it, and only for this
// one function; the real module is not loaded.
vi.mock('../../../src/main/providers/codex/spawn', () => ({
  warmNodeExeOnPosix: () => { looks.nodeAsked++; return looks.nodeEnds },
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { armClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!

const S = 'c1d2e3f4a5b6c1d2e3f4a5b6'
const outcome = async (p: unknown): Promise<string> => {
  try {
    const r = await p as { refused?: { code?: string }; started?: boolean } | undefined
    return r?.refused?.code ?? (r?.started === false ? 'not-started' : 'started')
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}
/** Let every promise the handler waits on, other than a look the test holds, settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
/** A look the test ends by calling the returned function. */
function heldLook<T>(value: T): { ends: Promise<T>; end: () => void } {
  let end = (): void => {}
  const ends = new Promise<T>((resolve) => { end = () => resolve(value) })
  return { ends, end }
}

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const asPlatform = (value: string): void => { Object.defineProperty(process, 'platform', { value, configurable: true }) }

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear()
  looks.gsudoKept = false
  looks.gsudoAsked = 0
  looks.gsudoEnds = Promise.resolve(true)
  looks.nodeAsked = 0
  looks.nodeEnds = Promise.resolve()
  _resetClaudeLaunchWalkForTest()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', PLATFORM)
  _resetClaudeLaunchWalkForTest()
})

describe('an elevated terminal on Windows is held for the look for gsudo', () => {
  const ELEVATED = { cwd: 'C:/w', shellOnly: true, elevated: true }

  // Mutation to prove this can fail: decide the hold false (or drop the wait):
  // the terminal then starts at once, and the launch line walks PATH for gsudo.
  it('with no answer kept it is a prepared spawn, and starts only once the look has ended', async () => {
    asPlatform('win32')
    armClaudeLaunchWalk()
    const look = heldLook(true)
    looks.gsudoEnds = look.ends
    const started = outcome(spawn({}, S, ELEVATED))
    await settle()
    expect(beginSpawnPreparation, 'held as a prepared spawn').toHaveBeenCalledTimes(1)
    expect(looks.gsudoAsked, 'it waits for the look').toBe(1)
    expect(spawnPty, 'nothing starts while the look is under way').not.toHaveBeenCalled()
    look.end()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: hold every elevated terminal, whatever is kept.
  it('with an answer kept it is not held', async () => {
    asPlatform('win32')
    armClaudeLaunchWalk()
    looks.gsudoKept = true
    expect(await outcome(spawn({}, S, ELEVATED))).toBe('started')
    expect(beginSpawnPreparation).not.toHaveBeenCalled()
    expect(looks.gsudoAsked).toBe(0)
  })

  it('a terminal that is not elevated, and any launch before main has started, are not held', async () => {
    asPlatform('win32')
    // Main has not started: nothing is looked for, whatever is kept.
    expect(await outcome(spawn({}, S, ELEVATED))).toBe('started')
    armClaudeLaunchWalk()
    expect(await outcome(spawn({}, 'd1d2e3f4a5b6c1d2e3f4a5b6', { cwd: 'C:/w', shellOnly: true }))).toBe('started')
    expect(beginSpawnPreparation).not.toHaveBeenCalled()
    expect(looks.gsudoAsked).toBe(0)
  })

  it('off Windows an elevated terminal is not held', async () => {
    asPlatform('linux')
    armClaudeLaunchWalk()
    expect(await outcome(spawn({}, S, ELEVATED))).toBe('started')
    expect(beginSpawnPreparation).not.toHaveBeenCalled()
    expect(looks.gsudoAsked).toBe(0)
  })
})

describe('a Codex launch that opens the resume list, on macOS and Linux, waits for the question about node', () => {
  const CODEX = { cwd: '/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }

  // Mutation to prove this can fail: drop the wait (the launch then starts
  // before the answer is kept and runs the picker on a bare `node`).
  it('it starts only once the question has been answered', async () => {
    asPlatform('linux')
    const look = heldLook<void>(undefined)
    looks.nodeEnds = look.ends
    const started = outcome(spawn({}, S, { ...CODEX, useResumePicker: true }))
    await settle()
    expect(looks.nodeAsked, 'the question is asked').toBe(1)
    expect(spawnPty, 'nothing starts while it is under way').not.toHaveBeenCalled()
    look.end()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: ask it for every Codex launch.
  it('a launch that opens no resume list does not ask it', async () => {
    asPlatform('linux')
    expect(await outcome(spawn({}, S, CODEX))).toBe('started')
    expect(looks.nodeAsked).toBe(0)
  })

  it('on Windows it is not asked (node.exe is found another way)', async () => {
    asPlatform('win32')
    expect(await outcome(spawn({}, S, { ...CODEX, cwd: 'C:/w', useResumePicker: true }))).toBe('started')
    expect(looks.nodeAsked).toBe(0)
  })
})
