// 2.1.3-beta.17, plan section B1b (aicc_planning#419): a Codex session started
// through the resume list keeps its pick folder through an app update that
// keeps it running, and the next start's take-over reads it again.
//
// The resume list (scripts/codex-resume-picker.js) writes each decision into
// a pick file in a folder of its own (spawn.ts makes it, ccc-codex-pick-*),
// and the session's watcher (telemetry.ts) reads it and removes the folder at
// its stop. An update that keeps the session running (S16 step 4) stops the
// watcher at the kill, as every session's end does; the list runs on in the
// kept CLI, and after the take-over (S16 step 5) it must still be able to
// write its pick. So: the release records the pick file and the folder as it
// was made (describeLaunch), the kill leaves that folder, the take-over binds
// it for the new run's watcher (still only while it is the same folder) with
// the decision the last run read, and once the session is kept no longer
// (removeKeptLaunchFiles) the folder goes. Every other stop removes it as
// before.
//
// Real modules: the launch bindings, the kept-launches seam, the Codex
// provider (with a live-usage stand-in, so its wrapper is the one that runs)
// and its watcher, on real folders in this run's own temp folder; no link is
// planted (host-safe). The session helper is a stand-in behind the seam;
// tests/unit/main/session-helper-take-over.test.ts holds the manager to the
// record. Mocked: Electron, the gateway (off), the per-session files, the
// loggers and registrations.
//
// Not checked here: an update from the published beta.16 (its own code
// removes the folder at the release; nothing in this version can help that);
// the resume list's own write (tests/unit/scripts/codex-resume-picker*.test.ts).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmdirSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename, dirname } from 'path'

const h = vi.hoisted(() => ({
  /** The watcher's claims, as its onRollout reports them. */
  claims: [] as Array<{ sid: string; uuid: string }>,
}))

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false }, app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {} } }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  removeLocalSessionSettings: () => {},
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
  getLocalSessionStatusUrlPath: () => '/nonexistent/status.url',
  writeLocalSessionStatusUrl: () => '/nonexistent/status.url',
  noteKeptLaunchStatusLine: () => {},
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../src/main/path-utils', () => ({ isHomeOrAncestor: () => false }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ clampAnsiChunk: (d: string) => d, getWatchdogManager: () => null }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/logging/should-register-run', () => ({ shouldRegisterRun: () => false }))
vi.mock('../../../src/main/logging/indexing-gaps', () => ({ openNotIndexedWindow: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null }))
vi.mock('../../../src/main/logging/codex-log-binder', () => ({ getCodexLogBinder: () => ({ beginLaunch: () => {}, endRun: () => {}, noteRollout: () => {}, startRun: () => {} }) }))
vi.mock('../../../src/main/spawn-claude-command', () => ({ buildResumeTranscriptPath: () => null }))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, getClaudeProfileId: () => undefined,
  pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {},
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  recordHeldToolSession: () => {},
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-store', () => ({
  registerCanvasUatRoot: () => true, revokeCanvasUatRoots: () => {}, designateCanvasWorktreeRoot: () => true,
  canvasRootRefusalReason: () => null, describeCanvasRootRefusal: () => '', setCanvasRootRefusal: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({ forgetCanvasMarkers: () => {}, releaseCanvasMarkersForTab: () => {} }))
vi.mock('../../../src/main/canvas/codex-canvas-roots', () => ({ registerCodexCanvasRoots: () => {}, codexDesignatedWorktree: () => null }))
vi.mock('../../../src/main/canvas/codex-guidance', () => ({ noteCodexSessionGuidance: () => {}, forgetCodexSessionGuidance: () => {} }))
// The provider registry: the real Codex provider, built below.
const reg = vi.hoisted(() => ({ codex: null as unknown }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: (id: string) => (id === 'codex' ? reg.codex : undefined) }))

const lb = await import('../../../src/main/sessions/launch-bindings')
const seam = await import('../../../src/main/sessions/kept-launches')
const { CodexProvider } = await import('../../../src/main/providers/codex')
const { codexFolderIdentity } = await import('../../../src/main/providers/codex/rollout-lookup')
type Ports = Parameters<typeof lb.setLaunchBindingPorts>[0]

// The live-usage stand-in makes the provider wrap its watcher, as the app's does.
const provider = new CodexProvider({ open: () => () => {}, record: () => {}, get: () => null } as never)
reg.codex = provider

const KEPT = 'cx00000000000000000000b1'
const ENDED = 'cx00000000000000000000b2'
const ID = '019dd000-0001-7000-8000-0000000004a1'
const ID2 = '019dd000-0002-7000-8000-0000000004a2'
const ACCOUNT = 'acct-b1b'

