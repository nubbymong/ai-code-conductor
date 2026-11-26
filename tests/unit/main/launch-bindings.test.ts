// S16 step 3 (aicc_planning#375): a launch's bindings, called directly. Each
// bind makes its calls once, in the order pty-manager.ts made them, with the
// same log lines; each unbind drops what its bind made, once, in order. The
// session's own end removes all three per-session files with the token.
// tests/unit/main/launch-bindings-launch.test.ts holds pty-manager.ts to calling
// each one once per launch and once per end, at its place.
//
// Not checked here: whether or where pty-manager.ts calls these (the launch
// test does that); the collaborators themselves, each mocked here and tested
// on its own; the colour answer's bytes beyond their start (the responder's
// own tests read them).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const show = (a: unknown): string => (a === null || a === undefined || typeof a !== 'object' ? String(a) : '{}')
  const rec = (name: string) => (...args: unknown[]): void => { calls.push([name, ...args.map(show)].join(' ')) }
  return {
    calls, rec,
    listening: true, prepareThrows: false, registers: true, canvasRefuses: false, refusalReason: 'resources-dir',
    home: '/home/u',
    account: null as null | { email: string },
    infos: [] as string[], warns: [] as string[], errors: [] as string[],
  }
})

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({
    status: () => (h.listening ? { enabled: true, listening: true, port: 51234 } : { enabled: false, listening: false, port: null }),
    registerSession: (sid: string) => { h.rec('gateway.registerSession')(sid); return 'secret-1' },
  }),
}))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  removeLocalSessionSettings: (sid: string) => h.rec('removeLocalSessionSettings')(sid),
  removeLocalSessionMcpConfig: (sid: string) => h.rec('removeLocalSessionMcpConfig')(sid),
  removeLocalSessionStatusUrl: (sid: string) => h.rec('removeLocalSessionStatusUrl')(sid),
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { h.infos.push(m) },
  logWarn: (m: string) => { h.warns.push(m) },
  logError: (m: string) => { h.errors.push(m) },
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (name: string) => { h.rec('readConfig')(name); return name === 'configs' ? [] : {} } }))
vi.mock('../../../src/main/path-utils', () => ({ isHomeOrAncestor: (p: string) => p === h.home }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ clampAnsiChunk: (d: string) => d }))
vi.mock('../../../src/main/logging/should-register-run', () => ({ shouldRegisterRun: () => h.registers }))
vi.mock('../../../src/main/logging/indexing-gaps', () => ({ openNotIndexedWindow: (sid: string, p: string) => h.rec('openNotIndexedWindow')(sid, p) }))
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => ({
    runStart: (m: { sessionId: string; provider: string; projectCwd: string; accountEmail?: string; profileId?: string; configLabel: string }) => h.rec('runStart')(m.sessionId, m.provider, m.projectCwd, m.accountEmail, m.profileId, m.configLabel),
    runEnd: (sid: string, _at: number, how: string) => h.rec('runEnd')(sid, how),
  }),
}))
vi.mock('../../../src/main/logging/codex-log-binder', () => ({
  getCodexLogBinder: () => ({
    beginLaunch: (sid: string) => h.rec('binder.beginLaunch')(sid),
    startRun: (sid: string, indexed: boolean) => h.rec('binder.startRun')(sid, indexed),
    endRun: (sid: string) => h.rec('binder.endRun')(sid),
    noteRollout: (sid: string, r: { path: string } | null) => h.rec('binder.noteRollout')(sid, r ? r.path : null),
  }),
}))
vi.mock('../../../src/main/spawn-claude-command', () => ({ buildResumeTranscriptPath: (cwd: string, uuid: string) => `${cwd}/t/${uuid}.jsonl` }))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: (sid: string, p?: string) => h.rec('captureClaudeAccount')(sid, p),
  pushAccountIdentity: (sid: string) => h.rec('pushAccountIdentity')(sid),
  startWatchingAccountIdentity: (sid: string, p?: string) => h.rec('startWatchingAccountIdentity')(sid, p),
  getAccountIdentity: () => h.account,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  registerCodexReviewSession: (sid: string, cwd: string) => h.rec('registerCodexReviewSession')(sid, cwd),
  registerClaudeReviewSession: (sid: string, cwd: string) => h.rec('registerClaudeReviewSession')(sid, cwd),
  unregisterCodexReviewSession: (sid: string) => h.rec('unregisterCodexReviewSession')(sid),
  releaseMcpSessionProvider: (sid: string) => h.rec('releaseMcpSessionProvider')(sid),
}))
vi.mock('../../../src/main/canvas/canvas-store', () => ({
  registerCanvasUatRoot: (sid: string, cwd: string) => { h.rec('registerCanvasUatRoot')(sid, cwd); return !h.canvasRefuses },
  revokeCanvasUatRoots: (sid: string) => h.rec('revokeCanvasUatRoots')(sid),
  designateCanvasWorktreeRoot: (sid: string, wt: string) => { h.rec('designateCanvasWorktreeRoot')(sid, wt); return true },
  canvasRootRefusalReason: () => h.refusalReason,
  describeCanvasRootRefusal: (reason: string) => `refused as ${reason}.`,
  setCanvasRootRefusal: (sid: string, text: string) => h.rec('setCanvasRootRefusal')(sid, text),
}))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({ forgetCanvasMarkers: (sid: string) => h.rec('forgetCanvasMarkers')(sid) }))
vi.mock('../../../src/main/canvas/codex-canvas-roots', () => ({ registerCodexCanvasRoots: (sid: string, cwd: string, wt: string | null) => h.rec('registerCodexCanvasRoots')(sid, cwd, wt) }))
vi.mock('../../../src/main/canvas/codex-guidance', () => ({
  noteCodexSessionGuidance: (sid: string) => h.rec('noteCodexSessionGuidance')(sid),
  forgetCodexSessionGuidance: (sid: string) => h.rec('forgetCodexSessionGuidance')(sid),
}))

