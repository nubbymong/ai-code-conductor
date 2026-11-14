// A local launch picks its assistant from the provider registry.
//
// A local launch looks its provider up in the registry, before it touches
// anything of the session: an assistant the app does not know, one that is
// not registered, or one whose package does not declare session launches is
// refused with a plain sentence, and nothing starts, never another assistant
// in its place. Claude Code, named or by default, starts, and its run is
// registered for the log under the provider the lookup found. A terminal tab
// starts no assistant, so it is not asked and still opens.
//
// How each assistant is started is its own row of a table, and the Claude Code
// row is Claude Code's alone: any other id that carried a copy of it is
// refused, not started the way Claude Code is. Whether an assistant's sessions
// start on this computer is the accounts service's answer (its `session.launch`
// declaration on this platform, with the experimental ones the owner enabled),
// so the PTY manager and the service cannot disagree; with no service to ask,
// the registry's own declaration answers.
//
// The real spawnPty over the real registry: the Claude Code package as the app
// ships it (its capability declarations included), with a stand-in session
// that hands back a fixed shell, and, where a case asks it, the real accounts
// service over the registry. node-pty records, nothing is started, and any
// other program a child-process call asks for is recorded and refused. The
// cases that put the other assistant's own package behind a launch are in
// tests/wp1/launch-handoff-pty.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  spawns: [] as Array<{ file: string; cwd: string }>,
  /** How often each stand-in process was told to end, in spawn order. */
  kills: [] as number[],
  /** Whether logging's record of each session's conversation is there to ask. */
  binder: false,
  /** Every session id that record was asked about (the conversation a Restart resumes). */
  binderAsked: [] as string[],
  /** Main's accounts service, or null for "main has none". */
  service: null as unknown,
  /** Whether the log service is running, and every run it was told started. */
  logging: false,
  runs: [] as Array<{ sessionId: string; provider: string }>,
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
  spawn: (file: string, _args: string[], opts: { cwd: string }) => {
    h.spawns.push({ file, cwd: opts.cwd })
    const n = h.kills.push(0) - 1
    return { pid: 4343, cols: 80, rows: 24, process: file,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() { h.kills[n]++ }, pause() {}, resume() {}, clear() {} }
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
vi.mock('../../../src/main/logging/logging-service', () => ({
  // The log service: none, unless a case turns it on to see which runs a
  // launch registers (logging is on in the settings these launches read).
  getLogSupervisor: () => (h.logging ? {
    runStart: (run: { sessionId: string; provider: string }) => { h.runs.push({ sessionId: run.sessionId, provider: run.provider }) },
    runEnd: () => {},
  } : null),
  // The record a launch reads the conversation to resume from. It holds none
  // here; a case that turns it on sees which sessions it was asked about.
  getTranscriptBinder: () => (h.binder ? {
    getExactResumeTarget: (id: string) => { h.binderAsked.push(id); return null },
    getLatestTranscriptPath: () => null,
    registerRun: () => {}, endRun: () => {}, notifyTranscriptPath: () => {},
  } : null),
}))
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

// Main's accounts service: none, unless a case builds the real one.
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => h.service }))

const { spawnPty, killPty, isSessionWritable, launchStyleOf, LOCAL_LAUNCH_STYLE } = await import('../../../src/main/pty-manager')
const { PROVIDER_IDS, CAPABILITY_PLATFORMS, isCapabilityPlatform } = await import('../../../src/shared/providers')
const { registerProviderPackage, listProviderPackages, _resetProviderRegistryForTest, AccountsService, ConsumerLeaseRegistry, SecretHandleStore } = await import('../../../src/main/providers/core')
const { createClaudePackage } = await import('../../../src/main/providers/claude')
type CapabilityPlatform = (typeof CAPABILITY_PLATFORMS)[number]

