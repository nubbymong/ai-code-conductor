// The submit primitive's driver (WP2 PR 4, P4.1): main's own reading of each
// local Codex session's screen, and the one door through which main submits a
// text into it (./composer-submit.ts holds the rule).
//
// WHY A PANE OF ITS OWN. Main holds a Codex session's screen only while the
// Watchdog is on (default off), and the renderer's screen is the renderer's:
// a marker the queue flushes at a turn boundary, or Ask's question held for
// the first ready composer, is main's to deliver whether or not a renderer is
// looking. So each local Codex session that no holder reads for it (below)
// gets a headless xterm pane fed the session's own output from its first
// byte, bounded the way the Watchdog's is (no scrollback, a clamped size, the
// CSI parameter clamp against hostile output), and kept at the real pane's
// size by resizePty. The completion plan leaves the choice open (9.4 P4.1);
// the phase record names this one.
//
// THE HOLDER'S SCREEN (2.1.3-beta.14 B2, aicc_planning#388). A session the
// session helper holds has a screen of record already: its holder's, which
// parses the session's output as it comes (`screen.read`). Such a run opens
// no pane. The composer rule reads the rows and the window title from the
// holder, one read each time it looks; a read that fails, or a screen that
// comes back cut (only its bottom rows), is no reading, never a ready one.
// Whether a run is held that way is known only at its first byte: a launch
// through the helper can still start the usual way before then (helper-pty.ts
// fallBack), and its holder may read no screen. So it is asked then (`held`):
// the holder's read, or the pane, opened before that byte is fed. Before the
// first byte a read gives nothing, as an empty pane gave nothing ready. The
// rule is the same for both (src/shared/codex-screen.ts and
// ./composer-submit.ts); only where its rows and title come from differs, and
// each submission's log line says which.
//
// ONE RUN. A pane belongs to the process it was opened for: a respawn opens a
// new one, and every key the primitive sends checks first that its run is
// still the session's, so nothing is typed into a later process. A holder's
// read is the run's as well: the session's next run is a new one.
//
// The CSI clamp is the caller's (the PTY manager hands in the Watchdog's,
// clampAnsiChunk), so both of main's panes clamp alike and this package
// imports no shared module that reaches the other provider's package. It is
// required: a pane is never fed unclamped output.
import { Terminal } from '@xterm/headless'
import { readXtermScreen, type ScreenLine } from '../../../shared/codex-screen'
import type { SubmitTextResult } from '../../../shared/types'
import type { HeldScreenRows } from '../types'
import { submitToCodexComposer, type ComposerSubmitOptions } from './composer-submit'
import { logInfo, logWarn } from '../../debug-logger'

/** No terminal is anywhere near this; a resize past it is ignored. */
const MAX_PANE_COLS = 1000
const MAX_PANE_ROWS = 1000

/** The clamp's state across chunks: a trailing partial CSI held back. */
interface ClampState {
  residual: string
}

/** What every chunk goes through before the pane parses it. */
export type PaneClamp = (data: string, state: ClampState) => string

/** B2: one read of the holder's screen (the session helper's `screen.read`). */
export type HeldScreenRead = () => Promise<HeldScreenRows>

/** Where a run's screen is read from. `first-byte`: a run a session helper
 *  may hold, before its first byte decides (`held`). `pane`: main's own
 *  headless pane, with the last window title the run's output set (null: none
 *  yet; 2.1.3-beta.13 B2, aicc_planning#370). `holder`: the holder's screen. */
type ScreenSource =
  | { kind: 'first-byte'; held: () => HeldScreenRead | undefined }
  | { kind: 'pane'; term: Terminal; clampState: ClampState; title: string | null }
  | { kind: 'holder'; read: HeldScreenRead }