/** This file's own folder in this run's temp folder; everything is made in it. */
const ROOT = mkdtempSync(join(tmpdir(), 'ccc-test-kept-pick-'))
afterAll(() => {
  if (dirname(ROOT) === tmpdir() && basename(ROOT).startsWith('ccc-test-kept-pick-')) rmSync(ROOT, { recursive: true, force: true })
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(20)
  }
}

let n = 0
let project: string
let sessions: string
let ports: ReturnType<typeof makePorts>
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as never
const lease = () => ({ accountId: ACCOUNT, release: () => {} })

function makePorts() {
  const codexTelemetrySources = new Map<string, { stop(o?: unknown): void }>()
  const keptCodexConversations = new Map<string, { uuid: string }>()
  return {
    ptySessions: new Map(),
    codexHookFiles: new Map(),
    codexHookedLaunches: new Set<string>(),
    codexLaunchLeases: new Map(),
    takenCodexLeases: new WeakSet<object>(),
    codexAskSessions: new Set<string>(),
    codexTelemetrySources,
    indexedRuns: new Map(),
    notIndexedSessions: new Map(),
    codexContextRollouts: new Map(),
    keptCodexConversations,
    lastCodexHookRollout: new Map(),
    claudeTranscripts: new Map<string, string>(),
    claudeFolders: new Map(),
    codexFolders: new Map(),
    noteGatewayToken: () => {},
    dropGatewayToken: () => {},
    forgetCodexHooks: () => {},
    keepCodexConversation: (sid: string, c: { uuid: string }) => { keptCodexConversations.set(sid, { uuid: c.uuid }) },
    markCodexConversationUncertain: () => {},
    clearCodexDoubtFromHook: () => {},
    // The watcher's own claims (its onRollout), by the conversation id its rollout's name ends in.
    noteCodexContextRollout: (sid: string, r: { path: string } | null) => { if (r) h.claims.push({ sid, uuid: basename(r.path).slice(-'.jsonl'.length - 36, -'.jsonl'.length) }) },
    endSessionNotIndexed: () => {},
    noteCodexFolder: () => {},
    savedConfigLoggingOff: () => undefined,
    noteClaudeFolder: () => {},
    noteClaudeTranscript: () => {},
    markSessionNotIndexed: () => {},
    closeCodexRunScreen: () => {},
    noteAgentRunFolder: () => {},
    codexRunWriters: () => ({ write: () => {}, writeColourAnswer: () => {} }),
  }
}

/** A pick folder as spawn.ts makes one, and the identity it records. */
function pickFolder(): { dir: string; file: string; folder: { id: string; real: string } } {
  const dir = mkdtempSync(join(ROOT, 'ccc-codex-pick-'))
  const folder = codexFolderIdentity(dir)
  if (!folder) throw new Error('no identity for ' + dir)
  return { dir, file: join(dir, 'pick.json'), folder }
}

/** A decision as the resume list writes one: a staging file renamed into place. */
function writePick(file: string, decision: { id: string } | { fresh: true }): void {
  const tmp = `${file}.0123456789abcdef.tmp`
  writeFileSync(tmp, JSON.stringify(decision))
  renameSync(tmp, file)
}

