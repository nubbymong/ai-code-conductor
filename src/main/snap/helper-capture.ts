/**
 * One run of the session helper's capture mode for Snap on Windows (ADR-030
 * D3; protocol section 15, "Capturing the displays"; plan 2.1.3-beta.16 A1,
 * aicc_planning#401):
 *
 *   aicc-helper capture --out <folder>
 *
 * The helper is run by its full path, its arguments as a list, no shell, no
 * window. It writes display-<n>.bmp into the folder and prints one line,
 * `{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":1920,
 * "height":1080,"dpi":144,"scale":150,"primary":true}]}`, then exits: 0
 * written; 1 a grab or a write failed; 2 a command line it does not take; 3 no
 * desktop to capture; 4 not supported on this system (helper/src/capture.rs).
 *
 * The run has a bound: HELPER_CAPTURE_BOUND_MS, P21's 2 s (it measured 44 to
 * 62 ms on the GitHub runner, run 45091643024; the skeleton of snap-e2e read
 * 58 ms). A helper that has not ended by then is ended through its own process
 * handle (ChildProcess.kill), never looked up again by its pid, which Windows
 * may have given to another process by then.
 */

/** How long the capture may take before it is ended (P21's 2 s). */
export const HELPER_CAPTURE_BOUND_MS = 2_000
/** The most of the helper's answer that is read. */
export const HELPER_CAPTURE_MAX_OUTPUT = 64 * 1024
/** The most displays one run writes (capture.rs MAX_DISPLAYS). */
export const HELPER_CAPTURE_MAX_DISPLAYS = 16
/** The longest side the mode captures (capture.rs MAX_SIDE). */
export const HELPER_CAPTURE_MAX_SIDE = 16_384

/** The capture mode's exit statuses (capture.rs). */
export const CAPTURE_EXIT = { written: 0, failed: 1, usage: 2, noDesktop: 3, notSupported: 4 } as const

/** One display as the helper captured it, in physical pixels on the virtual screen. */
export interface HelperDisplay {
  file: string
  left: number
  top: number
  width: number
  height: number
  dpi: number
  /** The display's scale as a percentage of 96 DPI, rounded. */
  scale: number
  primary: boolean
}

/** What one run came to. */
export type HelperCaptureRun =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string; ms: number }
  | { kind: 'no-answer'; ms: number }
  | { kind: 'start-failed'; why: string; ms: number }
  | { kind: 'too-much-output'; ms: number }

/** The parts of a child process a run uses. */
export interface CaptureChild {
  stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'error', fn: (err: Error) => void): unknown
  on(event: 'close', fn: (code: number | null) => void): unknown
  /** Ends the process through the handle this child holds. */
  kill(): boolean
}

export interface HelperCaptureDeps {
  /** Starts `file` with `args`: no shell, no window, output piped. */
  spawn: (file: string, args: string[]) => CaptureChild
  /** Calls `fn` after `ms`; the answer cancels it. */
  startTimer: (fn: () => void, ms: number) => () => void
  /** A clock in milliseconds, for the time the run took. */
  now: () => number
  /** The bound; HELPER_CAPTURE_BOUND_MS in the app. */
  boundMs: number
}

/** Run `helper capture --out <folder>` once. Never throws, and settles once. */
export function runHelperCapture(helper: string, folder: string, deps: HelperCaptureDeps): Promise<HelperCaptureRun> {
  const started = deps.now()
  const ms = () => Math.max(0, Math.round(deps.now() - started))
  return new Promise<HelperCaptureRun>((resolve) => {
    let settled = false
    let cancelTimer: () => void = () => {}
    let child: CaptureChild | null = null
    const settle = (run: HelperCaptureRun, end: boolean) => {
      if (settled) return
      settled = true
      cancelTimer()
      if (end) {
        try { child?.kill() } catch { /* it ended on its own */ }
      }
      resolve(run)
    }
    // Why a start failed: the error's code (ENOENT, EACCES) when it has one,
    // as a spawn error's message holds the helper's path.
    const why = (err: unknown) => String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.message : String(err)))
    try {
      child = deps.spawn(helper, ['capture', '--out', folder])
    } catch (err) {
      settle({ kind: 'start-failed', why: why(err), ms: ms() }, false)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > HELPER_CAPTURE_MAX_OUTPUT) settle({ kind: 'too-much-output', ms: ms() }, true)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < HELPER_CAPTURE_MAX_OUTPUT) stderr += String(chunk)
    })
    child.on('error', (err) => settle({ kind: 'start-failed', why: why(err), ms: ms() }, false))
    child.on('close', (code) => settle({ kind: 'exit', code, stdout, stderr: stderr.slice(0, HELPER_CAPTURE_MAX_OUTPUT), ms: ms() }, false))
    cancelTimer = deps.startTimer(() => settle({ kind: 'no-answer', ms: ms() }, true), deps.boundMs)
  })
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

/** The helper's one line, read strictly: one JSON object holding only
 *  `displays`, one to HELPER_CAPTURE_MAX_DISPLAYS of them, each named
 *  display-<n>.bmp in order (so a name is never a path), its bounds whole
 *  numbers, its sides 1 to HELPER_CAPTURE_MAX_SIDE. Null for anything else. */
export function parseCaptureLine(text: string): HelperDisplay[] | null {
  const line = String(text ?? '').trim()
  if (line === '' || /[\r\n]/.test(line)) return null
  let v: unknown
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).join(',') !== 'displays' || !Array.isArray(o.displays)) return null
  const list = o.displays as unknown[]
  if (list.length < 1 || list.length > HELPER_CAPTURE_MAX_DISPLAYS) return null
  const out: HelperDisplay[] = []
  for (let i = 0; i < list.length; i++) {
    const d = list[i] as Record<string, unknown> | null
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null
    if (d.file !== `display-${i + 1}.bmp`) return null
    if (!isInt(d.left, -0x80000000, 0x7fffffff) || !isInt(d.top, -0x80000000, 0x7fffffff)) return null
    if (!isInt(d.width, 1, HELPER_CAPTURE_MAX_SIDE) || !isInt(d.height, 1, HELPER_CAPTURE_MAX_SIDE)) return null
    if (!isInt(d.dpi, 1, 100_000) || !isInt(d.scale, 1, 100_000) || typeof d.primary !== 'boolean') return null
    out.push({ file: d.file, left: d.left, top: d.top, width: d.width, height: d.height, dpi: d.dpi, scale: d.scale, primary: d.primary })
  }
  return out
}
