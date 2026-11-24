// 2.1.3-beta.17, section B1g (aicc_planning#423): a canvas decision (an
// approval or a review the user files on the Agent Canvas) for a restored tab
// whose session an app update kept running, while that tab is not shown yet
// and has not taken the session over.
//
// Measured on the beta.17 aggregate (b0b450ec) before the fix, against these
// same cases: such a tab has no terminal process in this run, so the marker
// door (session-input submitMarker) answered 'not delivered, the session
// gone' and the canvas said the agent did not get it, for a Codex tab too (a
// session reads as Codex only with a live PTY, so a Codex tab's marker took
// the same no-run answer); and a decision the marker queue held while the
// kept CLI's turn ran was dropped by the take-over's own kill (killPty, then
// cleanupSessionResources, then unbindLaunchRegistrations, then
// forgetCanvasMarkers), told as not sent, and never typed at the turn's Stop.
//
// Now: such a decision waits for the take-over (the canvas is not told it was
// not sent; the channel answers 'queued'), the take-over's kill keeps it, and
// right after the take-over it goes the way an open tab's does (Claude Code:
// typed at its ready, empty prompt; Codex: its submit primitive), once. A tab
// closed, or a kept session ended, before the take-over drops it, and the
// canvas is told once (the session gone). Past MARKER_QUEUE_MAX waiting, the
// oldest is dropped with a log line only, as the queue drops one. Nothing kept
// for the tab (the switch off), and an open tab, are as before.
//
// 14 cases: 10 red on b0b450ec; the 4 that pin unchanged behaviour (nothing
// kept, an open tab's close, an open tab's typing, a kept session ended
// first) green there. A check that something was typed polls for it
// (typedIs); a fixed wait is kept only before a check that nothing was.
//
// Driven through the REAL pty-manager (its spawn's take-over branch and its
// kill), the REAL launch bindings, the REAL marker queue and its wiring as
// src/main/index.ts makes it, the REAL session input door and the REAL Claude
// Code marker chain. The session helper is a stand-in behind its seam
// (kept-launches.ts setKeptTakeOver and setKeptTabSignals), as
// launch-bindings-take-over.test.ts has it: it keeps a session for a tab until
// that tab takes it over (as manager.ts takeOverKept deletes its entry) or its
// end (as manager.ts forgetKeptForTab: its entry goes, then unserveKeptLaunch).
// The renderer's half of a Claude Code marker (it reads the screen and types)
// is a stand-in that reads the prompt ready and types through writePty, as the
// pty:write handler does. Codex's submit primitive is a stand-in that records.
//
// Not checked here: the manager itself (session-helper-take-over.test.ts holds
// it to its keeping, take-over and ends, and to forgetting the tab's entry
// before it asks unserve, which the drop at an end needs); the renderer's reading of Claude
// Code's prompt (canvas-marker-claude-gate.test.ts).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { CanvasMarkerUndelivered } from '../../../src/shared/types'

const h = vi.hoisted(() => ({
  /** Every write into a process node-pty started (a new CLI, not a kept one). */
  writes: [] as string[],
  /** Each marker Codex's submit primitive was handed: [session, line]. */
  codexSubmits: [] as Array<[string, string]>,
  /** The sessions whose Codex screen is read (opened by a take-over's pane binding). */
  codexScreens: new Set<string>(),
}))

/** Codex's run screen (providers/codex/session-screen.ts), a recorder: every
 *  submit is delivered at once. */
