import { execFile, type ChildProcess } from 'child_process'
import * as os from 'os'
import { isAbsolute, posix } from 'path'
import { logInfo } from './debug-logger'
import { findOnPosixPath, findOnPosixPathAsync, loginShellPathAsync, loginShellPathSync, loginShellWithOwnPath, shFamilyLoginShell } from './login-shell'
import { findOnWindowsPathAsync, findWithPowerShellProfile, isRegularFileAsync, windowsEnvValue, windowsPathRefreshCount, type PowerShellProfileLookup } from './windows-programs'

/**
 * Is the `claude` CLI actually INSTALLED on this machine?
 *
 * Not to be confused with `isCliReady()` in setup-handlers, which asks a
 * different question -- "has Claude been told to trust the install folder?" --
 * and answers it by looking for a folder under `~/.claude/projects/`. That
 * check passes vacuously when the CLI is absent, because a machine with no
 * `claude` binary also has no trusted project for it. First-run setup used to
 * push straight past step 2 on such a machine, spawn a PTY that printed
 * "'claude' is not recognized", and drop the user into an app in which nothing
 * can ever launch (#, phase 7 item B).
 *
 * `resolveClaudeBinary()` cannot answer it either: off Windows it returns a
 * name or a path without asking whether the file exists, which is the right
 * answer for a spawn and the wrong one for a gate.
 *
 * So probe for real, and probe the way the setup PTY will actually launch it:
 *   - Windows: claude.exe / claude.cmd / claude.bat found in-process in the
 *     folders PATH names (windows-programs.ts), no process at all. When none
 *     is there, Windows PowerShell is asked with the user's profile, which a
 *     Claude session's PowerShell also runs (claudeFromPowerShellProfile: a
 *     version manager such as fnm puts its folder on PATH only there); its
 *     answer, found or not, is kept until a check the user asks for.
 *   - POSIX: what a Claude session's launcher will run. A login shell outside
 *     the sh family (written for fish and PowerShell 7.3 or later) is asked
 *     for the PATH it builds, and Claude Code is looked for in that PATH's
 *     absolute folders (claudeInLoginShellPathAsync), as the launch names it.
 *     Otherwise, when it reports no PATH, or when Claude Code is not in it,
 *     the launcher's own sh-family LOGIN shell answers
 *     (`<shell> -lc 'command -v claude'`), so PATH picks up Homebrew, nvm, asdf
 *     and friends. A plain `which` from Electron's own environment would
 *     report "missing" for a CLI the login shell can see perfectly well.
 *     `which` is only the fallback if the login shell probe cannot run.
 *
 * ASYNC, and that is a security property rather than a style choice
 * (adversarial review, 2026-09-01 — DoS). This used to be `execFileSync`: up to
 * THREE sequential 8s probes, each of which BLOCKS the main process outright —
 * no IPC served, no PTY data pumped, no window repainted, for up to 24 seconds.
 * `setup:probeCli` is an ungated renderer channel, so any renderer could freeze
 * the whole app on demand simply by invoking it; and even in normal use a
 * hanging login shell (a slow network mount in an rc file is the classic) stalls
 * the app rather than one dialog. `execFile` answers the same question on the
 * event loop, and overlapping calls coalesce onto ONE probe (see `inFlight`), so
 * a loop of invocations costs one process set instead of three per call.
 */
export interface ClaudeCliProbe {
  /** True only when a probe actually resolved a path. Fail-closed on error. */
  installed: boolean
  /** The resolved path, when one was found. */
  path?: string
  /** Which probe answered (or last failed) -- for the log and the notice. */
  probe: string
}

/** Trim, take the first line, and reject the empty/whitespace answer. */
function firstLine(out: string | Buffer): string | null {
  const line = out.toString().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  return line || null
}

/** One probe candidate's answer: its first output line, or null; `miss` true
 *  only for a plain "not found" (it ran to its end and exited non-zero, the
 *  `command -v`/`which` miss), false when there is no answer to go by. */
interface ProbeStep { line: string | null; miss: boolean }

/** An execFile error that is a plain miss: the process ended on its own with
 *  a non-zero exit code. Not one ended by the timeout or a signal (`killed`,
 *  `signal`), nor one that could not start (its code is a name such as
 *  ENOENT). */
