// Windows programs by their full path. One module for every main-process site
// that starts a program on Windows, with no provider-specific rule:
//
// - A helper tool that ships with Windows (taskkill, reg, where, cmd.exe,
//   Windows PowerShell) starts from the system folder,
//   `<SystemRoot>\System32`, by its full path (systemTool).
// - Any other program is found IN-PROCESS in the folders PATH names, and is
//   started by the full path found (findOnWindowsPath). Only a fully
//   qualified folder is read (a drive or a share, the same rule as
//   findClaudeOnWindowsPath in claude-cli-version.ts and the PATH walks in
//   the provider packages), an entry with an unexpanded `%VAR%` is skipped,
//   and each folder is named as Windows names it when it starts a program from
//   it (windowsFolderAsRun). Not found is "not found": never a bare name.
// - A batch file (an npm `.cmd` shim) runs through the system cmd.exe with
//   the switches and quoting claude-cli-version.ts's versionProbeCommand uses
//   (windowsBatchFileCommand), never through `shell: true`.
// - A program that only the user's PowerShell profile puts on PATH (a
//   version manager such as fnm adds its folder there and nowhere else) is
//   asked of Windows PowerShell WITH that profile, by its full path in the
//   system folder, with a fixed command, in the home folder and off the
//   event loop (findWithPowerShellProfile). The command searches only the
//   PATH folders named from a drive letter, so a relative entry the profile
//   adds is never searched. Its one answer is taken only when it is a plain
//   drive-absolute path to an existing file of an allowed name: never a bare
//   or relative name, a share, or a file in the folder the question ran in.
//
// So what runs never depends on the folder a process happens to run in.
// Pure apart from the default file tests and findWithPowerShellProfile, the
// one function here that starts a process.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { windowsFolderAsRun, windowsPathFolderIsFullyQualified } from './providers/windows-path-names'

/** A name a plain path step may carry: no separator, drive colon, wildcard,
 *  quote, redirection, `%` or control character. */
// eslint-disable-next-line no-control-regex
const PLAIN_STEP = /^[^\\/:*?"<>|%\x00-\x1f]+$/

function isPlainStep(step: string): boolean {
  // `.` and `..` are not names, and a name ending in a dot or a space is read
  // differently by Node and by Windows (windows-path-names.ts).
  return PLAIN_STEP.test(step) && step !== '.' && step !== '..' && !/[. ]$/.test(step)
}

/** An environment variable by its Windows name in any case: the exact
 *  spelling first, then the first key equal to it ignoring case. Windows
 *  names are case-insensitive; a copied environment object is not. */
export function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name]
  if (typeof exact === 'string') return exact
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper)
  const value = key === undefined ? undefined : env[key]
  return typeof value === 'string' ? value : undefined
}

/** A plain drive-absolute folder: `C:\Windows` (either slash, an optional
 *  trailing one), every step a plain name. Not a share, not the device
 *  namespace, not relative, no `.` or `..` step, no `%`. */
function isPlainDriveFolder(p: unknown): p is string {
  if (typeof p !== 'string') return false
  const m = /^[A-Za-z]:[\\/](.*)$/.exec(p)
  if (!m) return false
  const rest = m[1].replace(/[\\/]$/, '')
  return rest === '' || rest.split(/[\\/]/).every(isPlainStep)
}

/** The full path of a helper tool that ships with Windows:
 *  `<SystemRoot>\System32\<relPath>` (`taskkill.exe`,
 *  `WindowsPowerShell\v1.0\powershell.exe`). THROWS when SystemRoot (read
 *  from `env` in any case) is not a plain drive-absolute folder, or when
 *  `relPath` is not a plain relative path below it: the caller then starts
 *  nothing by that name. */
