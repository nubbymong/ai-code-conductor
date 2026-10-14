// A CLI the check did not find, though its publisher's installer put it in
// its own folder: what to tell the user, and on Windows the one PATH change
// the app may make for them (the PATH finding of the first-run test,
// 2026-10-10; ADR-024).
//
// Anthropic's native Claude Code installer copies claude.exe to
// %USERPROFILE%\.local\bin on Windows (~/.local/bin/claude elsewhere) and
// never adds that folder to PATH; it only prints how to. On a computer where
// the folder is not on PATH yet, the check that follows the install finds
// nothing, and a restart of the app cannot change that. OpenAI's Codex
// installer adds its own folder to the user PATH on Windows (the refresh in
// windows-path-refresh.ts then finds it), but on Linux it writes the PATH line
// to a shell file a login shell does not read, so ~/.local/bin/codex can be
// missed there too.
//
// So when a check finds nothing, main looks in the publisher's fixed folder,
// computed here from the user's home folder and nothing else:
//   - Windows, the file there (a regular file: never a link, by lstat) and its
//     folder on neither the system nor the user PATH in the registry: the
//     surface says so and offers "Add it to PATH for me" (`add-to-path`).
//   - Windows, the tool in a folder the registry's PATH names (that folder,
//     or another one) though this process could not take it in (a folder
//     the PATH refresh before the check skipped, say): a restart of the app
//     is what helps (`restart`).
//   - Windows, the tool not found, and a REG_EXPAND_SZ entry of the
//     registry's PATH still naming a %VARIABLE% after it is expanded against
//     this process's environment (one defined after the app started, such as
//     %NVM_SYMLINK%): the folder it names cannot be looked in until the app
//     starts again, so a restart may help (`restart`, marked `unresolved`,
//     since the tool was not seen: the surfaces show it as a note beside
//     their own "not found", never in its place). Counted only when this
//     process's PATH does not hold that entry as it stands: an entry it
//     holds with the %NAME% still in it was unexpanded when the app started
//     too (a %JAVA_HOME%\bin left behind by an uninstaller), so a restart
//     would change nothing and is never advised for it. Expanded against
//     this process's environment only, never the registry's Environment
//     values, and from the same one registry read. These two are the only
//     cases where a restart is said.
//   - macOS and Linux, the file there: the surface names the shell file the
//     login shell reads and a command to run once that appends the PATH line
//     to it, to copy (`shell-profile`). The app never edits a shell file.
//
// The PATH change (addToolFolderToPath) appends exactly that one folder,
// computed here, to HKCU\Environment Path through windows-registry-path.ts:
// never a folder the renderer names (the IPC carries only a provider id),
// never a change to an entry already there. It then adds the folder to this
// process's PATH too, so the check that follows, later sessions, the version
// check and terminals find the tool. One log line per change: the folder and
// what happened.
//
// What crosses to the renderer is display text only: the folder as
// `%USERPROFILE%\.local\bin` or `~/.local/bin`, the shell file with the home
// folder as `~`, and the command, one of a fixed set of constants (its target
// written with $HOME, and zsh's $ZDOTDIR, for the user's own shell to
// expand). Never the user's real path, never a value from this process's
// environment.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ProviderId, PathHintView } from '../shared/providers'
import {
  appendFolderToUserPath, appendableFolder, readRegistryPaths, registryPathFolders, windowsFolderKey,
  type RegistryPaths, type UserPathAppendResult,
} from './windows-registry-path'
import { mergeWindowsPath, windowsPathKey } from './windows-path-refresh'
import { findOnWindowsPathAsync } from './windows-programs'
import { CLAUDE_WINDOWS_NAMES } from './claude-cli-probe'
import { defaultLoginShell } from './login-shell'
import { logInfo } from './debug-logger'

/** A publisher's install folder below the user's home folder, the file the
 *  check looks for in it, and the folder as the user is shown it. */
interface KnownFolder {
  steps: readonly string[]
  file: string
  display: string
}

/** Windows: Anthropic's native installer (setup page and troubleshooting
 *  page). Codex has none: OpenAI's installer adds its own folder to PATH. */
