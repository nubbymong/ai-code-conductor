// 2.1.3-beta.19 section 2 (aicc_planning#439), step 2.1.1: what a local Codex
// launch, a take-over of a kept session, the serving of one whose tab is not
// shown, its description for keeping and the unbind of each do today,
// recorded at cc36c7f3 (v2.1.3-beta.18) BEFORE the launch's body moves into
// the Codex package (2.1.2) and the bindings into each provider's lifecycle
// object (2.1.3). Pure moves change none of it: this file and its record
// (tests/fixtures/local-launch-characterisation.json) are not edited by
// either step, so the table is equal before and after.
//
// What is recorded, in order, for each case: the command the provider's
// builder was asked for (the saved options as the launch hands them over),
// the program, arguments, environment and folder the terminal was started
// with (and which ConPTY, and whether the session helper holds it), each
// file the launch asked to be written or removed (hook files, folders), the
// account lease, the hooks token, the telemetry the launch subscribed to, the
// pane, the registrations (review, canvas, tool host), Ask Conductor's
// question, the log lines, then what the session's kill or exit unbound.
//
// The REAL spawnPty, the REAL provider registry and the REAL Claude Code and
// Codex packages, each with a stand-in session that records (Object.create of
// the real one, so a member a later step adds to the package, such as its
// local launch group or its lifecycle object, is the package's own). The
// spawn, the session helper, the ConPTY choice, the hooks gateway and the
// tool host are recorded; nothing is started.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Rec = Record<string, unknown>
const h = vi.hoisted(() => ({
  journal: [] as Array<[string, unknown]>,
  root: '',
  resources: '',
  held: false,
  conpty: 'bundled' as 'bundled' | 'system' | 'none',
  bundledFails: false,
  systemFails: false,
  gateway: false,
  hookFileOk: true,
  mcpPort: 0,
  toolsOn: false,
  resumeFound: true,
  resumeCwdMismatch: false,
  pickFile: false,
  cmdRoute: false,
  askOnArgv: true,
  hooksInstalled: true,
  telemetryPick: null as unknown,
  ptyCount: 0,
  exits: [] as Array<() => void>,
}))
const rec = (what: string, detail?: unknown): void => { h.journal.push([what, detail ?? null]) }

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// node-pty is never reached for these launches (the session helper's spawn is
// recorded below); a call here is recorded so a case shows it.
vi.mock('node-pty', () => ({ spawn: (file: string) => { rec('node-pty spawn', file); throw new Error('node-pty is not used in this test') } }))
vi.mock('../../../src/main/session-helper/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/session-helper/manager')>()
  const { HelperPty } = await import('../../../src/main/session-helper/helper-pty')
  return {
    ...real,
    spawnAgentPty: (ctx: { sessionId: string; kind: string }, file: string, args: string[] | string, opts: Rec) => {
      const { name, cols, rows, cwd, env, ...conpty } = opts
      rec('spawn', { kind: ctx.kind, file, args, name, cols, rows, cwd, env, conpty })
      const viaBundled = (conpty as Rec).useConptyDll === true
      if (viaBundled && h.bundledFails) throw new Error('the bundled console host did not start')
      if (!viaBundled && h.systemFails) throw new Error('File not found: ' + file)
      const n = ++h.ptyCount
      const proc = (h.held ? Object.create(HelperPty.prototype) : {}) as Rec
      const exits: Array<(e: { exitCode: number }) => void> = []
      for (const [k, v] of Object.entries({
        pid: 7000 + n, cols: 120, rows: 30, process: file, handleFlowControl: false,
        onData: () => ({ dispose: () => {} }),
        onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => {} } },
        write: () => {}, resize: () => {}, pause: () => {}, resume: () => {}, clear: () => {},
        kill: () => { rec('kill', n) },
      })) Object.defineProperty(proc, k, { value: v, writable: true, configurable: true })
      h.exits.push(() => { for (const cb of [...exits]) cb({ exitCode: 0 }) })
      return proc
    },
  }
})
vi.mock('../../../src/main/bundled-conpty', () => ({
  bundledConptyChoice: () => (h.conpty === 'bundled' ? { kind: 'bundled', dir: '/bundled-conpty', options: { useConptyDll: true } }
    : h.conpty === 'system' ? { kind: 'system', reason: 'the bundled files are missing', options: { useConptyDll: false } }
      : { kind: 'none', options: {} }),
  bundledConptyFailed: (why: string) => { rec('bundledConptyFailed', why) },
  SYSTEM_CONPTY_OPTIONS: { useConptyDll: false },
  BUNDLED_EARLY_EXIT_MS: 5000,
}))
vi.mock('../../../src/main/debug-logger', () => {
  const keep = (line: string): void => { if (/Codex|Ask |took over|kept for this tab|claude_review|codex_review|canvas/.test(line)) rec('log', line) }
  return { logInfo: keep, logWarn: keep, logError: keep, logDebug: () => {} }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resources, getDataDirectory: () => h.resources, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => h.mcpPort,
  registerClaudeReviewSession: (sid: string, cwd: string) => { rec('registerClaudeReviewSession', { sid, cwd }) },
  registerCodexReviewSession: (sid: string, cwd: string) => { rec('registerCodexReviewSession', { sid, cwd }) },
  unregisterCodexReviewSession: (sid: string) => { rec('unregisterCodexReviewSession', sid) },
  releaseMcpSessionProvider: (sid: string) => { rec('releaseMcpSessionProvider', sid) },
  recordHeldToolSession: (sid: string, provider: string) => { rec('recordHeldToolSession', { sid, provider }) },
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/conductor-tools-switch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-tools-switch')>()),
  conductorToolsMasterOn: () => h.toolsOn,
}))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => (h.gateway ? {
    status: () => ({ listening: true, port: 4545 }),
    registerSession: (sid: string) => { rec('gateway token', sid); return `secret-${sid}` },
    unregisterSession: (sid: string) => { rec('gateway drop', sid) },
  } : null),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: (sid: string) => { rec('remove settings file', sid) },
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: (sid: string) => { rec('remove mcp file', sid) },
  removeLocalSessionStatusUrl: (sid: string) => { rec('remove status-url file', sid) },
  getLocalSessionStatusUrlPath: (sid: string) => path.join(h.root, 'status-url', `${sid}.url`),
  writeLocalSessionStatusUrl: (sid: string, url: string) => { rec('write status-url file', { sid, url }) },
  noteKeptLaunchStatusLine: (sid: string) => { rec('noteKeptLaunchStatusLine', sid) },
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: (sid: string, profile?: string) => { rec('captureClaudeAccount', { sid, profile: profile ?? null }) },
  clearClaudeAccount: (sid: string) => { rec('clearClaudeAccount', sid) },
  getAccountIdentity: () => null,
  pushAccountIdentity: (sid: string) => { rec('pushAccountIdentity', sid) },
  startWatchingAccountIdentity: (sid: string, profile?: string) => { rec('startWatchingAccountIdentity', { sid, profile: profile ?? null }) },
  stopWatchingAccountIdentity: (sid: string) => { rec('stopWatchingAccountIdentity', sid) },
  getWatchedProfileId: () => null,
  getClaudeProfileId: () => undefined,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/canvas/canvas-plugin')>()),
  ensureCanvasPlugin: () => null,
}))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.resources,
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ localLaunchRefusal: () => null, launchRefusal: () => null }) }))
vi.mock('../../../src/main/session-input', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/session-input')>()),
  askQuestion: async (_win: unknown, sid: string, question: string) => { rec('askQuestion', { sid, question }); return { ok: true } },
}))

