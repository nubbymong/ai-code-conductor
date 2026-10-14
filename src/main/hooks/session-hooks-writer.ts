import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HookEventKind } from '../../shared/hook-types'
import { atomicWriteSecure, mkdirSecure, hardenCredentialDir } from '../account-profiles'
import { logWarn } from '../debug-logger'
import { posixCanonicalLocalSettingsRootSync, GitPointerChangedError } from '../git-local-settings-root'
import { decodeSettingsText } from '../settings-text'
import { stripSpoofableText } from '../../shared/safe-text'

// Injected hook events. SubagentStart/SubagentStop bracket subagent and
// dynamic-workflow-agent execution so the status strip can pin its model +
// effort pills to the main window (see background-context.ts). StopFailure
// (#235) is the session watchdog's authoritative overload/server-error
// signal — see src/main/watchdog/watchdog-manager.ts. PreCompact remains
// unused for now.
export const MVP_EVENTS: HookEventKind[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
]

export interface InjectArgs {
  sessionId: string
  settingsPath: string
  port: number
  secret: string
  /** The directory Claude launches in. Used to resolve the user/project hooks
   *  Claude would otherwise apply, so they can be MERGED with CCC's hooks
   *  instead of shadowed by the --settings override (#137). */
  cwd: string
  /** Test-only override for the user-settings home dir. Defaults to
   *  os.homedir(); production callers omit it. */
  homeDir?: string
}

export interface RemoveArgs {
  settingsPath: string
}

/**
 * Build the `hooks` block for a Claude Code settings file. Returns the
 * object literal shape that goes under the `hooks` key of settings.json —
 * one array entry per MVP event kind, each pointing at the session's
 * gateway endpoint with the per-session secret in an X-CCC-Hook-Token
 * header.
 *
 * Exported so the SSH path can embed the same shape in its remote setup
 * script literal without re-implementing the endpoint/headers format.
 */
export function buildHooksBlock(
  sessionId: string,
  port: number,
  secret: string,
): Record<string, unknown[]> {
  const endpoint = `http://localhost:${port}/hook/${sessionId}`
  const headers = { 'X-CCC-Hook-Token': secret }
  const hooks: Record<string, unknown[]> = {}
  // Claude Code's hooks schema requires a matcher-wrapped entry:
  //   hooks.<Event> = [{ matcher: "<tool-name-regex-or-empty>", hooks: [<entry>] }]
  // Empty matcher matches every tool for the event. A flat
  // `[{ type, url, headers }]` was the earlier schema and is rejected by
  // newer Claude Code builds with "hooks: Expected array, but received undefined".
  for (const kind of MVP_EVENTS) {
    hooks[kind] = [
      {
        matcher: '',
        hooks: [{ type: 'http', url: endpoint, headers }],
      },
    ]
  }
  return hooks
}

/** The array-valued events of a parsed settings object's `hooks`; {} for
 *  anything else. */
function hooksOf(parsed: unknown): Record<string, unknown[]> {
  const hooks = parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).hooks
    : undefined
  const out: Record<string, unknown[]> = {}
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
      if (Array.isArray(arr)) out[event] = arr.slice()
    }
  }
  return out
}

/** The `hooks` of a settings file's bytes, decoded as Claude Code decodes
 *  them (../settings-text.ts): UTF-16LE after an FF FE mark, UTF-8 otherwise,
 *  a leading byte-order mark dropped. Throws when the text is not JSON. */
function hooksOfBytes(bytes: Buffer): Record<string, unknown[]> {
  return hooksOf(JSON.parse(decodeSettingsText(bytes, bytes.length)) as unknown)
}

/**
 * Read the `hooks` object out of a settings JSON file, keeping only
 * array-valued events. FAIL-SAFE: missing/unparseable/odd-shaped → {}.
 */
function readHooksFrom(file: string): Record<string, unknown[]> {
  try {
    return hooksOfBytes(fs.readFileSync(file))
  } catch { /* missing / unparseable — contributes nothing */ }
  return {}
}

/** The effective user and group ids. */
interface PosixIds { euid: number; egid: number }

/** The effective user and group ids on POSIX; null where there are none
 *  (Windows). An egid that cannot be read is -1, which matches no group. */
