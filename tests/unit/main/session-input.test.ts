// The session input module (src/main/session-input/, 2.1.3-beta.9 section
// A1; ADR-030 row 3's submit): the one door through which main types into a
// session on its own initiative. Moving the app's own typing behind it changes
// nothing that is typed, in what order or when; this pins what each door types,
// through the REAL spawnPty and the real writePty (the rest of main mocked, as
// codex-ask-carrier.test.ts does), so the same assertions held on beta, against
// the pty-manager functions the door took over, before anything moved.
//
//  - submitLine (the Watchdog's retry into a Claude Code session): exactly the
//    line and Enter, into a local session and into one the session helper
//    holds (its writes become the helper's raw input frames); a repeat within
//    300 ms is suppressed and a line over 256 bytes is chunked, as writePty
//    does for every submit. The tmux leave key of an SSH Persistent session is
//    in session-input-ssh.test.ts: the SSH flow needs its own mocks.
//  - typeKeys (the Watchdog's Codex retry): exactly the keys it is handed.
//  - submitMarker (an Agent Canvas marker): a Codex session's goes to the
//    run screen's submit with the marker queue's bound and answers its result;
//    a Claude Code session's is held by queueClaudeMarkerLine for the run it
//    was handed for, and never for a later one; no run answers session-gone.
//  - askQuestion and handOffAskQuestion (Ask Conductor on Codex): only a Codex
//    session launched as Ask takes a question, through the run screen's submit,
//    never as the raw question and Enter; the characters Codex's prompt drops
//    are removed first and the dock told; the log names a question by its
//    length only.
//  - the ports: the PTY manager registers them once, when it loads; a second
//    registration throws and changes nothing, and before any registration
//    each door that types through a port throws instead of dropping the input.
//
// Mutants this must catch: a marker typed into a run started after its own;
// an Ask question written raw with Enter; a second registration taking over
// the doors; a door that types nothing, silently, before the registration.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type PtyRecord = { writes: string[] }
type Queued = { sessionId: string; line: string; runLive: () => boolean; canvasId?: string }
const h = vi.hoisted(() => {
  /** A stand-in for the session helper's terminal (session-helper/helper-pty.ts):
   *  what it is handed to write becomes a raw input frame to the holder
   *  (HelperPty.write, attached: conn.sendInput(bytes)). */
  class FakeHelperPty {
    readonly throughHelper = true
    readonly frames: Buffer[] = []
    pid = 7301
    cols = 100
    rows = 30
    process = 'claude'
    handleFlowControl = false
    onData() { return { dispose() {} } }
    onExit() { return { dispose() {} } }
    write(data: string) { this.frames.push(Buffer.from(data, 'utf8')) }
    resize() {}
    kill() {}
    pause() {}
    resume() {}
    clear() {}
  }
  return {
    FakeHelperPty,
    ptys: [] as PtyRecord[],
    /** Sessions whose agent terminal the session helper holds. */
    held: new Map<string, InstanceType<typeof FakeHelperPty>>(),
    infos: [] as string[],
    notices: [] as Array<Record<string, unknown>>,
    submits: [] as Array<{ sessionId: string; text: string; readyWaitMs: number }>,
    submitAnswer: { delivered: true } as Record<string, unknown>,
    queued: [] as Queued[],
    withRunScreen: true,
    resources: '',
  }
})

vi.mock('node-pty', () => ({
  spawn: () => {
    const rec: PtyRecord = { writes: [] }
    h.ptys.push(rec)
    return {
      pid: 7300, process: 'pwsh', cols: 100, rows: 30,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: (d: string) => { rec.writes.push(String(d)) },
      resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}, clear: () => {},
    }
  },
}))
vi.mock('../../../src/main/session-helper/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/session-helper/manager')>()
  return {
    ...real,
    spawnAgentPty: (ctx: { sessionId: string }, ...rest: Parameters<typeof real.spawnAgentPty> extends [unknown, ...infer R] ? R : never) => {
      const held = h.held.get(ctx.sessionId)
      return held ?? real.spawnAgentPty(ctx as Parameters<typeof real.spawnAgentPty>[0], ...rest)
    },
  }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-session-input-res-'))
  h.resources = dir
  return { getResourcesDirectory: () => dir, getDataDirectory: () => dir, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }
})
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.infos.push(m) }, logWarn: (m: string) => { h.infos.push(m) }, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {} }))
vi.mock('../../../src/main/providers', () => ({
  providerCapability: () => ({ enabled: true }),
  getProvider: (id: string) => (id === 'codex' ? codexProvider() : claudeProvider()),
}))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))
vi.mock('../../../src/main/canvas/claude-marker-typing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/canvas/claude-marker-typing')>()),
  queueClaudeMarkerLine: (sessionId: string, line: string, runLive: () => boolean, canvasId?: string) => { h.queued.push({ sessionId, line, runLive, canvasId }) },
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/canvas/canvas-plugin')>()), ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
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

