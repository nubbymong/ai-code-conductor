// Whether a local Claude Code session on a Linux app machine has the program
// it reads the clipboard with (ADR-032's table, row 14; plan 2.1.3-beta.21
// phase 3, 3.1). Claude Code runs it by name from its own PATH:
// `wl-paste --list-types` when WAYLAND_DISPLAY is set, else
// `xclip -selection clipboard -o -t TARGETS`. Probe PL1 (run 46139776011,
// the GitHub Ubuntu runner under Xvfb) read Claude Code 2.1.332 attach a
// picture with xclip and not with wl-paste alone under X11, so the table's
// rule holds there with no fallback to the other program. Under Wayland,
// which no probe has measured, the same table rule is taken: wl-paste.
//
// A local session does not run on the app's own PATH. Its launcher is a
// sh-family login shell started in the session's terminal (spawn.ts: `-l`
// in a PTY, with the launch line typed into it), so an interactive login
// shell: its PATH is what the user's login profile builds and what .bashrc
// (past its interactive guard) or .zshrc adds (Homebrew, nvm, ~/.local/bin,
// a user's own PATH line). Or, for a login shell outside the sh family that
// names Claude Code, the PATH that shell builds (the launcher then starts
// with it, still in the terminal, so .bashrc or .zshrc adds to it too). So
// the login shell is asked: a login shell outside the sh family for the
// PATH it builds (LOGIN_SHELL_PATH_COMMAND, as the launch asks it, then a
// search of it here); the sh-family launcher `-l -c` for `command -v` of the
// program, as the CLI check asks it for claude (claude-cli-probe.ts
// runProbe); and, after a plain "not found" from that, the same launcher
// once more as it runs in the session, `-l -i -c`. The app's own PATH and
// the system folders are searched first, in this process, so a program
// there needs no process at all.
//
// The answer only decides whether the app sends the key, and it fails open.
// A login shell that gives no answer (it timed out, could not start, or its
// output was cut short) counts as the program being there, so the key goes,
// as it always did before this check. Only a plain "not found" from both
// sh-family questions, with the program in none of the folders searched
// here, makes it missing. An answer that is not "missing" is kept for the
// app's run; a missing one is asked again at the next press, so a program
// installed after the hint (which says to install it, then press Alt+V) is
// found.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import {
  extractLoginShellPath,
  findOnPosixPath,
  findOnPosixPathAsync,
  LOGIN_SHELL_PATH_COMMAND,
  LOGIN_SHELL_PATH_TIMEOUT_MS,
  loginShellRun,
  loginShellWithOwnPath,
  shFamilyLoginShell,
} from '../../login-shell'

/** The programs Claude Code reads the clipboard with on Linux. */
export const CLAUDE_LINUX_CLIPBOARD_TOOLS = ['xclip', 'wl-paste'] as const
export type ClaudeLinuxClipboardTool = (typeof CLAUDE_LINUX_CLIPBOARD_TOOLS)[number]

/** What the login shell said of one program: there, a plain "not found",
 *  or no answer to go by. */
export type LoginShellToolAnswer = 'found' | 'miss' | 'none'

type Env = Readonly<Record<string, string | undefined>>

/** The system's own program folders, searched after PATH's in this process. */
const SYSTEM_PROGRAM_FOLDERS = ['/usr/local/bin', '/usr/bin', '/bin']

/** The longest each sh-family question (`-l -c`, then `-l -i -c` after a
 *  plain "not found") is given to answer; then no answer (the key goes). A
 *  press waits for the questions only while the program is not found in
 *  this process. Each settles by its timeout plus the grace at the latest,
 *  so a press waits at most 12 s for a sh-family user's two questions, and
 *  at most 21 s when a login shell outside the sh family is asked for its
 *  PATH first (LOGIN_SHELL_PATH_TIMEOUT_MS, 8 s). */
export const LOGIN_SHELL_TOOL_TIMEOUT_MS = 5000
/** How long after its timeout a question whose shell ignores SIGTERM is
 *  waited for before the shell is killed (SIGKILL) and the question settles.
 *  A program the shell started that holds the output open does not need it:
 *  the output is closed at the timeout (execFile does this, and
 *  execInOwnSession). */