const lb = await import('../../../src/main/sessions/launch-bindings')
// 2.1.3-beta.19 section 2: each launch's bind is its package's lifecycle object's, and a Codex lease's unbind the Codex one's.
const { CODEX_LIFECYCLE } = await import('../../../src/main/providers/codex/lifecycle')
const { CLAUDE_LIFECYCLE } = await import('../../../src/main/providers/claude/lifecycle')
type Ports = Parameters<typeof lb.setLaunchBindingPorts>[0]

const SID = 'cx0000000000000000000001'
const OTHER = 'cx0000000000000000000002'
const CL = 'cl0000000000000000000001'
const ID = '019dd000-0001-7000-8000-00000000000a'

function makePorts() {
  return {
    ptySessions: new Map<string, { ptyProcess: unknown }>(),
    codexHookFiles: new Map<string, unknown>(),
    codexHookedLaunches: new Set<string>(),
    codexLaunchLeases: new Map<string, unknown>(),
    takenCodexLeases: new WeakSet<object>(),
    codexAskSessions: new Set<string>(),
    codexTelemetrySources: new Map<string, { stop(): void; recheckShared?(): void }>(),
    indexedRuns: new Map<string, { configId?: string; provider: string }>(),
    notIndexedSessions: new Map<string, { since: number; provider: string }>(),
    codexContextRollouts: new Map<string, { path: string; sessionsDir: string }>(),
    keptCodexConversations: new Map<string, unknown>(),
    lastCodexHookRollout: new Map<string, unknown>(),
    claudeTranscripts: new Map<string, unknown>(),
    claudeFolders: new Map<string, unknown>(),
    codexFolders: new Map<string, unknown>(),
    noteGatewayToken: (sid: string, codex: boolean) => h.rec('noteGatewayToken')(sid, codex),
    dropGatewayToken: (sid: string) => h.rec('dropGatewayToken')(sid),
    forgetCodexHooks: (sid: string) => h.rec('forgetCodexHooks')(sid),
    keepCodexConversation: (sid: string, c: { uuid: string }, account?: string, how?: { inferred: boolean }) => h.rec('keepCodexConversation')(sid, c.uuid, account, how?.inferred),
    markCodexConversationUncertain: (uuid: string) => h.rec('markCodexConversationUncertain')(uuid),
    clearCodexDoubtFromHook: (uuid: string) => h.rec('clearCodexDoubtFromHook')(uuid),
    noteCodexContextRollout: (sid: string, r: { path: string } | null) => h.rec('noteCodexContextRollout')(sid, r ? r.path : null),
    endSessionNotIndexed: (sid: string, _now: number, opts?: { coversStay?: boolean }) => h.rec('endSessionNotIndexed')(sid, opts?.coversStay === true),
    noteCodexFolder: (sid: string, cwd: string) => h.rec('noteCodexFolder')(sid, cwd),
    savedConfigLoggingOff: (_configs: unknown, configId: string | undefined, provider: string) => { h.rec('savedConfigLoggingOff')(configId, provider); return undefined },
    noteClaudeFolder: (sid: string, cwd: string) => h.rec('noteClaudeFolder')(sid, cwd),
    noteClaudeTranscript: (sid: string, t: string) => h.rec('noteClaudeTranscript')(sid, t),
    markSessionNotIndexed: (sid: string, provider: string, since: number) => h.rec('markSessionNotIndexed')(sid, provider, since),
    closeCodexRunScreen: (sid: string) => h.rec('closeCodexRunScreen')(sid),
  }
}
let ports = makePorts()

