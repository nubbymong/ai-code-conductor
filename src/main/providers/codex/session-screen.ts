// The submit primitive's driver (WP2 PR 4, P4.1): main's own reading of each
// local Codex session's screen, and the one door through which main submits a
// text into it (./composer-submit.ts holds the rule). Since 2.1.3-beta.17 C6
// (aicc_planning#415) also the door for a saved image, pasted as Codex's own
// paste (pasteImageIntoCodexComposer holds that rule, which types its sentence
// through the primitive), on the same per-run chain.
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
import { readXtermScreen, readCodexScreen, codexComposerDraft, type ScreenLine } from '../../../shared/codex-screen'
import { codexImagePlaceholderShown, codexDraftIsImagePlaceholder, codexWarningCountShown, codexScreenPastPlaceholder } from '../../../shared/codex-image-screen'
import type { SubmitTextResult } from '../../../shared/types'
import type { HeldScreenRows, RunScreenImageNotPasted, RunScreenImageResult } from '../types'
import {
  submitToCodexComposer, submitTextRefusal, submitIngestionWindowMs, TAKE_BACK_KEY,
  SUBMIT_READY_POLL_MS, SUBMIT_READY_SECOND_READ_MS, SUBMIT_CONFIRM_POLL_MS, SUBMIT_CLEAR_VERIFY_MS,
  type ComposerSubmitDeps, type ComposerSubmitOptions,
} from './composer-submit'
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
 *  holder whose connection reads the screen and its title, else the pane,
 *  opened now. */
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
 * One submission on the session's run, after anything already in flight for
 * it (one at a time, in order): `body` gets the rule's ports, reading the
 * run's screen from whichever source it has (B2: the holder's, or the pane)
 * and writing only into this run, and the reader, for its log line. `gone`
 * when the session has no reading. Since 2.1.3-beta.17 C6 both of the run's
 * doors go through it: a text (submitCodexText) and an image
 * (submitCodexImage), so one never lands between the other's keys.
 */
function onRun<T>(sessionId: string, tag: string, gone: T, body: (deps: ComposerSubmitDeps, screen: ScreenReader) => Promise<T>): Promise<T> {
  // The run's record, which holds the raw writer the PTY manager handed in.
  const pane = runs.get(sessionId)
  if (!pane) return Promise.resolve(gone)
  const live = (): boolean => runs.get(sessionId) === pane && pane.current()
  const run = async (): Promise<T> => {
    const screen = screenReader(pane, live)
    return body({
      readScreen: screen.lines,
      readTitle: screen.title,
      settle: screen.settle,
      size: screen.size,
      write: (data) => { if (live()) pane.write(data) },
      live,
      now: () => Date.now(),
      sleep,
      log: (msg) => logInfo(`[${tag}] ${sessionId}: ${msg}`),
    }, screen)
  }
  const next = pane.chain.then(run, run)
  pane.chain = next.catch(() => undefined)
  return next
}

/** The reader's part of a log line: where the rule read the screen, and how
 *  many of the holder's reads gave none. */
const readFrom = (screen: ScreenReader): string => {
  const failed = screen.failed()
  return `the rule read ${screen.from()}${failed > 0 ? `, and ${failed} of its reads gave no screen` : ''}`
}

/**
 * Submit `text` into the session's Codex composer by the primitive's rule,
 * after anything already in flight for this run (one at a time, in order).
 * Not delivered, `session-gone`, when the session has no reading or its run
 * ends meanwhile. Never rejects. One log line per submission says what came
 * of it and where the rule read the screen (B2: the holder's, or the pane).
 */
export function submitCodexText(sessionId: string, text: string, opts: ComposerSubmitOptions): Promise<SubmitTextResult> {
  return onRun<SubmitTextResult>(sessionId, 'codex-submit', { delivered: false, reason: 'session-gone' }, async (deps, screen) => {
    try {
      const result = await submitToCodexComposer(text, deps, opts)
      logInfo(`[codex-submit] ${sessionId}: ${result.delivered ? 'delivered' : `not delivered (${result.reason})`}, ${[...text].length} code points; ${readFrom(screen)}`)
      return result
    } catch (err) {
      logWarn(`[codex-submit] ${sessionId}: the submission failed (the rule read ${screen.from()}): ${(err as Error)?.message ?? err}`)
      return { delivered: false, reason: 'session-gone' }
    }
  })
}

