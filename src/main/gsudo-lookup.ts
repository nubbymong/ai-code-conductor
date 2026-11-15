// Windows: where gsudo.exe is, which an elevated terminal starts by its full
// path (providers/claude/spawn.ts buildClaudeLocalSpawn).
//
// The launch looked for it in place, on the main process's own thread, in
// every folder PATH names: a folder on a share that does not answer held one
// file test there for tens of seconds, and no window was repainted. It is
// looked for once, before the launch, off the event loop, one file test at a
// time through the shared one (windows-programs.ts findOnWindowsPathAsync,
// folderFileTest), as the look for node.exe is (spawn-claude-command.ts
// warmPickerNodeOnWindows). The answer, the full path or none, is kept for
// the PATH it was made under, and the launch reads it. An elevated terminal
// is held for the look, bounded, as a prepared spawn (ipc/pty-handlers.ts),
// the way a Claude Code launch is held for its walk (claude-launch-walk.ts).

import { findOnWindowsPathAsync, folderFileTest, pathWalkDeadline, windowsEnvValue, withPathWalkDeadline, type PathWalkInFlight } from './windows-programs'

/** What an elevated terminal says when gsudo is in none of PATH's folders. */
export const GSUDO_NOT_FOUND = 'An elevated terminal needs gsudo, which was not found in a folder PATH names (gsudo.exe)'

/** What it says when it was asked for before the look for gsudo had an
 *  answer: the look is made off the event loop and the terminal is held for
 *  it, so this is a terminal asked for in the moment between. Not the
 *  not-found message: the look has not said gsudo is missing. */
export const GSUDO_LOOKUP_UNDER_WAY = 'The elevated terminal was not started: the app was still looking for gsudo (gsudo.exe) in the folders PATH names. Try again in a moment.'

/** How long an answer is used under the same PATH, found or not. */
export const GSUDO_REUSE_MS = 60_000

/** The last answer: under which PATH, the full path found (null when none
 *  was), and when (a monotonic clock). */
let answer: { path: string; exe: string | null; at: number } | null = null
/** The look in flight, so a slow one (a folder on a share that does not
 *  answer) is never joined by another. */
let warming: Promise<void> | null = null
/** That look with the deadline of a launch that waits for it. */
let look: PathWalkInFlight<void> | null = null

/** The answer kept for `env`'s PATH when it is under GSUDO_REUSE_MS old: the
 *  full path, or null for none; undefined when there is none. Reads no file. */
export function recentGsudo(env: NodeJS.ProcessEnv = process.env, now: number = performance.now()): string | null | undefined {
  const last = answer
  if (!last || last.path !== (windowsEnvValue(env, 'PATH') ?? '')) return undefined
  const age = now - last.at
  return age >= 0 && age < GSUDO_REUSE_MS ? last.exe : undefined
}

/** Whether an answer is kept for `env`'s PATH (recentGsudo is not undefined). */
export function gsudoAnswerKept(env: NodeJS.ProcessEnv = process.env): boolean {
  return recentGsudo(env) !== undefined
}

/** Look for gsudo.exe in the folders `env`'s PATH names, off the event loop,
 *  and keep the answer. One look at a time: a call while one is in flight
 *  gets that one. The look waits for every folder in PATH's order, however
 *  long one takes, so the gsudo.exe it names is the one a walk in place
 *  would; its deadline, for a launch that waits for it, begins with it. Never
 *  rejects: a look that failed keeps no answer. */
export function warmGsudo(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (warming) return warming
  const pathValue = windowsEnvValue(env, 'PATH') ?? ''
  const deadline = pathWalkDeadline()
  let found: Promise<string | null>
  try {
    found = findOnWindowsPathAsync(['gsudo.exe'], env, folderFileTest(undefined, deadline))
  } catch {
    // No look began: its deadline's timer is not left behind.
    deadline.clear()
    return Promise.resolve()
  }
  const run: Promise<void> = found
    .then(
      (exe) => { answer = { path: pathValue, exe, at: performance.now() } },
      () => { /* no answer: the next launch looks again */ },
    )
    // Only this look's own mark: one started after a reset is left in flight.
    .finally(() => {
      if (warming !== run) return
      warming = null
      look = null
    })
  warming = run
  look = withPathWalkDeadline(run, deadline)
  return run
}

/** For an elevated terminal with no answer to read, which waits a bounded
 *  time: the look under way, or a new one, waited for until it ends (true)
 *  or until its deadline passes with a folder still unanswered (false; no
 *  answer is kept then, and none is made up). Never rejects. */
export function gsudoLookAnswered(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  void warmGsudo(env)
  return look ? look.answered : Promise.resolve(true)
}

/** Test seam: forget the kept answer and any look in flight (one still
 *  running lands its answer when it ends). */
export function _resetGsudoLookupForTest(): void {
  answer = null
  warming = null
  look?.forget()
  look = null
}