const hookFile = { hookFile: '/hooks/cx1/hook.json', dispose: () => h.rec('hookFile.dispose')() }
let telemetry: { opts: Record<string, any>; send: (d: unknown) => void } | null = null
const source = { stop: () => h.rec('source.stop')(), recheckShared: () => h.rec('source.recheckShared')() }
const provider = {
  prepareSessionHooks: (sid: string, port: number, secret: string) => {
    h.rec('prepareSessionHooks')(sid, port, secret)
    if (h.prepareThrows) throw new Error('no hook folder')
    return hookFile
  },
  ingestSessionTelemetry: (sid: string, opts: Record<string, any>, send: (d: unknown) => void) => {
    h.rec('ingestSessionTelemetry')(sid, opts.cwd, opts.spawnTimestamp, opts.sessionsDir, opts.resumeId)
    telemetry = { opts, send }
    return source
  },
}
const lease = { accountId: 'acct-a', release: () => h.rec('lease.release')() }
const sent: Array<[string, unknown]> = []
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } } }
const run = { pid: 1 }
const guidance = { line: 'skills' }

function codexLaunch(): void {
  CODEX_LIFECYCLE.bind({
    win: win as never, sessionId: SID, provider: provider as never,
    launch: { lease: lease as never, sessionsDir: '/realm/sessions' },
    codexCwd: '/proj/run', codexSpawnTimestamp: 1000, built: { resumeId: ID },
    resolvedCwd: '/proj/a', codexCanvas: { designatedWorktree: '/wt/a', guidance: guidance as never }, runProvider: 'codex',
  }, lb.lifecycleCore())
}

beforeEach(() => {
  h.calls.length = 0; h.infos.length = 0; h.warns.length = 0; h.errors.length = 0
  h.listening = true; h.prepareThrows = false; h.registers = true; h.canvasRefuses = false; h.refusalReason = 'resources-dir'; h.account = null
  telemetry = null; sent.length = 0; destroyed = false
  ports = makePorts()
  lb.setLaunchBindingPorts(ports as unknown as Ports)
})

describe('the ports', () => {
  it('a binding used before the PTY manager registered its ports says so, and does nothing', async () => {
    vi.resetModules()
    const fresh = await import('../../../src/main/sessions/launch-bindings')
    expect(() => fresh.unbindLaunchFiles(SID)).toThrow('The launch bindings were used before the PTY manager registered its ports.')
    expect(h.calls).toEqual([])
  })
})