/** 2.1.3-beta.17 C6: how long the image rule waits for Codex's image
 *  placeholder once the path's paste has gone. C6's reading (P11's stand-in,
 *  Codex 0.157.1 on the Windows test machine, 2026-11-24, P11's 96 by 64
 *  JPEG): "[Image #1]" showed 251 to 314 ms after the paste in 8 of 8 runs. A
 *  full-size Snap picture was not measured, so the bound keeps room. */
export const IMAGE_PLACEHOLDER_WAIT_MS = 5_000
/** C6: how long the sentence waits for the composer that holds only the
 *  placeholder, read ready on two reads, before nothing more is typed. */
export const IMAGE_SENTENCE_READY_WAIT_MS = 2_000

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** One read: the screen, and the window title taken with it. */
interface ImageShot { lines: ScreenLine[] | null; title: string | null }

/**
 * 2.1.3-beta.17 C6 (aicc_planning#415): a saved image's path into Codex's
 * composer as Codex's own paste, then the sentence, then Enter. PURE, as the
 * submit primitive is: the screen, the writer, liveness and the clock come in
 * `deps` (submitCodexImage drives it). Probe P11 found Codex 0.157.1 attaches
 * a path it gets as a bracketed paste, showing "[Image #1]" in its composer,
 * and reads a path typed as text only as words (ADR-030, the P11 result).
 * C6's reading on P11's stand-in (Codex 0.157.1, 2026-11-24) is what the
 * waits and the take-back stand on: with the placeholder shown, the composer
 * reads ready but not empty, so the primitive alone would never type the
 * sentence; read past the placeholder it reads ready and empty, and the
 * sentence typed after it confirms (4 of 4); Ctrl+U clears the placeholder
 * in about 80 ms and the next turn carries no picture (4 of 4, with and
 * without the sentence typed); one Backspace leaves it (it takes the space
 * Codex types after it).
 *
 * 1. Refuses an empty path, or a path or sentence the primitive would refuse
 *    (a control character, a character outside the Basic Multilingual Plane),
 *    before anything is typed.
 * 2. Waits within `readyWaitMs` for Codex's ready, EMPTY composer, ready on
 *    two reads SUBMIT_READY_SECOND_READ_MS apart, as the primitive's own wait
 *    reads it. Codex's warning count showing (aicc_planning#371): nothing
 *    typed, at once (`warning-count`).
 * 3. The path as a bracketed paste, in one write.
 * 4. Polls for Codex's image placeholder alone in the ready composer
 *    (codexImagePlaceholderShown) within IMAGE_PLACEHOLDER_WAIT_MS. A prompt
 *    up meanwhile: nothing more typed or taken back (its keys are the
 *    prompt's). The placeholder not shown in time (`no-placeholder`), or the
 *    warning count shown: the paste is taken back (below).
 * 5. The sentence, after a space, through the submit primitive
 *    (submitToCodexComposer, the rule submitCodexText drives), reading the
 *    composer with the placeholder taken as its start
 *    (codexScreenPastPlaceholder): it waits for that composer ready and empty
 *    within IMAGE_SENTENCE_READY_WAIT_MS, types the sentence in one write,
 *    presses Enter as its own write only once the screen shows the
 *    placeholder and the whole sentence, and takes its text back with Ctrl+U
 *    (the placeholder with it) when it is not confirmed. The placeholder gone
 *    or a warning count shown: no reading, so no Enter. Nothing of the
 *    sentence typed: the paste is taken back (below).
 * 6. Taking the paste back, as the primitive takes text back: after the
 *    paste's ingestion window, on a screen it can read with no prompt up, and
 *    only while the composer holds nothing but the paste (the placeholder
 *    alone, or a part of the path): Ctrl+U, then the composer read ready and
 *    empty within SUBMIT_CLEAR_VERIFY_MS. Anything else, or the clear not
 *    seen: nothing (more) taken back, and the answer says what it typed may
 *    still be at the prompt (`left`).
 * Never sends Ctrl+C. A run that ends meanwhile: `session-gone`, nothing more.
 */
