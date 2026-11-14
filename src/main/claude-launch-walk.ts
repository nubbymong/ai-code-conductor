// Windows, after the start: the walk of PATH a local Claude Code launch waits
// for.
//
// A launch names Claude Code by the full path found in a folder PATH names,
// or starts nothing (providers/claude/spawn.ts), and it cannot wait. It reads
// the answer a walk made off the event loop kept (the CLI check asks every
// 30 s), and only without a recent one did it walk PATH itself, in place, on
// the main process's own thread. A PATH folder on a share that does not
// answer can hold one file test there for tens of seconds: no window is
// repainted and no terminal gets its output meanwhile. The start's own walk
// was moved off that thread (claude-start-lookup.ts); this is the same for a
// launch asked for at any later time (after the computer wakes, say, when no
// recent answer is kept and the share is not back yet).
//
// So pty:spawn holds such a launch as a prepared spawn (ipc/pty-handlers.ts)
// while PATH is walked off the event loop, by the one walk every caller
// shares (claude-cli-probe.ts sharedClaudeWalk: the CLI check's, the
// start's, a launch's). The launch then reads the answer that walk kept.
//
// PATH's order holds. The walk asks the folders in PATH's order and waits
// for each one's answer: it names a folder's Claude Code only when every
// folder before it has answered that it holds none (or that it cannot be
// reached, which is what a walk in place takes as none too). A folder that
// has not answered is never passed over. What bounds the launch is how long
// it WAITS for the walk: one deadline for the walk as a whole, counted from
// the walk's own start (windows-programs.ts WINDOWS_PATH_WALK_WAIT_MS), not
// a timer on each file test. When it passes with a folder still unanswered
// the walk is inconclusive for this launch: no answer is kept, the launch is
// refused with a message that says a PATH folder did not answer in time
// (claude-cli-probe.ts CLAUDE_PATH_NOT_ANSWERING, not the not-found
// message), and nothing is walked in place. Never a later folder's Claude
// Code, never a bare name. The walk itself goes on; when the folder answers
// at last, the walk ends, its answer is kept, and the next launch reads it.
//
// A launch that opens the resume list starts it with node.exe, which is found
// the same way and kept the same way (spawn-claude-command.ts
// warmPickerNodeOnWindows); it waits for that look too, under the same
// deadline, when no answer is kept. With that look inconclusive the resume
// list is left out and Claude Code starts directly.
//
// The other callers of the same resolution wait for the same walk before
// they resolve: the path the Find Claude step shows (ipc/cli-handlers.ts),
// the first-run setup terminal (ipc/setup-handlers.ts) and the /insights
// terminal (insights-runner.ts). The resolution takes a walk under a minute
// old as the answer, found or not, so without this wait they would miss a
// Claude Code installed since that walk, for up to a minute.
//
// Nothing is held while a recent answer is kept (the usual case: the launch
// goes straight on, as before), off Windows, or before main has started
// (armClaudeLaunchWalk, at start: a unit test that drives pty:spawn alone
// holds nothing and walks nothing).

import { claudeOnWindowsKnown, claudeOnWindowsPathAnswered } from './claude-cli-probe'
import { pickerNodeAnswerKept, pickerNodeLookAnswered } from './spawn-claude-command'
import { windowsEnvValue } from './windows-programs'

/** Main has started (claude-start-lookup.ts startClaudeAtBoot). */
let armed = false

/** How many times one wait looks at PATH: PATH can be brought up to date
 *  while it waits (windows-path-refresh.ts), and the answer a walk keeps is
 *  for the PATH it walked. Each further look is for the PATH there is by
 *  then; after the last the launch resolves on what is known. */
const LAUNCH_WALK_ROUNDS = 3

/** From main's start on, a launch with no recent answer to read waits for a
 *  walk made off the event loop. Main calls it once, at start, on every
 *  platform. */
export function armClaudeLaunchWalk(): void {
  armed = true
}

/** Whether a local Claude Code launch asked for now has a walk of PATH to
 *  wait for (awaitClaudeLaunchWalk): on Windows, once main has started, when
 *  no Claude Code is known for `env`'s PATH (no walk of it in the last minute
 *  found one, and the PowerShell profile's kept answer names none), or, for
 *  a launch that opens the resume list (`resumeList`), when no answer about
 *  node.exe is kept. Reads no file and starts nothing: the PowerShell
 *  profile is not asked for this. */
export function claudeLaunchWalkPending(resumeList: boolean, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (!armed || platform !== 'win32') return false
  return !claudeOnWindowsKnown(env) || (resumeList && !pickerNodeAnswerKept(env))
}

/** The look for node.exe a launch that opens the resume list waits for. A
 *  look already under way may be for the PATH from before a refresh: when it
 *  has ended with no answer for this one, this PATH is looked at once more. */
async function nodeLookAnswered(env: NodeJS.ProcessEnv): Promise<void> {
  if ((await pickerNodeLookAnswered(env)) && !pickerNodeAnswerKept(env)) await pickerNodeLookAnswered(env)
}

/** A local Claude Code launch: wait for the walks claudeLaunchWalkPending
 *  names now, made off the event loop. At once when it names none: the
 *  answers are kept by now (the start's walk or another launch's ended
 *  meanwhile), or nothing is ever walked here (off Windows, before main has
 *  started). Each walk is waited for until it ends or until its own deadline
 *  passes (windows-programs.ts WINDOWS_PATH_WALK_WAIT_MS, from the walk's
 *  start), whichever is first; launches asked for together wait for the one
 *  walk. A walk past its deadline keeps no answer, and the launch is then
 *  refused with that reason, or opens no resume list (the header of this
 *  file).
 *
 *  When PATH reads differently once the walks have ended (it was brought up
 *  to date meanwhile), the answers kept are for the PATH from before: the
 *  PATH there is now is looked at again, off the event loop, a bounded
 *  number of times, so the launch does not walk it in place.
 *
 *  Never rejects: a walk that failed keeps no answer, and the launch then
 *  resolves as it did before. */
export async function awaitClaudeLaunchWalk(resumeList: boolean, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Promise<void> {
  try {
    for (let round = 0; round < LAUNCH_WALK_ROUNDS; round++) {
      if (!claudeLaunchWalkPending(resumeList, env, platform)) return
      const pathValue = windowsEnvValue(env, 'PATH') ?? ''
      const waits: Array<Promise<unknown>> = []
      if (!claudeOnWindowsKnown(env)) waits.push(claudeOnWindowsPathAnswered(env))
      if (resumeList && !pickerNodeAnswerKept(env)) waits.push(nodeLookAnswered(env))
      await Promise.all(waits)
      if ((windowsEnvValue(env, 'PATH') ?? '') === pathValue) return
    }
  } catch { /* a walk that failed keeps no answer */ }
}

/** Test seam: as before main has started. */
export function _resetClaudeLaunchWalkForTest(): void {
  armed = false
}