/** One run's reading of its screen, and its door into the run. */
interface RunScreen {
  clamp: PaneClamp
  /** A raw write into this run's own process. */
  write: (data: string) => void
  /** Whether this run's process is still the session's. */
  current: () => boolean
  /** The submissions in flight for this run, one at a time, in order. */
  chain: Promise<unknown>
  /** The run's size as the PTY manager last gave it: a pane opened at the
   *  first byte starts at it. */
  cols: number
  rows: number
  source: ScreenSource
}

const runs = new Map<string, RunScreen>()

const sane = (cols: number, rows: number): boolean =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cols <= MAX_PANE_COLS && rows <= MAX_PANE_ROWS

function openPane(cols: number, rows: number): ScreenSource & { kind: 'pane' } {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const source = { kind: 'pane' as const, term, clampState: { residual: '' }, title: null as string | null }
  term.onTitleChange((title) => { source.title = title })
  return source
}

/** Open the reading of a Codex session's new run (replacing any earlier one).
 *  `write` writes into that run's process as one write; `current` says
 *  whether that process is still the session's. Without `held`, its pane
 *  opens now; with it (B2), the run's first byte decides (feedCodexScreen). */
export function openCodexScreen(sessionId: string, opts: { cols: number; rows: number; write: (data: string) => void; current: () => boolean; clamp: PaneClamp; held?: () => HeldScreenRead | undefined }): void {
  closeCodexScreen(sessionId)
  if (typeof opts.clamp !== 'function') throw new Error('a Codex session pane needs its CSI clamp')
  const cols = sane(opts.cols, opts.rows) ? opts.cols : 120
  const rows = sane(opts.cols, opts.rows) ? opts.rows : 40
  const source: ScreenSource = typeof opts.held === 'function' ? { kind: 'first-byte', held: opts.held } : openPane(cols, rows)
  runs.set(sessionId, { clamp: opts.clamp, write: opts.write, current: opts.current, chain: Promise.resolve(), cols, rows, source })
}

/** B2: a held run's first byte. The holder's read when its terminal is on a
 *  holder whose connection reads the screen, else the pane, opened now. */
function decideAtFirstByte(sessionId: string, run: RunScreen, held: () => HeldScreenRead | undefined): void {
  let read: HeldScreenRead | undefined
  try { read = held() } catch { read = undefined }
  if (typeof read === 'function') {
    run.source = { kind: 'holder', read }
    logInfo(`[codex-screen] ${sessionId}: held by the session helper, so its composer rule reads the holder's screen and no pane is opened`)
    return
  }
  run.source = openPane(run.cols, run.rows)
  logInfo(`[codex-screen] ${sessionId}: not on a holder that reads its screen (started the usual way, or its holder reads none), so main's own pane is opened before its first byte`)
}

/** The session's output, as its terminal receives it. */
export function feedCodexScreen(sessionId: string, data: string): void {
  const run = runs.get(sessionId)
  if (!run) return
  if (run.source.kind === 'first-byte') decideAtFirstByte(sessionId, run, run.source.held)
  const source = run.source
  if (source.kind !== 'pane') return
  try { source.term.write(run.clamp(data, source.clampState)) } catch { /* a pane never breaks the data path */ }
}

/** Keep the pane at the real pane's size, so wrapping and the composer's
 *  height read as the user sees them. A holder keeps its own. */
export function resizeCodexScreen(sessionId: string, cols: number, rows: number): void {
  const run = runs.get(sessionId)
  if (!run || !sane(cols, rows)) return
  run.cols = cols
  run.rows = rows
  if (run.source.kind !== 'pane') return
  try { run.source.term.resize(cols, rows) } catch { /* a mid-write resize throw is not fatal */ }
}

/** The session's process is gone: its reading goes with it, and every
 *  submission still waiting on it reports the session gone. */
export function closeCodexScreen(sessionId: string): void {
  const run = runs.get(sessionId)
  if (!run) return
  runs.delete(sessionId)
  if (run.source.kind === 'pane') {
    try { run.source.term.dispose() } catch { /* already gone */ }
  }
}