// Claude Code is the first provider id in the app's own list; the second is the
// other assistant the app knows, which this test never registers.
const [CLAUDE, OTHER] = PROVIDER_IDS
const SHELL = 'stand-in-shell'
const NOT_KNOWN = /is not one this app can start/
/** The platform these tests run on, as the capability declarations name it. */
const HERE: CapabilityPlatform = isCapabilityPlatform(process.platform) ? process.platform : 'linux'

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const ids = ['not-known', 'not-registered', 'no-launch', 'by-default', 'named', 'tab', 'tab-no-launch', 'running', 'experimental']
let project = ''
type Declared = 'supported' | 'unsupported' | 'unknown' | 'experimental'

/** Register the Claude Code package as the app ships it, with a stand-in
 *  session, `launch` as what it declares about starting sessions, and
 *  `shownName` as the name its session is shown by (its own when absent). */
function registerClaude(launch: Declared = 'supported', shownName?: string): void {
  const real = createClaudePackage()
  const session = Object.assign(Object.create(Object.getPrototypeOf(real.session) as object), real.session, {
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: SHELL, args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
    ...(shownName === undefined ? {} : { displayName: shownName }),
  })
  _resetProviderRegistryForTest()
  registerProviderPackage({ ...real, session, capabilities: { ...real.capabilities, 'session.launch': { state: launch } } })
}

/** The real accounts service over the registered packages, on `platform`,
 *  with `experimental` as the declarations the owner enabled. */