const pad = (x: number) => String(x).padStart(2, '0')
/** A rollout of conversation `id` in today's (UTC) folder, begun at `at`. */
function rollout(id: string, at: number, cwd = project): void {
  const d = new Date(at)
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  const iso = d.toISOString()
  writeFileSync(join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.157.1' } }) + '\n')
}

/** A launch through the resume list, as pty-manager.ts binds it (the watcher is the real one). */
function launchedThroughList(sid: string, pick: { file: string; folder: { id: string; real: string } }): void {
  lb.bindCodexLease(sid, lease() as never)
  lb.bindCodexLaunch({
    win: fakeWin, sessionId: sid, provider: provider as never, launch: { lease: lease() as never, sessionsDir: sessions },
    codexCwd: project, codexSpawnTimestamp: Date.now(), built: { pickFile: pick.file, pickFolder: pick.folder },
    resolvedCwd: project, codexCanvas: { designatedWorktree: null, guidance: null }, runProvider: 'codex',
  })
}

/** The session's end as pty-manager.ts runs it at a kill: its files, then the teardown's three. */
function end(sid: string): void {
  lb.unbindLaunchFiles(sid)
  lb.unbindCodexLease(sid)
  lb.unbindLaunchTelemetry(sid)
  lb.unbindLaunchRegistrations(sid)
}

/** The kept CLI's terminal, as the session helper hands it over. */
function keptPty() {
  return {
    pid: 4242, cols: 120, rows: 30, process: 'node', handleFlowControl: false, kills: 0,
    onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
    write: () => {}, resize: () => {}, clear: () => {}, pause: () => {}, resume: () => {}, kill() { this.kills++ },
  }
}

/** The next start: the stand-in helper keeps `facts` for KEPT's tab, and the tab takes it over. */
function takeOver(facts: Record<string, unknown>): ReturnType<typeof keptPty> {
  const pty = keptPty()
  seam.setKeptTakeOver((sid) => (sid === KEPT ? { pty: pty as never, kept: { folder: project, at: Date.now() - 1000, ...facts } as never } : null))
  const taken = lb.takeOverKeptLaunch({ win: fakeWin, sessionId: KEPT, launch: { id: 'codex', style: 'direct', provider: provider as never }, resolvedCwd: project, cols: 120, rows: 30, codexLaunch: { lease: lease() as never, sessionsDir: sessions } })
  expect(taken).not.toBeNull()
  return pty
}

beforeEach(() => {
  n++
  project = join(ROOT, `project-${n}`)
  sessions = join(ROOT, `realm-${n}`, 'sessions')
  mkdirSync(project, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  h.claims.length = 0
  ports = makePorts()
  lb.setLaunchBindingPorts(ports as unknown as Ports)
  seam.setKeptLaunchCheck(null)
  seam.setKeptTakeOver(null)
})
afterEach(() => {
  // Every watcher this test left running stops (a new start's take-over is no longer kept).
  seam.setKeptLaunchCheck(null)
  for (const sid of [...ports.codexTelemetrySources.keys()]) end(sid)
  seam.setKeptTakeOver(null)
})

describe('the release of an update that keeps a session on its resume list', () => {
  it('records the pick file and the folder as it was made, and the kill leaves that folder for the list to write in', async () => {
    const pick = pickFolder()
    launchedThroughList(KEPT, pick)
    // The update keeps KEPT running (the session helper's answer).
    seam.setKeptLaunchCheck((sid) => sid === KEPT)
    const facts = lb.describeLaunch(KEPT)
    expect(facts).toEqual({ conversation: null, account: ACCOUNT, hookFolder: null, pick: { file: pick.file, folder: pick.folder } })
    end(KEPT)
    expect(ports.codexTelemetrySources.has(KEPT)).toBe(false)
    // The folder stays, the same folder, and the list can still record its pick there.
    expect(existsSync(pick.dir)).toBe(true)
    expect(codexFolderIdentity(pick.dir)).toEqual(pick.folder)
    writePick(pick.file, { id: ID })
    expect(existsSync(pick.file)).toBe(true)
  })

  it('a session the update does not keep: its folder goes at its stop, as before', () => {
    const kept = pickFolder()
    const ended = pickFolder()
    launchedThroughList(KEPT, kept)
    launchedThroughList(ENDED, ended)
    seam.setKeptLaunchCheck((sid) => sid === KEPT)
    end(ENDED)
    expect(existsSync(ended.dir)).toBe(false)
    end(KEPT)
    expect(existsSync(kept.dir)).toBe(true)
    // Once nothing keeps it, a stop removes it again.
    seam.setKeptLaunchCheck(null)
    launchedThroughList(KEPT, kept)
    end(KEPT)
    expect(existsSync(kept.dir)).toBe(false)
  })

  it('records the decision the watcher read: a conversation not yet claimed, or a new one not yet found', async () => {
    const pick = pickFolder()
    launchedThroughList(KEPT, pick)
    writePick(pick.file, { fresh: true })
    await until(() => !existsSync(pick.file), 'the watcher to read the decision')
    seam.setKeptLaunchCheck((sid) => sid === KEPT)
    const facts = lb.describeLaunch(KEPT) as unknown as { pick: { decided: { fresh: number } } }
    expect(facts.pick.decided).toEqual({ fresh: expect.any(Number) })
    expect(facts.pick.decided.fresh).toBeLessThanOrEqual(Date.now())
  })
})

describe('the next start\'s take-over of that session', () => {
  it('binds the kept pick: a conversation picked after the take-over is claimed, and the session\'s end then removes the folder', async () => {
    const pick = pickFolder()
    rollout(ID, Date.now() - 3 * 24 * 3600_000)
    takeOver({ conversation: null, account: ACCOUNT, hookFolder: null, pick: { file: pick.file, folder: pick.folder } })
    await tick(600)
    expect(h.claims).toEqual([])
    writePick(pick.file, { id: ID })
    await until(() => h.claims.length > 0, 'the pick to be claimed')
    expect(h.claims).toEqual([{ sid: KEPT, uuid: ID }])
    // Read once and removed, as at a launch.
    expect(existsSync(pick.file)).toBe(false)
    end(KEPT)
    expect(existsSync(pick.dir)).toBe(false)
  })

  it('a session already on a conversation through the list: that one is claimed at once, and the list\'s later decision is still read', async () => {
    const pick = pickFolder()
    rollout(ID, Date.now() - 3 * 24 * 3600_000)
    takeOver({ conversation: ID, account: ACCOUNT, hookFolder: null, pick: { file: pick.file, folder: pick.folder, decided: { id: ID } } })
    await until(() => h.claims.length > 0, 'the kept conversation to be claimed')
    expect(h.claims).toEqual([{ sid: KEPT, uuid: ID }])
    // The resumed conversation failed: the list starts a new one and says so.
    const before = Date.now()
    writePick(pick.file, { fresh: true })
    await until(() => !existsSync(pick.file), 'the later decision to be read')
    expect(ports.keptCodexConversations.has(KEPT)).toBe(false)
    rollout(ID2, before + 200)
    await until(() => h.claims.length > 1, 'the new conversation to be claimed')
    expect(h.claims.at(-1)).toEqual({ sid: KEPT, uuid: ID2 })
  })

  it('a new conversation chosen before the release and not yet found: it is claimed after the take-over', async () => {
    const pick = pickFolder()
    const chose = Date.now() - 60_000
    rollout(ID2, chose + 30_000)
    takeOver({ conversation: null, account: ACCOUNT, hookFolder: null, pick: { file: pick.file, folder: pick.folder, decided: { fresh: chose } } })
    await until(() => h.claims.length > 0, 'the new conversation to be claimed')
    expect(h.claims).toEqual([{ sid: KEPT, uuid: ID2 }])
  })

  it('a folder put in the kept one\'s place: not read and not removed, by the take-over\'s watcher or once the session is kept no longer', async () => {
    const pick = pickFolder()
    rollout(ID, Date.now() - 3 * 24 * 3600_000)
    // The kept folder went and another was put at its path: made beside it
    // first and renamed into place, so it is another folder on every system.
    // (Removed and then made at the same path, the Linux runner gave the new
    // folder the old one's device and file id: CI run 45399392626.)
    const other = `${pick.dir}-other`
    mkdirSync(other)
    rmdirSync(pick.dir)
    renameSync(other, pick.dir)
    expect(codexFolderIdentity(pick.dir)?.id).not.toBe(pick.folder.id)
    takeOver({ conversation: null, account: ACCOUNT, hookFolder: null, pick: { file: pick.file, folder: pick.folder } })
    writePick(pick.file, { id: ID })
    await tick(1200)
    expect(h.claims).toEqual([])
    expect(existsSync(pick.file)).toBe(true)
    end(KEPT)
    lb.removeKeptLaunchFiles({ sessionId: KEPT, provider: 'codex', hookFolder: null, pick: { file: pick.file, folder: pick.folder } } as never)
    expect(readdirSync(pick.dir)).toEqual(['pick.json'])
  })
})

describe('a kept session that is kept no longer', () => {
  it('its folder goes with what its launch left on disk (removeKeptLaunchFiles), its pick file and the list\'s staging files with it', () => {
    const pick = pickFolder()
    writeFileSync(join(pick.dir, 'pick.json'), JSON.stringify({ id: ID }))
    writeFileSync(join(pick.dir, 'pick.json.fedcba9876543210.tmp'), '{}')
    seam.removeKeptLaunch({ sessionId: KEPT, provider: 'codex', hookFolder: null, pick: { file: pick.file, folder: pick.folder } } as never)
    expect(existsSync(pick.dir)).toBe(false)
  })

  it('anything else in it keeps the folder (never removed recursively)', () => {
    const pick = pickFolder()
    writeFileSync(join(pick.dir, 'notes.txt'), 'not the list\'s')
    seam.removeKeptLaunch({ sessionId: KEPT, provider: 'codex', hookFolder: null, pick: { file: pick.file, folder: pick.folder } } as never)
    expect(readdirSync(pick.dir)).toEqual(['notes.txt'])
  })

  it('a take-over whose bindings fail before its watcher starts: the folder goes', () => {
    const pick = pickFolder()
    // The pane binding throws (a stand-in failure), before bindCodexLaunch.
    const broken = makePorts()
    broken.codexRunWriters = () => { throw new Error('the stand-in writers failed') }
    lb.setLaunchBindingPorts(broken as unknown as Ports)
    try {
      const pty = keptPty()
      seam.setKeptTakeOver(() => ({ pty: pty as never, kept: { conversation: null, account: ACCOUNT, hookFolder: null, folder: project, at: 0, pick: { file: pick.file, folder: pick.folder } } as never }))
      expect(() => lb.takeOverKeptLaunch({ win: fakeWin, sessionId: KEPT, launch: { id: 'codex', style: 'direct', provider: provider as never }, resolvedCwd: project, cols: 120, rows: 30, codexLaunch: { lease: lease() as never, sessionsDir: sessions } })).toThrow('the stand-in writers failed')
      expect(pty.kills).toBe(1)
      expect(existsSync(pick.dir)).toBe(false)
    } finally {
      lb.setLaunchBindingPorts(ports as unknown as Ports)
    }
  })
})
