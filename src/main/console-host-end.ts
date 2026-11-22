/**
 * A terminal's console host ends with its program (aicc_planning #363,
 * Windows only).
 *
 * On the ConPTY built into Windows a terminal's console host (conhost.exe, a
 * child of this main process) ends only when its pseudoconsole is closed.
 * node-pty (1.2.0-beta.15, src/win/conpty.cc) closes it in its kill, but only
 * while it still has it: the thread that waits for the program drops the
 * pseudoconsole, unclosed, the moment the program exits. So when a program
 * ends by itself (exit typed in a Terminal only tab, Claude Code quit from
 * inside), the kill that follows, at the tab's close, finds nothing to close,
 * and the host runs until the app quits. On the published beta.13: every one
 * of five such hosts was still running 60 s after its program's end, and 60 s
 * after its tab was closed (probe P19 found the same in 21 of 22 runs per CI
 * dispatch). A kill while the program still runs closes the pseudoconsole,
 * and the host ends (beta.13: none of five left). node-pty's bundled ConPTY
 * ends its host with the program by itself, and is left as it is.
 *
 * The app holds nothing it could close the pseudoconsole with after that, so
 * it ends the host instead, through the session helper's end-console-host
 * mode, with what it notes at the terminal's start: the time node-pty's spawn
 * took (Date.now() just before it and just after it). node-pty makes the
 * pseudoconsole, and Windows its host, inside that call, and spawns run one at
 * a time on this thread. Once node-pty reports the program's exit, the helper
 * ends the one console host that is a child of this process, Windows' own
 * System32\conhost.exe, this user's, made in that time and still running; when
 * none is, or more than one, it ends nothing (docs/remote/helper-protocol.md
 * section 15). After a kill while the program still ran, node-pty has closed
 * the pseudoconsole, so the helper finds no running host made then and ends
 * nothing: one short run on every end, so node-pty's own state at the kill is
 * never read. A terminal whose program still runs is never asked for. Two
 * starts in the same millisecond cannot be told apart by their time, so
 * neither is asked for. Only the PTY's own exit asks, so it is asked once, and
 * whichever session the PTY was for by then (a Restart's stale exit too).
 */
import type { IPty } from 'node-pty'
import { logInfo } from './debug-logger'
import { installedHelperPath, parseConsoleHostsAnswer, runHelperFile, type HelperRun } from './console-host-leftovers'

/** Milliseconds from 1 January 1601 to 1 January 1970 (UTC): a Windows
 *  FILETIME counts steps of 100 ns from the first. */
export const FILETIME_EPOCH_MS = 11_644_473_600_000

/** The longest a start may take and still be asked for: the helper's bound
 *  (consoles.rs MAX_START_SPAN, ten seconds). */
export const MAX_START_MS = 10_000

/** A Date.now() time as the helper takes one: steps of 100 ns since 1601
 *  (UTC), in digits. Exact: a whole number of milliseconds times 10,000. */
export function filetimeOf(ms: number): string {
  return `${ms + FILETIME_EPOCH_MS}0000`
}

/** What the end needs from the app (tests give fakes). */
export interface ConsoleHostEndPorts {
  platform: NodeJS.Platform
  /** This main process's pid: the helper's answer must name it. */
  ownPid: number
  now(): number
  /** The helper beside the app, or null when this install has none. */
  helperPath(): string | null
  runHelper(helper: string, args: string[]): Promise<HelperRun>
  log(line: string): void
}

function appPorts(): ConsoleHostEndPorts {
  return {
    platform: process.platform,
    ownPid: process.pid,
    now: () => Date.now(),
    helperPath: installedHelperPath,
    runHelper: runHelperFile,
    log: (line) => logInfo(line),
  }
}

let override: Partial<ConsoleHostEndPorts> | null = null

function ports(): ConsoleHostEndPorts {
  return { ...appPorts(), ...(override ?? {}) }
}

/** One terminal's start, as timed here: `from` and `to` are Date.now() just
 *  before and just after node-pty's spawn. */
