/**
 * pty:spawn asks, for ANY assistant, whether its sessions run on another
 * machine before it loads anything for an SSH spawn: the accounts service's
 * question (its `session.ssh` capability) takes any provider id. The
 * assistant an SSH launch starts is asked about whichever one it is, and a
 * terminal tab over SSH is asked about the assistant it names, when it names
 * one. Refused: nothing is spawned and the saved password is never read.
 *
 * With no accounts service to ask, the registry's own declaration answers, so
 * an assistant that does run on another machine is not refused for the
 * service's sake (a terminal tab that names it still opens).
 *
 * Driven through the real handler on a fake ipcMain; pty-manager is faked, so
 * nothing spawns, and the configs file and the keychain are stand-ins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  // A launch main holds first (none is expected to be here) starts the same way.
  beginSpawnPreparation: (win: unknown, sid: string) => ({ current: true, spawn: (o: unknown) => spawnPty(win, sid, o), abandon: vi.fn() }),
  isSessionLiveOrStarting: () => false,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))

let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null) }))
const keychain = vi.hoisted(() => ({ reads: [] as string[] }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => { keychain.reads.push(k); return 'pw' } }))
// Every provider is on here: main's on/off rule has its own suite
// (pty-spawn-provider-off.test.ts); these cases are about the other machine.
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

// What the accounts service answers about a provider's sessions on another
// machine (null: they run there), and each provider it was asked about.
const acct = vi.hoisted(() => ({
  present: true,
  asked: [] as string[],
  refusals: {} as Record<string, { ok: false; code: string; message: string } | undefined>,
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => (acct.present ? { remoteLaunchRefusal: (id: string) => { acct.asked.push(id); return acct.refusals[id] ?? null } } : null),
}))
// The registry's own declarations, as stand-ins: which providers declare
// sessions on another machine, and what each is called.
const registry = vi.hoisted(() => ({ remote: new Set<string>(), names: {} as Record<string, string> }))
vi.mock('../../../src/main/providers/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/core')>()),
  providerCapability: (id: string, key: string) => ({ key, state: 'supported', enabled: key === 'session.ssh' && registry.remote.has(id), labelExperimental: false }),
  tryGetProviderPackage: (id: string) => (registry.names[id] ? { id, displayName: registry.names[id] } : null),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { PROVIDER_IDS } = await import('../../../src/shared/providers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

// Claude Code is the first provider id in the app's own list; the second is
// the other assistant the app knows.
const [CLAUDE, OTHER] = PROVIDER_IDS
const SSH = { host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj' }
const HERE_ONLY = (name: string) => ({ ok: false as const, code: 'unsupported', message: `${name} runs on this computer only in this release; it is not available in SSH sessions.` })

beforeEach(() => {
  spawnPty.mockClear()
  keychain.reads.length = 0
  acct.present = true
  acct.asked.length = 0
  acct.refusals = {}
  registry.remote = new Set([CLAUDE])
  registry.names = { [CLAUDE]: 'Claude Code', [OTHER]: 'Second Assistant' }
  configsOnDisk = [{ id: 'cfgssh', sessionType: 'ssh', sshConfig: { ...SSH, hasPassword: true } }]
})

describe('an SSH launch asks whether its assistant runs on another machine, whichever assistant it is', () => {
  // Mutation to prove this can fail: ask only when the session names one
  // particular assistant (as before).
  it('a launch that names no assistant is asked about Claude Code, and starts when it runs there', async () => {
    await spawn({}, SID, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } })
    expect(acct.asked).toEqual([CLAUDE])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('a launch that names Claude Code is asked about it', async () => {
    await spawn({}, SID, { cwd: 'C:/w', provider: CLAUDE, configId: 'cfgssh', ssh: { ...SSH } })
    expect(acct.asked).toEqual([CLAUDE])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('refused for Claude Code as for any other: nothing is spawned, the saved password is never read, and the sentence names it', async () => {
    acct.refusals[CLAUDE] = HERE_ONLY('Claude Code')
    await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } }))
      .rejects.toThrow('Claude Code session refused: Claude Code runs on this computer only in this release; it is not available in SSH sessions.')
    expect(spawnPty).not.toHaveBeenCalled()
    expect(keychain.reads).toEqual([])
  })

  it('the other assistant is asked the same question and refused in the same sentence', async () => {
    acct.refusals[OTHER] = HERE_ONLY('Second Assistant')
    await expect(spawn({}, SID, { cwd: 'C:/w', provider: OTHER, configId: 'cfgssh', ssh: { ...SSH } }))
      .rejects.toThrow('Second Assistant session refused: Second Assistant runs on this computer only in this release; it is not available in SSH sessions.')
    expect(acct.asked).toEqual([OTHER])
    expect(spawnPty).not.toHaveBeenCalled()
    expect(keychain.reads).toEqual([])
  })

  it('a local launch is not asked', async () => {
    await spawn({}, SID, { cwd: 'C:/w' })
    expect(acct.asked).toEqual([])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })
})

describe('a terminal tab over SSH', () => {
  it('that names no assistant is not asked, and opens', async () => {
    acct.refusals[CLAUDE] = HERE_ONLY('Claude Code')
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgssh', ssh: { ...SSH } })
    expect(acct.asked).toEqual([])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('is asked about the assistant it names: refused before anything is loaded when that one runs on this computer only', async () => {
    acct.refusals[OTHER] = HERE_ONLY('Second Assistant')
    await expect(spawn({}, SID, { cwd: 'C:/w', shellOnly: true, provider: OTHER, configId: 'cfgssh', ssh: { ...SSH } }))
      .rejects.toThrow(/^Second Assistant session refused: .*this computer only/)
    expect(spawnPty).not.toHaveBeenCalled()
    expect(keychain.reads).toEqual([])
  })

  it('opens when the assistant it names runs on another machine', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, provider: CLAUDE, configId: 'cfgssh', ssh: { ...SSH } })
    expect(acct.asked).toEqual([CLAUDE])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })
})

describe('with no accounts service to ask, the registry\'s own declaration answers', () => {
  beforeEach(() => { acct.present = false })

  it('a terminal tab naming an assistant that declares sessions on another machine still opens', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, provider: CLAUDE, configId: 'cfgssh', ssh: { ...SSH } })
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: with no service, refuse nothing.
  it('one naming an assistant that does not declare them is refused, and nothing is loaded for it', async () => {
    await expect(spawn({}, SID, { cwd: 'C:/w', shellOnly: true, provider: OTHER, configId: 'cfgssh', ssh: { ...SSH } }))
      .rejects.toThrow('Second Assistant session refused: Accounts are not ready yet.')
    expect(spawnPty).not.toHaveBeenCalled()
    expect(keychain.reads).toEqual([])
  })

  it('an assistant the registry does not hold is refused: no declaration is never a yes', async () => {
    registry.remote = new Set()
    registry.names = {}
    await expect(spawn({}, SID, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } })).rejects.toThrow(/session refused: Accounts are not ready yet\./)
    expect(spawnPty).not.toHaveBeenCalled()
  })
})