export function systemTool(relPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof relPath !== 'string' || relPath === '' || !relPath.split(/[\\/]/).every(isPlainStep)) {
    throw new Error(`systemTool: ${JSON.stringify(relPath)} is not a plain path below the system folder`)
  }
  const root = windowsEnvValue(env, 'SystemRoot')
  if (!isPlainDriveFolder(root)) {
    throw new Error('systemTool: SystemRoot is not a plain drive-absolute folder')
  }
  return path.win32.join(root, 'System32', relPath)
}

/** The order a PATH walk asks in. `folder` (the default): PATH's folders in
 *  order, and in each folder the names in the order given (how Windows tries
 *  PATHEXT). `name`: the first name in every folder, then the next name in
 *  every folder (how the Claude launch has always asked: `claude.exe`
 *  anywhere on PATH before `claude.cmd`). */
export type WindowsPathOrder = 'folder' | 'name'

/** The folders a PATH walk reads, in PATH's order: fully qualified only (a
 *  drive or a share), no unexpanded `%VAR%`, one pair of surrounding quotes
 *  dropped, each named as Windows names it when it starts a program from it.
 *  The same rule as findClaudeOnWindowsPath (claude-cli-version.ts). */
export function windowsPathFolders(env: NodeJS.ProcessEnv): string[] {
  return (windowsEnvValue(env, 'PATH') ?? '').split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter((d) => d !== '' && !d.includes('%') && windowsPathFolderIsFullyQualified(d))
    // `.` and `..` steps stay (path.win32.join folds them).
    .map((d) => windowsFolderAsRun(d))
}

function assertPlainNames(names: readonly string[]): void {
  if (!Array.isArray(names) || names.length === 0) throw new Error('findOnWindowsPath: no program names')
  for (const n of names) {
    if (typeof n !== 'string' || !isPlainStep(n)) throw new Error(`findOnWindowsPath: ${JSON.stringify(n)} is not a plain file name`)
  }
}

/** Every [folder, candidate file] pair, in the walk's order. */
function candidates(dirs: string[], names: readonly string[], order: WindowsPathOrder): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (order === 'name') {
    for (const n of names) for (const d of dirs) out.push([d, path.win32.join(d, n)])
  } else {
    for (const d of dirs) for (const n of names) out.push([d, path.win32.join(d, n)])
  }
  return out
}

/** A regular file? `false` for an answer that says it is not there (or is not
 *  a file); THROWS for anything else (a share that did not answer, a denied
 *  folder), which the walk reads as "this folder cannot be reached". */
function isRegularFileSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw e
  }
}

/** isRegularFileSync, off the event loop: false for "not there" or "not a
 *  file", REJECTS for anything else. */
export async function isRegularFileAsync(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw e
  }
}

/** The full path of the first of `names` found IN-PROCESS in the folders
 *  PATH names (windowsPathFolders), in `order`; null when none is. `stat`
 *  answers whether a candidate is a file; a stat that THROWS marks that
 *  folder unreachable, and the walk does not ask it again for another name.
 *  Starts no process; never answers a bare name. */
export function findOnWindowsPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  stat: (p: string) => boolean = isRegularFileSync,
  order: WindowsPathOrder = 'folder',
): string | null {
  assertPlainNames(names)
  const unreachable = new Set<string>()
  for (const [dir, file] of candidates(windowsPathFolders(env), names, order)) {
    if (unreachable.has(dir)) continue
    try {
      if (stat(file) === true) return file
    } catch {
      unreachable.add(dir)
    }
  }
  return null
}

/** findOnWindowsPath, one stat at a time off the event loop: a PATH entry on
 *  a dead share can hold a stat for tens of seconds, which must not be the
 *  main process's. A rejected stat marks that folder unreachable. */
export async function findOnWindowsPathAsync(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  stat: (p: string) => Promise<boolean> = isRegularFileAsync,
  order: WindowsPathOrder = 'folder',
): Promise<string | null> {
  assertPlainNames(names)
  const unreachable = new Set<string>()
  for (const [dir, file] of candidates(windowsPathFolders(env), names, order)) {
    if (unreachable.has(dir)) continue
    try {
      if ((await stat(file)) === true) return file
    } catch {
      unreachable.add(dir)
    }
  }
  return null
}

