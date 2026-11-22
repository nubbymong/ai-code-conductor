import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HookEventKind } from '../../shared/hook-types'
import { atomicWriteSecure, mkdirSecure, hardenCredentialDir } from '../account-profiles'
import { logWarn } from '../debug-logger'
import { posixCanonicalLocalSettingsRootSync, GitPointerChangedError } from '../git-local-settings-root'
import { decodeSettingsText } from '../settings-text'
import { stripSpoofableText } from '../../shared/safe-text'
import { SID_RE } from '../session-helper/protocol'

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

/**
 * How Claude Code starts a command hook (2.1.3-beta.8, plan section A4): on
 * Windows through Git for Windows' bash, `bin\bash.exe -c "<command>"` (ADR-030
 * probe P16, step 0, seen with Claude Code 2.1.296), and elsewhere through
 * `/bin/sh -c "<command>"`. Both read the command as a POSIX shell does.
 */
export type HookLauncher = 'git-bash' | 'sh'

/** The session helper's hook mode for one held session. */
export interface HelperHookTarget {
  /** The per-user helper copy's absolute path. */
  helperPath: string
  /** The helper's store folder. */
  store: string
  /** The holder's session id. */
  sid: string
  launcher: HookLauncher
}

/** A control character anywhere. */
const HOOK_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/
/** A Windows path from a drive's root (no network path, no relative path). */
const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/

/** One word for a POSIX shell: single-quoted, so nothing in it has a meaning
 *  ($, `, %, &, ^, spaces and letters outside ASCII included), and a single
 *  quote in it closed, given escaped, and opened again. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * A path as the launcher takes it, or null when it cannot take it safely.
 * Git Bash: a drive path, its backslashes made forward slashes (bash reads a
 * backslash as an escape, and MSYS leaves a `C:/` argument as it is), and no
 * double quote, which would end Claude Code's own quoting of the command on
 * the Windows command line it builds for bash.exe. /bin/sh: an absolute path.
 * Neither takes a control character.
 */
function launcherPath(p: string, launcher: HookLauncher): string | null {
  if (typeof p !== 'string' || p.length === 0 || HOOK_CONTROL_RE.test(p)) return null
  if (launcher === 'git-bash') {
    if (!DRIVE_PATH_RE.test(p) || p.includes('"')) return null
    return p.replace(/\\/g, '/')
  }
  return p.startsWith('/') ? p : null
}

/**
 * The command a Claude Code session held by the session helper runs for a
 * hook event: the helper's hook mode, quoted for the launcher. Null when a
 * path cannot be given to that launcher safely, or the session id breaks its
 * pattern: then the session keeps its hooks on the hooks gateway.
 */
export function helperHookCommand(target: HelperHookTarget): string | null {
  const exe = launcherPath(target.helperPath, target.launcher)
  const store = launcherPath(target.store, target.launcher)
  // The session id: the helper's own pattern (protocol section 15).
  if (exe === null || store === null || !SID_RE.test(target.sid)) return null
  return `${shellWord(exe)} hook --store ${shellWord(store)} --session ${target.sid}`
}

/** How long Claude Code may give the hook mode, in seconds. The hook mode
 *  itself ends within 2 s; this bounds a launcher that hangs. */
export const HELPER_HOOK_TIMEOUT_SECS = 10

/**
 * The `hooks` block of a Claude Code session whose hooks go through the
 * session helper (2.1.3-beta.8, plan section A4): every injected event runs
 * the helper's hook mode, which passes each one to the session's holder.
 * From 2.1.3-beta.14 (S16 step 2) that includes PreToolUse, so no entry names
 * the hooks gateway's port or token: Claude Code reads its settings file once
 * (ADR-030 probe P20), and an entry that named this app run's gateway would
 * fail at every tool call once that run is gone. The hook mode answers no
 * permission: it always exits 0 and prints nothing, as the gateway answered
 * every PreToolUse `{}` at once. Null when the command cannot be given safely
 * (helperHookCommand).
 */