const LOGIN_SHELL_TOOL_GRACE_MS = 1000
/** The most output a question keeps (execFile's own default bound); past
 *  it the shell is stopped and the answer read from what was kept. */
export const LOGIN_SHELL_TOOL_MAX_OUTPUT = 1024 * 1024

/** The program Claude Code reads the clipboard with under this display:
 *  wl-paste when WAYLAND_DISPLAY is set and not empty, else xclip. */
export function claudeLinuxClipboardTool(env: Env): ClaudeLinuxClipboardTool {
  return typeof env.WAYLAND_DISPLAY === 'string' && env.WAYLAND_DISPLAY !== '' ? 'wl-paste' : 'xclip'
}

/** The marker the login shell prints after its answer, so an answer cut
 *  short is told from a plain "not found". */
const TOOL_ANSWER_END = '__CCC_CLIPBOARD_TOOL_END__'

/** What the sh-family launcher runs to say where `tool` is: `command -v`,
 *  then the marker. Fixed text: `tool` is one of CLAUDE_LINUX_CLIPBOARD_TOOLS,
 *  never a user's word. */
export function loginShellToolCommand(tool: ClaudeLinuxClipboardTool): string {
  if (!CLAUDE_LINUX_CLIPBOARD_TOOLS.includes(tool)) throw new Error('loginShellToolCommand: not a clipboard program')
  return `command -v ${tool}; printf '%s\\n' ${TOOL_ANSWER_END}`
}

/** The login shell's output read: `found` when a line before the last
 *  marker is an absolute path whose last part is `tool` (a profile may print
 *  lines of its own first); `miss` when the marker is there without such a
 *  line (`command -v` printed nothing, or named an alias or a function,
 *  which Claude Code cannot run by name); `none` without the marker. */
export function readLoginShellToolAnswer(tool: ClaudeLinuxClipboardTool, out: string | null): LoginShellToolAnswer {
  if (typeof out !== 'string') return 'none'
  const end = out.lastIndexOf(TOOL_ANSWER_END)
  if (end < 0) return 'none'
  for (const raw of out.slice(0, end).split('\n')) {
    const line = raw.replace(/\r$/, '')
    // eslint-disable-next-line no-control-regex
    if (line.startsWith('/') && line.endsWith(`/${tool}`) && !/[\0-\x1f\x7f]/.test(line)) return 'found'
  }
  return 'miss'
}

/** How a question is put to a login shell (a seam for the tests): the
 *  shell's output, or null when it could not be started. `interactive`:
 *  `-l -i -c` (askLoginShell). */
export type LoginShellQuestion = (shell: string, command: string, env: Env, interactive?: boolean) => Promise<string | null>

type ExecOptions = { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; windowsHide: boolean }
type ExecFileLike = (
  file: string,
  args: string[],
  opts: ExecOptions,
  cb: (err: Error | null, stdout: string) => void,
) => Pick<ChildProcess, 'kill'> | undefined