describe('a Codex launch binds each thing once, in the order pty-manager.ts made them', () => {
  it('its hooks, its lease, its pane and its conversation and registrations', () => {
    ports.notIndexedSessions.set(SID, { since: 1, provider: 'codex' })
    ports.codexContextRollouts.set(SID, { path: '/other/r.jsonl', sessionsDir: '/other/sessions' })
    const hooks = lb.mintCodexHooks(SID, provider as never)
    expect(hooks).toEqual({ hookFile, tokenMinted: true })
    expect(lb.keepCodexHooks(SID, hooks, true)).toEqual({ hookFile: null, tokenMinted: true })
    lb.bindCodexLease(SID, lease as never)
    let pane: Record<string, any> | null = null
    const runScreen = { open: (sid: string, o: Record<string, any>) => { h.rec('runScreen.open')(sid, o.cols, o.rows); pane = o } }
    const writePane = (d: string) => h.rec('writePane')(d)
    lb.bindCodexPane({ sessionId: SID, codexRun: run as never, runScreen: runScreen as never, cols: 103, rows: 27, write: writePane, writeColourAnswer: () => {} })
    codexLaunch()
    expect(h.calls).toEqual([
      `gateway.registerSession ${SID}`,
      `noteGatewayToken ${SID} true`,
      `prepareSessionHooks ${SID} 51234 secret-1`,
      `runScreen.open ${SID} 103 27`,
      `binder.beginLaunch ${SID}`,
      `noteCodexFolder ${SID} /proj/run`,
      `ingestSessionTelemetry ${SID} /proj/run 1000 /realm/sessions ${ID}`,
      `registerClaudeReviewSession ${SID} /proj/a`,
      `registerCodexCanvasRoots ${SID} /proj/a /wt/a`,
      `noteCodexSessionGuidance ${SID}`,
    ])
    expect(ports.codexHookFiles.get(SID)).toBe(hookFile)
    expect(ports.codexHookedLaunches.has(SID)).toBe(true)
    expect(ports.codexLaunchLeases.get(SID)).toBe(lease)
    expect(ports.takenCodexLeases.has(lease)).toBe(true)
    expect(ports.codexTelemetrySources.get(SID)).toBe(source)
    // This launch is not yet known as not indexed; the other account's rollout went.
    expect(ports.notIndexedSessions.has(SID)).toBe(false)
    expect(ports.codexContextRollouts.has(SID)).toBe(false)
    // The pane types through pty-manager.ts's writer, and is current while the session's PTY is this run.
    expect(pane!.write).toBe(writePane)
    expect(pane!.current()).toBe(false)
    ports.ptySessions.set(SID, { ptyProcess: run })
    expect(pane!.current()).toBe(true)
    ports.ptySessions.set(SID, { ptyProcess: { pid: 2 } })
    expect(pane!.current()).toBe(false)
    expect(h.infos).toEqual([])
  })

  it('a hook file the launch does not carry goes at once, and so does its token; the gateway off mints nothing', () => {
    const hooks = lb.mintCodexHooks(SID, provider as never)
    expect(lb.keepCodexHooks(SID, hooks, false)).toEqual({ hookFile: null, tokenMinted: false })
    expect(h.calls.slice(3)).toEqual(['hookFile.dispose', `dropGatewayToken ${SID}`])
    expect(ports.codexHookFiles.size).toBe(0)
    expect(ports.codexHookedLaunches.size).toBe(0)
    h.calls.length = 0
    h.listening = false
    expect(lb.mintCodexHooks(OTHER, provider as never)).toEqual({ hookFile: null, tokenMinted: false })
    expect(h.calls).toEqual([])
  })

  it('a hook file that cannot be written: the token it minted is in the answer, and the log line is the same', () => {
    h.prepareThrows = true
    expect(lb.mintCodexHooks(SID, provider as never)).toEqual({ hookFile: null, tokenMinted: true })
    expect(h.errors).toEqual([`[pty] Failed to prepare Codex hooks for ${SID}: no hook folder`])
    expect(lb.keepCodexHooks(SID, { hookFile: null, tokenMinted: true }, false)).toEqual({ hookFile: null, tokenMinted: false })
    expect(h.calls.at(-1)).toBe(`dropGatewayToken ${SID}`)
  })

  it('the colour answer is written through pty-manager.ts\'s writer, and one that cannot be written is logged as before', () => {
    const answers: string[] = []
    const colours = lb.bindCodexPane({ sessionId: SID, codexRun: run as never, runScreen: undefined, cols: 80, rows: 24, write: () => {}, writeColourAnswer: (b) => { answers.push(b) } })
    expect(colours.filter('a\x1b]10;?\x07b')).not.toContain(']10;?')
    expect(answers).toHaveLength(1)
    expect(answers[0].startsWith('\x1b]10;rgb:')).toBe(true)
    const failing = lb.bindCodexPane({ sessionId: SID, codexRun: run as never, runScreen: undefined, cols: 80, rows: 24, write: () => {}, writeColourAnswer: () => { throw new Error('EPIPE') } })
    failing.filter('\x1b]11;?\x07')
    expect(h.warns).toEqual([`[pty-manager] Codex ${SID}: the terminal colour answer could not be written: EPIPE`])
  })

  it('its telemetry: a claim keeps the conversation on the launch\'s account, and a rollout opens a not-indexed window only for a record of the run\'s own assistant', () => {
    codexLaunch()
    h.calls.length = 0
    telemetry!.opts.onClaim({ id: ID, cwd: '/proj/run', exact: true, certain: false })
    expect(h.calls).toEqual([`keepCodexConversation ${SID} ${ID} acct-a false`, `markCodexConversationUncertain ${ID}`])
    h.calls.length = 0
    ports.notIndexedSessions.set(SID, { since: 5, provider: 'claude' })
    telemetry!.opts.onRollout({ path: '/realm/sessions/r.jsonl', sessionsDir: '/realm/sessions' })
    expect(h.calls).toEqual([`noteCodexContextRollout ${SID} /realm/sessions/r.jsonl`, `binder.noteRollout ${SID} /realm/sessions/r.jsonl`])
    h.calls.length = 0
    ports.notIndexedSessions.set(SID, { since: 5, provider: 'codex' })
    telemetry!.opts.onRollout({ path: '/realm/sessions/r.jsonl', sessionsDir: '/realm/sessions' })
    telemetry!.opts.onRollout(null)
    expect(h.calls).toEqual([
      `noteCodexContextRollout ${SID} /realm/sessions/r.jsonl`, `openNotIndexedWindow ${SID} /realm/sessions/r.jsonl`, `binder.noteRollout ${SID} /realm/sessions/r.jsonl`,
      `noteCodexContextRollout ${SID} null`, `endSessionNotIndexed ${SID} true`, `binder.noteRollout ${SID} null`,
    ])
    telemetry!.send({ tokens: 1 })
    destroyed = true
    telemetry!.send({ tokens: 2 })
    expect(sent).toEqual([['statusline:update', { tokens: 1 }]])
  })

  it('a project folder at or above home registers no review, with the same log line', () => {
    CODEX_LIFECYCLE.bind({
      win: win as never, sessionId: SID, provider: provider as never, launch: { lease: lease as never, sessionsDir: '/realm/sessions' },
      codexCwd: '/proj/run', codexSpawnTimestamp: 1000, built: {}, resolvedCwd: h.home, codexCanvas: { designatedWorktree: null, guidance: null }, runProvider: 'codex',
    }, lb.lifecycleCore())
    expect(h.calls.some((c) => c.startsWith('registerClaudeReviewSession'))).toBe(false)
    expect(h.calls.at(-2)).toBe(`registerCodexCanvasRoots ${SID} ${h.home} null`)
    expect(h.calls.at(-1)).toBe(`forgetCodexSessionGuidance ${SID}`)
    expect(h.warns).toEqual([`[pty] claude_review NOT registered for ${SID}: the project directory resolves to (or above) the home directory. Set a real project directory to enable review.`])
  })
})