/** How a batch file found by its full path is started: the system cmd.exe,
 *  `/d` (no AutoRun), `/v:off` (no delayed expansion), `/s /c` with the line
 *  passed verbatim, the file quoted. The spawn passes `windowsVerbatimArguments`
 *  and never `shell`. */
export interface WindowsBatchFileCommand {
  file: string
  args: string[]
  windowsVerbatimArguments: true
}

/** An argument a batch file receives unchanged: letters, digits and
 *  `. _ : = @ + / , -` only (no space, quote, `%`, `!`, `^`, `&`, `|`, `<`,
 *  `>`, parenthesis, `;` or control character), so neither cmd.exe nor the
 *  batch file's own re-read of its arguments acts on it. A comma-joined list
 *  (`--disallowedTools A,B`) is one argument. */
const PLAIN_BATCH_ARG = /^[A-Za-z0-9._:=@+/,-]+$/

/** The start of `batchFile` (a `.cmd` / `.bat` by its full path) with `args`
 *  through the system cmd.exe (claude-cli-version.ts's versionProbeCommand
 *  pattern), or why it is not started: a path carrying `" % & ^` or a
 *  control character (characters cmd.exe or the batch file would re-read),
 *  an argument that is not plain (PLAIN_BATCH_ARG), or no plain SystemRoot. */
