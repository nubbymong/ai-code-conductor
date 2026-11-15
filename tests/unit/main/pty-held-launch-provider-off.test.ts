// A launch the PTY manager holds asks the launch rule again before it starts.
//
// A local Claude Code launch on an account is held inside the PTY manager
// while the account's sign-in is being refreshed, and again while the
// project's settings are checked. pty:spawn asks main's launch rule before
// those waits (provider-launch-gate.ts), and a wait can be long, so the held
// launch asks the same rule again when each wait ends. Refused (its assistant
// was switched off meanwhile, or the setting can no longer be read), it
// starts nothing, says why in the terminal before the exit, and gives up its
// hold on the account. A terminal tab starts no assistant and is never asked.
//
// The real spawnPty and the real launch rule; only the accounts service's
// answer is scripted. An account is a folder under this test's own root; the
// Claude Code package is the app's own with a stand-in session; node-pty
// records, nothing is started, and any other program a child-process call asks
// for is recorded and refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Refusal = { code: string; providerId: string; message: string }
const h = vi.hoisted(() => ({
  root: '',
  spawns: [] as string[],
  otherChildren: [] as string[],
  /** The accounts service, or null for "main has none". */
  service: null as null | { launchRefusal: (id: string) => Refusal | null; localLaunchRefusal: (id: string) => unknown },
  /** Whether the assistant's sessions start on this computer, as the service answers now. */
  startsHere: true,
  /** What the service answers for a launch now (null: it may start). */
  refusal: null as Refusal | null,
  /** Every provider id the launch rule was asked about. */
  asked: [] as string[],
  /** The account's sign-in folder check, held open by a case that needs to act while the project is checked. */
  folderCheck: null as Promise<void> | null,
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
    h.spawns.push(file)
    return { pid: 4343, cols: 80, rows: 24, process: file,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
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
// The session liveness record is the real one: a held launch that fails reads
// from it whether a process of the session has still to report its end.
vi.mock('../../../src/main/session-registry', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/session-registry')>()), updateSessionMeta: () => {}, clearSessionMeta: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))
// The project's settings are clean: these cases are about the wait, not the check.
vi.mock('../../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunchDirs: async () => ({ status: 'clean' }),
}))
// An account is a folder under the test's root, named by an id of the real
// shape; nothing of a real account is read or changed.
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
    withProfileHome: (env: Record<string, string>) => ({ ...env }),
  }
})
// The accounts service's answer is the only thing scripted; the rule that asks
// it (provider-launch-gate.ts) is the real one.
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => h.service }))

const consumers = await import('../../../src/main/profile-consumers')
const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { PROVIDER_IDS, providerOffMessage, providerStateUnknownMessage } = await import('../../../src/shared/providers')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

// Claude Code is the first provider id in the app's own list.
const [CLAUDE] = PROVIDER_IDS
const OFF: Refusal = { code: 'provider-off', providerId: CLAUDE, message: providerOffMessage('Claude Code') }
const UNREADABLE: Refusal = { code: 'provider-state-unknown', providerId: CLAUDE, message: providerStateUnknownMessage('Claude Code') }

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
/** The held launch has ended one way or the other: it started, or it said it did not. */
const settled = (id: string): Promise<void> => until(() => h.spawns.length > 0 || sent(`pty:exit:${id}`).length > 0, `the held launch ${id} to start or to say it did not`)

