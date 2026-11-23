/**
 * Ending a process a test started, and never another process that has its pid
 * now.
 *
 * Windows soon gives a freed pid to a new process, so "the pid answers" does
 * not mean "the process is ours". The installer probes end most of their
 * stand-ins themselves, and a later "if the pid answers, kill it" on such a
 * pid can end whatever has the pid by then. In CI that was a vitest worker
 * running another file beside installer-nsis-behaviour.test.ts: Windows part 2
 * failed with "Worker exited unexpectedly" on home-guard.test.ts (run
 * 45046712982) and then on reauth-staging.test.ts (run 45123495761), each a
 * file that runs while the installer probes do, and each with every test of
 * that file unreported.
 *
 * A process the test spawned is ended through its ChildProcess. Node ends it
 * by its process handle, and Windows gives no other process that pid while a
 * handle to it is open; once Node has seen it exit it ends nothing. A process
 * the test knows only by a pid read from a file is ended only while that pid
 * runs the program file it was started from.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** What a test keeps of a process it spawned: a ChildProcess fits. */
export interface SpawnedProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(): boolean
}

/** A process the test knows only by its pid (read from a file) and the program file it was started from. */
export interface PidOnlyProcess {
  readonly pid: number
  readonly exe: string
}

export type StartedProcess = SpawnedProcess | PidOnlyProcess

/** What ending a process reads and does; the defaults are the real ones. */
export interface EndDeps {
  /** The program file the process with this pid runs now, or undefined when none does. */
  programOf: (pid: number) => string | undefined
  /** Ends the process with this pid. */
  killPid: (pid: number) => void
  /** Whether a process with this pid runs (any process). */
  pidAnswers: (pid: number) => boolean
  pause: (ms: number) => Promise<void>
}

const isPidOnly = (p: StartedProcess): p is PidOnlyProcess => 'exe' in p

/** The program file process `pid` runs now (Windows, through Get-Process), or undefined. */
export function programFileOf(pid: number): string | undefined {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return undefined
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 30_000,
  })
  const out = (r.stdout ?? '').trim()
  return out === '' ? undefined : out
}

/** One spelling per file: the long, final path where the file is there, lower case (Windows). */
function canonical(p: string): string {
  try {
    return realpathSync.native(p).toLowerCase()
  } catch {
    return resolve(p).toLowerCase()
  }
}

/** Whether `p` is still the process the test started and still runs. */
export function stillOurs(p: StartedProcess, programOf: EndDeps['programOf'] = programFileOf): boolean {
  if (!isPidOnly(p)) return p.exitCode === null && p.signalCode === null
  const now = programOf(p.pid)
  return now !== undefined && canonical(now) === canonical(p.exe)
}

const realDeps: EndDeps = {
  programOf: programFileOf,
  killPid: (pid) => process.kill(pid),
  pidAnswers: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  pause: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
}

/**
 * Ends `p` when it is still the process the test started, and waits up to
 * `ms` for it to go. A process that is not, or no longer, the test's is left
 * alone.
 */
export async function endIfStillOurs(p: StartedProcess, ms = 5000, deps: Partial<EndDeps> = {}): Promise<void> {
  const d: EndDeps = { ...realDeps, ...deps }
  if (!stillOurs(p, d.programOf)) return
  const gone = isPidOnly(p) ? () => !d.pidAnswers(p.pid) : () => !stillOurs(p)
  try {
    if (isPidOnly(p)) d.killPid(p.pid)
    else p.kill()
  } catch {
    // already gone
  }
  const end = Date.now() + ms
  while (!gone() && Date.now() < end) await d.pause(100)
}