/** The registered Claude Code provider: a launch with nothing to run. */
function claudeProvider(): Record<string, unknown> {
  return {
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }
}
/** The registered Codex provider, with the run screen's submit recorded. */
function codexProvider(): Record<string, unknown> {
  return {
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: () => ({ cmd: '/proven/codex', args: [], env: {}, logLine: '--sandbox workspace-write' }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
    ...(h.withRunScreen ? {
      runScreen: {
        open: () => {}, feed: () => {}, resize: () => {}, close: () => {},
        has: () => true,
        submit: async (sessionId: string, text: string, opts: { readyWaitMs: number }) => { h.submits.push({ sessionId, text, readyWaitMs: opts.readyWaitMs }); return h.submitAnswer },
      },
    } : {}),
  }
}

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { submitLine, typeKeys, submitMarker, askQuestion, handOffAskQuestion, ASK_READY_WAIT_MS, setSessionInputPorts } = await import('../../../src/main/session-input')
const { MARKER_FALLBACK_FLUSH_MS } = await import('../../../src/main/canvas/canvas-marker-queue')
const { IPC } = await import('../../../src/shared/ipc-channels')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => { if (channel === IPC.ASK_CONDUCTOR_NOTICE) h.notices.push(payload as Record<string, unknown>) } },
} as unknown as Parameters<typeof spawnPty>[0]
const HOME = path.resolve(os.tmpdir(), 'ccc-session-input-home')
const codexLaunch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: HOME }, sessionsDir: path.join(HOME, 'sessions'), home: HOME }) as unknown as SpawnOpts['codexLaunch']
const EMOJI = String.fromCodePoint(0x1f680)
const MARKER = 'Approved v2 on the canvas'
const CANVAS = 'c1c2c3c4c5c6c7c8c9c0d1d2'

let seq = 0
let SID = ''
const sids: string[] = []
const nextSid = (): string => { SID = `sinp${String(++seq).padStart(20, '0')}`; sids.push(SID); return SID }
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A local Claude Code session, its launch line already typed (it is held for
 *  300 ms after the spawn). Its terminal's writes from here on. */
async function claudeSession(sessionId = nextSid()): Promise<PtyRecord> {
  const before = h.ptys.length
  try { spawnPty(fakeWin, sessionId, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered before any later throw */ }
  await tick(400)
  const rec = h.ptys[before] ?? { writes: [] }
  rec.writes.length = 0
  return rec
}
/** A local Codex session (Ask Conductor's when `isAsk`). Its terminal's writes. */
async function codexSession(extra: Partial<SpawnOpts> = {}, sessionId = nextSid()): Promise<PtyRecord> {
  const before = h.ptys.length
  spawnPty(fakeWin, sessionId, { cwd: os.tmpdir(), cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: codexLaunch(), ...extra })
  await tick(5)
  const rec = h.ptys[before]
  rec.writes.length = 0
  return rec
}
const allWrites = (): string => h.ptys.map((p) => p.writes.join('')).join('')

beforeEach(() => {
  h.infos = []
  h.notices = []
  h.submits = []
  h.submitAnswer = { delivered: true }
  h.queued = []
  h.withRunScreen = true
  h.held.clear()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const id of sids.splice(0)) { try { killPty(id) } catch { /* best effort */ } }
})

afterAll(() => {
  if (h.resources) { try { fs.rmSync(h.resources, { recursive: true, force: true }) } catch { /* best effort */ } }
})