/** What execInOwnSession starts and signals with (seams for the tests). */
export interface OwnSessionDeps {
  spawn: (file: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** A signal to every process in the process group `pgid`. */
  killGroup: (pgid: number, signal: NodeJS.Signals) => void
}

const OWN_SESSION_DEPS: OwnSessionDeps = {
  spawn: (file, args, opts) => spawn(file, args, opts),
  killGroup: (pgid, signal) => { process.kill(-pgid, signal) },
}

/**
 * execFile's form for the interactive question, with the shell started in
 * a session of its own (spawn's `detached`: setsid), so it has no
 * controlling terminal. An interactive bash or zsh takes the terminal it
 * finds for job control (/dev/tty, when its output is not one): as a child
 * of an app started from a terminal, it would make itself that terminal's
 * foreground, and bash, when the app is a background job there, stops its
 * whole process group, the app with it, with SIGTTIN. With no terminal to
 * find it runs without job control. Its stdin reads nothing (a profile that
 * asks for input reads its end at once), and its error output is not kept.
 * Like execFile: the output whatever the exit status, an error with it when
 * the shell did not end by itself; at `opts.timeout`, or past
 * LOGIN_SHELL_TOOL_MAX_OUTPUT, the output is closed and the shell's process
 * group (the shell and what it started there) gets SIGTERM. The kill it
 * returns signals that group too, and nothing once the shell has ended, so
 * a pid freed by its end is never signalled. A group is only ever a pid
 * above 1; without one the shell itself is signalled.
 */
export function execInOwnSession(
  file: string,
  args: string[],
  opts: ExecOptions,
  cb: (err: Error | null, stdout: string) => void,
  deps: OwnSessionDeps = OWN_SESSION_DEPS,
): Pick<ChildProcess, 'kill'> {
  const child = deps.spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: opts.windowsHide })
  let out = ''
  let exited = false
  let done = false
  let failure: Error | null = null
  const stop = (signal: NodeJS.Signals): boolean => {
    child.stdout?.destroy()
    if (exited) return false
    const pid = child.pid
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1) {
      try { deps.killGroup(pid, signal); return true } catch { /* the group is gone */ }
    }
    try { return child.kill(signal) } catch { return false }
  }
  const timer = setTimeout(() => {
    failure ??= new Error('the login shell did not answer in time')
    stop('SIGTERM')
  }, opts.timeout)
  const finish = (err: Error | null): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    cb(err ?? failure, out)
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (out.length + chunk.length > LOGIN_SHELL_TOOL_MAX_OUTPUT) {
      out += chunk.slice(0, LOGIN_SHELL_TOOL_MAX_OUTPUT - out.length)
      failure ??= new Error('the login shell printed too much')
      stop('SIGTERM')
      return
    }
    out += chunk
  })
  child.once('exit', () => { exited = true })
  child.once('error', (err: Error) => finish(err))
  child.once('close', () => finish(null))
  return { kill: (signal?: NodeJS.Signals | number) => stop(typeof signal === 'string' ? signal : 'SIGKILL') }
}

/** How askLoginShell asks (each a seam for the tests, but `interactive`). */
export interface LoginShellAsk {
  /** `-l -i -c` (loginShellRun), as the launcher runs, in a session of its
   *  own (execInOwnSession); else `-l -c` through execFile. */
  interactive?: boolean
  exec?: ExecFileLike
  timeoutMs?: number
}

/** One question to `shell` (loginShellRun: `-l -c command`, or `-l -i -c
 *  command` when interactive, in the home folder, with `env` as its whole
 *  environment), off the event loop. Its output whatever its exit status
 *  (the marker decides what it means); null when it could not start. Always
 *  settles, by the timeout plus a grace at the latest: at the timeout the
 *  shell gets SIGTERM and its output is closed, so a program it started
 *  that holds the output open does not hold the answer; a shell that
 *  ignores SIGTERM is killed (SIGKILL) at the end of the grace and left. */
export function askLoginShell(shell: string, command: string, env: Env, o: LoginShellAsk = {}): Promise<string | null> {
  const interactive = o.interactive === true
  const exec = o.exec ?? (interactive ? execInOwnSession : (execFile as unknown as ExecFileLike))
  const timeoutMs = o.timeoutMs ?? LOGIN_SHELL_TOOL_TIMEOUT_MS
  const run = loginShellRun(shell, command, env as NodeJS.ProcessEnv, interactive)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (out: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(out)
    }
    let child: Pick<ChildProcess, 'kill'> | undefined
    try {
      child = exec(run.file, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (_err, stdout) => {
        settle(typeof stdout === 'string' ? stdout : null)
      })
    } catch {
      settle(null)
      return
    }
    if (settled) return
    timer = setTimeout(() => {
      settle(null)
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs + LOGIN_SHELL_TOOL_GRACE_MS)
    timer.unref?.()
  })
}

/** The PATH `shell`, a login shell outside the sh family, builds: the
 *  launch's question (LOGIN_SHELL_PATH_COMMAND, its timeout), asked through
 *  askLoginShell so it settles as the other questions do; null when it gave
 *  none. */
async function ownShellPathAsked(shell: string, env: Env): Promise<string | null> {
  const out = await askLoginShell(shell, LOGIN_SHELL_PATH_COMMAND, env, { timeoutMs: LOGIN_SHELL_PATH_TIMEOUT_MS })
  return out === null ? null : extractLoginShellPath(out)
}