export function windowsBatchFileCommand(
  batchFile: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WindowsBatchFileCommand | { refused: string } {
  if (typeof batchFile !== 'string' || !/\.(cmd|bat)$/i.test(batchFile) || !windowsPathFolderIsFullyQualified(batchFile)) {
    return { refused: 'not a batch file named by its full path' }
  }
  // eslint-disable-next-line no-control-regex
  if (/["%&^\x00-\x1f]/.test(batchFile)) {
    return { refused: 'the batch file path carries a character cmd.exe or the batch file would re-read (" % & ^ or a control character)' }
  }
  for (const a of args) {
    if (typeof a !== 'string' || !PLAIN_BATCH_ARG.test(a)) return { refused: 'an argument is not one a batch file receives unchanged' }
  }
  let cmd: string
  try {
    cmd = systemTool('cmd.exe', env)
  } catch {
    return { refused: 'the system cmd.exe could not be named (SystemRoot is not a plain drive-absolute folder)' }
  }
  return {
    file: cmd,
    args: ['/d', '/v:off', '/s', '/c', `""${batchFile}"${args.map((a) => ` ${a}`).join('')}"`],
    windowsVerbatimArguments: true,
  }
}

/** How a program found by its full path (findOnWindowsPath, or a path the
 *  app made) starts with `args` and no shell, and the environment it starts
 *  with (withFullyQualifiedProgramLookup of the one passed in): the start and
 *  the lookup rule for what the child itself starts travel together. */
export interface WindowsStartCommand<E extends Record<string, string | undefined> = NodeJS.ProcessEnv> {
  file: string
  args: string[]
  /** Pass to spawn / execFile as is (true only for a batch file). */
  windowsVerbatimArguments: boolean
  /** Pass as the child's environment. */
  env: E & { NoDefaultCurrentDirectoryInExePath: string }
}

/** The start of `program` with `args`, never through a shell: an executable
 *  (`.exe`, `.com`) by its full path directly, with Node's own argument
 *  quoting; a batch file through the system cmd.exe (windowsBatchFileCommand).
 *  Either way the environment is `env` with the child's own program lookup
 *  kept to the folders PATH names in full (withFullyQualifiedProgramLookup):
 *  never the child's working folder, nor a folder named relative to it.
 *  Anything else (a `.ps1`, a bare or relative name) is refused. `env`
 *  itself is not changed. */
export function windowsStartCommand<E extends Record<string, string | undefined> = NodeJS.ProcessEnv>(
  program: string,
  args: readonly string[],
  env: E = process.env as E,
): WindowsStartCommand<E> | { refused: string } {
  if (typeof program !== 'string' || !windowsPathFolderIsFullyQualified(program)) {
    return { refused: 'not a program named by its full path' }
  }
  if (/\.(exe|com)$/i.test(program)) return { file: program, args: [...args], windowsVerbatimArguments: false, env: withFullyQualifiedProgramLookup(env) }
  if (/\.(cmd|bat)$/i.test(program)) {
    const how = windowsBatchFileCommand(program, args, env)
    return 'refused' in how ? how : { ...how, env: withFullyQualifiedProgramLookup(env) }
  }
  return { refused: 'not an executable or a batch file' }
}

/** The setting's name, compared in upper case (Windows names are
 *  case-insensitive). */
const CURRENT_FOLDER_LOOKUP_KEY = 'NODEFAULTCURRENTDIRECTORYINEXEPATH'

/** A copy of `env` with NoDefaultCurrentDirectoryInExePath set, so a program
 *  the child itself starts by a bare name (an npm shim's `node`) is looked for
 *  in the folders PATH names and never in the child's own working folder. One
 *  spelling: a key equal to it in any other case is left out, so the
 *  environment reads the same however the variable was inherited. `env`
 *  itself is not changed. */
export function withoutCurrentFolderLookup<T extends Record<string, string | undefined>>(env: T): T & { NoDefaultCurrentDirectoryInExePath: string } {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== CURRENT_FOLDER_LOOKUP_KEY) out[k] = v
  out.NoDefaultCurrentDirectoryInExePath = '1'
  return out as T & { NoDefaultCurrentDirectoryInExePath: string }
}

/** A copy of `env` for a child that starts Claude Code on Windows: every
 *  spelling of PATH kept to its fully qualified folders, a drive or a share
 *  (windowsPathFolderIsFullyQualified), each read as a PATH walk reads it
 *  (trimmed, and without the quotes around a quoted one), and a spelling left
 *  with none dropped; with NoDefaultCurrentDirectoryInExePath set, in one
 *  spelling (withoutCurrentFolderLookup). A program the child starts by a bare
 *  name (an npm shim's `node`) is then found only in a folder PATH names in
 *  full: never in the child's working folder, nor in one named relative to it.
 *  A Claude session's launch, the setup terminal, the /insights terminal, the
 *  install or update tab and every start through windowsStartCommand (a cloud
 *  agent, a headless run, the sign-in check, npm) use it. `env` itself is not
 *  changed. */
export function withFullyQualifiedProgramLookup<T extends Record<string, string | undefined>>(env: T): T & { NoDefaultCurrentDirectoryInExePath: string } {
  const out: Record<string, string | undefined> = withoutCurrentFolderLookup(env)
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== 'PATH') continue
    const value = out[key]
    const kept: string[] = []
    for (const raw of typeof value === 'string' ? value.split(';') : []) {
      let dir = raw.trim()
      if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
      if (windowsPathFolderIsFullyQualified(dir)) kept.push(dir)
    }
    if (kept.length) out[key] = kept.join(';')
    else delete out[key]
  }
  return out as T & { NoDefaultCurrentDirectoryInExePath: string }
}

// ---------------------------------------------------------------------------
// A program only the user's PowerShell profile puts on PATH
// ---------------------------------------------------------------------------

/** How many times a check the user asked for has brought this process's PATH
 *  up to date (windows-path-refresh.ts refreshWindowsPath calls
 *  noteWindowsPathRefresh for each one, for any provider: Check again on the
 *  setup screen or in Settings, a provider's setup page, the check after an
 *  install ends). A lookup that keeps its answer for the run
 *  (claude-cli-probe.ts keeps the PowerShell profile's) asks again once this
 *  count has moved, and never because of a check the app runs by itself. */