const codexScreen = vi.hoisted(() => ({
  open: (sid: string) => { h.codexScreens.add(sid) },
  feed: () => {},
  resize: () => {},
  close: (sid: string) => { h.codexScreens.delete(sid) },
  has: (sid: string) => h.codexScreens.has(sid),
  submit: (sid: string, text: string) => { h.codexSubmits.push([sid, text]); return Promise.resolve({ delivered: true }) },
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 4242,
    process: 'pwsh',
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(d) },
    resize: () => {},
    kill: () => {},
  }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// [host] The real logger keeps its log inside the test's own folder (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  recordHeldToolSession: () => {},
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  providerCapability: () => ({ enabled: true }),
  tryGetProvider: () => ({}),
  getProvider: (id: string) => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
    ...(id === 'codex' ? { runScreen: codexScreen } : {}),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => '/nonexistent/settings.json',
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
  getLocalSessionStatusUrlPath: (sid: string) => path.join(os.tmpdir(), 'ccc-no-such-folder', `ccc-status-${sid}.url`),
  writeLocalSessionStatusUrl: () => '',
  noteKeptLaunchStatusLine: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, getClaudeProfileId: () => null,
  pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ startWatchdog: () => {}, stopWatchdog: () => {}, feedData: () => {}, noteRedrawTrigger: () => {}, noteResize: () => {} }),
  clampAnsiChunk: (d: string) => d,
}))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { spawnPty, killPty, writePty } = await import('../../../src/main/pty-manager')
const { submitMarker } = await import('../../../src/main/session-input')
const delivery = await import('../../../src/main/canvas/canvas-marker-delivery')
const { MARKER_QUEUE_MAX } = await import('../../../src/main/canvas/canvas-marker-queue')
const typing = await import('../../../src/main/canvas/claude-marker-typing')
const { setKeptTakeOver, setKeptTabSignals, unserveKeptLaunch, keptTabClosed } = await import('../../../src/main/sessions/kept-launches')
// Read off the module as a plain copy, so a case fails on what it checks on
// the code before the fix (where the name is not exported) rather than on the import.
const deliveryNames: Record<string, unknown> = Object.fromEntries(Object.entries(delivery))
const releaseForTab = (sid: string): void => { (deliveryNames.releaseCanvasMarkersForTab as ((s: string) => void) | undefined)?.(sid) }

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-b1g-project-'))
afterAll(() => {
  setKeptTakeOver(null)
  setKeptTabSignals(null)
  if (path.basename(PROJECT).startsWith('ccc-b1g-project-')) fs.rmSync(PROJECT, { recursive: true, force: true })
})

const CLAUDE_SID = 'b1g000000000000000000c01'
const CODEX_SID = 'b1g000000000000000000c02'
const CANVAS = 'c1c2c3c4c5c6c7c8c9c0d1d2'
const MARKER = 'Approved v3 on the canvas · canvas_version_verdict recorded'
const MARKER_2 = 'Review #4 — 2 notes · canvas_review R4'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const codexLaunch = () => ({
  lease: { release: () => {}, accountId: 'acct-b1g' },
  executable: '/proven/b1g/codex',
  env: { PATH: '/usr/bin', CODEX_HOME: '/res/codex-realms/b1g' },
  sessionsDir: '/res/codex-realms/b1g/sessions',
})
const codexOptions = () => ({ cwd: PROJECT, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() }) as never
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
/** What was typed at Claude Code's prompt, polled until it reads `lines`: the
 *  chain runs a real 300 ms timer (its second read), so a positive check
 *  waits for its result rather than for a fixed time. */
const typedIs = (lines: string[]) => vi.waitFor(() => expect(typeAsks).toEqual(lines), { timeout: 15_000, interval: 20 })
/** How long a check that nothing (more) was typed waits: past the Claude
 *  Code chain's probe, its second read (300 ms) and its type. */
const TYPED_BY_MS = 700

/** The tabs a session is kept for, until each is taken over or ended. */
const waiting = new Set<string>()
/** The kept CLI's terminal the stand-in helper hands over, and what reached it. */
let keptWrites: string[]
/** Each line the renderer's stand-in was asked to type at Claude Code's prompt. */
let typeAsks: string[]
/** What the canvas was told did not reach the agent (the wiring's onUndelivered). */
let told: CanvasMarkerUndelivered[]
/** The hook stream the queue subscribes to at boot (index.ts wires it to every hook event). */
let emit: (sessionId: string, event: string) => void = () => {}

