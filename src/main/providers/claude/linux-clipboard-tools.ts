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
// login shell (providers/claude/spawn.ts, login-shell.ts), so its PATH is
// what the user's profile builds (Homebrew, nvm, ~/.local/bin), or, for a
// login shell outside the sh family that names Claude Code, the PATH that
// shell builds. So the login shell is asked, as the CLI check asks it for
// claude (claude-cli-probe.ts runProbe): a login shell outside the sh family
// for the PATH it builds (loginShellPathAsync, then a search of it here),
// and the sh-family launcher `-lc` for `command -v` of the program. The
// app's own PATH and the system folders are searched first, in this
// process, so a program there needs no process at all.
//
// The answer only decides whether the app sends the key, and it fails open.
// A login shell that gives no answer (it timed out, could not start, or its
// output was cut short) counts as the program being there, so the key goes,
// as it always did before this check. Only a plain "not found" from the
// login shell, with the program in none of the folders searched here, makes
// it missing. An answer that is not "missing" is kept for the app's run; a
// missing one is asked again at the next press, so a program installed
// after the hint (which says to install it, then press Alt+V) is found.
import { execFile, type ChildProcess } from 'child_process'
import {
  findOnPosixPath,
  findOnPosixPathAsync,
  loginShellPathAsync,
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

/** The longest the login shell is given to answer; then no answer (the key
 *  goes). A press waits for it only while the program is not found here. */
export const LOGIN_SHELL_TOOL_TIMEOUT_MS = 5000
/** How long after the timeout a login shell that holds its output open is
 *  waited for before it is left (killed) and the question settles. */
const LOGIN_SHELL_TOOL_GRACE_MS = 1000

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
 *  shell's output, or null when it could not be started. */
export type LoginShellQuestion = (shell: string, command: string, env: Env) => Promise<string | null>

type ExecFileLike = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; windowsHide: boolean },
  cb: (err: Error | null, stdout: string) => void,
) => Pick<ChildProcess, 'kill'> | undefined

/** One question to `shell` (loginShellRun: `-l -c command`, in the home
 *  folder, with `env` as its whole environment), off the event loop. Its
 *  output whatever its exit status (the marker decides what it means); null
 *  when it could not start. Always settles, by the timeout plus a grace at
 *  the latest: execFile only sends SIGTERM, and answers only once the
 *  output closes, so a shell that ignores it, or a program it started that
 *  holds the output open, is killed and left. */
export function askLoginShell(
  shell: string,
  command: string,
  env: Env,
  exec: ExecFileLike = execFile as unknown as ExecFileLike,
  timeoutMs = LOGIN_SHELL_TOOL_TIMEOUT_MS,
): Promise<string | null> {
  const run = loginShellRun(shell, command, env as NodeJS.ProcessEnv)
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
 *  sh-family launcher's `command -v` (readLoginShellToolAnswer). Both,
 *  because the launch takes either PATH (spawn.ts): the first when Claude
 *  Code is in it, else the launcher's own login profile's. */
export async function loginShellToolAnswer(tool: ClaudeLinuxClipboardTool, env: Env, platform: NodeJS.Platform, seams: ClaudeClipboardToolSeams = {}): Promise<LoginShellToolAnswer> {
  const own = loginShellWithOwnPath(env as NodeJS.ProcessEnv, platform)
  if (own) {
    let path: string | null = null
    try { path = await (seams.ownShellPath ?? ((s, e) => loginShellPathAsync(s, e as NodeJS.ProcessEnv)))(own, env) } catch { path = null }
    if (path && (await findOnPosixPathAsync(tool, path, seams.runnableAsync)) !== null) return 'found'
  }
  let out: string | null = null
  try { out = await (seams.ask ?? askLoginShell)(shFamilyLoginShell(env as NodeJS.ProcessEnv, platform), loginShellToolCommand(tool), env) } catch { out = null }
  return readLoginShellToolAnswer(tool, out)
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