function currentIds(): PosixIds | null {
  if (typeof process.geteuid !== 'function') return null
  return { euid: process.geteuid(), egid: typeof process.getegid === 'function' ? process.getegid() : -1 }
}

/**
 * Why a project `.claude` folder or settings file is not taken, or null when
 * it is. It must be owned by the user and not writable by others. It may be
 * writable by its group only when that group is the user's own per-user group:
 * the user's primary group, with the same number as the user id. That is the
 * user-private group useradd makes when USERGROUPS_ENAB is on (the default on
 * Ubuntu and the RHEL family), where umask 002 is the default too, so mkdir,
 * git clone and Claude Code make the folder 0775 and the files 0664. A primary
 * group other accounts share never qualifies, even when it is the user's own:
 * on macOS every account's is staff (gid 20, and a new file takes its folder's
 * group), and some systems give every user the shared users group (gid 100).
 */
function notPrivateWhy(st: fs.Stats, ids: PosixIds): 'owner' | 'mode' | null {
  if (st.uid !== ids.euid) return 'owner'
  if ((st.mode & 0o002) !== 0) return 'mode'
  if ((st.mode & 0o020) !== 0 && !(st.gid === ids.egid && ids.egid === ids.euid)) return 'mode'
  return null
}

/** A path as it may be written to the app log (see ../../shared/safe-text.ts). */
const shown = (p: string): string => stripSpoofableText(p, 300)

/**
 * POSIX: readHooksFrom, but only for a regular file that passes notPrivateWhy.
 * The file is opened without following a link (O_NOFOLLOW; O_NONBLOCK so a
 * FIFO cannot stall the spawn) and checked on the open descriptor (fstat), so
 * the file read is the file checked. A file that is present but not taken is
 * added to `skipped` with the reason. FAIL-SAFE.
 */
function readOwnedHooksFrom(file: string, ids: PosixIds, skipped: string[]): Record<string, unknown[]> {
  let fd = -1
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    try {
      fd = fs.openSync(file, flags)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'ELOOP' || code === 'EMLINK') skipped.push(`${shown(file)} (link)`)
      return {} // missing or a link: contributes nothing
    }
    const st = fs.fstatSync(fd)
    const why = st.isFile() ? notPrivateWhy(st, ids) : 'type'
    if (why) {
      skipped.push(`${shown(file)} (${why})`)
      return {}
    }
    return hooksOfBytes(fs.readFileSync(fd))
  } catch {
    return {} // unparseable: contributes nothing
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd) } catch { /* already closed */ } }
  }
}

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** True when `dir` is `target` or a folder above it. path.relative compares
 *  without regard to case on Windows, and answers an absolute path for a
 *  folder on another drive. */
function isAtOrAbove(dir: string, target: string): boolean {
  const rel = path.relative(dir, target)
  return rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
}

/** True when `dir` is the home folder or a folder above it, compared on the
 *  resolved and the real path of each. FAIL-SAFE: an error counts as true. */
