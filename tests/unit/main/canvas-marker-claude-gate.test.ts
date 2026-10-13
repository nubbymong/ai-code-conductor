// [host] An Agent Canvas marker line into a Claude Code session is typed only
// at Claude Code's ready, empty prompt, as the status strip's controls are:
// held until then, in order, for at most the hold bound, and dropped with its
// run. A marker dropped untyped is told to its canvas (the wiring's
// onUndelivered), once, and never typed later. A marker waits in the queue,
// not at the prompt, while a turn runs that a line typed ahead of it opened
// or that began while it waited at the prompt; and a marker the queue still
// holds when its session ends or restarts is told to its canvas too, after
// those held at the prompt, so in the order filed.
//
// Driven end to end: the REAL spawnPty (a local Claude session; the rest of
// main mocked, as canvas-worktree-spawn.test.ts does), the REAL marker queue
// and its wiring, the REAL writeCanvasMarkerLine and the module that holds a
// Claude marker (canvas/claude-marker-typing.ts), and the REAL renderer half
// (answerClaudeMarkerAsk in src/renderer/lib/claudePrompt.ts reading
// src/shared/claude-screen.ts) over a fake IPC hop. What reaches the session's
// process is what the mocked node-pty records.
//
// Mutant this must catch: writeCanvasMarkerLine's Claude branch calling
// writeSubmittedLine(sessionId, line) in place of queueClaudeMarkerLine.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { CanvasMarkerUndelivered } from '../../../src/shared/types'

const h = vi.hoisted(() => ({
  /** Every write into a session's process, in order. */
  writes: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 4343,
    process: 'pwsh',
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(d) },
    resize: () => {},
    kill: () => {},
  }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-claude-gate-res-'))
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
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
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
// The renderer half's own write path is the app's IPC bridge; here it is the
// pty:write handler's own call, writePty (below).
vi.mock('../../../src/renderer/components/terminal/screenRegistry', () => ({ readSessionScreen: () => null }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: () => {} }))

const { spawnPty, killPty, writePty, writeCanvasMarkerLine } = await import('../../../src/main/pty-manager')
const delivery = await import('../../../src/main/canvas/canvas-marker-delivery')
const { MARKER_FALLBACK_FLUSH_MS } = await import('../../../src/main/canvas/canvas-marker-queue')
const typing = await import('../../../src/main/canvas/claude-marker-typing')
const { answerClaudeMarkerAsk } = await import('../../../src/renderer/lib/claudePrompt')
const S = await import('../shared/claude-screens')
const { setupDir } = await import('../../../src/main/ipc/setup-handlers').then((m) => ({ setupDir: m.getResourcesDirectory() }))

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const MARKER = 'Approved v2 on the canvas · canvas_version_verdict recorded'
const MARKER_2 = 'Review #3 — 5 notes · canvas_review R3'
/** Two canvases of one session. canvas:agentMarker always names the canvas. */
const CANVAS_A = 'c1c2c3c4c5c6c7c8c9c0d1d2'
const CANVAS_B = 'e1e2e3e4e5e6e7e8e9e0f1f2'

let seq = 0
let SID = ''
/** What the session's terminal shows now. */
let screen: S.Row[] = S.READY
/** The hook stream the queue subscribes to at boot. */
let emit: (sessionId: string, event: string) => void = () => {}
/** How many 'type' answers still to send late, after main stopped waiting. */
let lateTypeAnswers = 0
/** What the wiring's onUndelivered was handed in this test (the canvas's
 *  "not sent" notice). A fresh list per test, so a marker of an earlier
 *  test that is told late lands in that test's list. */
let told: CanvasMarkerUndelivered[] = []

/** The marker lines that reached the session's process. */
const typedMarkers = (): string[] => h.writes.filter((w) => w.includes('canvas'))