describe('a Claude Code launch binds each thing once, in the order pty-manager.ts made them', () => {
  it('the account and its watch, the review, the canvas root and the designated worktree, with the same log line', () => {
    CLAUDE_LIFECYCLE.bind({ sessionId: CL, resolvedProfileId: 'prof-1', claudeCwd: '/proj/resumed', resolvedCwd: '/proj/a', designatedWorktree: '/wt/a' }, lb.lifecycleCore())
    expect(h.calls).toEqual([
      `captureClaudeAccount ${CL} prof-1`,
      `pushAccountIdentity ${CL}`,
      `startWatchingAccountIdentity ${CL} prof-1`,
      `registerCodexReviewSession ${CL} /proj/resumed`,
      `registerCanvasUatRoot ${CL} /proj/a`,
      `designateCanvasWorktreeRoot ${CL} /wt/a`,
    ])
    expect(h.infos).toEqual([`[pty] canvas: designated session worktree /wt/a for ${CL} (served once it exists)`])
    expect(h.warns).toEqual([])
  })

  it('a home folder registers neither the review nor the canvas root; a root the store refuses names its floor', () => {
    CLAUDE_LIFECYCLE.bind({ sessionId: CL, resolvedProfileId: undefined, claudeCwd: h.home, resolvedCwd: h.home, designatedWorktree: null }, lb.lifecycleCore())
    expect(h.calls).toEqual([
      `captureClaudeAccount ${CL} undefined`, `pushAccountIdentity ${CL}`, `startWatchingAccountIdentity ${CL} undefined`,
      `setCanvasRootRefusal ${CL} refused as home-or-ancestor.`,
    ])
    expect(h.warns).toEqual([
      `[pty] codex_review NOT registered for ${CL}: launch cwd resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home). Set a real project directory to enable review.`,
      `[pty] canvas serving root NOT registered for ${CL}: the configured project directory resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home).`,
    ])
    h.calls.length = 0; h.warns.length = 0
    h.canvasRefuses = true
    CLAUDE_LIFECYCLE.bind({ sessionId: CL, resolvedProfileId: undefined, claudeCwd: '/proj/a', resolvedCwd: '/proj/a', designatedWorktree: null }, lb.lifecycleCore())
    expect(h.calls.slice(-2)).toEqual([`registerCanvasUatRoot ${CL} /proj/a`, `setCanvasRootRefusal ${CL} refused as resources-dir.`])
    expect(h.warns).toEqual([`[pty] canvas serving root NOT registered for ${CL} (resources-dir): refused as resources-dir.`])
    // 2.1.3-beta.19 fix round: a folder INSIDE the resources directory is the app's own help folder (Ask
    // Conductor), refused by design: one line of the log, not a warning.
    h.calls.length = 0; h.warns.length = 0; h.infos.length = 0
    h.refusalReason = 'inside-resources-dir'
    CLAUDE_LIFECYCLE.bind({ sessionId: CL, resolvedProfileId: undefined, claudeCwd: '/res/help', resolvedCwd: '/res/help', designatedWorktree: null }, lb.lifecycleCore())
    expect(h.calls.slice(-1)).toEqual([`setCanvasRootRefusal ${CL} refused as inside-resources-dir.`])
    expect(h.warns).toEqual([])
    expect(h.infos).toContain(`[pty] canvas serving root NOT registered for ${CL} (inside-resources-dir): refused as inside-resources-dir.`)
  })
})