function isHomeOrAbove(dir: string, homeDir: string): boolean {
  try {
    const homes = [path.resolve(homeDir), realOrResolved(homeDir)]
    for (const d of [path.resolve(dir), realOrResolved(dir)]) {
      for (const h of homes) if (isAtOrAbove(d, h)) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * True when the `.claude` folder at `claudeDir` may be read: on Windows (`ids`
 * null) whenever it is there to read; on POSIX only when it is a real folder
 * (lstat, not a link) that passes notPrivateWhy. Each file in it is checked
 * again when it is opened (readOwnedHooksFrom). A folder that is present but
 * not taken is added to `skipped` with the reason. FAIL-SAFE.
 */
function claudeDirUsable(claudeDir: string, ids: PosixIds | null, skipped: string[]): boolean {
  if (ids === null) return true
  let st: fs.Stats
  try { st = fs.lstatSync(claudeDir) } catch { return false } // no .claude here
  const why = st.isSymbolicLink() ? 'link' : st.isDirectory() ? notPrivateWhy(st, ids) : 'type'
  if (why) {
    skipped.push(`${shown(claudeDir)} (${why})`)
    return false
  }
  return true
}

/**
 * POSIX: the `.claude` folder of the checkout root whose settings.local.json
 * Claude Code also reads for a session in `cwd`, or null. FAIL-SAFE.
 *
 * Claude Code (the repo's tracked pin, 2.1.278) reads local settings from the
 * canonical git root of the working directory as well as from the working
 * directory itself, when that root is not the working directory or the home
 * folder and the root, its .git and its .claude belong to the user: the
 * checkout root for a session in a subfolder, and the MAIN checkout for a
 * session in a linked git worktree. Never on Windows. The answer comes from
 * the same resolver the launch gate uses (../git-local-settings-root.ts), so
 * the two read the same files. On top of it: never the home folder or a folder
 * above it, and the root's .claude must pass the same checks as the session
 * folder's (claudeDirUsable).
 */
function gitRootClaudeDir(cwd: string, homeDir: string, ids: PosixIds, skipped: string[]): string | null {
  let root: string | null
  try {
    root = posixCanonicalLocalSettingsRootSync(cwd, homeDir)
  } catch (err) {
    // Which root Claude reads is not known (a git pointer changed while it was
    // read, or the lookup failed), so the app adds none, and says so on its
    // own line. Claude Code still reads its own settings files as usual.
    const code = (err as NodeJS.ErrnoException | null)?.code
    const why = err instanceof GitPointerChangedError
      ? 'a git pointer changed while it was read'
      : `the lookup failed${code ? `: ${shown(String(code))}` : ''}`
    logWarn(`[hooks] the app did not add the checkout root's local hooks for ${shown(path.resolve(cwd))} to this session's settings file: which checkout root Claude Code reads could not be determined (${why})`)
    return null
  }
  if (root === null || isHomeOrAbove(root, homeDir)) return null
  const claudeDir = path.join(root, '.claude')
  return claudeDirUsable(claudeDir, ids, skipped) ? claudeDir : null
}

/** Concatenate per-event hook arrays across maps (source order preserved),
 *  then drop byte-identical duplicate entries within each event — a guard so
 *  a hook can never double-fire if Claude's own resolution ever also merges. */
function concatHookMaps(...maps: Record<string, unknown[]>[]): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const m of maps) {
    for (const [event, arr] of Object.entries(m)) {
      if (Array.isArray(arr)) merged[event] = (merged[event] || []).concat(arr)
    }
  }
  const out: Record<string, unknown[]> = {}
  for (const [event, arr] of Object.entries(merged)) {
    const seen = new Set<string>()
    const kept: unknown[] = []
    for (const entry of arr) {
      let key: string
      try { key = JSON.stringify(entry) } catch { key = String(entry) }
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(entry)
    }
    out[event] = kept
  }
  return out
}

/**
 * Reproduce the hooks Claude Code would apply for a session launched in `cwd`,
 * so CCC can MERGE them with its own gateway hooks rather than shadow them.
 * Claude treats a --settings `hooks` key as an override (it is NOT a
 * concatenating array), so without this a project/user hook — e.g. a project
 * `carp-hook.ps1` — never fires in a CCC-launched session (#137).
 *
 * Sources, low to high precedence (all concatenated; all run), the files Claude
 * Code itself reads (the repo's tracked pin, 2.1.278):
 *   user     ~/.claude/settings.json
 *   project  <cwd>/.claude/settings.json
 *   local    <cwd>/.claude/settings.local.json
 *   local    <git root>/.claude/settings.local.json, POSIX only: the checkout
 *            root of a session in a subfolder, or the main checkout of a
 *            session in a linked git worktree (gitRootClaudeDir)
 * Claude reads no other ancestor folder (not a parent's settings.json). Nothing
 * project is read when `cwd` is the home folder (that is the USER source) or a
 * folder above it, and no git root that is the home folder or above it. On
 * POSIX a project .claude folder and its files are used only when they are the
 * user's own, not links, not writable by others, and writable by their group
 * only when it is the user's own per-user group (notPrivateWhy; claudeDirUsable,
 * readOwnedHooksFrom). A project folder or file that is present but not taken
 * is logged once, with the reason, so a hook the app did not add can be
 * traced; so is a checkout root that could not be determined
 * (gitRootClaudeDir). What is not taken here is only what the app does not
 * ADD to the session's settings file: Claude Code still reads the project's
 * own settings files itself.
 * Enterprise "managed" settings outrank --settings regardless, so folding them
 * in would not change Claude's resolution — left to Claude. FAIL-SAFE.
 */
export function resolveInheritedHooks(cwd: string, homeDir: string = os.homedir()): Record<string, unknown[]> {
  const userClaude = path.join(homeDir, '.claude')
  const maps: Record<string, unknown[]>[] = [readHooksFrom(path.join(userClaude, 'settings.json'))]
  const ids = currentIds()
  const skipped: string[] = []
  if (!isHomeOrAbove(cwd, homeDir)) {
    const read = (file: string): Record<string, unknown[]> =>
      ids === null ? readHooksFrom(file) : readOwnedHooksFrom(file, ids, skipped)
    const projectClaude = path.join(path.resolve(cwd), '.claude')
    if (claudeDirUsable(projectClaude, ids, skipped)) {
      maps.push(read(path.join(projectClaude, 'settings.json')))
      maps.push(read(path.join(projectClaude, 'settings.local.json')))
    }
    const rootClaude = ids === null ? null : gitRootClaudeDir(cwd, homeDir, ids, skipped)
    if (rootClaude) maps.push(read(path.join(rootClaude, 'settings.local.json')))
  }
  if (skipped.length > 0) {
    logWarn(`[hooks] the app did not add the hooks of ${skipped.join(', ')} to this session's settings file. It adds a project .claude folder's settings files only when the folder and the file are your own (owner), are not writable by other users, and are writable by their group only when it is your own per-user group, the one with the same number as your user id (mode), are not links (link), and are a real folder and a regular file (type). Claude Code itself still applies the project's own settings files, as in any session`)
  }
  return concatHookMaps(...maps)
}

// Rewrites the entire `hooks` key on every inject with the MERGE of the hooks
// Claude would inherit for this cwd (user + project + project-local) and CCC's
// own gateway hooks — so CCC sessions behave like a plain `claude` in the same
// folder, plus the CCC hooks (#137). Per-session settings files are ours to
// manage; a user hand-editing hooks in one is overwritten on next spawn.
export function injectHooks(a: InjectArgs): void {
  const settings = readJsonSafe(a.settingsPath)
  const inherited = resolveInheritedHooks(a.cwd, a.homeDir)
  const ccc = buildHooksBlock(a.sessionId, a.port, a.secret)
  // CCC hooks last so inherited hooks keep their natural order; CCC's http
  // entries are unique (per-session URL) so dedupe never drops them.
  settings.hooks = concatHookMaps(inherited, ccc)
  writeJson(a.settingsPath, settings)
}

export function removeHooks(a: RemoveArgs): void {
  if (!fs.existsSync(a.settingsPath)) return
  const settings = readJsonSafe(a.settingsPath)
  if (!('hooks' in settings)) return
  delete settings.hooks
  writeJson(a.settingsPath, settings)
}

function readJsonSafe(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Write via a per-pid temp file + rename so a crash mid-write cannot leave
// the settings file truncated (which Claude Code would then fail to parse
// on /reload). renameSync within the same directory is atomic on every
// platform Node supports, and the destination-held-open EPERM the prior
// comment warned about was a theoretical concern from the SSH setup script
// — in practice Claude Code only opens settings to read, releases the
// handle, and uses /reload to refresh, so rename-over a just-released
// handle is safe. Using a `.tmp.<pid>` suffix keeps concurrent callers
// (different Electron processes in dev) from colliding on the tmp path.
function writeJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  try {
    // settings-<sid>.json carries the per-session X-CCC-Hook-Token in its hooks
    // block, so write it owner-only through the same hardened path the MCP config
    // uses: mkdirSecure refuses a planted ~/.claude junction, hardenCredentialDir
    // makes the dir 0700, and atomicWriteSecure stages exclusively (wx) at 0600.
    // The old plain writeFileSync (no mode) left it 0644 and its symlink-following
    // fallback undid the per-session-settings hardening on the same file.
    mkdirSecure(dir)
    hardenCredentialDir(dir)
    atomicWriteSecure(file, JSON.stringify(data, null, 2), 0o600)
  } catch (err) {
    // Fail closed: leave the existing file (base settings from
    // writeLocalSessionSettings) rather than fall back to an insecure write.
    logWarn(`[hooks] secure write of ${path.basename(file)} failed (${String(err)}); left the previous file`)
  }
}