beforeEach(async () => {
  SID = `cgate${String(++seq).padStart(19, '0')}`
  h.writes = []
  screen = S.READY
  lateTypeAnswers = 0
  vi.useRealTimers()
  typing._resetClaudeMarkerTypingForTest()
  delivery._resetCanvasMarkerQueueForTest()
  const list: CanvasMarkerUndelivered[] = []
  told = list
  // The app's own wiring (src/main/index.ts; pinned by the source check below).
  delivery.startCanvasMarkerQueue({
    write: (sessionId, line, canvasId) => writeCanvasMarkerLine(sessionId, line, canvasId),
    onUndelivered: (u) => { list.push(u) },
    subscribe: (cb) => { emit = cb },
  })
  // The renderer: answers from the session's screen, one IPC hop later, and
  // types through the pty:write handler's own call.
  const settling = new Set<string>()
  typing.setClaudeMarkerSender((ask) => {
    queueMicrotask(() => {
      const answer = answerClaudeMarkerAsk(ask, {
        readScreen: () => screen,
        write: (sessionId, data) => writePty(sessionId, data),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        settling,
      })
      if (!answer) return
      if (ask.mode === 'type' && lateTypeAnswers > 0) {
        lateTypeAnswers--
        setTimeout(() => typing.resolveClaudeMarkerAnswer(answer), typing.CLAUDE_MARKER_ANSWER_MS + 1_000)
        return
      }
      typing.resolveClaudeMarkerAnswer(answer)
    })
    return true
  })
  try { spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered before any later throw */ }
  // The launch line is held for 300 ms after the spawn; let it go first.
  await new Promise((r) => setTimeout(r, 400))
  h.writes = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  try { killPty(SID) } catch { /* best effort */ }
})

afterAll(() => {
  try { fs.rmSync(setupDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('a canvas marker into a Claude Code session waits for its ready, empty prompt', () => {
  it('types nothing while a question is on screen, then types it once at the ready prompt', async () => {
    screen = S.TOOL_QUESTION
    writeCanvasMarkerLine(SID, MARKER)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(3_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
  })

  it("a marker held over a turn stays held after the queue's fallback while Claude Code is not at its prompt", async () => {
    // UserPromptSubmit, a verdict at t=0, a tool's PreToolUse and a
    // Notification at t=5 s, then silence past the fallback.
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, 'c1c2c3c4c5c6c7c8c9c0d1d2')).toBe('queued')
    await vi.advanceTimersByTimeAsync(5_000)
    screen = S.TOOL_QUESTION
    emit(SID, 'PreToolUse')
    emit(SID, 'Notification')
    await vi.advanceTimersByTimeAsync(130_000)
    expect(typedMarkers()).toEqual([])
    // The turn now reads closed; the next verdict is held too, never typed in.
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, 'c1c2c3c4c5c6c7c8c9c0d1d2')).toBe('sent')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
    // The turn ends at the ready prompt.
    screen = S.READY
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
  })

  it('with no hook stream, a verdict filed while the folder-trust screen is up types nothing', async () => {
    screen = S.TRUST
    expect(delivery.deliverCanvasMarker(SID, MARKER, 'c1c2c3c4c5c6c7c8c9c0d1d2')).toBe('sent')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(typedMarkers()).toEqual([])
  })

  it('types nothing while the turn runs, while text is at the prompt, or on a screen it does not recognise', async () => {
    for (const shown of [S.BUSY, S.TYPED, S.SHELL, S.MODEL_PICKER]) {
      screen = shown
      writeCanvasMarkerLine(SID, MARKER)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(typedMarkers()).toEqual([])
      killPty(SID)
      try { spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered */ }
      await vi.advanceTimersByTimeAsync(400)
      h.writes = []
    }
  })

  it('keeps the order markers were handed in, one at a time', async () => {
    screen = S.EDIT_QUESTION
    writeCanvasMarkerLine(SID, MARKER)
    writeCanvasMarkerLine(SID, MARKER_2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
  })

  it('a held marker dies with its run: never typed into the next one', async () => {
    screen = S.TOOL_QUESTION
    writeCanvasMarkerLine(SID, MARKER)
    await vi.advanceTimersByTimeAsync(5_000)
    killPty(SID)
    try { spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered */ }
    await vi.advanceTimersByTimeAsync(400)
    h.writes = []
    screen = S.READY
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
  })

  it('a marker typed whose answer reaches main after it stopped waiting is typed once', async () => {
    lateTypeAnswers = 1
    writeCanvasMarkerLine(SID, MARKER)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
  })

  it('collapses a verdict line the same as one still held, and keeps a different one', async () => {
    screen = S.TOOL_QUESTION
    writeCanvasMarkerLine(SID, MARKER)
    writeCanvasMarkerLine(SID, MARKER)
    writeCanvasMarkerLine(SID, MARKER_2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
  })

  it('two canvases that file the same words over a turn: both typed at the ready prompt, in order; the same canvas again is folded', async () => {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_B)).toBe('queued')
    // Flushed at Stop while the turn's last frame still shows it running.
    screen = S.BUSY
    emit(SID, 'Stop')
    // The same words about the same canvases again, while theirs are held:
    // handed on at once, and folded into the held ones.
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_B)).toBe('sent')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`, `${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toHaveLength(3)
  })

  it("the app's wiring hands each marker's canvas on to writeCanvasMarkerLine", () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    expect(src).toMatch(/write:\s*\(sessionId,\s*line,\s*canvasId\)\s*=>\s*writeCanvasMarkerLine\(sessionId,\s*line,\s*canvasId\)/)
  })

  it('a session with no run takes nothing', async () => {
    killPty(SID)
    writeCanvasMarkerLine(SID, MARKER)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
  })
})