const { spawnPty, killPty, holdsCodexLaunchLease, getKeptCodexConversation } = await import('../../../src/main/pty-manager')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const { createClaudePackage } = await import('../../../src/main/providers/claude')
const { createCodexPackage } = await import('../../../src/main/providers/codex')
const { setKeptTakeOver, setKeptLaunchCheck, serveKeptLaunch, unserveKeptLaunch, describeKeptLaunch } = await import('../../../src/main/sessions/kept-launches')
const { HelperPty } = await import('../../../src/main/session-helper/helper-pty')
const { askConductorProjectDocMaxBytes } = await import('../../../src/main/help-workspace')

/** An Ask launch's project_doc_max_bytes is the size of the AGENTS.md the help
 *  folder holds plus a margin (help-workspace.ts askConductorProjectDocMaxBytes):
 *  the whole user guide on Windows, the preamble alone elsewhere, so the number
 *  differs by system and grows with the guide. It is recorded as this name when
 *  it is exactly that function's number, so the record holds on every system
 *  and after any guide edit; any other number is recorded as it is and fails
 *  the case. (The record at cc36c7f3 held 218222, the Windows number then.) */
const ASK_DOC_SIZE = '<askConductorProjectDocMaxBytes()>'
function askDocSized(opts: Rec): Rec {
  return opts.askProjectDocMaxBytes === askConductorProjectDocMaxBytes() ? { ...opts, askProjectDocMaxBytes: ASK_DOC_SIZE } : opts
}