describe('the logging run', () => {
  const base = { options: { configId: 'cfg-1', configLabel: 'Work' }, localLaunch: null, effectiveLaunchCwd: '/proj/a', resumeUuidForBind: null, resolvedProfileId: 'prof-1', codexLaunchedAt: 111, claudeLaunchedAt: 222 }

  it('an indexed Claude Code run: its folder and resumed transcript noted, recorded for the switches, then started', () => {
    h.account = { email: 'a@example.invalid' }
    const r = lb.bindLoggingRun({ ...base, sessionId: CL, localLaunch: { id: 'claude' }, resumeUuidForBind: ID, runProvider: 'claude', codexRunProvider: false, claudeRunProvider: true, provider: 'claude' })
    expect(r.codexLocalRun).toBe(false)
    expect(r.logSup).not.toBeNull()
    expect(h.calls).toEqual([
      'readConfig settings', 'readConfig configs', 'savedConfigLoggingOff cfg-1 claude',
      `noteClaudeFolder ${CL} /proj/a`, `noteClaudeTranscript ${CL} /proj/a/t/${ID}.jsonl`,
      `runStart ${CL} claude /proj/a a@example.invalid prof-1 Work`,
    ])
    expect(ports.indexedRuns.get(CL)).toEqual({ configId: 'cfg-1', provider: 'claude' })
  })

  it('an indexed Codex run: recorded under the launch\'s own provider, started, and its log binder told it is indexed', () => {
    const r = lb.bindLoggingRun({ ...base, sessionId: SID, localLaunch: { id: 'codex' }, runProvider: 'codex', codexRunProvider: true, claudeRunProvider: false, provider: 'codex' })
    expect(r.codexLocalRun).toBe(true)
    expect(h.calls.slice(3)).toEqual([`runStart ${SID} codex /proj/a undefined prof-1 Work`, `binder.startRun ${SID} true`])
    expect(ports.indexedRuns.get(SID)).toEqual({ configId: 'cfg-1', provider: 'codex' })
  })

  it('a run the switches leave out ends the run the id still had and is marked not indexed under its own assistant, from its own launch', () => {
    h.registers = false
    ports.indexedRuns.set(SID, { provider: 'codex' })
    const r = lb.bindLoggingRun({ ...base, sessionId: SID, runProvider: 'codex', codexRunProvider: true, claudeRunProvider: false, provider: 'codex' })
    expect(r).toEqual({ logSup: null, codexLocalRun: true })
    expect(ports.indexedRuns.has(SID)).toBe(false)
    expect(h.calls.slice(3)).toEqual([`runEnd ${SID} exited`, `markSessionNotIndexed ${SID} codex 111`, `binder.startRun ${SID} false`])
    h.calls.length = 0
    lb.bindLoggingRun({ ...base, sessionId: CL, runProvider: 'claude', codexRunProvider: false, claudeRunProvider: true, provider: 'claude' })
    expect(h.calls.slice(3)).toEqual([`noteClaudeFolder ${CL} /proj/a`, `runEnd ${CL} exited`, `markSessionNotIndexed ${CL} claude 222`])
    h.calls.length = 0
    // An SSH session or a terminal tab: neither assistant runs here, so nothing is marked.
    lb.bindLoggingRun({ ...base, sessionId: 'ssh1', runProvider: 'claude', codexRunProvider: false, claudeRunProvider: false, provider: 'claude' })
    expect(h.calls.slice(3)).toEqual(['runEnd ssh1 exited'])
  })
})

