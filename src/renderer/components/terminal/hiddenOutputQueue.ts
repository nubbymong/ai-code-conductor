/**
 * aicc_planning#303: output for a terminal that is not on screen, written in
 * batches.
 *
 * Every write that scrolls an xterm terminal refreshes its selection layer,
 * and on the DOM renderer (every terminal but the active one) that redraw
 * rebuilds the whole viewport -- through a path that ignores xterm's own pause
 * for a hidden terminal. With many sessions streaming, the window spent most
 * of its time redrawing terminals nobody could see. Hidden terminals now take
 * their output in one write per `flushMs`; the visible one still writes every
 * chunk at once.
 *
 * Order is the whole contract: `push` on a visible terminal flushes what is
 * queued before the new chunk, and callers flush before writing a line of
 * their own (an exit line, a launch failure) and when the terminal is shown.
 */
export const HIDDEN_OUTPUT_FLUSH_MS = 1000

export interface HiddenOutputQueueOptions {
  /** Writes output to the terminal (the caller's full per-chunk write path). */
  write: (chunk: string) => void
  /** Whether the terminal is on screen now. */
  isVisible: () => boolean
  flushMs?: number
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

export interface HiddenOutputQueue {
  /** Output for the terminal: written now when visible, queued when hidden. */
  push(chunk: string): void
  /** Write everything queued, now. */
  flush(): void
  /** Drop the timer (the terminal is gone); queued output is discarded. */
  dispose(): void
}

export function createHiddenOutputQueue(opts: HiddenOutputQueueOptions): HiddenOutputQueue {
  const flushMs = opts.flushMs ?? HIDDEN_OUTPUT_FLUSH_MS
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t))
  let queued = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (disposed || queued === '') return
    const chunk = queued
    queued = ''
    opts.write(chunk)
  }

  return {
    push(chunk) {
      if (disposed) return
      if (opts.isVisible()) {
        flush()
        opts.write(chunk)
        return
      }
      queued += chunk
      if (timer === null) timer = setTimer(flush, flushMs)
    },
    flush,
    dispose() {
      if (timer !== null) { clearTimer(timer); timer = null }
      queued = ''
      disposed = true
    },
  }
}