/** `real` with the members in `over` in place of its own (its prototype, its
 *  own members and anything a later step adds to it kept). */
function standIn<T extends object>(real: T, over: Rec): T {
  const copy = Object.create(Object.getPrototypeOf(real) as object) as T
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(real))
  for (const [k, v] of Object.entries(over)) Object.defineProperty(copy, k, { value: v, writable: true, configurable: true, enumerable: true })
  return copy
}

/** Each case its own session id, so nothing a case left in the PTY manager's
 *  per-session records reaches the next. */
let SID = ''
let caseNumber = 0
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]

function register(): void {
  const claude = createClaudePackage()
  const codex = createCodexPackage()
  const codexScreen = codex.session.runScreen!
  const runScreen = standIn(codexScreen, {
    open: (sid: string, o: Rec) => { rec('pane open', { sid, cols: o.cols, rows: o.rows, held: typeof o.held === 'function', current: typeof o.current === 'function', clamp: typeof o.clamp === 'function' }) },
    feed: () => {},
    resize: () => {},
    close: (sid: string) => { rec('pane close', sid) },
    has: () => false,
  })
  const codexSession = standIn(codex.session, {
    buildSpawnCommand: (opts: Rec) => {
      rec('build', askDocSized(opts))
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string>; sessionsDir: string }
      const env: Record<string, string> = { ...launch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) }
      const resume = opts.resume as { uuid: string; cwd: string } | undefined
      const found = resume && h.resumeFound
        ? { resumeId: resume.uuid, cwd: resume.cwd, resumePath: `${launch.sessionsDir}/rollout-${resume.uuid}.jsonl`, ...(h.resumeCwdMismatch ? { resumeCwdMismatch: true } : {}) }
        : opts.useResumePicker && h.pickFile ? { pickFile: path.join(h.root, 'pick', 'pick.json'), pickFolder: { id: 'pick-folder', real: path.join(h.root, 'pick') } } : {}
      const hooks = opts.codexHooks && h.hooksInstalled ? { hooksInstalled: true } : {}
      const ask = opts.askPrompt && h.askOnArgv ? { askPromptOnArgv: true } : {}
      const extra = (opts.codexOptions as { extraArgs?: string } | undefined)?.extraArgs
      const args = ['--sandbox', 'read-only', ...(extra ? extra.split(' ') : [])]
      return h.cmdRoute
        ? { cmd: 'C:/Windows/System32/cmd.exe', args: [], env, commandLine: `/d /s /c ""${launch.executable}" ${args.join(' ')}"`, logLine: 'via cmd.exe', ...found, ...hooks, ...ask }
        : { cmd: launch.executable, args, env, logLine: args.join(' '), ...found, ...hooks, ...ask }
    },
    prepareSessionHooks: (sid: string, port: number) => {
      rec('prepareSessionHooks', { sid, port })
      return h.hookFileOk ? { hookFile: path.join(h.root, 'hooks', sid, 'hook.json'), dispose: () => { rec('hook file dispose', sid) } } : null
    },
    rewriteSessionHooks: (dir: string, sid: string, port: number) => {
      rec('rewriteSessionHooks', { dir, sid, port })
      return h.hookFileOk ? { hookFile: path.join(dir, 'hook.json'), dispose: () => { rec('kept hook file dispose', sid) } } : null
    },
    removeSessionHookFolder: (dir: string) => { rec('removeSessionHookFolder', dir) },
    removeSessionPickFolder: (pick: unknown) => { rec('removeSessionPickFolder', pick) },
    ingestSessionTelemetry: (sid: string, opts: Rec) => {
      const { onClaim, onRelease, onShared, onRollout, ...rest } = opts
      rec('telemetry', { sid, ...rest, callbacks: [onClaim, onRelease, onShared, onRollout].map((f) => typeof f) })
      return { stop: (o?: unknown) => { rec('telemetry stop', o ?? null) }, pick: () => h.telemetryPick, recheckShared: () => false }
    },
    runScreen,
  })
  const claudeSession = standIn(claude.session, {
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: 'stand-in-shell', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
    statusPostUrl: (sid: string) => `http://127.0.0.1:4646/status/${sid}`,
  })
  _resetProviderRegistryForTest()
  registerProviderPackage({ ...claude, session: claudeSession })
  registerProviderPackage({ ...codex, session: codexSession })
}