function isPlainMiss(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown; signal?: unknown } | null
  return !!e && typeof e.code === 'number' && e.code !== 0 && !e.killed && !e.signal
}

/** The folder the login-shell probe runs in: the home folder, as the login
 *  shell's own PATH question runs (login-shell.ts loginShellPathRun), never
 *  the app's working folder. A login shell in POSIX mode answers `command -v`
 *  for a relative PATH entry (`node_modules/.bin`, `.`) with an absolute path
 *  under the folder it runs in, so a probe started in a terminal's project
 *  folder could name a claude in that project, and every later headless run,
 *  in any folder, would put that folder first on PATH. `/` when there is no
 *  absolute home folder to name. */
function probeCwd(): string {
  try {
    const home = os.homedir()
    if (home && isAbsolute(home)) return home
  } catch { /* no home folder */ }
  return '/'
}

/**
 * Run one probe candidate and resolve its first output line, or null, and
 * whether a null is a plain miss (ProbeStep).
 *
 * Never rejects: a non-zero exit (the `where`/`command -v` miss), a missing
 * binary, a timeout kill and a synchronous spawn throw are all the same answer
 * to the question "did it find claude" — "no". Only the first is a plain
 * "not found"; the rest give no answer to go by. stderr is captured by
 * execFile rather than inherited, so a probe miss cannot leak "INFO: Could not
 * find files..." into whatever terminal launched the app (the job the old
 * `stdio` option did). `cwd`, when given, is the folder it runs in (else the
 * app's own).
 *
 * It always SETTLES, by its timeout plus PROBE_STEP_GRACE_MS at the latest.
 * execFile's timeout only sends SIGTERM, and execFile answers only once the
 * process has exited and its output is closed: a login shell that ignores
 * SIGTERM, or a process it started that holds the output open, would
 * otherwise keep the probe (and so `inFlight`) unsettled for the life of the
 * app, and every later headless run with no Claude Code known would wait out
 * its full bound for it. Settled that way it gives no answer to go by, so a
 * good kept path stays (keepFoundPath), and the process is ended with
 * SIGKILL (abandonProbeStep).
 */
function probeOnce(bin: string, args: string[], cwd?: string): Promise<ProbeStep> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (step: ProbeStep): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(step)
    }
    let child: ChildProcess | undefined
    try {
      child = execFile(
        bin,
        args,
        { encoding: 'utf-8', timeout: probeStepTimeoutMs, windowsHide: true, ...(cwd ? { cwd } : {}) },
        (err, stdout) => settle(err ? { line: null, miss: isPlainMiss(err) } : { line: firstLine(stdout ?? ''), miss: false }),
      )
    } catch {
      settle({ line: null, miss: false })
      return
    }
    if (settled) return
    timer = setTimeout(() => {
      settle({ line: null, miss: false })
      abandonProbeStep(child)
    }, probeStepTimeoutMs + PROBE_STEP_GRACE_MS)
    timer.unref?.()
  })
}

/** How long one probe process may run before execFile ends it (SIGTERM),
 *  and the grace after that by which the probe settles anyway (probeOnce). */
const PROBE_STEP_TIMEOUT_MS = 8000
const PROBE_STEP_GRACE_MS = 1000
let probeStepTimeoutMs = PROBE_STEP_TIMEOUT_MS

/** Test seam: one probe process's timeout (null puts PROBE_STEP_TIMEOUT_MS back). */
export function _setProbeStepTimeoutForTest(ms: number | null): void {
  probeStepTimeoutMs = ms ?? PROBE_STEP_TIMEOUT_MS
}

/** End a probe process that outlived its timeout and grace; the probe has
 *  settled by then. Nothing is killed once the process has exited (its pid
 *  may be another's by then); the streams are destroyed either way, so a
 *  process it started that holds them cannot keep them open. Best-effort,
 *  never throws. */
function abandonProbeStep(child: ChildProcess | undefined): void {
  if (!child) return
  try {
    if (child.exitCode == null && child.signalCode == null) child.kill?.('SIGKILL')
    child.stdout?.destroy?.()
    child.stderr?.destroy?.()
  } catch { /* best-effort */ }
}

