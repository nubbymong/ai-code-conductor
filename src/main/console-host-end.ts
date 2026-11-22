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
 * a time on this thread. Date.now() is not quite the clock Windows stamps a
 * process's creation time with: in Electron's main process it can run up to
 * one Windows clock tick (15.6 ms by default) behind it, so the time the
 * helper is given is widened by CLOCK_SLACK_MS on each side. That wider time
 * can hold the host of another terminal started just before or after, an SSH
 * tab's among them. What keeps a running terminal's host is the helper's own
 * check on its program, not the time: the helper ends a host only when no
 * running process still has it as its console host, and only once it is 6 s
 * old (NEW_HOST_WAIT_MS: node-pty gives a program 5 s to start in its
 * pseudoconsole, and until then a running terminal's host has no program).
 * So the helper is asked no sooner than NEW_HOST_WAIT_MS and the slack after
 * the start. Once node-pty reports the program's exit, the helper ends the
 * one console host that is a child of this process, Windows' own
 * System32\conhost.exe, this user's, made in that time, still running, 6 s
 * old or more and with no program left; when none is, or more than one, it
 * ends nothing (docs/remote/helper-protocol.md section 15). After a kill
 * while the program still ran, node-pty has closed the pseudoconsole, so the
 * helper finds no running host made then and ends nothing: one short run on
 * every end, so node-pty's own state at the kill is never read. A terminal
 * whose program still runs is never asked for. Two starts in the same
 * millisecond, or with the clock set back between them, are not asked for:
 * their times do not order their hosts. Only the PTY's own exit asks, so it is
 * asked once, and whichever session the PTY was for by then (a Restart's
 * stale exit too).
 */
import type { IPty } from 'node-pty'
import { logInfo } from './debug-logger'
import { installedHelperPath, parseConsoleHostsAnswer, runHelperFile, type HelperRun } from './console-host-leftovers'

/** Milliseconds from 1 January 1601 to 1 January 1970 (UTC): a Windows
 *  FILETIME counts steps of 100 ns from the first. */
export const FILETIME_EPOCH_MS = 11_644_473_600_000

/** The helper's bound on the time it is given (consoles.rs MAX_START_SPAN,
 *  ten seconds): a start is asked for only when its time, widened by
 *  CLOCK_SLACK_MS on each side, fits in it. */
export const MAX_START_MS = 10_000

/** How far, in milliseconds, the time given to the helper is widened on each
 *  side. Date.now() in Electron's main process is V8's clock: Windows' coarse
 *  system time, read once a minute, plus the ticks since. It runs behind the
 *  clock Windows stamps creation times with by up to one Windows clock tick,
 *  15.625 ms at the default tick, and a terminal's host is made only a few ms
 *  before the spawn returns, so a time not widened can end before its own
 *  host was made. 50 ms on each side covers the tick with room. */
export const CLOCK_SLACK_MS = 50

/** How old a terminal's console host must be before the helper ends it
 *  (consoles.rs NEW_HOST_WAIT): node-pty gives a program 5 s to start in its
 *  pseudoconsole (CONNECTION_TIMEOUT in its windowsPtyAgent.js), and until it
 *  has, a running terminal's host has no program; a second more is slack. */
export const NEW_HOST_WAIT_MS = 6_000

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
  /** Run `fn` after `ms` milliseconds, on a timer that does not keep the app running. */
  later(ms: number, fn: () => void): void
  log(line: string): void
}

function appPorts(): ConsoleHostEndPorts {
  return {
    platform: process.platform,
    ownPid: process.pid,
    now: () => Date.now(),
    helperPath: installedHelperPath,
    runHelper: runHelperFile,
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms)
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    },
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
  /** Not asked for: its time, widened, does not fit the helper's bound, or
   *  does not order it against the start before it (spawnEndingConsoleHost). */
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
  // Its time, widened by the slack on each side (endConsoleHost), must fit
  // the helper's ten seconds.
  const timed: Start = { from, to, untimed: !(Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from && to - from < MAX_START_MS - 2 * CLOCK_SLACK_MS) }
  // In the same millisecond as the start before it, or with the clock set
  // back: the two times do not order the two hosts, so neither is asked for.
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
      askOnceOldEnough(timed, proc)
    })
  } catch { /* a PTY that cannot report its exit: nothing is asked for it */ }
  return proc
}

/** Ask the helper to end the host `start` made once that host is old enough
 *  for it (NEW_HOST_WAIT_MS after the start, and the clock's slack): at once,
 *  or on a timer that does not keep the app running. Never throws. */
function askOnceOldEnough(start: Start, proc: IPty): void {
  const p = ports()
  try {
    const wait = start.to + NEW_HOST_WAIT_MS + CLOCK_SLACK_MS - p.now()
    if (wait > 0) {
      p.later(wait, () => { void endConsoleHost(start, proc) })
      return
    }
  } catch (err) {
    p.log(`[console-hosts] The end of the console host of a terminal whose program ended${pidTag(proc)} could not be timed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  void endConsoleHost(start, proc)
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
    // Widened by the slack on each side; --made-to is not included.
    const run = await p.runHelper(helper, ['end-console-host', '--made-from', filetimeOf(start.from - CLOCK_SLACK_MS), '--made-to', filetimeOf(start.to + 1 + CLOCK_SLACK_MS)])
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
