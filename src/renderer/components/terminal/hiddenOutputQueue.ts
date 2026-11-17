/**
 * aicc_planning#303: output for a terminal that is not on screen, written in
 * batches.
 *
 * Why, per the ticket's 2.1.2 profile and a read of xterm 6.0.0's source (not
 * re-measured: the test VM's profiles show `handleSelectionChanged` at 0 ms,
 * because its fake CLI redraws in place and does not scroll): every write
 * that scrolls an xterm terminal refreshes its selection layer, and on the
 * DOM renderer (every terminal but the active one) that redraw rebuilds the
 * whole viewport, through a path that ignores xterm's own pause for a hidden
 * terminal. What the VM did measure is xterm's write and parse loop, which
 * fell by about three quarters with this queue. A hidden terminal takes its
 * output in one write per HIDDEN_OUTPUT_FLUSH_MS; the visible one still
 * writes every chunk at once.
 *
 * Order is the whole contract: `push` on a visible terminal writes what is
 * queued before the new chunk, and callers flush before they write a line of
 * their own (an exit line, a launch failure), before the resume nudge, and
 * when the terminal is shown.
 *
 * A screen read (the gate a command or a canvas marker is typed behind) is
 * the one reader of a hidden terminal's buffer. xterm parses a write on a
 * later task, so a batch is on the screen only once xterm reports it parsed
 * (the write's callback). Until then the screen can be up to
 * HIDDEN_OUTPUT_FLUSH_MS old: `prepareScreenRead` writes anything queued and
 * says whether a batch is still waiting to be parsed (`behind`), and the
 * reader answers "no screen" for that read. The terminal then writes each
 * chunk at once for SCREEN_READ_LIVE_MS, so the reads that follow (the gates
 * poll) see it as current as a visible terminal. A chunk written at once
 * (visible, or live after a read) is not waited for: that is how every
 * terminal was read before batching.
 */
export const HIDDEN_OUTPUT_FLUSH_MS = 1000

/** How long after a screen read a hidden terminal writes each chunk at once. */
export const SCREEN_READ_LIVE_MS = 3000

export interface HiddenOutputQueueOptions {
  /** Writes output to the terminal (the caller's full per-chunk write path:
   *  the follow decision, the write and the repaint scheduling). For a batch
   *  it passes `parsed`, which the caller hands to xterm's write callback. */
  write: (chunk: string, parsed?: () => void) => void
  /** Whether the terminal's output must be written at once now (it is on
   *  screen, or its screen is read). */
  isVisible: () => boolean
}

export interface HiddenOutputQueue {
  /** Output for the terminal: written now when visible (after anything
   *  queued), queued when hidden. */
  push(chunk: string): void
  /** Write everything queued, now. */
  flush(): void
  /** A screen read is about to happen: write everything queued, and write
   *  each chunk at once for the next SCREEN_READ_LIVE_MS. `behind` is true
   *  while a batch is not yet parsed: the screen read now does not show it. */
  prepareScreenRead(): { behind: boolean }
  /** The terminal is gone: drop the timer and what is queued. */
  dispose(): void
}

export function createHiddenOutputQueue(opts: HiddenOutputQueueOptions): HiddenOutputQueue {
  let queued = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let liveUntil = Number.NEGATIVE_INFINITY
  /** Batches handed to the terminal that xterm has not reported parsed. */
  let unparsed = 0
  let disposed = false
  /** A refused batch has been logged. */
  let warned = false

  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (disposed || queued === '') return
    const chunk = queued
    queued = ''
    let settled = false
    const parsed = (): void => {
      if (settled) return
      settled = true
      unparsed -= 1
    }
    unparsed += 1
    try {
      opts.write(chunk, parsed)
    } catch (err) {
      // xterm refused the batch (it throws once about 50 MB is waiting to be
      // parsed): it never reaches the screen, so there is nothing to wait
      // for. Not rethrown: every caller is a cleanup or bookkeeping path
      // (shown, exit, spawn end, launch failure, the timer) that must finish,
      // and the batch is lost either way. Logged on the first refusal only,
      // so a flood does not fill the console.
      parsed()
      if (!warned) {
        warned = true
        console.warn('[hiddenOutputQueue] xterm refused a batch', err)
      }
    }
  }

  return {
    push(chunk) {
      if (disposed) return
      if (opts.isVisible() || performance.now() < liveUntil) {
        flush()
        opts.write(chunk)
        return
      }
      queued += chunk
      if (timer === null) timer = setTimeout(flush, HIDDEN_OUTPUT_FLUSH_MS)
    },
    flush,
    prepareScreenRead() {
      if (disposed) return { behind: false }
      // A steady clock: a wall clock set back or forward (time sync, a manual
      // change) must not stretch or cut the live window.
      liveUntil = performance.now() + SCREEN_READ_LIVE_MS
      flush()
      return { behind: unparsed > 0 }
    },
    dispose() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      queued = ''
      disposed = true
    },
  }
}