let pathRefreshes = 0

export function noteWindowsPathRefresh(): void {
  pathRefreshes += 1
}

export function windowsPathRefreshCount(): number {
  return pathRefreshes
}

/** A program file name the profile lookup may ask for: letters, digits, `.`,
 *  `_` and `-` only, ending in `.exe`, `.cmd` or `.bat`, so a PowerShell
 *  single-quoted string holds it exactly as written. */
const PROFILE_LOOKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|cmd|bat)$/i

/** The markers around the answer findWithPowerShellProfile's command prints:
 *  a profile may print before it, so only the text between the LAST opening
 *  marker and the first closing marker after it counts. */
const PROFILE_ANSWER_BEGIN = '__CCC_PROGRAM_BEGIN__'
const PROFILE_ANSWER_END = '__CCC_PROGRAM_END__'

/** How long the PowerShell profile has to answer (a profile that loads conda
 *  or a prompt theme can take a few seconds). After it the question counts as
 *  unanswered, and PowerShell, with whatever it started, is stopped. */
export const POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS = 10_000

/** How long the output is still read after PowerShell has exited, when
 *  something the profile started (an agent such as gpg-agent or ssh-agent)
 *  still holds the output open, so it never closes: what PowerShell printed
 *  before it exited has arrived by then. */
export const POWERSHELL_PROFILE_EXIT_DRAIN_MS = 300

/** About how much of the END of PowerShell's output is kept (a profile may
 *  print a lot before the answer). */
const PROFILE_LOOKUP_MAX_OUTPUT = 256 * 1024

/** What findWithPowerShellProfile learned. `found`: the program's full path.
 *  `none`: PowerShell answered, and named no program the app takes (none of
 *  those names, one powerShellProfileAnswer refuses, or one that is not a
 *  regular file). `failed`: no answer to go by: PowerShell did not start,
 *  did not answer in time, exited without printing one, or the file could
 *  not be checked. */
export type PowerShellProfileLookup = { outcome: 'found'; path: string } | { outcome: 'none' } | { outcome: 'failed' }

function assertProfileLookupNames(names: readonly string[]): void {
  if (!Array.isArray(names) || names.length === 0) throw new Error('findWithPowerShellProfile: no program names')
  for (const n of names) {
    if (typeof n !== 'string' || !PROFILE_LOOKUP_NAME.test(n)) throw new Error(`findWithPowerShellProfile: ${JSON.stringify(n)} is not a plain program file name`)
  }
}

/** The fixed command Windows PowerShell runs, after the user's profile, to
 *  say where the first of `names` is. First the PATH the profile built is
 *  kept to the folders named from a drive letter (`C:\...`, in quotes or
 *  not, no `%`): a relative entry (`.`, `bin`, `node_modules\.bin`) is
 *  dropped, and a share's answer is refused anyway. Then each name in turn:
 *  the first program (an application, never a script, alias or function) of
 *  that name in that PATH, in PATH's order, as Get-Command finds it (the
 *  names in claude-cli-probe.ts CLAUDE_WINDOWS_NAMES order, as the app's own
 *  walk asks them). The path goes out between the markers as Base64 of its
 *  UTF-8 bytes, so no console code page can change a character of it and no
 *  profile banner can be mistaken for it. No double quote anywhere in it, so
 *  Windows PowerShell's command line cannot split it. THROWS for a name
 *  PROFILE_LOOKUP_NAME refuses. */
export function powerShellProfileLookupCommand(names: readonly string[]): string {
  assertProfileLookupNames(names)
  const list = names.map((n) => `'${n}'`).join(',')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$env:PATH = (@($env:PATH -split ';') | Where-Object { $_.Trim() -match '^\\x22?[A-Za-z]:[\\\\/]' -and $_ -notmatch '%' }) -join ';'",
    "$found = ''",
    `foreach ($name in @(${list})) { $c = Get-Command -Name $name -CommandType Application | Select-Object -First 1; if ($c) { $found = [string]$c.Source; break } }`,
    `[Console]::Out.Write('${PROFILE_ANSWER_BEGIN}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($found)) + '${PROFILE_ANSWER_END}')`,
  ].join('; ')
}