/** The account launch pty:spawn prepares: `kind` the account's realm. */
function account(kind: 'managed' | 'own' | 'bare', extra: Rec = {}): Rec {
  const realm = path.join(h.root, 'realms', kind)
  return {
    lease: { accountId: `acct-${kind}`, release: () => { rec('lease release', kind) } },
    executable: path.join(h.root, 'bin', 'codex.exe'),
    env: { PATH: '/usr/bin', CODEX_HOME: realm },
    sessionsDir: path.join(realm, 'sessions'),
    ...(kind === 'managed' ? { home: realm, ownership: 'conductor-managed' } : kind === 'own' ? { ownership: 'external-default' } : {}),
    ...extra,
  }
}

const codexOptions = { permissionsPreset: 'read-only' as const }
function codex(extra: Rec = {}): void {
  spawnPty(fakeWin, SID, { cwd: path.join(h.root, 'project'), provider: 'codex', codexOptions, codexLaunch: account('managed') as never, ...extra } as never)
}

/** Every value made comparable across machines: the test's own folders by
 *  name, separators as /, times as <t>, functions by kind. */
function normal(v: unknown): unknown {
  const roots = [[fs.realpathSync.native(h.root), '<root>'], [h.root, '<root>'], [os.homedir(), '<home>'], [realOrSame(os.homedir()), '<home>'], [SID, '<sid>']] as const
  if (typeof v === 'string') {
    let s = v
    for (const [from, to] of roots) {
      for (const f of [from, from.replace(/\\/g, '/'), from.replace(/\\/g, '\\\\')]) s = s.split(f).join(to)
    }
    return s.replace(/\\/g, '/')
  }
  if (v === undefined) return '<undefined>'
  if (typeof v === 'number') return v > 1e12 ? '<t>' : v
  if (typeof v === 'function') return '<function>'
  if (Array.isArray(v)) return v.map(normal)
  if (v && typeof v === 'object') {
    if (v instanceof HelperPty) return '<held terminal>'
    const out: Rec = {}
    for (const k of Object.keys(v).sort()) out[k] = normal((v as Rec)[k])
    return out
  }
  return v
}