/** Whether main reads this session's screen (a local Codex session's run):
 *  through its pane, through its holder, or (a held run before its first
 *  byte) through whichever that byte decides. */
export function hasCodexScreen(sessionId: string): boolean {
  return runs.has(sessionId)
}

/** The live screen of the session's pane, as the renderer's reader reads a
 *  terminal; null when it has no pane (none, or read from its holder). */
export function readCodexSessionScreen(sessionId: string): ScreenLine[] | null {
  const source = runs.get(sessionId)?.source
  if (source?.kind !== 'pane') return null
  try { return readXtermScreen(source.term) } catch { return null }
}

/** B2 of 2.1.3-beta.13: the window title the session's run has set, beside
 *  its pane's screen; null when it has set none, or the session has no pane. */
export function readCodexSessionTitle(sessionId: string): string | null {
  const source = runs.get(sessionId)?.source
  return source?.kind === 'pane' ? source.title : null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, ms))
  ;(t as { unref?: () => void }).unref?.()
})

/** The longest a read waits for the pane to draw what it was fed. */
export const PANE_DRAW_WAIT_MS = 1_000

/** Resolves true once the pane has parsed everything fed to it so far (xterm
 *  parses a write a moment later; an empty write's callback runs after every
 *  write before it), false when that does not happen in time or the pane is
 *  gone (ADR-009 round 1). */
function paneDrawn(term: Terminal): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), PANE_DRAW_WAIT_MS)
    ;(t as { unref?: () => void }).unref?.()
    try {
      term.write('', () => { clearTimeout(t); resolve(true) })
    } catch {
      clearTimeout(t)
      resolve(false)
    }
  })
}

/** Whether the session's pane has drawn everything it was fed (see paneDrawn);
 *  false for a session with no pane. */
export function settleCodexScreen(sessionId: string): Promise<boolean> {
  const source = runs.get(sessionId)?.source
  return source?.kind === 'pane' ? paneDrawn(source.term) : Promise.resolve(false)
}

/** One answer of the holder's, as the rule reads a screen. */
interface HolderShot { lines: ScreenLine[]; title: string | null; cols: number; rows: number }

/** B2: the holder's screen now, or null: a read that failed, and a screen cut
 *  to its bottom rows (what is above them could be a prompt), are no reading. */
async function holderShot(read: HeldScreenRead): Promise<HolderShot | null> {
  let answer: HeldScreenRows
  try { answer = await read() } catch { return null }
  if (!answer || answer.cut || !Array.isArray(answer.lines) || answer.lines.length !== answer.rows) return null
  const lines: ScreenLine[] = answer.lines.map((l) => ({
    text: l.text,
    typed: l.typed,
    ...(typeof l.inverse === 'string' ? { inverse: l.inverse } : {}),
    ...(typeof l.width === 'number' ? { width: l.width } : {}),
    ...(typeof l.end === 'number' ? { end: l.end } : {}),
  }))
  return { lines, title: typeof answer.title === 'string' ? answer.title : null, cols: answer.cols, rows: answer.rows }
}

/** What a submission (and readCodexScreenOnce) reads a run's screen through:
 *  settle first, then the rows and the title, from whichever source the run
 *  has at that moment. `live` false: nothing is read. */
interface ScreenReader {
  settle: () => Promise<boolean>
  lines: () => ScreenLine[] | null
  title: () => string | null
  size: () => { cols: number; rows: number }
  /** Where the last read came from, for the log line. */
  from: () => string
  /** How many of the holder's reads gave no screen. */
  failed: () => number
}