/** A screen the reader does not recognise: Claude Code's ready, empty prompt
 *  with one footer row drawn one column in (it holds, fail closed). */
const READY_FOOTER_ONE_COLUMN_IN: S.Row[] = (() => {
  const rows = [...S.READY]
  rows[rows.length - 6] = S.plain(` ${String.fromCharCode(0x26a0)} 1 MCP server failed`)
  return rows
})()

describe('a Claude Code marker that is not typed is told to its canvas as not sent', () => {
  it('held past the bound on a screen the reader does not recognise: told once, and never typed later', async () => {
    screen = READY_FOOTER_ONE_COLUMN_IN
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(MARKER_FALLBACK_FLUSH_MS - 5_000)
    expect(told).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'busy-timeout' }])
    expect(typedMarkers()).toEqual([])
    // The prompt reads ready later: the line is not typed after the canvas
    // was told it was not sent.
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(1)
  })

  it('held past the bound behind a question: told once, never typed over it, and not typed once it is answered', async () => {
    screen = S.TOOL_QUESTION
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(MARKER_FALLBACK_FLUSH_MS + 5_000)
    expect(told.map((u) => [u.canvasId, u.line, u.reason])).toEqual([[CANVAS_A, MARKER, 'busy-timeout']])
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(1)
  })

  it('dropped when its run ends: told once (the session gone), and never typed into the next run', async () => {
    screen = READY_FOOTER_ONE_COLUMN_IN
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(told).toEqual([])
    killPty(SID)
    try { spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered */ }
    await vi.advanceTimersByTimeAsync(400)
    h.writes = []
    await vi.advanceTimersByTimeAsync(5_000)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' }])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(1)
  })

  it('ready in time: typed once at the ready prompt, and nothing told', async () => {
    screen = S.TOOL_QUESTION
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(MARKER_FALLBACK_FLUSH_MS - 10_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(3_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toEqual([])
  })

  it('a session with no run: told at once (the session gone)', async () => {
    killPty(SID)
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(0)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' }])
    expect(typedMarkers()).toEqual([])
  })
})

const MARKER_3 = 'Approved v3 on the canvas · canvas_version_verdict recorded'