function realOrSame(p: string): string {
  try { return fs.realpathSync.native(p) } catch { return p }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** The journal of what happened, then the state the launch left. */
function snapshot(): unknown {
  const out = normal([...h.journal]) as unknown[]
  h.journal.length = 0
  return out
}
function state(extra: Rec = {}): unknown {
  const kept = getKeptCodexConversation(SID)
  return normal({ kept: kept ?? null, ...extra })
}

interface Case { name: string; run: () => Promise<unknown> | unknown }

/** A launch, what it left, then its kill (the unbind). */
function launchCase(name: string, setup: () => void, options: () => Rec = () => ({}), tail: 'kill' | 'exit' = 'kill'): Case {
  return {
    name,
    run: async () => {
      setup()
      const extra = options()
      const lease = (Object.hasOwn(extra, 'codexLaunch') ? extra.codexLaunch : account('managed')) as Rec | undefined
      let threw: string | null = null
      try { codex({ codexLaunch: lease, ...extra }) } catch (e) { threw = (e as Error).message }
      await flush()
      const launched = snapshot()
      const after = state({ holdsLease: lease ? holdsCodexLaunchLease(SID, lease.lease as never) : false, threw })
      if (tail === 'kill') { try { killPty(SID) } catch { /* not started */ } } else { h.exits.at(-1)?.() }
      await flush()
      return { launched, after, unbound: snapshot() }
    },
  }
}

const project = (): string => path.join(h.root, 'project')
const elsewhere = (): string => path.join(h.root, 'elsewhere')
const UUID_A = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

const cases: Case[] = [
  launchCase('managed account, fresh, bundled ConPTY, hooks gateway off, tools off', () => {}),
  launchCase('hooks gateway on and listening, tools on and served', () => { h.gateway = true; h.mcpPort = 4747; h.toolsOn = true }),
  launchCase('hooks gateway on, the hook file not written', () => { h.gateway = true; h.hookFileOk = false }),
  launchCase('hooks gateway on, the launch cannot carry hooks', () => { h.gateway = true; h.hooksInstalled = false }),
  launchCase('this computer\'s own sign-in (no app-managed home)', () => {}, () => ({ codexLaunch: account('own') })),
  launchCase('an account with no home and no ownership recorded', () => {}, () => ({ codexLaunch: account('bare') })),
  launchCase('exact resume of a restored tab\'s conversation, found in the realm', () => {}, () => ({ resume: { uuid: UUID_A, cwd: elsewhere() } })),
  launchCase('exact resume whose rollout does not record the kept folder', () => { h.resumeCwdMismatch = true }, () => ({ resume: { uuid: UUID_A, cwd: elsewhere() } })),
  launchCase('exact resume not found in the realm', () => { h.resumeFound = false }, () => ({ resume: { uuid: UUID_A, cwd: elsewhere() } })),
  launchCase('a fresh conversation asked by the account launch (carry not certain)', () => {}, () => ({ resume: { uuid: UUID_A, cwd: elsewhere() }, codexLaunch: account('managed', { freshConversation: true }) })),
  launchCase('the resume list with a pick file', () => { h.pickFile = true }, () => ({ useResumePicker: true })),
  launchCase('the resume list with no pick file', () => {}, () => ({ useResumePicker: true })),
  launchCase('Ask Conductor, its question on argv', () => {}, () => ({ isAsk: true, askPrompt: 'How do I add a machine?' })),
  launchCase('Ask Conductor, its question typed at the first ready composer', () => { h.askOnArgv = false }, () => ({ isAsk: true, askPrompt: 'How do I add a machine?' })),
  launchCase('Ask Conductor resuming a conversation of another folder', () => {}, () => ({ isAsk: true, resume: { uuid: UUID_A, cwd: elsewhere() } })),
  launchCase('Ask Conductor resuming a conversation of its own folder', () => {}, () => ({ isAsk: true, resume: { uuid: UUID_A, cwd: project() } })),
  launchCase('an opening question on a launch that is not Ask Conductor\'s', () => {}, () => ({ askPrompt: 'ignored' })),
  launchCase('held by the session helper', () => { h.held = true }),
  launchCase('the npm .cmd route through cmd.exe', () => { h.cmdRoute = true }),
  launchCase('the bundled ConPTY fails to start: the system one', () => { h.bundledFails = true }),
  launchCase('the system ConPTY chosen', () => { h.conpty = 'system' }),
  launchCase('no ConPTY choice (not Windows)', () => { h.conpty = 'none' }),
  launchCase('both ConPTYs fail: nothing runs, the lease goes', () => { h.bundledFails = true; h.systemFails = true; h.gateway = true }),
  launchCase('a folder "." (home fallback)', () => {}, () => ({ cwd: '.' })),
  launchCase('no folder', () => {}, () => ({ cwd: undefined })),
  launchCase('a folder that does not exist', () => {}, () => ({ cwd: path.join(h.root, 'no-such-folder') })),
  launchCase('extra arguments and a model in the saved options', () => {}, () => ({ codexOptions: { permissionsPreset: 'standard', model: 'gpt-x', reasoningEffort: 'high', extraArgs: '--search -c a=b' } })),
  launchCase('no account launch: refused, nothing started', () => {}, () => ({ codexLaunch: undefined })),
  launchCase('its own exit (natural end)', () => { h.gateway = true }, () => ({}), 'exit'),
  {
    name: 'a Restart resumes the conversation the tab is on',
    run: async () => {
      codex({ resume: { uuid: UUID_A, cwd: project() } })
      snapshot()
      codex({})
      await flush()
      const launched = snapshot()
      killPty(SID)
      await flush()
      return { launched, after: state(), unbound: snapshot() }
    },
  },
  {
    name: 'the resume list ("Restart and pick") does not take the kept conversation',
    run: async () => {
      codex({ resume: { uuid: UUID_A, cwd: project() } })
      snapshot()
      codex({ useResumePicker: true })
      await flush()
      const launched = snapshot()
      killPty(SID)
      await flush()
      return { launched, after: state(), unbound: snapshot() }
    },
  },
]

/** A take-over: the helper hands this tab's kept session back. */
function takeOverCase(name: string, keptOf: () => Rec, opts: { provider: 'codex' | 'claude'; withLease?: boolean; profileId?: string; isAsk?: boolean; statusFile?: boolean }): Case {
  return {
    name,
    run: async () => {
      h.gateway = true
      h.held = true
      if (opts.statusFile) { fs.mkdirSync(path.join(h.root, 'status-url'), { recursive: true }); fs.writeFileSync(path.join(h.root, 'status-url', `${SID}.url`), '') }
      const asked: unknown[] = []
      const kept = keptOf()
      setKeptTakeOver((sid, provider, size, ...account) => {
        asked.push({ sid, provider, size, account })
        const n = ++h.ptyCount
        const proc = Object.create(HelperPty.prototype) as Rec
        const exits: Array<(e: { exitCode: number }) => void> = []
        for (const [k, v] of Object.entries({ pid: 8000 + n, cols: 120, rows: 30, process: 'kept', onData: () => ({ dispose: () => {} }), onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => {} } }, write: () => {}, resize: () => {}, kill: () => { rec('kill', `kept ${n}`) } })) Object.defineProperty(proc, k, { value: v, writable: true, configurable: true })
        h.exits.push(() => { for (const cb of [...exits]) cb({ exitCode: 0 }) })
        return { pty: proc as never, kept: { conversation: null, account: null, hookFolder: null, folder: null, at: 0, ...kept } as never }
      })
      const lease = account('managed')
      let threw: string | null = null
      try {
        if (opts.provider === 'codex') spawnPty(fakeWin, SID, { cwd: project(), provider: 'codex', codexOptions, ...(opts.withLease === false ? {} : { codexLaunch: lease }), ...(opts.isAsk ? { isAsk: true } : {}) } as never)
        else spawnPty(fakeWin, SID, { cwd: project(), provider: 'claude', ...(opts.profileId ? { profileId: opts.profileId } : {}) } as never)
      } catch (e) { threw = (e as Error).message }
      await flush()
      const launched = snapshot()
      const after = state({ asked, threw, holdsLease: holdsCodexLaunchLease(SID, (lease as Rec).lease as never) })
      killPty(SID)
      await flush()
      return { launched, after, unbound: snapshot() }
    },
  }
}