function accountsService(platform: CapabilityPlatform, experimental: string[] = []): InstanceType<typeof AccountsService> {
  return new AccountsService({
    store: () => null,
    leases: new ConsumerLeaseRegistry(),
    secrets: new SecretHandleStore({ now: () => 0 }),
    packages: () => listProviderPackages(),
    preference: () => 'on',
    experimentalEnabled: () => experimental as never,
    platform,
    randomHex: () => '0'.repeat(32),
  })
}

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-launch-registry-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  h.spawns.length = 0
  h.kills.length = 0
  h.binder = false
  h.binderAsked.length = 0
  h.otherChildren.length = 0
  h.service = null
  h.logging = false
  h.runs.length = 0
  registerClaude()
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  _resetProviderRegistryForTest()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(h.root).startsWith('pty-launch-registry-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a local launch of an assistant the registry does not hold', () => {
  // Mutation to prove this can fail: start Claude Code for every provider id
  // that is not the other assistant's (the bare `else` this replaced).
  it('an assistant the app does not know is refused: nothing starts, and Claude Code does not run in its place', () => {
    expect(() => spawnPty(win, 'not-known', { provider: 'elsewhere', cwd: project } as never)).toThrow(NOT_KNOWN)
    expect(h.spawns).toEqual([])
  })

  it('an assistant the app knows but has not registered is refused the same way', () => {
    expect(OTHER, 'the app lists a second assistant').toBeTruthy()
    expect(() => spawnPty(win, 'not-registered', { provider: OTHER, cwd: project } as never)).toThrow(NOT_KNOWN)
    expect(h.spawns).toEqual([])
  })

  it('the sentence names the assistant asked for, with nothing in it a terminal would act on', () => {
    let message = ''
    try { spawnPty(win, 'not-known', { provider: 'else\u001b[31mwhere', cwd: project } as never) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(NOT_KNOWN)
    expect(message).toContain('else')
    expect(message).not.toContain('\u001b')
    expect(h.spawns).toEqual([])
  })
})

describe('a local launch of a registered assistant that does not declare session launches', () => {
  // Mutation to prove this can fail: do not ask for the capability.
  for (const state of ['unsupported', 'unknown'] as const) {
    it(`declared ${state}: refused, and nothing starts, with or without an accounts service to ask`, () => {
      registerClaude(state)
      expect(() => spawnPty(win, 'no-launch', { provider: CLAUDE, cwd: project } as never)).toThrow(/cannot start sessions on this computer/)
      h.service = accountsService(HERE)
      expect(() => spawnPty(win, 'no-launch', { provider: CLAUDE, cwd: project } as never)).toThrow(/cannot start sessions on this computer/)
      expect(h.spawns).toEqual([])
    })
  }

  it('the sentence names the assistant by the name the app shows it by', () => {
    registerClaude('unsupported')
    expect(() => spawnPty(win, 'no-launch', { provider: CLAUDE, cwd: project } as never)).toThrow('Claude Code cannot start sessions on this computer. Nothing was started.')
  })

  // Mutation to prove this can fail: put the shown name into the sentence as it is.
  it('a shown name carrying an escape sequence reaches the sentence without it', () => {
    registerClaude('unsupported', 'Claude\u001b]8;;https://example.invalid\u0007 Code\u009b31m\u202e')
    let message = ''
    try { spawnPty(win, 'no-launch', { provider: CLAUDE, cwd: project } as never) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/cannot start sessions on this computer/)
    expect(message).toContain('Claude')
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(h.spawns).toEqual([])
  })
})

describe('a declaration marked experimental starts sessions only once the owner has enabled it for that assistant', () => {
  const launch = (): void => spawnPty(win, 'experimental', { provider: CLAUDE, cwd: project } as never)

  // The accounts service resolves the declaration with the owner's list, and
  // the PTY manager takes that answer. Mutation to prove this can fail:
  // resolve the declaration in the PTY manager without the owner's list.
  it('enabled for it: the accounts service says its sessions start, and the launch starts', () => {
    registerClaude('experimental')
    const service = accountsService(HERE, [`${CLAUDE}:session.launch`])
    h.service = service
    expect(service.localLaunchRefusal(CLAUDE)).toBeNull()
    expect(launch).not.toThrow()
    expect(h.spawns).toEqual([{ file: SHELL, cwd: project }])
  })

  it('not enabled: the accounts service refuses, and so does the launch', () => {
    registerClaude('experimental')
    const service = accountsService(HERE, [])
    h.service = service
    expect(service.localLaunchRefusal(CLAUDE)).not.toBeNull()
    expect(launch).toThrow(/cannot start sessions on this computer/)
    expect(h.spawns).toEqual([])
  })

  it('enabled for the other assistant only: refused', () => {
    registerClaude('experimental')
    h.service = accountsService(HERE, [`${OTHER}:session.launch`])
    expect(launch).toThrow(/cannot start sessions on this computer/)
    expect(h.spawns).toEqual([])
  })

  it('with no accounts service to ask, the registry\'s own declaration answers, and nothing experimental is enabled', () => {
    registerClaude('experimental')
    expect(launch).toThrow(/cannot start sessions on this computer/)
    expect(h.spawns).toEqual([])
  })

  it('the accounts service is the one asked: its answer decides, whatever the registry would say by itself', () => {
    // The registry by itself says Claude Code's sessions start; a service that refuses is believed.
    const asked: string[] = []
    h.service = { localLaunchRefusal: (id: string) => { asked.push(id); return { ok: false, code: 'capability-disabled' } } }
    expect(launch).toThrow(/cannot start sessions on this computer/)
    expect(asked).toEqual([CLAUDE])
    expect(h.spawns).toEqual([])
  })
})

describe('how an assistant is started is its own row, and the Claude Code row is Claude Code\'s alone', () => {
  it('every provider id the app knows has a row, and exactly Claude Code has the Claude Code row', () => {
    expect(Object.keys(LOCAL_LAUNCH_STYLE).sort()).toEqual([...PROVIDER_IDS].sort())
    for (const id of PROVIDER_IDS) expect(launchStyleOf(id), id).toBeDefined()
    expect(PROVIDER_IDS.filter((id) => launchStyleOf(id) === 'claude-shell')).toEqual([CLAUDE])
  })

  it('an id with no row has no way to start', () => {
    for (const id of ['elsewhere', '', 'toString', '__proto__', undefined, null, 7]) expect(launchStyleOf(id), String(id)).toBeUndefined()
  })

  // Mutation to prove this can fail: take the row as it stands, whatever id it is under.
  it('a third id given a copy of the Claude Code row has no way to start, and the two the app knows keep theirs', () => {
    const widened = { ...LOCAL_LAUNCH_STYLE, third: LOCAL_LAUNCH_STYLE[CLAUDE] }
    expect(launchStyleOf('third', widened)).toBeUndefined()
    expect(launchStyleOf(CLAUDE, widened)).toBe(LOCAL_LAUNCH_STYLE[CLAUDE])
    expect(launchStyleOf(OTHER, widened)).toBe(LOCAL_LAUNCH_STYLE[OTHER])
  })
})

describe('a refused launch for a session that is running changes nothing of it', () => {
  // The launch is refused before the session's process is ended and before
  // the conversation a Restart would resume is read. Mutation to prove this
  // can fail: look the provider up after the running process was ended.
  const refusals: Array<[string, () => Record<string, unknown>, RegExp]> = [
    ['an assistant the app does not know', () => ({ provider: 'elsewhere' }), NOT_KNOWN],
    ['an assistant the app knows but has not registered', () => ({ provider: OTHER }), NOT_KNOWN],
    ['an assistant that declares no session launches', () => { registerClaude('unsupported'); return { provider: CLAUDE } }, /cannot start sessions on this computer/],
  ]
  for (const [what, refusedOptions, sentence] of refusals) {
    it(`${what}: the running process is not ended, and the conversation to resume is not read`, () => {
      h.binder = true
      spawnPty(win, 'running', { cwd: project })
      expect(h.spawns).toHaveLength(1)
      expect(h.binderAsked, 'a launch that starts reads the conversation its session was on').toEqual(['running'])
      h.binderAsked.length = 0
      expect(() => spawnPty(win, 'running', { ...refusedOptions(), cwd: project } as never)).toThrow(sentence)
      expect(h.kills, 'the running process was ended for a launch that was refused').toEqual([0])
      expect(h.binderAsked, 'the conversation to resume was read for a launch that was refused').toEqual([])
      expect(isSessionWritable('running'), 'the session still has its process').toBe(true)
      expect(h.spawns, 'nothing new started').toHaveLength(1)
      // A launch that may start replaces the running process, as before.
      registerClaude()
      spawnPty(win, 'running', { cwd: project })
      expect(h.kills).toEqual([1, 0])
      expect(h.binderAsked).toEqual(['running'])
    })
  }
})

describe('the run a local launch is registered as, for the log', () => {
  // A launch that names no assistant starts Claude Code, and its run is
  // registered under the provider the lookup found, as a launch that names
  // Claude Code is. Mutation to prove this can fail: register the run from
  // the name the session gave, which is none.
  it('a session that names no assistant is registered as a Claude Code run, as one that names Claude Code is', () => {
    h.logging = true
    spawnPty(win, 'by-default', { cwd: project })
    spawnPty(win, 'named', { provider: CLAUDE, cwd: project } as never)
    expect(h.runs).toEqual([{ sessionId: 'by-default', provider: CLAUDE }, { sessionId: 'named', provider: CLAUDE }])
  })

  it('a terminal tab starts no assistant and registers no run, whatever it names', () => {
    h.logging = true
    spawnPty(win, 'tab', { shellOnly: true, cwd: project })
    spawnPty(win, 'tab-no-launch', { shellOnly: true, provider: CLAUDE, cwd: project } as never)
    expect(h.runs).toEqual([])
  })
})

describe('what is unchanged', () => {
  it('a session that names no assistant starts Claude Code', () => {
    expect(() => spawnPty(win, 'by-default', { cwd: project })).not.toThrow()
    expect(h.spawns).toEqual([{ file: SHELL, cwd: project }])
  })

  it('a session that names Claude Code starts it', () => {
    expect(() => spawnPty(win, 'named', { provider: CLAUDE, cwd: project } as never)).not.toThrow()
    expect(h.spawns).toEqual([{ file: SHELL, cwd: project }])
  })

  it('a terminal tab starts no assistant and is not asked: it opens whatever assistant it names', () => {
    expect(() => spawnPty(win, 'tab', { shellOnly: true, provider: 'elsewhere', cwd: project } as never)).not.toThrow()
    expect(h.spawns).toHaveLength(1)
  })

  it('a terminal tab opens though the assistant it names declares no session launches', () => {
    registerClaude('unsupported')
    expect(() => spawnPty(win, 'tab-no-launch', { shellOnly: true, provider: CLAUDE, cwd: project } as never)).not.toThrow()
    expect(h.spawns).toHaveLength(1)
  })
})