describe('a marker behind a line just typed waits for the turn that line started', () => {
  /** Two verdicts held over one turn and handed on at its Stop: the first is
   *  typed at the ready prompt, and Claude Code then takes it. */
  async function firstTyped(): Promise<void> {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    screen = S.BUSY
  }

  /** As firstTyped, and the new turn's UserPromptSubmit reaches the app. */
  async function firstTypedThenBusy(): Promise<void> {
    await firstTyped()
    emit(SID, 'UserPromptSubmit')
  }

  it('busy for longer than the hold bound, then a Stop at the ready prompt: the second is typed once after it, and nothing is told', async () => {
    await firstTypedThenBusy()
    // The turn runs past the hold bound, its tools firing hooks as they go.
    for (let t = 0; t < typing.CLAUDE_MARKER_HOLD_MS + 60_000; t += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000)
      emit(SID, 'PreToolUse')
    }
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toEqual([])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(2)
    expect(told).toEqual([])
  })

  it('no Stop ever comes: the second is told once, after the queue\'s fallback and then its own hold, and never typed', async () => {
    await firstTypedThenBusy()
    await vi.advanceTimersByTimeAsync(MARKER_FALLBACK_FLUSH_MS + typing.CLAUDE_MARKER_HOLD_MS - 5_000)
    expect(told).toEqual([])
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER_2, reason: 'busy-timeout' }])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toHaveLength(1)
  })

  it('a verdict filed as that turn opens is typed after the one waiting before it: the order they were filed in', async () => {
    await firstTypedThenBusy()
    // Filed before the second has left the prompt's wait for the queue.
    expect(delivery.deliverCanvasMarker(SID, MARKER_3, CANVAS_B)).toBe('queued')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`, `${MARKER_3}\r`])
    expect(told).toEqual([])
  })

  it.each([
    ['a short turn', 30_000],
    ['a turn longer than the hold bound', typing.CLAUDE_MARKER_HOLD_MS + 60_000],
  ])('a verdict filed after the first is typed, before that turn reads open, is typed after the one waiting before it (%s)', async (_turn, turnMs) => {
    await firstTyped()
    // Claude Code has taken the first line; its UserPromptSubmit has not
    // reached the app yet, so the turn still reads closed.
    expect(delivery.deliverCanvasMarker(SID, MARKER_3, CANVAS_B)).toBe('sent')
    emit(SID, 'UserPromptSubmit')
    // The turn runs, its tools firing hooks as they go.
    for (let t = 0; t < turnMs; t += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000)
      emit(SID, 'PreToolUse')
    }
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toEqual([])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`, `${MARKER_3}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(3)
    expect(told).toEqual([])
  })

  it('a marker whose type request went unanswered stays where it is while that turn runs: typed once', async () => {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    // The second is typed at the ready prompt too, and its answer reaches
    // main only after main stopped waiting for it.
    lateTypeAnswers = 1
    await vi.advanceTimersByTimeAsync(1_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
    // A turn opens while main still has no answer.
    screen = S.BUSY
    emit(SID, 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(30_000)
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`])
    expect(told).toEqual([])
  })
})

describe('a verdict waiting at the prompt when a turn begins waits for that turn', () => {
  /** The turn runs `ms`, its tools firing hooks every 30 s when `hooks`. */
  async function turnRuns(ms: number, hooks: boolean): Promise<void> {
    for (let t = 0; t < ms; t += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000)
      if (hooks) emit(SID, 'PreToolUse')
    }
  }

  it.each([
    ['its tools firing hooks', true, typing.CLAUDE_MARKER_HOLD_MS + 60_000],
    ['no hook at all, so the queue hands it on at its fallback', false, typing.CLAUDE_MARKER_HOLD_MS + 30_000],
  ])('text at the prompt, then a turn the user starts that runs longer than the hold bound (%s), then a Stop at the ready prompt: typed once after it, and nothing told', async (_how, hooks, turnMs) => {
    screen = S.TYPED
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([])
    // The user sends the text they had typed: a turn begins.
    screen = S.BUSY
    emit(SID, 'UserPromptSubmit')
    await turnRuns(turnMs, hooks)
    expect(typedMarkers()).toEqual([])
    expect(told).toEqual([])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('the verdicts behind it follow it, and one filed during that turn comes after them: typed in the order filed, and nothing told', async () => {
    screen = S.TYPED
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(5_000)
    screen = S.BUSY
    emit(SID, 'UserPromptSubmit')
    // Filed before the two waiting at the prompt have gone back to the queue.
    expect(delivery.deliverCanvasMarker(SID, MARKER_3, CANVAS_B)).toBe('queued')
    await turnRuns(typing.CLAUDE_MARKER_HOLD_MS + 60_000, true)
    expect(typedMarkers()).toEqual([])
    expect(told).toEqual([])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_2}\r`, `${MARKER_3}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(3)
    expect(told).toEqual([])
  })

  it('a verdict filed after the line before it is typed, before that turn reads open, with nothing waiting ahead of it: typed once after that turn, and nothing told', async () => {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    screen = S.BUSY
    // Claude Code has taken the line; its UserPromptSubmit has not reached
    // the app yet, so the turn still reads closed.
    expect(delivery.deliverCanvasMarker(SID, MARKER_3, CANVAS_B)).toBe('sent')
    emit(SID, 'UserPromptSubmit')
    await turnRuns(typing.CLAUDE_MARKER_HOLD_MS + 60_000, true)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toEqual([])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`, `${MARKER_3}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(2)
    expect(told).toEqual([])
  })

  it('a tool hook with no prompt sent (a background agent) sends nothing back: typed once the prompt reads ready', async () => {
    screen = S.TYPED
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(5_000)
    emit(SID, 'SubagentStart')
    emit(SID, 'PreToolUse')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(3_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('with no turn event nothing goes back: held at the prompt while the turn runs, and told once when its hold passes', async () => {
    screen = S.TYPED
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(10_000)
    screen = S.BUSY
    await vi.advanceTimersByTimeAsync(typing.CLAUDE_MARKER_HOLD_MS)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'busy-timeout' }])
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(1)
  })
})