function screenReader(run: RunScreen, live: () => boolean): ScreenReader {
  // The holder's answer to the last settle, read by the calls that follow it.
  let shot: HolderShot | null = null
  let failed = 0
  return {
    settle: async () => {
      shot = null
      if (!live()) return false
      const source = run.source
      if (source.kind === 'pane') return paneDrawn(source.term)
      // Before the first byte there is nothing to read yet.
      if (source.kind !== 'holder') return false
      shot = await holderShot(source.read)
      if (!shot) failed++
      return shot !== null && live()
    },
    lines: () => {
      if (!live()) return null
      const source = run.source
      if (source.kind === 'pane') return readXtermScreen(source.term)
      return source.kind === 'holder' && shot ? shot.lines : null
    },
    title: () => {
      if (!live()) return null
      const source = run.source
      if (source.kind === 'pane') return source.title
      return source.kind === 'holder' && shot ? shot.title : null
    },
    size: () => {
      const source = run.source
      if (source.kind === 'pane') return { cols: source.term.cols, rows: source.term.rows }
      return source.kind === 'holder' && shot ? { cols: shot.cols, rows: shot.rows } : { cols: run.cols, rows: run.rows }
    },
    from: () => {
      const kind = run.source.kind
      if (kind === 'holder') return 'the holder\'s screen'
      return kind === 'pane' ? 'main\'s own pane' : 'no screen yet (the session had sent nothing)'
    },
    failed: () => failed,
  }
}

/** B2: one read of the session's screen as the composer rule takes it (the
 *  pane drawn, or the holder asked), with the window title; null when there is
 *  no reading (no run, nothing sent yet, a pane not drawn in time, or a
 *  holder's read that gave no screen). */
export async function readCodexScreenOnce(sessionId: string): Promise<{ lines: ScreenLine[]; title: string | null } | null> {
  const run = runs.get(sessionId)
  if (!run) return null
  const reader = screenReader(run, () => runs.get(sessionId) === run)
  if (!(await reader.settle())) return null
  const lines = reader.lines()
  return lines ? { lines, title: reader.title() } : null
}

/**
 * Submit `text` into the session's Codex composer by the primitive's rule,
 * after anything already in flight for this run (one at a time, in order).
 * Not delivered, `session-gone`, when the session has no reading or its run
 * ends meanwhile. Never rejects. One log line per submission says what came
 * of it and where the rule read the screen (B2: the holder's, or the pane).
 */
export function submitCodexText(sessionId: string, text: string, opts: ComposerSubmitOptions): Promise<SubmitTextResult> {
  // The run's record, which holds the raw writer the PTY manager handed in.
  const pane = runs.get(sessionId)
  if (!pane) return Promise.resolve({ delivered: false, reason: 'session-gone' })
  const live = (): boolean => runs.get(sessionId) === pane && pane.current()
  const run = async (): Promise<SubmitTextResult> => {
    const screen = screenReader(pane, live)
    try {
      const result = await submitToCodexComposer(text, {
        readScreen: screen.lines,
        readTitle: screen.title,
        settle: screen.settle,
        size: screen.size,
        write: (data) => { if (live()) pane.write(data) },
        live,
        now: () => Date.now(),
        sleep,
        log: (msg) => logInfo(`[codex-submit] ${sessionId}: ${msg}`),
      }, opts)
      const failed = screen.failed()
      const noScreen = failed > 0 ? `, and ${failed} of its reads gave no screen` : ''
      logInfo(`[codex-submit] ${sessionId}: ${result.delivered ? 'delivered' : `not delivered (${result.reason})`}, ${[...text].length} code points; the rule read ${screen.from()}${noScreen}`)
      return result
    } catch (err) {
      logWarn(`[codex-submit] ${sessionId}: the submission failed (the rule read ${screen.from()}): ${(err as Error)?.message ?? err}`)
      return { delivered: false, reason: 'session-gone' }
    }
  }
  const next = pane.chain.then(run, run)
  pane.chain = next.catch(() => undefined)
  return next
}

/** Test seam. */
export function _resetCodexScreensForTest(): void {
  for (const id of [...runs.keys()]) closeCodexScreen(id)
}