describe('a session\'s end drops what its launch bound, once each, in order', () => {
  it('its own exit: the token and all three per-session files', () => {
    lb.unbindLaunchFiles(SID)
    expect(h.calls).toEqual([`dropGatewayToken ${SID}`, `removeLocalSessionSettings ${SID}`, `removeLocalSessionMcpConfig ${SID}`, `removeLocalSessionStatusUrl ${SID}`])
  })

  it('the teardown: the lease once, then the telemetry and records, then the registrations', () => {
    lb.bindCodexLease(SID, lease as never)
    ports.codexTelemetrySources.set(SID, source)
    const other = { stop: () => h.rec('other.stop')(), recheckShared: () => h.rec('other.recheckShared')() }
    ports.codexTelemetrySources.set(OTHER, other)
    for (const m of [ports.notIndexedSessions, ports.claudeTranscripts, ports.claudeFolders, ports.codexFolders]) m.set(SID, {} as never)
    ports.codexAskSessions.add(SID)
    CODEX_LIFECYCLE.unbind(SID, lb.lifecycleCore())
    CODEX_LIFECYCLE.unbind(SID, lb.lifecycleCore())
    expect(h.calls).toEqual(['lease.release'])
    expect(ports.codexLaunchLeases.has(SID)).toBe(false)
    h.calls.length = 0
    lb.unbindLaunchTelemetry(SID)
    expect(h.calls).toEqual([`endSessionNotIndexed ${SID} false`, 'source.stop', 'other.recheckShared', `binder.endRun ${SID}`, `forgetCodexHooks ${SID}`])
    for (const m of [ports.notIndexedSessions, ports.claudeTranscripts, ports.claudeFolders, ports.codexFolders]) expect(m.has(SID)).toBe(false)
    expect([...ports.codexTelemetrySources.keys()]).toEqual([OTHER])
    h.calls.length = 0
    lb.unbindLaunchRegistrations(SID)
    expect(h.calls).toEqual([
      `unregisterCodexReviewSession ${SID}`, `releaseMcpSessionProvider ${SID}`, `revokeCanvasUatRoots ${SID}`,
      `forgetCanvasMarkers ${SID}`, `closeCodexRunScreen ${SID}`, `forgetCodexSessionGuidance ${SID}`,
    ])
    expect(ports.codexAskSessions.has(SID)).toBe(false)
  })
})