describe('submitLine: the Watchdog\'s retry into a Claude Code session', () => {
  it('a local session: exactly the line and Enter, once', async () => {
    const term = await claudeSession()
    submitLine(SID, 'continue')
    expect(term.writes).toEqual(['continue\r'])
  })

  it('a session the helper holds: exactly the line and Enter, as one raw input frame, and nothing outside the helper', async () => {
    const id = nextSid()
    const helper = new h.FakeHelperPty()
    h.held.set(id, helper)
    const ptysBefore = h.ptys.length
    await claudeSession(id)
    helper.frames.length = 0
    submitLine(id, 'continue')
    expect(helper.frames.map((f) => f.toString('utf8'))).toEqual(['continue\r'])
    expect(h.ptys.length).toBe(ptysBefore)
  })

  it('a repeat within 300 ms is suppressed, as every submit is; after it, the line goes again', async () => {
    const term = await claudeSession()
    vi.useFakeTimers()
    submitLine(SID, 'continue')
    vi.advanceTimersByTime(299)
    submitLine(SID, 'continue')
    expect(term.writes).toEqual(['continue\r'])
    vi.advanceTimersByTime(2)
    submitLine(SID, 'continue')
    expect(term.writes).toEqual(['continue\r', 'continue\r'])
  })

  it('a line over 256 bytes goes in 256-byte slices, 12 ms apart, whole and in order', async () => {
    const term = await claudeSession()
    vi.useFakeTimers()
    const line = 'x'.repeat(600)
    submitLine(SID, line)
    expect(term.writes).toEqual(['x'.repeat(256)])
    vi.advanceTimersByTime(12)
    expect(term.writes).toHaveLength(2)
    vi.advanceTimersByTime(12)
    expect(term.writes).toEqual(['x'.repeat(256), 'x'.repeat(256), `${'x'.repeat(88)}\r`])
    expect(term.writes.join('')).toBe(`${line}\r`)
  })
})

describe('typeKeys: the Watchdog\'s Codex retry', () => {
  it('types exactly the keys it is handed, and adds no Enter of its own', async () => {
    const term = await codexSession()
    typeKeys(SID, 'continue')
    typeKeys(SID, '\r')
    typeKeys(SID, '\x7f\x7f')
    expect(term.writes).toEqual(['continue', '\r', '\x7f\x7f'])
  })
})

describe('submitMarker: an Agent Canvas marker', () => {
  it('a Codex session: through the run screen\'s submit, within the marker queue\'s bound, answering its result; nothing typed raw', async () => {
    const term = await codexSession()
    h.submitAnswer = { delivered: false, reason: 'busy-timeout' }
    const answer = submitMarker(SID, MARKER, CANVAS)
    expect(answer).toBeInstanceOf(Promise)
    expect(await answer).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(h.submits).toEqual([{ sessionId: SID, text: MARKER, readyWaitMs: MARKER_FALLBACK_FLUSH_MS }])
    expect(term.writes).toEqual([])
    expect(h.queued).toEqual([])
  })

  it('a Codex session with no run screen registered: session gone, nothing typed', async () => {
    const term = await codexSession()
    h.withRunScreen = false
    expect(await submitMarker(SID, MARKER)).toEqual({ delivered: false, reason: 'session-gone' })
    expect(term.writes).toEqual([])
  })

  it('a Claude Code session: held by queueClaudeMarkerLine with its canvas, for the run it was handed for only', async () => {
    const first = await claudeSession()
    expect(submitMarker(SID, MARKER, CANVAS)).toBeUndefined()
    expect(h.queued.map(({ sessionId, line, canvasId }) => ({ sessionId, line, canvasId }))).toEqual([{ sessionId: SID, line: MARKER, canvasId: CANVAS }])
    expect(first.writes).toEqual([])
    const { runLive } = h.queued[0]
    expect(runLive()).toBe(true)
    // A restart is a new run of the same session: the held marker is not its.
    await claudeSession(SID)
    expect(runLive()).toBe(false)
    // The new run's own marker is bound to it.
    submitMarker(SID, MARKER)
    expect(h.queued[1].runLive()).toBe(true)
    killPty(SID)
    expect(h.queued[1].runLive()).toBe(false)
  })

  it('a session with no run: session gone, nothing held or typed', async () => {
    await claudeSession()
    killPty(SID)
    expect(await submitMarker(SID, MARKER)).toEqual({ delivered: false, reason: 'session-gone' })
    expect(await submitMarker('none0000none0000none0000', MARKER)).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.queued).toEqual([])
    expect(h.infos).toContain(`[canvas-marker] ${SID}: no running session, so a marker was not typed`)
  })
})

