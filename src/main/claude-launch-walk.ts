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
// while PATH is walked here, off the event loop, by the walk the start uses
// (claude-cli-probe.ts claudeOnWindowsPathAsync), each folder given a bounded
// time to answer (windows-programs.ts fileTestWithin). A folder that does not
// answer in that time counts as holding no Claude Code, and the walk goes on
// to the next. The answer is kept, found or not, and the launch reads it: it
// names the full path found, or it is refused as before. Never a bare name,
// and never a guess.
//
// A launch that opens the resume list starts it with node.exe, which is found
// the same way and kept the same way (spawn-claude-command.ts
// warmPickerNodeOnWindows); it waits for that look too when no answer is
// kept, so it does not walk PATH in place for node.exe either.
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

import { claudeOnWindowsPathAsync, recentClaudeOnWindows } from './claude-cli-probe'
import { pickerNodeAnswerKept, warmPickerNodeOnWindows } from './spawn-claude-command'
import { fileTestWithin, windowsEnvValue } from './windows-programs'

/** Main has started (claude-start-lookup.ts startClaudeAtBoot). */
let armed = false
/** The walk for Claude Code in flight, by the PATH value it walks: launches
 *  asked for together (tabs restored after a wake) wait for one walk. */
const walking = new Map<string, Promise<void>>()

/** From main's start on, a launch with no recent answer to read waits for a
 *  walk made here. Main calls it once, at start, on every platform. */
export function armClaudeLaunchWalk(): void {
  armed = true
}

/** Whether a local Claude Code launch asked for now has a walk of PATH to
 *  wait for (awaitClaudeLaunchWalk): on Windows, once main has started, when
 *  no Claude Code is known for `env`'s PATH (no walk of it in the last minute
 *  found one, and the PowerShell profile named none), or, for a launch that
 *  opens the resume list (`resumeList`), when no answer about node.exe is
 *  kept. Reads no file. */
export function claudeLaunchWalkPending(resumeList: boolean, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (!armed || platform !== 'win32') return false
  return recentClaudeOnWindows(env) === null || (resumeList && !pickerNodeAnswerKept(env))
}

/** Walk `env`'s PATH for Claude Code once, off the event loop, each folder
 *  bounded; the answer is kept for the launch. One walk per PATH value at a
 *  time. Never rejects. */
function walkForClaude(env: NodeJS.ProcessEnv): Promise<void> {
  const pathValue = windowsEnvValue(env, 'PATH') ?? ''
  const running = walking.get(pathValue)
  if (running) return running
  // The walk begins in this turn; one that throws before it has anything to
  // wait for is a walk that kept no answer.
  const run: Promise<void> = new Promise<unknown>((resolve) => { resolve(claudeOnWindowsPathAsync(env, fileTestWithin())) })
    .then(() => undefined, () => undefined)
    .finally(() => { if (walking.get(pathValue) === run) walking.delete(pathValue) })
  walking.set(pathValue, run)
  return run
}

/** A local Claude Code launch: wait for the walks claudeLaunchWalkPending
 *  names now, made off the event loop. At once when it names none: the
 *  answers are kept by now (the start's walk or another launch's ended
 *  meanwhile), or nothing is ever walked here (off Windows, before main has
 *  started). It ends when each folder has answered or been given its
 *  bounded time, and never rejects: a walk that failed keeps no answer, and
 *  the launch then resolves as it did before. */
export function awaitClaudeLaunchWalk(resumeList: boolean, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Promise<void> {
  if (!claudeLaunchWalkPending(resumeList, env, platform)) return Promise.resolve()
  const walks: Array<Promise<void>> = []
  if (recentClaudeOnWindows(env) === null) walks.push(walkForClaude(env))
  if (resumeList && !pickerNodeAnswerKept(env)) {
    // A look already in flight may be for the PATH from before a refresh:
    // when it has ended with no answer for this one, this PATH is looked at
    // once more.
    walks.push(warmPickerNodeOnWindows(env).then(() => (pickerNodeAnswerKept(env) ? undefined : warmPickerNodeOnWindows(env))))
  }
  return Promise.all(walks).then(() => undefined, () => undefined)
}

/** Test seam: as before main has started, and no walk in flight. */
export function _resetClaudeLaunchWalkForTest(): void {
  armed = false
  walking.clear()
}