const WINDOWS_FOLDERS: Partial<Record<ProviderId, KnownFolder>> = Object.freeze({
  claude: Object.freeze({ steps: ['.local', 'bin'], file: 'claude.exe', display: '%USERPROFILE%\\.local\\bin' }),
})

/** macOS and Linux: both installers link the tool into ~/.local/bin. */
const POSIX_FOLDERS: Partial<Record<ProviderId, KnownFolder>> = Object.freeze({
  claude: Object.freeze({ steps: ['.local', 'bin'], file: 'claude', display: '~/.local/bin' }),
  codex: Object.freeze({ steps: ['.local', 'bin'], file: 'codex', display: '~/.local/bin' }),
})

/** The names each tool is looked for by on Windows (Claude Code's from the
 *  one list every check and start uses), read when asked. */
const WINDOWS_NAMES: Partial<Record<ProviderId, () => readonly string[]>> = Object.freeze({
  claude: () => CLAUDE_WINDOWS_NAMES,
  codex: () => ['codex.exe', 'codex.cmd'],
})

/** The line every sh-family shell file gets, and fish's own. */
export const POSIX_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
export const FISH_PATH_LINE = 'fish_add_path $HOME/.local/bin'

/** The command the surface gives to copy and run once (aicc_planning#194):
 *  a bare export line changes only the terminal it is pasted into,
 *  so the login shell the app asks would still lack the folder. printf puts the
 *  line on a line of its own, also after a file whose last line has no
 *  newline. */
function appendOnce(target: string): string {
  return `printf '\\n${POSIX_PATH_LINE}\\n' >> "${target}"`
}

/** One command per sh-family shell file, constants: the target is written for
 *  the user's shell to expand ($HOME; for zsh "${ZDOTDIR:-$HOME}", so it lands
 *  where zsh reads .zprofile whether or not ZDOTDIR is set there), never a
 *  value read from this process's environment. fish runs FISH_PATH_LINE
 *  once instead: fish_add_path keeps the folder in fish's own variables. */
export const POSIX_PATH_COMMANDS = Object.freeze({
  '.zprofile': appendOnce('$' + '{ZDOTDIR:-$HOME}/.zprofile'),
  '.bash_profile': appendOnce('$HOME/.bash_profile'),
  '.bash_login': appendOnce('$HOME/.bash_login'),
  '.profile': appendOnce('$HOME/.profile'),
})

export type EntryKind = 'file' | 'dir' | 'link' | 'other' | 'none'

export interface InstallFolderDeps {
  platform: NodeJS.Platform
  home: string
  /** This process's environment: %VARIABLES% are read from it, and an added
   *  folder is appended to its PATH. */
  env: Record<string, string | undefined>
  /** What `p` itself is (lstat: a link is a link, never followed). */
  entryKind: (p: string) => Promise<EntryKind>
  /** Whether `p` is a file, following links (stat). */
  isFile: (p: string) => Promise<boolean>
  /** The system and user PATH values as stored. */
  readRegistry: () => Promise<RegistryPaths>
  /** Appends one folder to the user PATH in the registry. */
  appendUserPath: (folder: string) => Promise<UserPathAppendResult>
  /** The user's login shell (macOS and Linux). */
  loginShell: () => string
  /** Whether a file exists (which shell file a login shell reads). */
  exists: (p: string) => boolean
  log: (line: string) => void
}

/** The real ones. */
export function installFolderDeps(): InstallFolderDeps {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    entryKind: async (p) => {
      try {
        const s = await fs.promises.lstat(p)
        return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
      } catch {
        return 'none'
      }
    },
    isFile: async (p) => {
      try { return (await fs.promises.stat(p)).isFile() } catch { return false }
    },
    readRegistry: () => readRegistryPaths(),
    appendUserPath: (folder) => appendFolderToUserPath(folder),
    loginShell: () => defaultLoginShell(process.env, process.platform),
    exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
    log: (line) => logInfo(line),
  }
}

/** The Windows folder for `providerId` below `home`, when it is one the
 *  append may write. */
