/**
 * 2.1.3-beta.6, plan section E: a Codex launch that resumes a conversation
 * waits, before it starts, for the look at that conversation's folders by real
 * path (the Codex provider's warmResumeLookup), asked off the event loop, through
 * the REAL pty:spawn handler.
 *
 * The look itself is covered where it lives (resume-real-path.test.ts); here it
 * is a stand-in the test answers, so what is checked is the handler's wiring:
 * if the call or its wait is removed, the launch starts before the look has
 * ended; if the conversation it names is not the one pty-manager resumes, or it
 * asks for a launch that resumes nothing, these fail. pty-manager and the
 * accounts service are faked, so nothing spawns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))

interface Target { uuid: string; cwd: string }
interface KeptSource { uuid: string; cwd: string; accountId: string; uncertain: boolean; unconfirmed: boolean }
const look = vi.hoisted(() => ({
  asked: [] as Array<{ target: Target; sessionsDir: string }>,
  prepared: 0,
  ends: Promise.resolve() as Promise<void>,
  fails: false,
  provided: true,
  kept: undefined as Target | undefined,
  keptSource: undefined as KeptSource | undefined,
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
  getKeptCodexConversationSource: () => look.keptSource,
  getKeptCodexConversation: () => look.kept,
  codexRunEnded: async () => true,
  codexConversationHeldElsewhere: () => false,
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
    prepareLaunch: async () => {
      look.prepared++
      return { ok: true, lease: { accountId: 'acct-1', release: () => {} }, executable: '/proven/codex', env: {}, sessionsDir: '/realm/sessions', home: '/realm' }
    },
    carryConversation: async () => ({ ok: true, carried: 'copied' }),
    snapshot: () => ({ accounts: [] }),
  }),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: () => Promise.resolve(),
}))
// The handler asks the Codex provider (through the core registry, never the
// package's own modules); the provider is a stand-in that records the question
// and answers when the test says.
vi.mock('../../../src/main/providers/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/core')>()),
  tryGetProvider: (id: string) => (id === 'codex'
    ? {
        warmResumeListNode: () => Promise.resolve(),
        ...(look.provided
          ? {
              warmResumeLookup: (target: Target, sessionsDir: string) => {
                look.asked.push({ target: { ...target }, sessionsDir })
                return look.fails ? Promise.reject(new Error('the look failed')) : look.ends
              },
            }
          : {}),
      }
    : null),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!

const S = 'c1d2e3f4a5b6c1d2e3f4a5b6'
const U1 = '019dd000-0001-7000-8000-0000000000a1'
const U2 = '019dd000-0001-7000-8000-0000000000a2'
const CODEX = { cwd: '/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }
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
function heldLook(): { ends: Promise<void>; end: () => void } {
  let end = (): void => {}
  const ends = new Promise<void>((resolve) => { end = () => resolve() })
  return { ends, end }
}

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const asPlatform = (value: string): void => { Object.defineProperty(process, 'platform', { value, configurable: true }) }

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear()
  look.asked.length = 0
  look.prepared = 0
  look.ends = Promise.resolve()
  look.fails = false
  look.provided = true
  look.kept = undefined
  look.keptSource = undefined
})
afterEach(() => { Object.defineProperty(process, 'platform', PLATFORM) })

describe('a Codex launch that resumes a conversation waits for the look at its folders', () => {
  // Mutation to prove this can fail: drop the call, or its await: the launch
  // then starts before the look has ended, or never asks.
  it('the conversation the request names: it starts only once the look has ended, and the look is for that conversation and the launch\'s own sessions folder', async () => {
    const held = heldLook()
    look.ends = held.ends
    const started = outcome(spawn({}, S, { ...CODEX, resume: { uuid: U1, cwd: '/proj/link' } }))
    await settle()
    expect(look.asked).toEqual([{ target: { uuid: U1, cwd: '/proj/link' }, sessionsDir: '/realm/sessions' }])
    expect(spawnPty, 'nothing starts while the look is under way').not.toHaveBeenCalled()
    held.end()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: never read the kept conversation.
  it('on a restart, the conversation the tab is on (pty-manager resumes that one)', async () => {
    look.kept = { uuid: U2, cwd: '/proj/real' }
    const held = heldLook()
    look.ends = held.ends
    const started = outcome(spawn({}, S, CODEX))
    await settle()
    expect(look.asked).toEqual([{ target: { uuid: U2, cwd: '/proj/real' }, sessionsDir: '/realm/sessions' }])
    expect(spawnPty).not.toHaveBeenCalled()
    held.end()
    expect(await started).toBe('started')
  })

  // Mutation to prove this can fail: prefer the kept conversation.
  it('the request\'s own conversation wins over the kept one, as in pty-manager', async () => {
    look.kept = { uuid: U2, cwd: '/proj/real' }
    expect(await outcome(spawn({}, S, { ...CODEX, resume: { uuid: U1, cwd: '/proj/link' } }))).toBe('started')
    expect(look.asked.map((a) => a.target.uuid)).toEqual([U1])
  })

  // Mutation to prove this can fail: warm the kept conversation after the picker.
  it('a launch that opens the resume list does not warm the kept conversation (pty-manager resumes none)', async () => {
    asPlatform('linux')
    look.kept = { uuid: U2, cwd: '/proj/real' }
    expect(await outcome(spawn({}, S, { ...CODEX, useResumePicker: true }))).toBe('started')
    expect(look.asked).toEqual([])
  })

  it('but one that names its conversation as well still warms that one', async () => {
    asPlatform('linux')
    expect(await outcome(spawn({}, S, { ...CODEX, useResumePicker: true, resume: { uuid: U1, cwd: '/proj/link' } }))).toBe('started')
    expect(look.asked.map((a) => a.target.uuid)).toEqual([U1])
  })

  // Mutation to prove this can fail: ignore the fresh-conversation rule.
  it('a respawn that starts a new conversation (its claim was not certain) does not warm the kept one', async () => {
    look.kept = { uuid: U2, cwd: '/proj/real' }
    look.keptSource = { uuid: U2, cwd: '/proj/real', accountId: 'acct-other', uncertain: true, unconfirmed: false }
    expect(await outcome(spawn({}, S, CODEX))).toBe('started')
    expect(look.prepared).toBe(1)
    expect(look.asked).toEqual([])
  })

  it('a launch that resumes nothing asks nothing', async () => {
    expect(await outcome(spawn({}, S, CODEX))).toBe('started')
    expect(look.prepared).toBe(1)
    expect(look.asked).toEqual([])
  })
})

describe('what is left to the spelling', () => {
  // Mutation to prove this can fail: drop the SSH condition.
  it('a launch over SSH is not looked at (nothing Codex runs there is resumed from this computer)', async () => {
    const ssh = { host: 'h.example', port: 22, username: 'u', remotePath: '~/p' }
    const result = await outcome(spawn({}, S, { ...CODEX, ssh, resume: { uuid: U1, cwd: '/proj/link' } }))
    expect(look.prepared, `the Codex launch was prepared (${result})`).toBe(1)
    expect(look.asked).toEqual([])
  })

  // Mutation to prove this can fail: drop the Ask condition.
  it('an Ask Conductor launch is not looked at (its folder is the help folder)', async () => {
    expect(await outcome(spawn({}, S, { ...CODEX, isAsk: true, resume: { uuid: U1, cwd: '/proj/link' } }))).toBe('started')
    expect(look.prepared).toBe(1)
    expect(look.asked).toEqual([])
  })
})

describe('a look that does not work never stops a launch', () => {
  // Mutation to prove this can fail: take the try/catch away.
  it('one that fails: the launch starts, comparing the spelling', async () => {
    look.fails = true
    expect(await outcome(spawn({}, S, { ...CODEX, resume: { uuid: U1, cwd: '/proj/link' } }))).toBe('started')
    expect(look.asked).toHaveLength(1)
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('a provider with no such look: the launch starts', async () => {
    look.provided = false
    expect(await outcome(spawn({}, S, { ...CODEX, resume: { uuid: U1, cwd: '/proj/link' } }))).toBe('started')
    expect(look.asked).toEqual([])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })
})
