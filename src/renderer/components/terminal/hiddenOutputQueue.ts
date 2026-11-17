/**
 * aicc_planning#303: output for a terminal that is not on screen, written in
 * batches.
 *
 * Every write that scrolls an xterm terminal refreshes its selection layer,
 * and on the DOM renderer (every terminal but the active one) that redraw
 * rebuilds the whole viewport, through a path that ignores xterm's own pause
 * for a hidden terminal. With many sessions streaming, the window spent much
 * of its time redrawing terminals nobody could see. A hidden terminal now
 * takes its output in one write per `flushMs`; the visible one still writes
 * every chunk at once.
 *
 * Order is the whole contract: `push` on a visible terminal writes what is
 * queued before the new chunk, and callers flush before they write a line of
 * their own (an exit line, a launch failure), before the resume nudge, and
 * when the terminal is shown.
 *
 * A screen read (the gate a command or a canvas marker is typed behind) is
 * the one reader of a hidden terminal's buffer. xterm parses a write on a
 * later task, so output queued at the moment of a read cannot be on the
 * screen it reads: `beforeScreenRead` writes the queue and says so, and the
 * reader answers "no screen" for that read rather than a screen up to
 * `flushMs` old. The terminal then writes each chunk at once for
 * `liveAfterReadMs`, so the reads that follow (the gates poll) see it as
 * current as a visible terminal.
 */
export const HIDDEN_OUTPUT_FLUSH_MS = 1000

/** How long after a screen read a hidden terminal writes each chunk at once. */
export const SCREEN_READ_LIVE_MS = 3000

export interface HiddenOutputQueueOptions {
  /** Writes output to the terminal (the caller's full per-chunk write path:
   *  the follow decision, the write and the repaint scheduling). */
  write: (chunk: string) => void
  /** Whether the terminal is on screen now. */
  isVisible: () => boolean
  flushMs?: number
  liveAfterReadMs?: number
}

export interface HiddenOutputQueue {
  /** Output for the terminal: written now when visible (after anything
   *  queued), queued when hidden. */
  push(chunk: string): void
  /** Write everything queued, now. */
  flush(): void
  /** A screen read is about to happen: write everything queued, and write
   *  each chunk at once for the next `liveAfterReadMs`. True when something
   *  was queued, so the screen read now does not show it yet. */
  beforeScreenRead(): boolean
  /** The terminal is gone: drop the timer and what is queued. */
  dispose(): void
}

export function createHiddenOutputQueue(opts: HiddenOutputQueueOptions): HiddenOutputQueue {
  const flushMs = opts.flushMs ?? HIDDEN_OUTPUT_FLUSH_MS
  const liveAfterReadMs = opts.liveAfterReadMs ?? SCREEN_READ_LIVE_MS
  let queued = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let liveUntil = Number.NEGATIVE_INFINITY
  let disposed = false

  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (disposed || queued === '') return
    const chunk = queued
    queued = ''
    opts.write(chunk)
  }

  return {
    push(chunk) {
      if (disposed) return
      if (opts.isVisible() || Date.now() < liveUntil) {
        flush()
        opts.write(chunk)
        return
      }
      queued += chunk
      if (timer === null) timer = setTimeout(flush, flushMs)
    },
    flush,
    beforeScreenRead() {
      if (disposed) return false
      liveUntil = Date.now() + liveAfterReadMs
      const behind = queued !== ''
      flush()
      return behind
    },
    dispose() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      queued = ''
      disposed = true
    },
  }
}