/** The names Claude Code goes by on Windows, in the order every check and
 *  every start asks them: claude.exe in any folder PATH names, then
 *  claude.cmd, then claude.bat (claude-cli-version.ts findClaudeOnWindowsPath's
 *  order). One list, so a check never says installed for a program no start
 *  would run. */
export const CLAUDE_WINDOWS_NAMES: readonly string[] = Object.freeze(['claude.exe', 'claude.cmd', 'claude.bat'])

/** What a check or a start says when Claude Code is in none of PATH's folders. */
export const CLAUDE_NOT_ON_PATH = `Claude Code was not found in a folder PATH names (${CLAUDE_WINDOWS_NAMES.join(', ')})`

/** How long an answer of findClaudeOnWindowsAsync is reused by
 *  recentClaudeOnWindows. The CLI check asks every 30 s while the app runs. */
export const CLAUDE_LOOKUP_REUSE_MS = 60_000

/** Recent walks, by the PATH value each walked (a profile run's PATH differs
 *  from the app's: it adds the profile's own folder), `found` null for a
 *  walk that found nothing. A few only. */
const recentLookups = new Map<string, { found: string | null; at: number }>()
const RECENT_LOOKUPS_KEPT = 8

/** findClaudeOnWindowsAsync's answer, whether the PowerShell profile gave
 *  it, and whether the profile was consulted at all (not while Claude Code
 *  is switched off, nor before main has set that rule). */
async function findClaudeOnWindowsWithSource(
  env: NodeJS.ProcessEnv,
  stat: ((p: string) => Promise<boolean>) | undefined,
  now: () => number,
): Promise<{ found: string | null; viaProfile: boolean; profileConsulted: boolean }> {
  const pathValue = windowsEnvValue(env, 'PATH') ?? ''
  const found = await findOnWindowsPathAsync(CLAUDE_WINDOWS_NAMES, env, stat, 'name')
  recordClaudeOnWindows(pathValue, found, now())
  if (found) return { found, viaProfile: false, profileConsulted: false }
  if (!profileLookupMayRun()) return { found: null, viaProfile: false, profileConsulted: false }
  const viaProfile = await claudeFromPowerShellProfile(stat ?? isRegularFileAsync)
  return { found: viaProfile, viaProfile: viaProfile !== null, profileConsulted: true }
}

/** Claude Code on Windows, found IN-PROCESS in the folders PATH names (`env`),
 *  in CLAUDE_WINDOWS_NAMES order, one stat at a time off the event loop
 *  (windows-programs.ts findOnWindowsPathAsync). When none is there, Claude
 *  Code as the user's PowerShell profile finds it (claudeFromPowerShellProfile:
 *  its kept answer, or the question when there is none yet); null when that
 *  finds none either. The walk's answer is kept for recentClaudeOnWindows. */