interface Start {
  from: number
  to: number
  /** Not asked for: its time cannot single out its host. */
  untimed: boolean
}

/** The last start timed, to tell two in the same millisecond. */
let lastStart: Start | null = null
/** Said once a run: no helper in this install. */
let saidNoHelper = false

/** Whether `proc` is a terminal node-pty made on Windows: it has node-pty's
 *  ConPTY agent (WindowsTerminal._agent, the shape pty-input-guard.ts reads
 *  too). Anything else has no pseudoconsole of this process. */
function isWindowsNodePty(proc: unknown): boolean {
  const agent = (proc as { _agent?: unknown } | null | undefined)?._agent
  return !!agent && typeof agent === 'object'
}

/**
 * node-pty's spawn (`start`, which calls it with the options `opts`): on
 * Windows, on the ConPTY built into Windows, its console host is ended once
 * node-pty reports its program's exit (see the module comment). Anything else
 * is `start` as it is: another system, node-pty's bundled ConPTY
 * (`useConptyDll: true`), or what is not a terminal node-pty made.
 */
export function spawnEndingConsoleHost(opts: object | undefined, start: () => IPty): IPty {
  const p = ports()
  if (p.platform !== 'win32' || (opts as { useConptyDll?: unknown } | undefined)?.useConptyDll === true) return start()
  const from = p.now()
  const proc = start()
  const to = p.now()
  if (!isWindowsNodePty(proc)) return proc
  const timed: Start = { from, to, untimed: !(Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from && to - from < MAX_START_MS) }
  // In the same millisecond as the start before it (or a clock set back):
  // which host is whose cannot be told by time.
  if (lastStart && from <= lastStart.to) {
    lastStart.untimed = true
    timed.untimed = true
  }
  lastStart = timed
  let asked = false
  try {
    proc.onExit(() => {
      if (asked || timed.untimed) return
      asked = true
      void endConsoleHost(timed, proc)
    })
  } catch { /* a PTY that cannot report its exit: nothing is asked for it */ }
  return proc
}

/** The terminal's program for the log, " (process <pid>)", when its pid can be read. */
function pidTag(proc: IPty): string {
  try {
    const pid = proc.pid
    if (typeof pid === 'number' && pid > 0) return ` (process ${pid})`
  } catch { /* not readable */ }
  return ''
}

/** Ask the helper to end the host `start` made. Never throws. */
async function endConsoleHost(start: Start, proc: IPty): Promise<void> {
  const p = ports()
  const which = `a terminal whose program ended${pidTag(proc)}`
  try {
    const helper = p.helperPath()
    if (!helper) {
      if (!saidNoHelper) {
        saidNoHelper = true
        p.log('[console-hosts] The session helper is not in this install, so the console host of a terminal whose program ended runs until the app quits')
      }
      return
    }
    const run = await p.runHelper(helper, ['end-console-host', '--made-from', filetimeOf(start.from), '--made-to', filetimeOf(start.to + 1)])
    const notes = run.stderr.trim().slice(0, 1000)
    if (!run.ok) {
      p.log(`[console-hosts] The session helper could not end the console host of ${which}: ${(run.why || notes || 'no reason given').slice(0, 300)}`)
      return
    }
    const answer = parseConsoleHostsAnswer(run.stdout)
    if (!answer || answer.pid !== p.ownPid) {
      p.log(`[console-hosts] The session helper's answer about ${which} could not be read, or names another process`)
      return
    }
    if (answer.ended > 0) p.log(`[console-hosts] Ended the console host of ${which}`)
    if (notes) p.log(`[console-hosts] About ${which}: ${notes}`)
  } catch (err) {
    p.log(`[console-hosts] Ending the console host of ${which} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Tests only: the ports to use (null: the app's own), with the starts timed
 *  so far and the once-a-run note forgotten. */
export function _setConsoleHostEndPortsForTest(ports: Partial<ConsoleHostEndPorts> | null): void {
  override = ports
  lastStart = null
  saidNoHelper = false
}