const KEPT_HOOKS = (): string => path.join(h.root, 'hooks', 'kept-folder')
const takeOvers: Case[] = [
  takeOverCase('Codex, its hook events on the gateway: the kept hook file written again', () => ({ conversation: UUID_A, account: 'acct-managed', hookFolder: KEPT_HOOKS(), folder: elsewhere(), at: 1_700_000_000_000 }), { provider: 'codex' }),
  takeOverCase('Codex, its hook events through its holder', () => ({ conversation: UUID_A, account: 'acct-managed', hookFolder: KEPT_HOOKS(), folder: null, hooks: 'holder' }), { provider: 'codex', isAsk: true }),
  takeOverCase('Codex through the resume list, its pick kept', () => ({ conversation: null, account: 'acct-managed', hookFolder: null, folder: project(), pick: { file: path.join(h.root, 'pick.json'), folder: { id: 'p', real: 'p' }, decided: { id: UUID_A } } }), { provider: 'codex' }),
  takeOverCase('Codex with no prepared launch: not taken over, launched as before', () => ({ conversation: UUID_A, account: 'acct-managed' }), { provider: 'codex', withLease: false }),
  takeOverCase('Claude Code on a named account, its status line address file there', () => ({ conversation: UUID_A, account: 'prof-1', folder: elsewhere() }), { provider: 'claude', profileId: 'prof-1', statusFile: true }),
  takeOverCase('Claude Code on the default account, no status line file', () => ({ conversation: null, account: null }), { provider: 'claude' }),
]