function windowsFolder(providerId: ProviderId, home: string): { dir: string; known: KnownFolder } | null {
  const known = WINDOWS_FOLDERS[providerId]
  if (!known || typeof home !== 'string' || home === '') return null
  const dir = path.win32.join(home, ...known.steps)
  return appendableFolder(dir) ? { dir, known } : null
}

/** The publisher's file is there, a regular file in a real folder. */
async function installedThere(deps: InstallFolderDeps, dir: string, known: KnownFolder): Promise<boolean> {
  return (await deps.entryKind(dir)) === 'dir' && (await deps.entryKind(path.win32.join(dir, known.file))) === 'file'
}

async function registryOrNull(deps: InstallFolderDeps): Promise<RegistryPaths | null> {
  try { return await deps.readRegistry() } catch { return null }
}

function registryFolders(reg: RegistryPaths, env: NodeJS.ProcessEnv): string[] {
  return [...registryPathFolders(reg.machine, env), ...registryPathFolders(reg.user, env)]
}

/** A %NAME% left in a folder after expansion: a variable this process does
 *  not have. A name never holds a path separator, so a folder that merely
 *  has two % signs in it is not taken for one. */
const UNEXPANDED_VARIABLE = /%[^%\\\/;]+%/

/** This process's PATH entries, as folders to compare. It still holds
 *  every entry it started with, as Windows wrote them for it: the only two
 *  writers of it (the refresh before a check, windows-path-refresh.ts, and
 *  Add it to PATH for me, below) append, and never a folder with a % in it. */
function processPathKeys(env: Record<string, string | undefined>): Set<string> {
  const value = env[windowsPathKey(env)]
  return new Set(String(value ?? '').split(';').map(windowsFolderKey).filter((k) => k !== ''))
}

/** A REG_EXPAND_SZ value of the registry's PATH (the only type Windows
 *  expands for a new program) with an entry that still names a %VARIABLE%
 *  once expanded against this process's environment `env`, and nothing
 *  else, which this process's PATH does not hold as it stands: added after
 *  the app started, through a variable it does not have (%NVM_SYMLINK%,
 *  say), so its folder can be looked in only after a restart. One the PATH
 *  holds was unexpanded at the start too, so a restart would leave it so
 *  (aicc_planning#190: a dangling %JAVA_HOME%\bin must not advise a
 *  restart after every restart). */
function namesVariableSetSinceStart(reg: RegistryPaths, env: NodeJS.ProcessEnv): boolean {
  const had = processPathKeys(env)
  return [reg.machine, reg.user].some((v) => v?.kind === 'ExpandString'
    && registryPathFolders(v, env).some((f) => UNEXPANDED_VARIABLE.test(f) && !had.has(windowsFolderKey(f))))
}

/** Which shell file a login shell reads, as the user is shown it, and the
 *  command to run once that puts the folder on its PATH. zsh: .zprofile (in
 *  $ZDOTDIR when that is set). bash: the first of .bash_profile,
 *  .bash_login, .profile that exists (else .bash_profile on macOS, .profile
 *  on Linux), so a file bash would stop reading is never named. fish: the
 *  file fish keeps fish_add_path's folders in (in $XDG_CONFIG_HOME when that
 *  is set). Any other: .profile. */
export function shellProfileFor(
  shell: string, platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>, exists: (p: string) => boolean,
): { file: string; line: string } {
  const name = path.posix.basename(String(shell ?? ''))
  if (name === 'zsh') return { file: env.ZDOTDIR ? '$ZDOTDIR/.zprofile' : '~/.zprofile', line: POSIX_PATH_COMMANDS['.zprofile'] }
  if (name === 'fish') return { file: env.XDG_CONFIG_HOME ? '$XDG_CONFIG_HOME/fish/fish_variables' : '~/.config/fish/fish_variables', line: FISH_PATH_LINE }
  if (name === 'bash') {
    const first = (['.bash_profile', '.bash_login', '.profile'] as const).find((f) => exists(path.posix.join(home, f)))
    const file = first ?? (platform === 'darwin' ? '.bash_profile' : '.profile')
    return { file: `~/${file}`, line: POSIX_PATH_COMMANDS[file] }
  }
  return { file: '~/.profile', line: POSIX_PATH_COMMANDS['.profile'] }
}

