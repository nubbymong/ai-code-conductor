// The ssh every SSH start runs (a session, its End exec, the liveness probe),
// moved here from pty-manager.ts (planning #310, item 5).
//
// On Windows the start walked PATH for ssh.exe in place, on the main
// process's own thread, at every SSH start: a folder on a share that does not
// answer held one file test there for tens of seconds, and no window was
// repainted. Now the walk is also made off the event loop, one file test at a
// time through the shared one (windows-programs.ts findOnWindowsPathAsync,
// folderFileTest), as the look for gsudo.exe is (gsudo-lookup.ts): once at
// start (ipc/pty-handlers.ts registerPtyHandlers, where gsudo's look is
// started too) and again after each PATH refresh (windows-path-refresh.ts
// refreshWindowsPath). The full path it finds is kept for the PATH and the
// PATH refresh count it was found under, and an SSH start reads it. With
// none kept (the look has not ended, found none, or PATH has changed or been
// refreshed since), the start walks in place as before. So no SSH start
// waits for the look, and the rule that picks ssh.exe is the same either
// way: the first ssh.exe in the folders PATH names in full, in PATH's order.
// A start that reads an answer older than SSH_PROGRAM_RECHECK_MS also starts
// a new look, for the starts after it. Off Windows `ssh` by name, as before.
import * as os from 'os'

import { findOnWindowsPath, findOnWindowsPathAsync, windowsEnvValue, windowsPathRefreshCount } from './windows-programs'

/** What an SSH start says on Windows when no ssh.exe is in a folder PATH
 *  names in full. */
export const SSH_NOT_ON_PATH = 'ssh was not found in a folder PATH names (ssh.exe). Add the folder that holds ssh.exe to your PATH as a full path, then restart the app.'

/** How old a kept answer may be before a start that reads it also starts a
 *  new look (the start still runs the kept answer). */
export const SSH_PROGRAM_RECHECK_MS = 60_000

/** What an answer is kept for: the PATH it was found under, and the PATH
 *  refresh count of then (windows-programs.ts windowsPathRefreshCount). */
interface LookKey { path: string; refreshes: number }

/** The last answer the look found: the full path of ssh.exe, and when (a
 *  monotonic clock). A look that found none keeps nothing. */
let answer: (LookKey & { exe: string; at: number }) | null = null
/** The look in flight, so a slow one (a folder on a share that does not
 *  answer) is never joined by another for the same key. */
let look: (LookKey & { run: Promise<void> }) | null = null
/** Whether the look was started at start (startSshProgramLookup): only then
 *  does a PATH refresh start it again. */
let started = false

function keyFor(env: NodeJS.ProcessEnv): LookKey {
  return { path: windowsEnvValue(env, 'PATH') ?? '', refreshes: windowsPathRefreshCount() }
}

function sameKey(a: LookKey, b: LookKey): boolean {
  return a.path === b.path && a.refreshes === b.refreshes
}

/** The kept answer when it was found under `env`'s PATH and no PATH refresh
 *  has happened since; null when there is none. Reads no file. */
function keptAnswer(env: NodeJS.ProcessEnv): (LookKey & { exe: string; at: number }) | null {
  const last = answer
  return last && sameKey(last, keyFor(env)) ? last : null
}

/** The full path of ssh.exe kept for `env`'s PATH, or undefined when none is
 *  kept. Reads no file. */
export function keptSshProgram(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return keptAnswer(env)?.exe
}

/** Look for ssh.exe in the folders `env`'s PATH names, off the event loop,
 *  and keep the full path found. One look at a time for one PATH and PATH
 *  refresh count: a call while one is in flight for them gets that one. A
 *  look ends only when every folder before the answer has answered, however
 *  long one takes, so the ssh.exe it names is the one a walk in place would.
 *  Only the newest look keeps its answer: one begun before PATH changed or
 *  was refreshed, which ends after a newer one began, keeps nothing. A look
 *  that finds none drops what was kept for the same key. Never rejects and
 *  never throws: a look that failed keeps nothing. Off Windows, nothing. */
export function lookForSshProgram(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = os.platform()): Promise<void> {
  try {
    if (platform !== 'win32') return Promise.resolve()
    const key = keyFor(env)
    if (look && sameKey(look, key)) return look.run
    const found = findOnWindowsPathAsync(['ssh.exe'], env)
    const run: Promise<void> = found
      .then(
        (exe) => {
          if (look?.run !== run) return
          if (exe) answer = { ...key, exe, at: performance.now() }
          else if (answer && sameKey(answer, key)) answer = null
        },
        () => { /* no answer: the next start walks in place */ },
      )
      .finally(() => { if (look?.run === run) look = null })
    look = { ...key, run }
    return run
  } catch {
    return Promise.resolve()
  }
}

/** At start (ipc/pty-handlers.ts registerPtyHandlers): the first look, and
 *  from here on a new one after each PATH refresh. Never throws. */
export function startSshProgramLookup(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = os.platform()): void {
  started = true
  void lookForSshProgram(env, platform)
}

/** After a PATH refresh (windows-path-refresh.ts refreshWindowsPath): the
 *  kept answer went with the refresh count, so the look is made again, on
 *  the PATH there is now. Nothing before start. Never throws. */
export function lookForSshProgramAfterPathRefresh(): void {
  if (!started) return
  void lookForSshProgram()
}

/** The ssh every SSH start runs (a session, its End exec, the liveness
 *  probe), asked for at the start itself. On Windows: the full path of the
 *  first ssh.exe in the folders PATH names in full (findOnWindowsPath, the
 *  rule the app's other programs follow there), never a bare name. It is
 *  the answer kept from the look off the event loop when there is one for
 *  this PATH (keptSshProgram); else the walk reads PATH's folders in order
 *  on this thread, as before, and keeps nothing. With none there it THROWS
 *  SSH_NOT_ON_PATH and nothing starts. Elsewhere `ssh` by name from PATH, as
 *  before. */
export function sshProgram(platform: NodeJS.Platform = os.platform(), env: NodeJS.ProcessEnv = process.env, now: number = performance.now()): string {
  if (platform !== 'win32') return 'ssh'
  const kept = keptAnswer(env)
  if (kept) {
    const age = now - kept.at
    if (!(age >= 0 && age < SSH_PROGRAM_RECHECK_MS)) void lookForSshProgram(env, platform)
    return kept.exe
  }
  const found = findOnWindowsPath(['ssh.exe'], env)
  if (!found) throw new Error(SSH_NOT_ON_PATH)
  return found
}

/** Test seam: forget the kept answer, any look in flight (one still running
 *  keeps nothing when it ends) and the start. */
export function _resetSshProgramForTest(): void {
  answer = null
  look = null
  started = false
}