export async function pasteImageIntoCodexComposer(imagePath: string, sentence: string, deps: ComposerSubmitDeps, opts: { readyWaitMs: number }): Promise<RunScreenImageResult> {
  const models = deps.models ?? null
  const log = (msg: string): void => { try { deps.log?.(msg) } catch { /* a log line never breaks the rule */ } }
  const notPasted = (reason: RunScreenImageNotPasted, left: boolean): RunScreenImageResult => ({ pasted: false, reason, left })
  if (typeof imagePath !== 'string' || imagePath === '' || submitTextRefusal(imagePath) || submitTextRefusal(sentence)) return notPasted('refused-text', false)

  // Every read waits for the screen to draw what the session has sent, as
  // the primitive's does; a screen not drawn in time gives no reading.
  const read = async (): Promise<ImageShot> => {
    if (deps.settle) {
      let drawn = false
      try { drawn = (await deps.settle()) === true } catch { drawn = false }
      if (!drawn) return { lines: null, title: null }
    }
    let title: string | null = null
    try { title = deps.readTitle?.() ?? null } catch { title = null }
    try { return { lines: deps.readScreen(), title } } catch { return { lines: null, title } }
  }
  const state = ({ lines, title }: ImageShot): 'ready' | 'blocked' | 'waiting' => {
    const shown = readCodexScreen(lines, models, { title })
    if (shown.screen === 'blocked') return 'blocked'
    return shown.screen === 'ready' && shown.text === '' ? 'ready' : 'waiting'
  }

  // 2. The ready, empty composer, on two reads; never with the warning count.
  const waitUntil = deps.now() + Math.max(0, opts.readyWaitMs)
  let last: 'ready' | 'blocked' | 'waiting' = 'waiting'
  for (;;) {
    if (!deps.live()) return notPasted('session-gone', false)
    let shot = await read()
    if (codexWarningCountShown(shot.lines)) {
      log('Codex shows its warning count; nothing typed')
      return notPasted('warning-count', false)
    }
    last = state(shot)
    if (last === 'ready') {
      await deps.sleep(SUBMIT_READY_SECOND_READ_MS)
      if (!deps.live()) return notPasted('session-gone', false)
      shot = await read()
      if (codexWarningCountShown(shot.lines)) {
        log('Codex shows its warning count; nothing typed')
        return notPasted('warning-count', false)
      }
      last = state(shot)
      if (last === 'ready') break
    }
    if (deps.now() >= waitUntil) return notPasted(last === 'blocked' ? 'prompt-on-screen' : 'busy-timeout', false)
    await deps.sleep(SUBMIT_READY_POLL_MS)
  }

  // 3. The paste, in one write.
  deps.write(`${PASTE_START}${imagePath}${PASTE_END}`)
  const pastedAt = deps.now()

  // 6. The paste taken back, only while the composer holds nothing but it.
  const takeBack = async (reason: RunScreenImageNotPasted): Promise<RunScreenImageResult> => {
    const ingested = pastedAt + submitIngestionWindowMs([...imagePath].length)
    if (deps.now() < ingested) await deps.sleep(ingested - deps.now())
    if (!deps.live()) return notPasted('session-gone', true)
    const before = await read()
    if (before.lines === null || state(before) === 'blocked') {
      log(before.lines === null ? 'the paste was not taken back: the screen cannot be read' : 'the paste was not taken back: a prompt is up')
      return notPasted(reason, true)
    }
    const draft = codexComposerDraft(before.lines, models)
    if (draft === '') return notPasted(reason, false)
    if (draft === null || !(codexDraftIsImagePlaceholder(draft) || imagePath.replace(/\s+/g, '').includes(draft))) {
      log(draft === null ? 'the paste was not taken back: what the composer holds cannot be read' : 'the paste was not taken back: the composer holds more than the paste')
      return notPasted(reason, true)
    }
    deps.write(TAKE_BACK_KEY)
    const clearUntil = deps.now() + SUBMIT_CLEAR_VERIFY_MS
    for (;;) {
      await deps.sleep(SUBMIT_CONFIRM_POLL_MS)
      if (!deps.live()) return notPasted('session-gone', true)
      if (state(await read()) === 'ready') {
        log('the paste was taken back (Ctrl+U)')
        return notPasted(reason, false)
      }
      if (deps.now() >= clearUntil) {
        log('the paste was taken back (Ctrl+U) but the cleared composer was not seen in time')
        return notPasted(reason, true)
      }
    }
  }

  // 4. Codex's placeholder for the image.
  let placeholder: string | null = null
  const placeholderBy = pastedAt + IMAGE_PLACEHOLDER_WAIT_MS
  for (;;) {
    await deps.sleep(SUBMIT_CONFIRM_POLL_MS)
    if (!deps.live()) return notPasted('session-gone', true)
    const shot = await read()
    if (state(shot) === 'blocked') {
      log('a prompt came up after the paste; nothing more typed or taken back')
      return notPasted('prompt-on-screen', true)
    }
    if (codexWarningCountShown(shot.lines)) return takeBack('warning-count')
    placeholder = codexImagePlaceholderShown(shot.lines, models, shot.title)
    if (placeholder) break
    if (deps.now() >= placeholderBy) return takeBack('no-placeholder')
  }

  // 5. The sentence, through the primitive, past the placeholder.
  const shown = placeholder
  let typed = false
  const past: ComposerSubmitDeps = {
    ...deps,
    readScreen: () => codexScreenPastPlaceholder(deps.readScreen(), shown, typed, models),
    write: (data) => { typed = true; deps.write(data) },
    log: (msg) => log(`the sentence: ${msg}`),
  }
  const result = await submitToCodexComposer(` ${sentence}`, past, { readyWaitMs: IMAGE_SENTENCE_READY_WAIT_MS })
  if (result.delivered) return { pasted: true }
  if (result.reason === 'session-gone') return notPasted('session-gone', true)
  if (result.reason === 'prompt-on-screen') return notPasted('prompt-on-screen', true)
  if (!typed) return takeBack(result.reason === 'too-tall' ? 'too-tall' : 'busy-timeout')
  // The primitive took its text back, with the placeholder, if it could.
  const after = await read()
  return notPasted(result.reason === 'too-tall' ? 'too-tall' : 'not-drawn', state(after) !== 'ready')
}