describe('a verdict the queue still holds when its session ends or restarts is told to its canvas as not sent', () => {
  /** Restart the session under the same id (killPty, then a new run). */
  async function restart(): Promise<void> {
    killPty(SID)
    try { spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30 }) } catch { /* registered */ }
    await vi.advanceTimersByTimeAsync(400)
    h.writes = []
  }

  it('held over a turn, then the session restarts: told once (the session gone), and never typed into the next run', async () => {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_B)).toBe('queued')
    await restart()
    expect(told).toEqual([
      { sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' },
      { sessionId: SID, canvasId: CANVAS_B, line: MARKER_2, reason: 'session-gone' },
    ])
    // The new run's first hook, then its ready prompt.
    emit(SID, 'SessionStart')
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(2)
  })

  it('given back to wait for the turn the one before it started, then the session ends: told once, and never typed', async () => {
    emit(SID, 'UserPromptSubmit')
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    screen = S.BUSY
    emit(SID, 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(5_000)
    killPty(SID)
    delivery.forgetCanvasMarkers(SID) // the tab's close runs it again
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER_2, reason: 'session-gone' }])
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([`${MARKER}\r`])
    expect(told).toHaveLength(1)
  })

  // Order at the session end. Every marker held at the prompt was filed
  // before every marker the queue holds, so the canvas is told the first
  // ones first, at once, and the user who retypes the notices from the top
  // sends them in the order filed.
  it('one held at the busy prompt after the queue\'s fallback, a second filed once the turn reads open again, then the session ends: each told once, at once, in the order filed', async () => {
    emit(SID, 'UserPromptSubmit')
    screen = S.BUSY
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('queued')
    // No hook for longer than the fallback: the queue hands it on, and it
    // waits at the busy prompt.
    await vi.advanceTimersByTimeAsync(MARKER_FALLBACK_FLUSH_MS + 1_000)
    expect(typedMarkers()).toEqual([])
    // The turn's next tool hook reads it open again, so the second waits in
    // the queue.
    emit(SID, 'PostToolUse')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    const gone = [
      { sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' },
      { sessionId: SID, canvasId: CANVAS_A, line: MARKER_2, reason: 'session-gone' },
    ]
    killPty(SID)
    expect(told).toEqual(gone)
    delivery.forgetCanvasMarkers(SID) // the tab's close runs it again
    await vi.advanceTimersByTimeAsync(10_000)
    expect(told).toEqual(gone)
    screen = S.READY
    emit(SID, 'Stop')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toEqual(gone)
  })

  it('one held at the prompt on a screen it does not read, a second queued behind a background agent\'s tool hook, then the session restarts: each told once, in the order filed', async () => {
    screen = S.UNKNOWN_QUESTION_UNDER_OLD_PROMPT
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(typedMarkers()).toEqual([])
    emit(SID, 'PreToolUse')
    expect(delivery.deliverCanvasMarker(SID, MARKER_2, CANVAS_A)).toBe('queued')
    await restart()
    const gone = [
      { sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' },
      { sessionId: SID, canvasId: CANVAS_A, line: MARKER_2, reason: 'session-gone' },
    ]
    expect(told).toEqual(gone)
    emit(SID, 'SessionStart')
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toEqual(gone)
  })

  it('given back when the user began a turn, then the session restarts: told once, and never typed into the next run', async () => {
    screen = S.TYPED
    expect(delivery.deliverCanvasMarker(SID, MARKER, CANVAS_A)).toBe('sent')
    await vi.advanceTimersByTimeAsync(5_000)
    screen = S.BUSY
    emit(SID, 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(5_000)
    await restart()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(told).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: MARKER, reason: 'session-gone' }])
    emit(SID, 'SessionStart')
    screen = S.READY
    await vi.advanceTimersByTimeAsync(600_000)
    expect(typedMarkers()).toEqual([])
    expect(told).toHaveLength(1)
  })
})