/** The stand-in helper keeps a session for `sid`'s tab (a Codex one on `account`). */
function keepFor(sid: string, account: string | null = null): void {
  waiting.add(sid)
  setKeptTakeOver((id, _provider, size, acct) => {
    if (!waiting.has(id)) return null
    if (acct !== undefined && acct !== account) return null
    // As manager.ts takeOverKept: the tab's entry goes, so it waits no longer.
    waiting.delete(id)
    const pty = {
      pid: 7070, cols: size.cols, rows: size.rows, process: 'pwsh', handleFlowControl: false,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: (d: string) => { keptWrites.push(d) },
      resize: () => {}, clear: () => {}, pause: () => {}, resume: () => {}, kill: () => {},
    }
    return { pty: pty as never, kept: { conversation: null, account, hookFolder: null, folder: PROJECT, at: 0 } }
  })
}

/** As manager.ts forgetKeptForTab: the kept session's entry goes, then what was bound for it (unserveKeptLaunch). */
function endKept(sid: string): void {
  if (!waiting.delete(sid)) return
  unserveKeptLaunch(sid)
}

/** The pty:kill handler's close of a tab (pty-handlers.ts, in its order). */
function closeTab(sid: string): void {
  killPty(sid, { reason: 'close' })
  delivery.forgetCanvasMarkers(sid)
  keptTabClosed(sid)
}

const markersIn = (writes: string[]): string[] => writes.filter((w) => w.includes('canvas'))

beforeEach(() => {
  void TEST_DATA
  waiting.clear()
  for (const sid of [CLAUDE_SID, CODEX_SID]) { try { killPty(sid) } catch { /* none */ } }
  setKeptTakeOver(null)
  h.writes.length = 0
  h.codexSubmits.length = 0
  keptWrites = []
  typeAsks = []
  const list: CanvasMarkerUndelivered[] = []
  told = list
  typing._resetClaudeMarkerTypingForTest()
  delivery._resetCanvasMarkerQueueForTest()
  // The app's own wiring (src/main/index.ts).
  delivery.startCanvasMarkerQueue({
    write: (sessionId, line, canvasId) => submitMarker(sessionId, line, canvasId),
    onUndelivered: (u) => { list.push({ ...u }) },
    subscribe: (cb) => { emit = cb },
  })
  // The renderer's half: the prompt reads ready and empty; a type request is
  // typed through the pty:write handler's own call.
  typing.setClaudeMarkerSender((ask) => {
    queueMicrotask(() => {
      if (ask.mode === 'type') {
        typeAsks.push(ask.line)
        writePty(ask.sessionId, `${ask.line}\r`)
      }
      typing.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: true })
    })
    return true
  })
  setKeptTabSignals({
    restored: () => {},
    shown: () => {},
    // As manager.ts tabClosed: a session kept for the tab is ended.
    closed: (id) => endKept(id),
    waits: (id) => waiting.has(id),
  })
})