const ids = ['held-refresh', 'held-project', 'held-unreadable', 'held-no-service', 'held-still-on', 'held-tab', 'held-both', 'held-not-here']
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

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-held-launch-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  consumers._resetProfileConsumersForTest()
  h.spawns.length = 0; h.otherChildren.length = 0; h.asked.length = 0; payloads.length = 0
  h.refusal = null
  h.startsHere = true
  h.folderCheck = null
  // Claude Code's sessions start on this computer (the PTY manager asks that too).
  h.service = {
    launchRefusal: (id: string) => { h.asked.push(id); return h.refusal },
    localLaunchRefusal: () => (h.startsHere ? null : { ok: false, code: 'capability-disabled' }),
  }
  registerFakeClaudePackage({
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: 'stand-in-shell', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
  })
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  consumers._resetProfileConsumersForTest()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(h.root).startsWith('pty-held-launch-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a Claude Code launch held in the PTY manager, whose assistant is switched off while it waits', () => {
  // Mutation to prove this can fail: start the held launch without asking the
  // launch rule again (as before).
  it('held for a sign-in refresh: when the wait ends nothing starts, the terminal says why before the exit, and the account is let go', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    expect(() => spawnPty(win, 'held-refresh', { profileId: id, cwd: project })).not.toThrow()
    expect(h.spawns, 'held: nothing has started').toEqual([])
    expect(consumers.profileConsumerCount(id), 'the wait holds the account').toBeGreaterThan(0)
    // The user switches Claude Code off in Settings while the launch waits.
    h.refusal = OFF
    refreshDone()
    await settled('held-refresh')
    expect(h.spawns, 'nothing started after the switch-off').toEqual([])
    expect(h.asked).toEqual([CLAUDE])
    expect(terminal('held-refresh')).toContain(OFF.message)
    expect(payloads.findIndex(([c]) => c === 'pty:data:held-refresh')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:held-refresh'))
    expect(sent('pty:exit:held-refresh')).toEqual([-1])
    expect(consumers.profileConsumerCount(id), 'the hold on the account was released').toBe(0)
  })

  it('held for the check of the project settings: the same', async () => {
    const id = account()
    let checked!: () => void
    h.folderCheck = new Promise<void>((resolve) => { checked = resolve })
    expect(() => spawnPty(win, 'held-project', { profileId: id, cwd: project })).not.toThrow()
    expect(h.spawns).toEqual([])
    h.refusal = OFF
    checked()
    await settled('held-project')
    expect(h.spawns).toEqual([])
    expect(terminal('held-project')).toContain(OFF.message)
    expect(sent('pty:exit:held-project')).toEqual([-1])
    expect(consumers.profileConsumerCount(id)).toBe(0)
  })

  // The two waits follow one another (the refresh, then the project check),
  // and the rule is asked when each ends. Mutation to prove this can fail: ask
  // only when the first wait ends.
  it('switched off after the first wait ended and before the second did: still nothing starts', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    let checked!: () => void
    h.folderCheck = new Promise<void>((resolve) => { checked = resolve })
    spawnPty(win, 'held-both', { profileId: id, cwd: project })
    refreshDone()
    // The first wait ended with Claude Code on; the launch now waits for the project check.
    await until(() => h.asked.length === 1, 'the rule to be asked when the refresh wait ended')
    expect(h.spawns).toEqual([])
    h.refusal = OFF
    checked()
    await settled('held-both')
    expect(h.spawns).toEqual([])
    expect(h.asked).toEqual([CLAUDE, CLAUDE])
    expect(terminal('held-both')).toContain(OFF.message)
    expect(consumers.profileConsumerCount(id)).toBe(0)
  })
})

describe('a held launch whose setting cannot be read when the wait ends', () => {
  it('main could not read whether the assistant is on: no answer is never a yes, and nothing starts', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'held-unreadable', { profileId: id, cwd: project })
    h.refusal = UNREADABLE
    refreshDone()
    await settled('held-unreadable')
    expect(h.spawns).toEqual([])
    expect(terminal('held-unreadable')).toContain(UNREADABLE.message)
  })

  // Mutation to prove this can fail: treat "no accounts service" as nothing to ask.
  it('main has no accounts service to ask: refused the same way', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'held-no-service', { profileId: id, cwd: project })
    h.service = null
    refreshDone()
    await settled('held-no-service')
    expect(h.spawns).toEqual([])
    expect(sent('pty:exit:held-no-service')).toEqual([-1])
    expect(terminal('held-no-service')).toContain('could not read whether')
  })
})

describe('a held launch whose assistant no longer starts sessions on this computer when the wait ends', () => {
  // The launch that goes on after a wait looks its provider up again, as a
  // launch that was not held does. Mutation to prove this can fail: go on
  // after the wait with what the lookup answered before it.
  it('nothing starts, and the terminal says so before the exit', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    expect(() => spawnPty(win, 'held-not-here', { profileId: id, cwd: project })).not.toThrow()
    expect(h.spawns).toEqual([])
    h.startsHere = false
    refreshDone()
    await settled('held-not-here')
    expect(h.spawns).toEqual([])
    expect(terminal('held-not-here')).toContain('Claude Code cannot start sessions on this computer. Nothing was started.')
    expect(payloads.findIndex(([c]) => c === 'pty:data:held-not-here')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:held-not-here'))
    expect(sent('pty:exit:held-not-here')).toEqual([-1])
    expect(consumers.profileConsumerCount(id), 'the hold on the account was released').toBe(0)
  })
})

describe('what is unchanged', () => {
  it('the assistant is still on when the waits end: the launch starts, once', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'held-still-on', { profileId: id, cwd: project })
    refreshDone()
    await settled('held-still-on')
    expect(h.spawns).toEqual(['stand-in-shell'])
    expect(sent('pty:exit:held-still-on')).toEqual([])
    expect(h.asked.every((asked) => asked === CLAUDE)).toBe(true)
  })

  // A terminal tab runs no assistant: main's rule is never asked about it.
  it('a terminal tab held the same way opens though the assistant is off, and the rule is not asked', async () => {
    const id = account()
    const refreshDone = refreshUnderWay(id)
    spawnPty(win, 'held-tab', { shellOnly: true, profileId: id, cwd: project })
    h.refusal = OFF
    refreshDone()
    await settled('held-tab')
    expect(h.spawns).toHaveLength(1)
    expect(h.asked).toEqual([])
    expect(sent('pty:exit:held-tab')).toEqual([])
  })
})