export function buildHelperHooksBlock(target: HelperHookTarget): Record<string, unknown[]> | null {
  const command = helperHookCommand(target)
  if (command === null) return null
  const hooks: Record<string, unknown[]> = {}
  for (const kind of MVP_EVENTS) {
    hooks[kind] = [{ matcher: '', hooks: [{ type: 'command', command, timeout: HELPER_HOOK_TIMEOUT_SECS }] }]
  }
  return hooks
}

/** What switchHooksToHelper did. */
export type HelperHooksResult =
  /** The settings file now sends every injected event through the helper. */
  | 'switched'
  /** The file holds no gateway hooks of this session (the gateway was down
   *  or switched off at the spawn, or the file was not written): nothing to
   *  switch. */
  | 'no-gateway-hooks'
  /** A path the launcher cannot take safely (helperHookCommand). */
  | 'unsafe-path'
  /** The file could not be written; it was left as it was. */
  | 'not-written'

/** The port and token of this session's gateway hooks in a `hooks` map: read
 *  from its PreToolUse entry, exactly as buildHooksBlock writes it. */
function gatewayHooksIn(hooks: Record<string, unknown[]>, sessionId: string): { port: number; secret: string } | null {
  const tail = `/hook/${sessionId}`
  for (const entry of hooks.PreToolUse ?? []) {
    const inner = (entry as { hooks?: unknown } | null)?.hooks
    const first = Array.isArray(inner) ? (inner[0] as Record<string, unknown> | undefined) : undefined
    if (!first || first.type !== 'http' || typeof first.url !== 'string' || !first.url.endsWith(tail)) continue
    const m = /^http:\/\/localhost:(\d{1,5})\/hook\//.exec(first.url)
    const secret = (first.headers as Record<string, unknown> | undefined)?.['X-CCC-Hook-Token']
    if (!m || typeof secret !== 'string') continue
    const port = Number(m[1])
    // Only the entry buildHooksBlock writes, byte for byte.
    if (JSON.stringify(entry) === JSON.stringify(buildHooksBlock(sessionId, port, secret).PreToolUse[0])) return { port, secret }
  }
  return null
}

/**
 * Point a session's per-session settings file at the helper's hook mode, in
 * place (2.1.3-beta.8, plan section A4). The file was written as usual for
 * the hooks gateway (injectHooks) in the same synchronous run as the spawn
 * call (pty-manager.ts: spawnAgentPty, then writeLocalSessionSettings and
 * injectHooks), so always before the holder answers term.launched. Once the
 * session's holder has launched it and before the launch line reaches it,
 * this swaps the app's own entries of the nine events, PreToolUse included
 * (2.1.3-beta.14), for the hook mode and keeps every hook the session
 * inherited as it was. No gateway URL or token is left in the file. A file
 * switched already holds no gateway hooks, so a second switch leaves it as it
 * is ('no-gateway-hooks'). FAIL-SAFE: on anything but 'switched' the file is
 * as it was, and the session keeps its gateway hooks.
 */
export function switchHooksToHelper(a: { settingsPath: string; sessionId: string; target: HelperHookTarget }): HelperHooksResult {
  const settings = readJsonSafe(a.settingsPath)
  const hooks = hooksOf(settings)
  const gw = gatewayHooksIn(hooks, a.sessionId)
  if (!gw) return 'no-gateway-hooks'
  const helper = buildHelperHooksBlock(a.target)
  if (!helper) return 'unsafe-path'
  const own = buildHooksBlock(a.sessionId, gw.port, gw.secret)
  const kept: Record<string, unknown[]> = {}
  for (const [event, arr] of Object.entries(hooks)) {
    const mine = own[event]?.[0] !== undefined ? JSON.stringify(own[event][0]) : null
    kept[event] = mine === null ? arr : arr.filter((entry) => JSON.stringify(entry) !== mine)
  }
  // The app's hooks last, as injectHooks puts them.
  settings.hooks = concatHookMaps(kept, helper)
  return writeJson(a.settingsPath, settings) ? 'switched' : 'not-written'
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
function writeJson(file: string, data: unknown): boolean {
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
    return true
  } catch (err) {
    // Fail closed: leave the existing file (base settings from
    // writeLocalSessionSettings) rather than fall back to an insecure write.
    logWarn(`[hooks] secure write of ${path.basename(file)} failed (${String(err)}); left the previous file`)
    return false
  }
}