/** Two folders that are one for Windows (case and a trailing separator aside). */
function sameWindowsFolder(a: string, b: string): boolean {
  const key = (p: string): string => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return key(a) === key(b)
}

/** The text between the last opening marker and the first closing marker
 *  after it, or null when the output holds no such pair (the command never
 *  got to print its answer). */
function printedProfileAnswer(stdout: string): string | null {
  const open = stdout.lastIndexOf(PROFILE_ANSWER_BEGIN)
  if (open < 0) return null
  const start = open + PROFILE_ANSWER_BEGIN.length
  const end = stdout.indexOf(PROFILE_ANSWER_END, start)
  return end < 0 ? null : stdout.slice(start, end)
}

/** The program path in findWithPowerShellProfile's output, or null. Taken
 *  only when the text between the markers is Base64 of whole UTF-8 that reads
 *  as one plain drive-absolute path (`C:\...`, every step a plain name: not a
 *  share, the device namespace or a relative path, and no `.`, `..`, `%`,
 *  wildcard, quote, line break or other control character), whose file name
 *  is one of `names` (in any case) and whose folder is not `workingFolder`,
 *  the folder the question ran in (what a `.` PATH entry would answer).
 *  Returned with backslashes. Whether the file exists is the caller's to ask. */
export function powerShellProfileAnswer(stdout: string, names: readonly string[], workingFolder: string): string | null {
  const encoded = printedProfileAnswer(stdout)
  if (encoded === null) return null
  if (encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  if (Buffer.from(decoded, 'utf8').toString('base64') !== encoded) return null
  const m = /^([A-Za-z]:)[\\/](.+)$/.exec(decoded.trim())
  if (!m) return null
  const steps = m[2].split(/[\\/]/)
  if (!steps.every(isPlainStep)) return null
  const file = path.win32.join(`${m[1]}\\`, ...steps)
  const base = steps[steps.length - 1].toLowerCase()
  if (!names.some((n) => typeof n === 'string' && n.toLowerCase() === base)) return null
  if (sameWindowsFolder(path.win32.dirname(file), workingFolder)) return null
  return file
}

/** What findWithPowerShellProfile may be told. */
export interface PowerShellProfileLookupOptions {
  /** The environment PowerShell starts with (this process's by default),
   *  with its PATH kept to fully qualified folders and the current folder
   *  kept out of program lookup (withFullyQualifiedProgramLookup). */
  env?: NodeJS.ProcessEnv
  /** The folder the question runs in: the home folder by default. It must be
   *  a plain drive-absolute folder, or nothing is asked. */
  cwd?: string
  timeoutMs?: number
  /** Whether the answer is a regular file (a real file test by default). */
  stat?: (p: string) => Promise<boolean>
}

/** Stop a question that did not answer in time. `taskkill /T` (by its full
 *  path in the system folder) finds what the profile started only while
 *  PowerShell is alive and still its root, so nothing is killed once
 *  PowerShell has exited: its process id is Windows's to reuse. Best-effort,
 *  never throws. */
function stopPowerShellLookup(child: ChildProcess | undefined, env: NodeJS.ProcessEnv): void {
  if (!child) return
  const kill = (): void => { try { child.kill() } catch { /* best-effort */ } }
  try {
    if (child.exitCode == null && child.signalCode == null) {
      let taskkill: string | null = null
      try { taskkill = systemTool('taskkill.exe', env) } catch { taskkill = null }
      if (taskkill && child.pid) {
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000, cwd: path.win32.dirname(taskkill) }, () => kill())
      } else {
        kill()
      }
    }
    child.stdout?.destroy()
  } catch { /* best-effort */ }
}

