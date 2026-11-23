/**
 * Ending a process a test started, and never another process that has its pid
 * by then. Every test that ends a process it started goes through here; no
 * test ends a process by a bare pid (started-processes.test.ts checks).
 *
 * Windows gives a freed pid to a new process within seconds on a busy machine,
 * so "the pid answers" does not mean "the process is ours". Measured on the
 * Windows CI runner (diag run 45140445533, part 2 of the unit suite, 18 runs):
 * pids the installer probes had freed were held 3 to 21 s later by node.exe,
 * conhost.exe and powershell.exe, and installer-nsis-behaviour.test.ts's old
 * "if the pid answers, end it" ended a conhost.exe that way. A vitest worker
 * (a node.exe) ended that way is "Worker exited unexpectedly" and its file is
 * never reported: Windows part 2, runs 45046712982 and 45123495761.
 *
 * So a test ends:
 *  - a process it spawned through its ChildProcess (endSpawned). Node ends it
 *    through its process handle, and Windows gives no other process that pid
 *    while a handle to it is open; once Node has seen it exit, nothing is sent.
 *  - a process it knows only by a pid read from a file, and whose program it
 *    wrote, by asking it to end itself (askToStop): the program watches a stop
 *    file (stopWhen) and exits when it appears. Nothing is ended by number.
 *  - a process it knows only by number and did not write (a fake CLI's ping.exe
 *    "browser"), by number only while that number runs that program, read
 *    right before (endIfImage). node.exe is refused there: a vitest worker is
 *    a node.exe.
 * It tells whether one still runs the same way: a spawned one through its
 * ChildProcess (runs), one known only by number through its program (runsImage).
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** What a test keeps of a process it spawned: a ChildProcess fits. */
export interface SpawnedProcess {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(): boolean
}

/** A process the test knows only by a pid read from a file, running a program that ends itself once `stopFile` exists (stopWhen). */
export interface StoppableProcess {
  readonly pid: number
  readonly stopFile: string
  /** Its image name (the program file's name, as tasklist shows it). */
  readonly image: string
}

/** What ending a process reads and does; the defaults are the real ones. */
export interface EndDeps {
  /** Whether a process with this pid runs (any process). */
  pidAnswers: (pid: number) => boolean
  /** The image name of the process with this pid now, or undefined when none has it. */
  imageOf: (pid: number) => string | undefined
  /** Ends the process with this pid. Only endIfImage calls it, after reading the image. */
  killPid: (pid: number) => void
  /** Creates the stop file. */
  touch: (file: string) => void
  pause: (ms: number) => Promise<void>
}

/** The image name of process `pid` now (tasklist on Windows, ps elsewhere), or undefined when no process has that pid. */
export function imageOf(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'win32') {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe')
    const r = spawnSync(exe, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true, timeout: 30_000 })
    return parseTasklistImage(r.stdout ?? '', pid)
  }
  const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf-8', timeout: 30_000 })
  const name = (r.stdout ?? '').trim()
  return name === '' ? undefined : basename(name)
}

/** The image name in tasklist's CSV line for `pid`, or undefined (tasklist prints a notice, not a line, when no process matches). */
export function parseTasklistImage(stdout: string, pid: number): string | undefined {
  const m = stdout.match(/^"([^"]*)","(\d+)"/m)
  return m && Number(m[2]) === pid ? m[1] : undefined
}

const realDeps: EndDeps = {
  pidAnswers: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  imageOf,
  killPid: (pid) => process.kill(pid),
  touch: (file) => writeFileSync(file, ''),
  pause: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
}

const exited = (p: SpawnedProcess) => p.exitCode !== null || p.signalCode !== null

/**
 * Whether a process the test spawned still runs. Until Node has seen it exit,
 * Node holds its process handle, so its pid is still its own and "the pid
 * answers" is about it (an exited process held open does not answer); once
 * Node has seen the exit, it does not run, whatever has the pid now.
 */
export function runs(p: SpawnedProcess, deps: Partial<EndDeps> = {}): boolean {
  // No pid: it never started.
  if (exited(p) || p.pid === undefined) return false
  return (deps.pidAnswers ?? realDeps.pidAnswers)(p.pid)
}

/** Whether process `pid` runs the program named `image` now (case-blind, as Windows names files). */
export function runsImage(pid: number, image: string, deps: Partial<EndDeps> = {}): boolean {
  const now = (deps.imageOf ?? realDeps.imageOf)(pid)
  return now !== undefined && now.toLowerCase() === image.toLowerCase()
}

async function waitUntil(done: () => boolean, ms: number, pause: EndDeps['pause']): Promise<boolean> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() >= end) return false
    await pause(100)
  }
  return true
}

/**
 * Ends a process the test spawned, through its ChildProcess, and waits up to
 * `ms` for Node to see it exit. Once Node has seen it exit, nothing is sent.
 * Returns whether it has exited.
 */
export async function endSpawned(p: SpawnedProcess, ms = 5000, deps: Partial<EndDeps> = {}): Promise<boolean> {
  const d: EndDeps = { ...realDeps, ...deps }
  if (exited(p)) return true
  try {
    p.kill()
  } catch {
    // it had exited
  }
  return waitUntil(() => exited(p), ms, d.pause)
}

/**
 * The script line a Node program a test starts runs to end itself once the
 * file named by its `process.argv[argIndex]` exists (askToStop creates it).
 */
export function stopWhen(argIndex: number): string {
  if (!Number.isInteger(argIndex) || argIndex < 1) throw new Error(`no such argument: ${argIndex}`)
  return `setInterval(() => { if (require('fs').existsSync(process.argv[${argIndex}])) process.exit(0) }, 100)`
}

/**
 * Asks a process the test knows only by number to end itself, by creating its
 * stop file, and waits up to `ms` for its pid to stop running its program.
 * Nothing is ended by number. Returns whether it has gone.
 */
export async function askToStop(p: StoppableProcess, ms = 5000, deps: Partial<EndDeps> = {}): Promise<boolean> {
  const d: EndDeps = { ...realDeps, ...deps }
  d.touch(p.stopFile)
  return waitUntil(() => !runsImage(p.pid, p.image, d), ms, d.pause)
}

/**
 * Ends process `pid` by number only while it runs the program named `image`,
 * read right before, and waits up to `ms` for it to stop running it. For a
 * process the test did not write and knows only by number; one the test wrote
 * watches a stop file instead (askToStop). Refuses node.exe: a vitest worker
 * runs node.exe, so a node.exe known only by number must watch a stop file.
 * Returns whether it ended one.
 */
export async function endIfImage(pid: number, image: string, ms = 5000, deps: Partial<EndDeps> = {}): Promise<boolean> {
  if (/^node(\.exe)?$/i.test(image)) throw new Error(`endIfImage refuses ${image}: a vitest worker is one too, so give that process a stop file (askToStop)`)
  const d: EndDeps = { ...realDeps, ...deps }
  if (!runsImage(pid, image, d)) return false
  try {
    d.killPid(pid)
  } catch {
    // it had exited
  }
  await waitUntil(() => !runsImage(pid, image, d), ms, d.pause)
  return true
}