/** What to tell the user when a check did not find `providerId`'s CLI (see
 *  the header); undefined when there is nothing more to say. */
export async function pathHintFor(providerId: ProviderId, deps: InstallFolderDeps = installFolderDeps()): Promise<PathHintView | undefined> {
  const env = deps.env as NodeJS.ProcessEnv
  if (deps.platform === 'win32') {
    const at = windowsFolder(providerId, deps.home)
    if (at && await installedThere(deps, at.dir, at.known)) {
      const reg = await registryOrNull(deps)
      const key = windowsFolderKey(at.dir)
      if (reg && registryFolders(reg, env).some((f) => windowsFolderKey(f) === key)) return { kind: 'restart' }
      return { kind: 'add-to-path', folder: at.known.display }
    }
    const names = WINDOWS_NAMES[providerId]?.()
    if (!names) return undefined
    const reg = await registryOrNull(deps)
    if (!reg) return undefined
    const found = await findOnWindowsPathAsync(names, { PATH: registryFolders(reg, env).join(';') }, deps.isFile, 'name')
    if (found) return { kind: 'restart' }
    return namesVariableSetSinceStart(reg, env) ? { kind: 'restart', unresolved: true } : undefined
  }
  const known = POSIX_FOLDERS[providerId]
  if (!known || typeof deps.home !== 'string' || !deps.home.startsWith('/')) return undefined
  if (!(await deps.isFile(path.posix.join(deps.home, ...known.steps, known.file)))) return undefined
  const profile = shellProfileFor(deps.loginShell(), deps.platform, deps.home, deps.env, deps.exists)
  return { kind: 'shell-profile', folder: known.display, file: profile.file, line: profile.line }
}

export type AddToPathOutcome =
  | { outcome: 'added' | 'already' }
  | { outcome: 'refused' | 'failed'; message: string }

/** "Add it to PATH for me" (Windows only): the publisher's folder for
 *  `providerId`, computed here, appended to the user PATH in the registry
 *  when neither PATH has it, then to this process's PATH. Refused when that
 *  folder does not hold the tool as a regular file. */
export async function addToolFolderToPath(providerId: ProviderId, deps: InstallFolderDeps = installFolderDeps()): Promise<AddToPathOutcome> {
  if (deps.platform !== 'win32') return { outcome: 'refused', message: 'The app adds a folder to PATH only on Windows.' }
  const at = windowsFolder(providerId, deps.home)
  if (!at) return { outcome: 'refused', message: 'There is no install folder the app adds to PATH for this tool.' }
  if (!(await installedThere(deps, at.dir, at.known))) {
    return { outcome: 'refused', message: `${at.known.file} is not in ${at.known.display}, so the folder was not added.` }
  }
  let r: UserPathAppendResult
  try {
    r = await deps.appendUserPath(at.dir)
  } catch (err) {
    deps.log(`[path] Adding ${at.dir} to the user PATH failed: ${err instanceof Error ? err.message : String(err)}`)
    return { outcome: 'failed', message: 'Windows PowerShell could not change your PATH. The app log has the detail.' }
  }
  if (r.outcome === 'changed') {
    deps.log(`[path] Adding ${at.dir} to the user PATH: not written, the PATH kept changing while the app wrote it`)
    return { outcome: 'failed', message: 'Your PATH changed while the app was adding to it. Try again.' }
  }
  if (r.outcome === 'unsupported') {
    deps.log(`[path] Adding ${at.dir} to the user PATH: not written, ${r.why}`)
    return { outcome: 'failed', message: 'Your PATH is stored in a form the app does not change. Add the folder yourself.' }
  }
  deps.log(r.outcome === 'added'
    ? `[path] Added ${at.dir} to the user PATH (HKCU\\Environment): written, change ${r.broadcast ? 'announced' : 'not announced'}`
    : `[path] Adding ${at.dir} to the user PATH: already on the PATH in the registry, nothing written`)
  const key = windowsPathKey(deps.env)
  const merged = mergeWindowsPath(deps.env[key], [at.dir])
  if (merged.added.length > 0) deps.env[key] = merged.value
  return { outcome: r.outcome }
}