/** A kept session served while its tab is not shown, then kept no longer. */
function serveCase(name: string, keptOf: () => Rec, port = 4747): Case {
  return {
    name,
    run: async () => {
      h.gateway = true
      h.mcpPort = port
      const served = serveKeptLaunch({ sessionId: SID, hookFolder: null, folder: null, ...keptOf() } as never, project())
      const launched = snapshot()
      unserveKeptLaunch(SID)
      return { launched, after: normal({ served }), unbound: snapshot() }
    },
  }
}
const serves: Case[] = [
  serveCase('Codex, its hook folder kept: the hook file written again', () => ({ provider: 'codex', hookFolder: KEPT_HOOKS() })),
  serveCase('Codex, its hook events through its holder', () => ({ provider: 'codex', hookFolder: KEPT_HOOKS(), hooks: 'holder' })),
  serveCase('Claude Code, launched in another folder', () => ({ provider: 'claude', folder: elsewhere() })),
  serveCase('the tool host not serving: nothing', () => ({ provider: 'codex', hookFolder: KEPT_HOOKS() }), 0),
]

/** What the release records of a session before an update keeps it. */
const describes: Case[] = [
  {
    name: 'a Codex session with a claimed conversation, hooks and a pick',
    run: async () => {
      h.gateway = true
      h.telemetryPick = { file: 'pick.json', folder: { id: 'p', real: 'p' } }
      codex({ resume: { uuid: UUID_A, cwd: project() } })
      snapshot()
      const facts = describeKeptLaunch(SID)
      killPty(SID)
      await flush()
      return { launched: [], after: normal(facts), unbound: snapshot() }
    },
  },
  {
    name: 'a session this run knows nothing of',
    run: () => ({ launched: [], after: normal(describeKeptLaunch('ch-nothing-known-000000001')), unbound: [] }),
  },
]

const RECORD = path.join(__dirname, '..', '..', 'fixtures', 'local-launch-characterisation.json')
const recorded = JSON.parse(fs.readFileSync(RECORD, 'utf8')) as Record<string, unknown>

beforeEach(() => {
  try { killPty(SID) } catch { /* nothing running */ }
  for (const exit of h.exits.splice(0)) exit()
  SID = `ch${String(++caseNumber).padStart(22, '0')}`
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-launch-char-')))
  madeRoots.push(h.root)
  h.resources = path.join(h.root, 'resources')
  for (const d of ['resources', 'project', 'elsewhere', path.join('realms', 'managed'), path.join('realms', 'own'), path.join('realms', 'bare'), 'bin']) fs.mkdirSync(path.join(h.root, d), { recursive: true })
  Object.assign(h, {
    held: false, conpty: 'bundled', bundledFails: false, systemFails: false, gateway: false, hookFileOk: true, mcpPort: 0, toolsOn: false,
    resumeFound: true, resumeCwdMismatch: false, pickFile: false, cmdRoute: false, askOnArgv: true, hooksInstalled: true, telemetryPick: null, ptyCount: 0,
  })
  setKeptTakeOver(() => null)
  setKeptLaunchCheck(() => false)
  register()
  h.journal.length = 0
})
const madeRoots: string[] = []
afterAll(() => {
  // TEST CLEANUP GUARD: only this test's own folders directly under the temp folder.
  for (const root of madeRoots) {
    if (path.basename(root).startsWith('local-launch-char-') && path.dirname(root) === fs.realpathSync.native(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
  }
  _resetProviderRegistryForTest()
  setKeptTakeOver(null)
  setKeptLaunchCheck(null)
})

describe('a local Codex launch, a take-over, the serving of a kept session, its description and each unbind: as recorded at cc36c7f3', () => {
  for (const [group, list] of [['launch', cases], ['take-over', takeOvers], ['serve', serves], ['describe', describes]] as const) {
    for (const c of list) {
      it(`${group}: ${c.name}`, async () => {
        const got = await c.run()
        expect(got, 'recorded at cc36c7f3: a pure move leaves it as it was').toEqual(recorded[`${group}: ${c.name}`])
      })
    }
  }
  it('the record holds exactly these cases', () => {
    const names = [['launch', cases], ['take-over', takeOvers], ['serve', serves], ['describe', describes]].flatMap(([g, l]) => (l as Case[]).map((c) => `${g as string}: ${c.name}`))
    expect(Object.keys(recorded).sort()).toEqual([...names].sort())
  })
})