/** What the check reads, beside the platform and the environment (seams for
 *  the tests; each defaults to the real one). */
export interface ClaudeClipboardToolSeams {
  /** Whether `p` is a file this user may run (the search in this process). */
  runnable?: (p: string) => boolean
  /** The same, off the event loop (the search of a login shell's PATH). */
  runnableAsync?: (p: string) => Promise<boolean>
  /** The PATH a login shell outside the sh family builds, or null. */
  ownShellPath?: (shell: string, env: Env) => Promise<string | null>
  /** A question to the sh-family launcher. */
  ask?: LoginShellQuestion
}

/** What the user's login shell says of `tool`: a login shell outside the sh
 *  family first, by the PATH it builds (found there is `found`); then the
 *  sh-family launcher's `command -v` (readLoginShellToolAnswer), `-l -c`,
 *  and after its plain "not found" `-l -i -c`, as the launcher runs in the
 *  session's terminal (found or no answer there is not a miss). Both
 *  shells, because the launch takes either PATH (spawn.ts): the first when
 *  Claude Code is in it, else the launcher's own login profile's. */
export async function loginShellToolAnswer(tool: ClaudeLinuxClipboardTool, env: Env, platform: NodeJS.Platform, seams: ClaudeClipboardToolSeams = {}): Promise<LoginShellToolAnswer> {
  const own = loginShellWithOwnPath(env as NodeJS.ProcessEnv, platform)
  if (own) {
    let path: string | null = null
    try { path = await (seams.ownShellPath ?? ownShellPathAsked)(own, env) } catch { path = null }
    if (path && (await findOnPosixPathAsync(tool, path, seams.runnableAsync)) !== null) return 'found'
  }
  const ask: LoginShellQuestion = seams.ask ?? ((shell, command, e, interactive) => askLoginShell(shell, command, e, { interactive }))
  const launcher = shFamilyLoginShell(env as NodeJS.ProcessEnv, platform)
  const command = loginShellToolCommand(tool)
  const asked = async (interactive: boolean): Promise<LoginShellToolAnswer> => {
    let out: string | null = null
    try { out = await ask(launcher, command, env, interactive) } catch { out = null }
    return readLoginShellToolAnswer(tool, out)
  }
  const answer = await asked(false)
  return answer === 'miss' ? asked(true) : answer
}

/**
 * Whether the program Claude Code reads the clipboard with on `platform` is
 * missing (claudeLinuxClipboardTool). Never on Windows or macOS, where
 * Claude Code reads the clipboard with a program the system ships
 * (PowerShell, osascript). On Linux: found in this process's PATH's absolute
 * folders or the system's, not missing (no process); else the login shell's
 * answer (loginShellToolAnswer): missing only for its plain "not found".
 */
export async function claudeClipboardToolMissing(platform: NodeJS.Platform, env: Env, seams: ClaudeClipboardToolSeams = {}): Promise<boolean> {
  if (platform !== 'linux') return false
  const tool = claudeLinuxClipboardTool(env)
  const folders = [env.PATH ?? '', ...SYSTEM_PROGRAM_FOLDERS].join(':')
  if (findOnPosixPath(tool, folders, seams.runnable) !== null) return false
  return (await loginShellToolAnswer(tool, env, platform, seams)) === 'miss'
}

/** The check as a press asks it: an answer that is not "missing" is kept
 *  for the app's run; a missing one is asked again next time; callers that
 *  ask while it runs share its answer. */
export function createClaudeClipboardToolCheck(
  envOf: () => Env = () => process.env,
  seams: ClaudeClipboardToolSeams = {},
): (platform: NodeJS.Platform) => Promise<boolean> {
  let found = false
  let inFlight: Promise<boolean> | null = null
  return (platform) => {
    if (platform !== 'linux' || found) return Promise.resolve(false)
    if (inFlight) return inFlight
    const run = claudeClipboardToolMissing(platform, envOf(), seams)
      .catch(() => false)
      .then((missing) => { if (!missing) found = true; return missing })
      .finally(() => { inFlight = null })
    inFlight = run
    return run
  }
}