export async function findClaudeOnWindowsAsync(
  env: NodeJS.ProcessEnv,
  stat?: (p: string) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<string | null> {
  return (await findClaudeOnWindowsWithSource(env, stat, now)).found
}

/** Keep an answer of a PATH walk for Claude Code under `pathValue`, a walk
 *  that found nothing included (it replaces what was kept for that PATH). */
export function recordClaudeOnWindows(pathValue: string, found: string | null, at: number): void {
  recentLookups.delete(pathValue)
  recentLookups.set(pathValue, { found, at })
  while (recentLookups.size > RECENT_LOOKUPS_KEPT) recentLookups.delete(recentLookups.keys().next().value as string)
}

/** The Claude Code a walk of the same PATH value found less than
 *  CLAUDE_LOOKUP_REUSE_MS ago; when that walk found none, the path the
 *  PowerShell profile last named (claudeFromPowerShellProfileForLaunch:
 *  without a current answer it also starts the question in the background);
 *  otherwise null. Synchronous and reads no file, so a caller that cannot
 *  wait (the session launch) skips the walk while the answer is recent. A
 *  caller with no recent walk of its own PATH walks it first, so a Claude
 *  Code in that PATH always comes before the profile's. */
export function recentClaudeOnWindows(env: NodeJS.ProcessEnv, now: () => number = Date.now): string | null {
  const kept = recentLookups.get(windowsEnvValue(env, 'PATH') ?? '')
  if (!kept) return null
  const age = now() - kept.at
  if (age < 0 || age >= CLAUDE_LOOKUP_REUSE_MS) return null
  return kept.found ?? claudeFromPowerShellProfileForLaunch()
}

// -- Windows: Claude Code that only the user's PowerShell profile puts on PATH --
//
// A Claude session on Windows runs in Windows PowerShell, which runs the
// user's profile, and a version manager such as fnm puts its folder (with an
// npm-installed claude.cmd in it) on PATH only there. The app's own PATH then
// names no Claude Code, and every check and start would say it was not found
// while a terminal runs it. So when the walk of the app's PATH finds none,
// Windows PowerShell is asked WITH the profile where Claude Code is
// (windows-programs.ts findWithPowerShellProfile: by its full path in the
// system folder, a fixed command searching only PATH's drive-letter folders,
// in the home folder, off the event loop, one plain drive-absolute answer of
// an existing claude.exe, claude.cmd or claude.bat, never a share or a file
// in the folder it ran in).
//
// One question at a time, and its answer, found or not, is kept for the run:
// a machine without Claude Code does not run the user's profile again for
// the CLI check every 30 s, a start, or a background run. A question with no
// answer to go by (it timed out, for example while Windows is still signing
// in) is not an answer: it may be asked once more,
// PROFILE_RETRY_AFTER_FAILURE_MS later, and keeps the path an earlier
// question named. The kept answer becomes stale after a check the user asked
// for (Check again on the setup screen or in Settings, a provider's setup
// page, the check after an install ends: each brings PATH up to date first,
// windows-programs.ts windowsPathRefreshCount): the next lookup asks again,
// and a check that started after it never takes the answer of a question
// that started before it. Stale is not wrong: until the new answer arrives a
// start keeps using the path last named, so it is never refused because of a
// check about another provider. It is also asked again when a path it gave
// is no longer a file. Never while Claude Code is switched off, nor before
// main has set that rule at start (setClaudeProfileLookupAllowed).

/** The probe label when the PowerShell profile answered. */
export const CLAUDE_PROFILE_PROBE = 'Windows PowerShell profile (Get-Command claude.exe, claude.cmd, claude.bat)'

/** How long after a question with no answer to go by (timed out, did not
 *  start) the profile may be asked once more, by any lookup. Long enough that
 *  a slow profile never runs on every 30 s CLI check. */
export const PROFILE_RETRY_AFTER_FAILURE_MS = 3 * 60_000

/** WP2: whether the PowerShell profile may be asked now. Not while Claude
 *  Code is switched off: main sets this with the version probe's rule at
 *  start, before any window exists (claude-cli-version.ts
 *  setClaudeCliProbeAllowed). Until it is set, it may NOT: the user's
 *  profile is run only once main has its launch rule (and never by a unit
 *  test that does not ask for it). */
const PROFILE_LOOKUP_NOT_SET = (): boolean => false
let profileLookupAllowed: () => boolean = PROFILE_LOOKUP_NOT_SET

export function setClaudeProfileLookupAllowed(allowed: () => boolean): void {
  profileLookupAllowed = allowed
}

function profileLookupMayRun(): boolean {
  try { return profileLookupAllowed() === true } catch { return false }
}

/** The profile's last answer: `found` null for none; `refreshes` the count of
 *  checks the user asked for when it was asked (windowsPathRefreshCount);
 *  `failed` when there was no answer to go by (`found` is then the path an
 *  earlier question named, if any), and `retryAt` when it may be asked once
 *  more for the same count. */
interface ProfileAnswer { found: string | null; refreshes: number; failed: boolean; retryAt: number | null }
let profileKept: ProfileAnswer | null = null
/** The question running, and the count of checks when it started. */
let profileInFlight: { run: Promise<string | null>; refreshes: number } | null = null
/** Moved by the test seam, so a question still running from an earlier case keeps nothing. */
let profileEpoch = 0

function askProfile(): Promise<string | null> {
  const epoch = profileEpoch
  const refreshes = windowsPathRefreshCount()
  const run = findWithPowerShellProfile(CLAUDE_WINDOWS_NAMES)
    .catch((): PowerShellProfileLookup => ({ outcome: 'failed' }))
    .then((answer) => {
      const prev = profileKept
      const failed = answer.outcome === 'failed'
      // No answer to go by: the path an earlier question named still stands.
      const found = answer.outcome === 'found' ? answer.path : failed ? prev?.found ?? null : null
      if (epoch !== profileEpoch) return found
      // The first such question for this count may be asked once more, a
      // while later; a second is kept like an answer.
      const again = failed && !(prev && prev.failed && prev.refreshes === refreshes)
      profileKept = { found, refreshes, failed, retryAt: again ? Date.now() + PROFILE_RETRY_AFTER_FAILURE_MS : null }
      profileInFlight = null
      logInfo(answer.outcome === 'found'
        ? `[setup] Claude CLI found: ${found} (${CLAUDE_PROFILE_PROBE})`
        : failed
          ? `[setup] Windows PowerShell gave no answer about Claude CLI (it did not start or did not answer in time); ${again ? 'asked once more in a few minutes' : 'asked again after a check you ask for'}`
          : '[setup] Claude CLI NOT found through the Windows PowerShell profile either; asked again after a check you ask for')
      return found
    })
  profileInFlight = { run, refreshes }
  return run
}

/** The profile's answer while it is current: the path, null when it found
 *  none, undefined when there is none to read (never asked, a check the user
 *  asked for came after it, or a question with no answer may now be asked
 *  once more). Synchronous; reads no file, starts nothing. */
export function keptClaudeFromPowerShellProfile(): string | null | undefined {
  const kept = profileKept
  if (!kept || kept.refreshes !== windowsPathRefreshCount()) return undefined
  if (kept.retryAt !== null && Date.now() >= kept.retryAt) return undefined
  return kept.found
}

/** The current answer, the question already running, or a new one. Nothing
 *  while Claude Code is switched off. */
function joinOrAsk(): Promise<string | null> {
  if (!profileLookupMayRun()) return Promise.resolve(null)
  if (profileInFlight) return profileInFlight.run
  const kept = keptClaudeFromPowerShellProfile()
  return kept !== undefined ? Promise.resolve(kept) : askProfile()
}

/** The answer for a lookup now. A question that started before a check the
 *  user asked for may answer for a profile or a PATH that check changed, so
 *  it is waited for and the profile asked once more (still one question at
 *  a time: the lookups waiting on it share the next one). */
function profileQuestionForNow(): Promise<string | null> {
  const running = profileInFlight
  if (running && running.refreshes !== windowsPathRefreshCount()) return running.run.then(joinOrAsk, joinOrAsk)
  return joinOrAsk()
}

/** On Windows, for a check whose walk of PATH found no Claude Code: Claude
 *  Code as the user's PowerShell profile finds it. The current answer when
 *  there is one (a path only while `stat` still finds a file there), else
 *  the question for now (profileQuestionForNow: the one running, or Windows
 *  PowerShell asked now). Null when it finds none, and while Claude Code is
 *  switched off (nothing is asked or kept then). Never rejects. */
export async function claudeFromPowerShellProfile(stat: (p: string) => Promise<boolean> = isRegularFileAsync): Promise<string | null> {
  if (!profileLookupMayRun()) return null
  const kept = keptClaudeFromPowerShellProfile()
  if (kept === null) return null
  if (kept !== undefined) {
    let still = false
    try { still = (await stat(kept)) === true } catch { still = false }
    if (still) return kept
    if (profileKept?.found === kept) profileKept = null
  }
  return profileQuestionForNow()
}

/** For a start, which cannot wait: ask the PowerShell profile in the
 *  background when there is no current answer and no question running for
 *  this count of checks (and Claude Code is on). Never waits; the next start
 *  reads the answer. */
export function startClaudeProfileLookup(): void {
  if (!profileLookupMayRun() || keptClaudeFromPowerShellProfile() !== undefined) return
  if (profileInFlight && profileInFlight.refreshes === windowsPathRefreshCount()) return
  void profileQuestionForNow()
}

/** For a start, which cannot wait: the Claude Code the PowerShell profile
 *  last named, also when a check the user asked for has made that answer
 *  stale (stale is not wrong, so the start is not refused for it); null when
 *  it named none, was never asked, or Claude Code is switched off. Without a
 *  current answer the question starts in the background
 *  (startClaudeProfileLookup) for the next start. Synchronous; reads no
 *  file. */
export function claudeFromPowerShellProfileForLaunch(): string | null {
  if (!profileLookupMayRun()) return null
  startClaudeProfileLookup()
  return profileKept?.found ?? null
}

/** Test seam: forget every answer, the PowerShell profile's too, and put its
 *  rule back to not set (the profile is not asked until a case sets it). */
export function _resetClaudeWindowsLookupForTest(): void {
  recentLookups.clear()
  profileKept = null
  profileInFlight = null
  profileEpoch += 1
  profileLookupAllowed = PROFILE_LOOKUP_NOT_SET
}

/** The Windows probe: an in-process walk of PATH's folders, no process. */
const WINDOWS_PROBE = `PATH walk (${CLAUDE_WINDOWS_NAMES.join(', ')})`

async function runProbe(): Promise<ClaudeCliProbe> {
  if (os.platform() === 'win32') {
    // claude.exe in any folder PATH names, then claude.cmd, then claude.bat
    // (claude-cli-version.ts findClaudeOnWindowsPath's order), each a full
    // path in a fully qualified folder; one stat at a time off the event loop.
    // None there: the PowerShell profile's answer (claudeFromPowerShellProfile).
    const { found, viaProfile, profileConsulted } = await findClaudeOnWindowsWithSource(process.env, undefined, Date.now)
    const probe = viaProfile ? CLAUDE_PROFILE_PROBE : WINDOWS_PROBE
    if (found) {
      logInfo(`[setup] Claude CLI found: ${found} (${probe})`)
      return { installed: true, path: found, probe }
    }
    logInfo(profileConsulted
      ? `[setup] Claude CLI NOT found (${WINDOWS_PROBE}, then the Windows PowerShell profile)`
      : `[setup] Claude CLI NOT found (${WINDOWS_PROBE}; the Windows PowerShell profile is not asked while Claude Code is off)`)
    return { installed: false, probe: WINDOWS_PROBE }
  }

  // os.platform(), not the helper's process.platform default: this file gates
  // on os.platform() above, and the two must agree (they differ only under a
  // test's os mock, which is exactly when it matters).
  // Asked only of a login shell outside the sh family; a sh-family user's
  // probe goes straight to its own login shell, as before.
  const own = loginShellWithOwnPath(process.env, os.platform()) ? await claudeInLoginShellPathAsync(process.env, os.platform()) : null
  if (own?.claude) {
    logInfo(`[setup] Claude CLI found: ${own.claude} (the login shell's PATH)`)
    return withLoginShellAnswer({ installed: true, path: own.claude, probe: 'login shell PATH' }, { found: own.claude })
  }
  const shell = shFamilyLoginShell(process.env, os.platform())
  const viaLoginShell = await probeOnce(shell, ['-lc', 'command -v claude'], probeCwd())
  if (viaLoginShell.line) {
    logInfo(`[setup] Claude CLI found: ${viaLoginShell.line} (${shell} -lc "command -v claude")`)
    return withLoginShellAnswer({ installed: true, path: viaLoginShell.line, probe: `${shell} -lc 'command -v claude'` }, { found: viaLoginShell.line })
  }
  // The login shell named none: its plain "not found", or no answer to go by.
  // `which` below never changes that for a headless run (loginShellAnswers).
  const loginShell: LoginShellAnswer = viaLoginShell.miss ? 'miss' : 'none'

  const viaWhich = await probeOnce('which', ['claude'])
  if (viaWhich.line) {
    logInfo(`[setup] Claude CLI found: ${viaWhich.line} (which claude)`)
    return withLoginShellAnswer({ installed: true, path: viaWhich.line, probe: 'which claude' }, loginShell)
  }

  logInfo('[setup] Claude CLI NOT found (login shell and `which` both missed)')
  return withLoginShellAnswer({ installed: false, probe: 'command -v claude' }, loginShell)
}

/** What the login shell said, for a headless run's PATH (keepFoundPath):
 *  the Claude Code it named (`found`), `miss` for its plain "not found"
 *  (its `command -v` exited non-zero), `none` for no answer to go by (ended
 *  by its timeout or a signal, could not start, printed nothing). Never what
 *  `which` said: `which` searches the app's own PATH from the app's working
 *  folder, so an absolute folder it names is on the run's PATH already, and
 *  GNU which answers a relative PATH entry with a full path under that
 *  working folder, which can be another project's claude. Recorded off
 *  Windows only, in a WeakMap so the ClaudeCliProbe the renderer receives
 *  keeps its shape. */
type LoginShellAnswer = { found: string } | 'miss' | 'none'
const loginShellAnswers = new WeakMap<ClaudeCliProbe, LoginShellAnswer>()

function withLoginShellAnswer(result: ClaudeCliProbe, answer: LoginShellAnswer): ClaudeCliProbe {
  loginShellAnswers.set(result, answer)
  return result
}

/** The folder a headless run off Windows may put first on PATH for the
 *  Claude Code at `claudePath` (claude-headless.ts withClaudeFolderOnPath),
 *  or null when it may not, which is also the only kind of path kept for a
 *  run (keepFoundPath). Null for no path, a path that is not absolute
 *  (`command -v` names an alias or a function by its name), a last part
 *  that is not exactly `claude` (a line a login profile printed before
 *  `command -v` answered: its folder would decide which `claude` runs), and
 *  a folder with a `:` (no PATH entry can name it) or a control character
 *  in it: C0, DEL, C1, or a Unicode line or paragraph separator. A NUL makes
 *  the start throw; none of them has a place in a folder Claude Code is
 *  installed in, and the folder goes into the debug log. */
export function claudeFolderForPath(claudePath: string | null): string | null {
  if (!claudePath || !posix.isAbsolute(claudePath)) return null
  const name = posix.basename(claudePath)
  if (name !== 'claude') return null
  const folder = posix.dirname(claudePath)
  // eslint-disable-next-line no-control-regex
  return /[:\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(folder) ? null : folder
}

/**
 * The single probe a set of overlapping callers share.
 *
 * `setup:probeCli` is invoked from a dialog that can be clicked repeatedly (and
 * from an effect that can re-fire), so without this a user — or a renderer loop —
 * multiplies the process count by the call count for an answer that cannot
 * change between two calls a millisecond apart. Cleared on settle, so the NEXT
 * call after an install genuinely re-probes. This coalesces concurrent work:
 * probeClaudeCli never answers from an earlier probe. The one thing kept
 * between calls is the path a probe found (lastFound below), which only a
 * headless run off Windows reads.
 */
let inFlight: Promise<ClaudeCliProbe> | null = null

/** The path kept for a headless run (keepFoundPath): set by a probe whose
 *  login shell names a Claude Code a run may put on PATH
 *  (claudeFolderForPath), cleared by one whose login shell says plainly "not
 *  found" (or that runs on Windows and finds none), and kept through any
 *  other answer while a file is still there. Null before any probe has set
 *  it. Read by a headless run off Windows (claudeFoundByLastProbe). */
let lastFound: string | null = null

export function probeClaudeCli(): Promise<ClaudeCliProbe> {
  if (inFlight) return inFlight
  const run = runProbe().then(
    (result) => { inFlight = null; keepFoundPath(result); return result },
    // A probe that rejects leaves the kept path as it is.
    (err) => { inFlight = null; throw err },
  )
  inFlight = run
  return run
}

/** lastFound after a probe's answer, from what its login shell said
 *  (loginShellAnswers). A Claude Code it named that a run may put on PATH
 *  (claudeFolderForPath): that path. Its plain "not found": null. Anything
 *  else (no answer to go by, or a line that is no such path, such as a
 *  profile's stray output) keeps the path set before, while a file is still
 *  there. That check runs after the probe has settled and holds nothing (a
 *  stat that hangs leaves the path as it is); an error other than "no such
 *  file" keeps it. A fish or PowerShell user whose login shell gives no
 *  PATH in time, and whose sh-family login shell then says "not found",
 *  loses the kept path: that answer is the one taken. Not checked: who owns
 *  the file or its folder. A kept folder that was deleted and made again by
 *  another user, under a shared parent anyone may write to (a sticky one
 *  such as /tmp), is still used while a file named claude is there. On
 *  Windows (nothing recorded) it is the path found or null, as before, and
 *  nothing on Windows reads it. Never throws. */
function keepFoundPath(result: ClaudeCliProbe): void {
  const said = loginShellAnswers.get(result)
  if (said === undefined) { lastFound = result.installed && result.path ? result.path : null; return }
  if (said === 'miss') { lastFound = null; return }
  if (said !== 'none' && claudeFolderForPath(said.found) !== null) { lastFound = said.found; return }
  const kept = lastFound
  if (!kept) return
  try {
    isRegularFileAsync(kept).then((still) => { if (!still && lastFound === kept) lastFound = null }, () => { /* kept */ })
  } catch { /* kept */ }
}

/** For a headless run off Windows (claude-headless.ts), which starts `claude`
 *  by name through sh: the Claude Code a probe found and that is still kept
 *  (lastFound: null when none has found one, or the last answer was a plain
 *  "not found"). A run that finds no path here joins the probe still running
 *  (claudeProbeInFlight): before any probe has found one (Sentinel's check at
 *  start runs while the start-up version probe is still asking), or after a
 *  plain "not found", while a later probe runs. Synchronous; starts nothing. */
export function claudeFoundByLastProbe(): string | null {
  return lastFound
}

export function claudeProbeInFlight(): Promise<ClaudeCliProbe> | null {
  return inFlight
}

/** Test seam: drop a probe still in flight, and the last answer, so cases cannot bleed into each other. */
export function _resetClaudeCliProbeForTest(): void {
  inFlight = null
  lastFound = null
}

/** Off Windows, for a user whose login shell is not of the sh family (fish
 *  and PowerShell 7.3 or later report it; another such shell may report
 *  none): the PATH that shell builds, and the Claude Code found in it (null
 *  when it is in none of its absolute folders). A Claude session's launcher
 *  is a sh-family shell
 *  (shFamilyLoginShell), so it carries this PATH and names this Claude Code
 *  (providers/claude/spawn.ts), and the CLI checks ask the same question. */
export interface ClaudeInLoginShellPath {
  path: string
  claude: string | null
}

/** The last answer, for the login shell and the PATH it was asked under;
 *  `answer` null when that shell gave none. */
let lastLoginShellAnswer: { key: string; answer: ClaudeInLoginShellPath | null; at: number } | null = null

function loginShellAnswerKey(shell: string, env: NodeJS.ProcessEnv): string {
  return `${shell}\0${env.PATH ?? ''}`
}

/** The user's login shell's PATH and the Claude Code in it, asked off the
 *  event loop; null when the login shell is of the sh family (or on Windows)
 *  or gave no answer. The answer is kept for recentClaudeInLoginShellPath. */
export async function claudeInLoginShellPathAsync(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): Promise<ClaudeInLoginShellPath | null> {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell) return null
  const path = await loginShellPathAsync(shell, env)
  const answer = path ? { path, claude: await findOnPosixPathAsync('claude', path) } : null
  lastLoginShellAnswer = { key: loginShellAnswerKey(shell, env), answer, at: now() }
  return answer
}

/** The answer claudeInLoginShellPathAsync (or a launch) got less than
 *  CLAUDE_LOOKUP_REUSE_MS ago for the same login shell and PATH: the answer,
 *  null when that shell gave none, undefined when there is no recent one (or
 *  the login shell is of the sh family). Synchronous; starts no process. */
export function recentClaudeInLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): ClaudeInLoginShellPath | null | undefined {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell || !lastLoginShellAnswer || lastLoginShellAnswer.key !== loginShellAnswerKey(shell, env)) return undefined
  const age = now() - lastLoginShellAnswer.at
  return age >= 0 && age < CLAUDE_LOOKUP_REUSE_MS ? lastLoginShellAnswer.answer : undefined
}

/** For the session launch, which cannot wait: the recent answer, else the
 *  login shell asked on the event loop (bounded; its answer, or that it gave
 *  none, is kept, so this runs at most once per answer's life). Null as
 *  claudeInLoginShellPathAsync. */
export function claudeInLoginShellPathForLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): ClaudeInLoginShellPath | null {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell) return null
  const recent = recentClaudeInLoginShellPath(env, platform, now)
  if (recent !== undefined) return recent
  const path = loginShellPathSync(shell, env)
  const answer = path ? { path, claude: findOnPosixPath('claude', path) } : null
  lastLoginShellAnswer = { key: loginShellAnswerKey(shell, env), answer, at: now() }
  return answer
}

/** Test seam: forget the last login-shell answer. */
export function _resetClaudeLoginShellLookupForTest(): void {
  lastLoginShellAnswer = null
}