describe('B1g: a canvas decision for a restored tab whose kept session waits for its take-over', () => {
  it('Claude Code, no turn open: held (the canvas is not told it was not sent), then typed once into the kept CLI right after the take-over', async () => {
    keepFor(CLAUDE_SID)
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)).toBe('queued')
    await tick(TYPED_BY_MS)
    expect(told).toEqual([])
    expect(typeAsks).toEqual([])

    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    expect(waiting.has(CLAUDE_SID)).toBe(false)
    await typedIs([MARKER])
    expect(markersIn(keptWrites)).toEqual([`${MARKER}\r`])
    expect(h.writes).toEqual([])
    await tick(TYPED_BY_MS)
    expect(typeAsks).toEqual([MARKER])
    expect(told).toEqual([])
  })

  it('Claude Code, a turn open: the decision the queue holds is not dropped by the take-over\'s kill, and is typed once after the turn\'s Stop', async () => {
    keepFor(CLAUDE_SID)
    emit(CLAUDE_SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)).toBe('queued')

    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    await tick(TYPED_BY_MS)
    expect(told).toEqual([])
    expect(typeAsks).toEqual([])

    // The same CLI's turn ends (its hook route goes on across the take-over, B1e).
    emit(CLAUDE_SID, 'Stop')
    await typedIs([MARKER])
    expect(markersIn(keptWrites)).toEqual([`${MARKER}\r`])
    expect(told).toEqual([])
  })

  it('a Restart\'s kill while it waits (pty:kill with \'restart\', which also clears the canvas markers) keeps them: its tab starts again and takes the session over', async () => {
    keepFor(CLAUDE_SID)
    emit(CLAUDE_SID, 'UserPromptSubmit')
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)
    killPty(CLAUDE_SID, { reason: 'restart' })
    delivery.forgetCanvasMarkers(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    emit(CLAUDE_SID, 'Stop')
    await typedIs([MARKER])
    expect(told).toEqual([])
  })

  it('Codex: the same door (with no PTY its tab reads as no Codex session); held, then handed once to Codex\'s submit primitive after the take-over', async () => {
    keepFor(CODEX_SID, 'acct-b1g')
    expect(delivery.deliverCanvasMarker(CODEX_SID, MARKER, CANVAS)).toBe('queued')
    await tick()
    expect(told).toEqual([])
    expect(h.codexSubmits).toEqual([])

    spawnPty(fakeWin, CODEX_SID, codexOptions())
    expect(waiting.has(CODEX_SID)).toBe(false)
    await tick(50)
    expect(h.codexSubmits).toEqual([[CODEX_SID, MARKER]])
    expect(told).toEqual([])
  })

  it('Codex, a turn open: kept through the take-over\'s kill, and handed on once at the turn\'s Stop', async () => {
    keepFor(CODEX_SID, 'acct-b1g')
    emit(CODEX_SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(CODEX_SID, MARKER, CANVAS)).toBe('queued')
    spawnPty(fakeWin, CODEX_SID, codexOptions())
    await tick(50)
    expect(h.codexSubmits).toEqual([])
    expect(told).toEqual([])
    emit(CODEX_SID, 'Stop')
    await tick(50)
    expect(h.codexSubmits).toEqual([[CODEX_SID, MARKER]])
    expect(told).toEqual([])
  })

  it('in the order filed, never twice: the same decision pressed twice is one, and the release asked again types nothing more', async () => {
    keepFor(CLAUDE_SID)
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER_2, CANVAS)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    await typedIs([MARKER, MARKER_2])
    releaseForTab(CLAUDE_SID)
    emit(CLAUDE_SID, 'Stop')
    await tick(TYPED_BY_MS * 2)
    expect(typeAsks).toEqual([MARKER, MARKER_2])
    expect(markersIn(keptWrites)).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
    expect(told).toEqual([])
  })

  it('Codex, never twice: the same decision pressed twice while it waits is handed on once (its submit primitive collapses nothing itself)', async () => {
    keepFor(CODEX_SID, 'acct-b1g')
    delivery.deliverCanvasMarker(CODEX_SID, MARKER, CANVAS)
    delivery.deliverCanvasMarker(CODEX_SID, MARKER, CANVAS)
    spawnPty(fakeWin, CODEX_SID, codexOptions())
    await tick(50)
    releaseForTab(CODEX_SID)
    await tick(50)
    expect(h.codexSubmits).toEqual([[CODEX_SID, MARKER]])
    expect(told).toEqual([])
  })

  it('a decision held through a turn, filed after one handed on while none ran: typed in the order filed after the take-over', async () => {
    keepFor(CLAUDE_SID)
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)
    emit(CLAUDE_SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER_2, CANVAS)).toBe('queued')
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    await tick(TYPED_BY_MS)
    expect(typeAsks).toEqual([])
    emit(CLAUDE_SID, 'Stop')
    await typedIs([MARKER, MARKER_2])
    expect(told).toEqual([])
  })

  it('a tab closed before it is shown: its held decisions are dropped, the canvas is told once each (the session gone) in the order filed, and none is typed later', async () => {
    keepFor(CLAUDE_SID)
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)
    emit(CLAUDE_SID, 'UserPromptSubmit')
    delivery.deliverCanvasMarker(CLAUDE_SID, MARKER_2, CANVAS)
    closeTab(CLAUDE_SID)
    await tick()
    expect(told).toEqual([
      { sessionId: CLAUDE_SID, canvasId: CANVAS, line: MARKER, reason: 'session-gone' },
      { sessionId: CLAUDE_SID, canvasId: CANVAS, line: MARKER_2, reason: 'session-gone' },
    ])
    // The tab opened again later starts a new CLI: nothing of them reaches it.
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    emit(CLAUDE_SID, 'Stop')
    releaseForTab(CLAUDE_SID)
    await tick(TYPED_BY_MS)
    expect(typeAsks).toEqual([])
    expect(markersIn(h.writes)).toEqual([])
    expect(told).toHaveLength(2)
  })

  it('a kept session ended before its tab is shown (its CLI ended, the 5 minutes after it was shown, End on the Machines page, a quit): its held decisions are dropped and told once', async () => {
    keepFor(CODEX_SID, 'acct-b1g')
    delivery.deliverCanvasMarker(CODEX_SID, MARKER, CANVAS)
    endKept(CODEX_SID)
    await tick()
    expect(told).toEqual([{ sessionId: CODEX_SID, canvasId: CANVAS, line: MARKER, reason: 'session-gone' }])
    // The tab, shown, starts a new CLI (nothing is kept for it now): nothing of it is handed on.
    spawnPty(fakeWin, CODEX_SID, codexOptions())
    releaseForTab(CODEX_SID)
    await tick(50)
    expect(h.codexSubmits).toEqual([])
    expect(told).toHaveLength(1)
  })

  it('nothing kept for the tab (the agent sessions\' switch off, or no update) and no terminal: not sent, told at once, as before', async () => {
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)).toBe('sent')
    await tick()
    expect(told).toEqual([{ sessionId: CLAUDE_SID, canvasId: CANVAS, line: MARKER, reason: 'session-gone' }])
  })

  it('an open tab (its session taken over already): a close drops what the queue holds and tells the canvas, as before', async () => {
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    emit(CLAUDE_SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)).toBe('queued')
    closeTab(CLAUDE_SID)
    await tick()
    expect(told).toEqual([{ sessionId: CLAUDE_SID, canvasId: CANVAS, line: MARKER, reason: 'session-gone' }])
    emit(CLAUDE_SID, 'Stop')
    await tick(TYPED_BY_MS)
    expect(typeAsks).toEqual([])
  })

  it('an open tab, no turn open: typed at its ready prompt at once, as before', async () => {
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: PROJECT } as never)
    await tick()
    expect(delivery.deliverCanvasMarker(CLAUDE_SID, MARKER, CANVAS)).toBe('sent')
    await typedIs([MARKER])
    expect(told).toEqual([])
  })

  it('past the cap: when more than MARKER_QUEUE_MAX wait for the take-over, the oldest is dropped with a log line only (no canvas is told), and the rest go on in order', async () => {
    keepFor(CODEX_SID, 'acct-b1g')
    const lines = Array.from({ length: MARKER_QUEUE_MAX + 1 }, (_, i) => `Review #${i + 1} — 1 notes · canvas_review R${i + 1}`)
    for (const l of lines) delivery.deliverCanvasMarker(CODEX_SID, l, CANVAS)
    spawnPty(fakeWin, CODEX_SID, codexOptions())
    await tick(50)
    expect(h.codexSubmits.map(([, l]) => l)).toEqual(lines.slice(1))
    expect(told).toEqual([])
  })
})