/** The full path of the first of `names` that Windows PowerShell finds after
 *  running the user's profile (`found`), that it named none the app takes
 *  (`none`), or that there is no answer to go by (`failed`). Windows
 *  PowerShell starts by its full path in the system folder (systemTool; with
 *  no plain SystemRoot nothing starts), WITH the profile, `-NonInteractive`,
 *  the fixed command of powerShellProfileLookupCommand, in `opts.cwd` (the
 *  home folder), no shell, off the event loop. The answer is
 *  powerShellProfileAnswer's, and only when it is a regular file. It is read
 *  when the output closes, or POWERSHELL_PROFILE_EXIT_DRAIN_MS after
 *  PowerShell exits when something the profile started still holds the
 *  output open. No answer within `opts.timeoutMs` and a start that failed are
 *  `failed`. Rejects only for names PROFILE_LOOKUP_NAME refuses. Windows
 *  only: the caller decides when. */
export function findWithPowerShellProfile(names: readonly string[], opts: PowerShellProfileLookupOptions = {}): Promise<PowerShellProfileLookup> {
  const FAILED: PowerShellProfileLookup = { outcome: 'failed' }
  const NONE: PowerShellProfileLookup = { outcome: 'none' }
  let command: string
  try {
    command = powerShellProfileLookupCommand(names)
  } catch (e) {
    return Promise.reject(e)
  }
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? homedir()
  if (!isPlainDriveFolder(cwd)) return Promise.resolve(FAILED)
  let start: WindowsStartCommand
  try {
    const how = windowsStartCommand(systemTool('WindowsPowerShell\\v1.0\\powershell.exe', env), ['-NoLogo', '-NonInteractive', '-Command', command], env)
    if ('refused' in how) return Promise.resolve(FAILED)
    start = how
  } catch {
    return Promise.resolve(FAILED)
  }
  const timeoutMs = opts.timeoutMs ?? POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS
  const stat = opts.stat ?? isRegularFileAsync
  return new Promise<PowerShellProfileLookup>((resolve) => {
    let settled = false
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcess | undefined
    const chunks: Buffer[] = []
    let size = 0
    const finish = (answer: PowerShellProfileLookup): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (drain) clearTimeout(drain)
      resolve(answer)
    }
    const read = (): void => {
      if (settled || reading) return
      reading = true
      // Nothing more is read: PowerShell has exited, and what it started
      // may hold the output open for good.
      try { child?.stdout?.destroy() } catch { /* best-effort */ }
      const out = Buffer.concat(chunks).toString('utf8')
      if (printedProfileAnswer(out) === null) { finish(FAILED); return }
      const found = powerShellProfileAnswer(out, names, cwd)
      if (!found) { finish(NONE); return }
      stat(found).then((ok) => finish(ok === true ? { outcome: 'found', path: found } : NONE), () => finish(FAILED))
    }
    try {
      child = spawn(start.file, start.args, {
        cwd,
        env: start.env,
        windowsHide: true,
        windowsVerbatimArguments: start.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      // The answer is printed last, so the end of the output is what is kept.
      child.stdout?.on('data', (d: Buffer) => {
        chunks.push(d)
        size += d.length
        while (size - chunks[0].length >= PROFILE_LOOKUP_MAX_OUTPUT) size -= (chunks.shift() as Buffer).length
      })
      child.on('error', () => finish(FAILED))
      child.on('exit', () => {
        if (settled || drain) return
        drain = setTimeout(read, POWERSHELL_PROFILE_EXIT_DRAIN_MS)
        drain.unref?.()
      })
      child.on('close', () => read())
    } catch {
      finish(FAILED)
      return
    }
    timer = setTimeout(() => {
      if (settled) return
      finish(FAILED)
      stopPowerShellLookup(child, env)
    }, timeoutMs)
    timer.unref?.()
  })
}