describe('Ask Conductor on Codex: askQuestion and handOffAskQuestion', () => {
  it('a Codex session not launched as Ask takes no question, and nothing is typed', async () => {
    const term = await codexSession()
    expect(await handOffAskQuestion(fakeWin, SID, 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.submits).toEqual([])
    expect(term.writes).toEqual([])
    expect(h.notices).toEqual([])
  })

  it('a Claude Code session, or none, takes no question either', async () => {
    const term = await claudeSession()
    expect(await handOffAskQuestion(fakeWin, SID, 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(await handOffAskQuestion(fakeWin, 'none0000none0000none0000', 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.submits).toEqual([])
    expect(term.writes).toEqual([])
  })

  it('a Codex Ask session: the dropped characters removed with the notice, then through the run screen\'s submit, never raw with Enter', async () => {
    const term = await codexSession({ isAsk: true })
    expect(await handOffAskQuestion(fakeWin, SID, `and then? ${EMOJI}${EMOJI}`)).toEqual({ delivered: true })
    expect(h.notices).toEqual([{ sessionId: SID, kind: 'removed', count: 2 }])
    expect(h.submits).toEqual([{ sessionId: SID, text: 'and then? ', readyWaitMs: ASK_READY_WAIT_MS }])
    expect(term.writes).toEqual([])
    expect(allWrites()).not.toContain('and then?')
  })

  it('a question not delivered is told to the dock, with why', async () => {
    await codexSession({ isAsk: true })
    h.submitAnswer = { delivered: false, reason: 'prompt-on-screen' }
    expect(await handOffAskQuestion(fakeWin, SID, 'what now')).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(h.notices).toEqual([{ sessionId: SID, kind: 'not-delivered', reason: 'prompt-on-screen' }])
  })

  it('the log names a question by its length only', async () => {
    await codexSession({ isAsk: true })
    const q = 'my project is called ORCHIDWORD'
    await handOffAskQuestion(fakeWin, SID, q)
    expect(h.infos.join('\n')).not.toContain('ORCHIDWORD')
    expect(h.infos).toContain(`[codex-ask] ${SID}: a question of ${q.length} characters typed into Codex's prompt`)
  })

  it('the launch\'s own question, not on argv, goes the same way once the run is registered', async () => {
    const id = nextSid()
    const before = h.ptys.length
    spawnPty(fakeWin, id, { cwd: os.tmpdir(), cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: codexLaunch(), isAsk: true, askPrompt: 'how do I add an account?' })
    expect(h.submits).toEqual([])
    await tick(20)
    expect(h.submits).toEqual([{ sessionId: id, text: 'how do I add an account?', readyWaitMs: ASK_READY_WAIT_MS }])
    expect(h.ptys[before].writes.join('')).not.toContain('account')
  })

  it('askQuestion: with no run screen for the session, session gone, told to the dock, never a rejection', async () => {
    const term = await codexSession({ isAsk: true })
    h.withRunScreen = false
    expect(await askQuestion(fakeWin, SID, 'hello')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.notices).toEqual([{ sessionId: SID, kind: 'not-delivered', reason: 'session-gone' }])
    expect(term.writes).toEqual([])
  })
})

describe('the ports: registered once, by the PTY manager, when it loads', () => {
  it('a second registration throws, and every door still types through the first ports', async () => {
    const term = await claudeSession()
    const redirected: string[] = []
    const other = {
      write: (sessionId: string, data: string) => { redirected.push(`${sessionId}:${data}`) },
      run: () => undefined, tmuxWrapped: () => true, isCodexSession: () => true, isCodexAskSession: () => true,
    }
    expect(() => setSessionInputPorts(other)).toThrow(/already registered/)
    submitLine(SID, 'continue')
    expect(term.writes).toEqual(['continue\r'])
    expect(redirected).toEqual([])
  })

  it('before the PTY manager loads, each door that types through a port throws, naming the missing registration, and types nothing', async () => {
    // A fresh copy of the module and what it imports, the PTY manager not
    // among them: nothing it loads registers the ports.
    vi.resetModules()
    const fresh = await import('../../../src/main/session-input')
    const before = allWrites()
    expect(() => fresh.submitLine(SID, 'continue')).toThrow(/has not registered its ports/)
    expect(() => fresh.typeKeys(SID, 'continue')).toThrow(/has not registered its ports/)
    expect(() => fresh.submitMarker(SID, MARKER)).toThrow(/has not registered its ports/)
    expect(() => fresh.handOffAskQuestion(fakeWin, SID, 'type this')).toThrow(/has not registered its ports/)
    expect(allWrites()).toBe(before)
    expect(h.submits).toEqual([])
    expect(h.queued).toEqual([])
  })
})