/**
 * C6: a saved image into the session's Codex composer by the image rule
 * (pasteImageIntoCodexComposer), after anything already in flight for this
 * run, as one submission: nothing else is typed between the paste and the
 * Enter. Not pasted, `session-gone`, when the session has no reading or its
 * run ends meanwhile. Never rejects. One log line says what came of it and
 * where the rule read the screen; the log names the image by its path's
 * length only.
 */
export function submitCodexImage(sessionId: string, imagePath: string, sentence: string, opts: { readyWaitMs: number }): Promise<RunScreenImageResult> {
  return onRun<RunScreenImageResult>(sessionId, 'codex-image', { pasted: false, reason: 'session-gone', left: false }, async (deps, screen) => {
    const chars = typeof imagePath === 'string' ? [...imagePath].length : 0
    try {
      const result = await pasteImageIntoCodexComposer(imagePath, sentence, deps, opts)
      const what = result.pasted ? 'pasted and sent' : `not pasted (${result.reason})${result.left ? '; what it typed may still be at the prompt' : ''}`
      logInfo(`[codex-image] ${sessionId}: an image path of ${chars} characters ${what}; ${readFrom(screen)}`)
      return result
    } catch (err) {
      logWarn(`[codex-image] ${sessionId}: the image failed (the rule read ${screen.from()}): ${(err as Error)?.message ?? err}`)
      return { pasted: false, reason: 'session-gone', left: true }
    }
  })
}

/** Test seam. */
export function _resetCodexScreensForTest(): void {
  for (const id of [...runs.keys()]) closeCodexScreen(id)
}
