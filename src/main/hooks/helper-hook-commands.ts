/**
 * The session helper's hook and status line commands, and the merge of hook
 * maps (moved out of session-hooks-writer.ts unchanged in 2.1.3-beta.18, plan
 * section 3.2, which re-exports them): pure, and with no import that reaches
 * Electron or a file of this computer, so the Claude package's remote launch
 * (providers/claude/remote-launch.ts), which core asks under plain Node too
 * (tests/live/remote-helper-device.live.ts), can build a remote session's
 * settings with them.
 */
import { SID_RE } from '../session-helper/protocol'

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
  return helperModeCommand(target, 'hook')
}

/**
 * The status line command of a Claude Code session whose status line goes
 * through the session helper (2.1.3-beta.18 section 3.2, a tab through the
 * helper on another machine): the helper's status mode, quoted for the
 * launcher as the hook mode is. Null when it cannot be given safely.
 */
export function helperStatusCommand(target: HelperHookTarget): string | null {
  return helperModeCommand(target, 'status')
}

function helperModeCommand(target: HelperHookTarget, mode: 'hook' | 'status'): string | null {
  const exe = launcherPath(target.helperPath, target.launcher)
  const store = launcherPath(target.store, target.launcher)
  // The session id: the helper's own pattern (protocol section 15).
  if (exe === null || store === null || !SID_RE.test(target.sid)) return null
  return `${shellWord(exe)} ${mode} --store ${shellWord(store)} --session ${target.sid}`
}

/** How long Claude Code may give the hook mode, in seconds. The hook mode
 *  itself ends within 2 s; this bounds a launcher that hangs. */
export const HELPER_HOOK_TIMEOUT_SECS = 10

/** The `hooks` block that runs the helper's hook mode for each of `kinds`
 *  (session-hooks-writer.ts buildHelperHooksBlock gives it MVP_EVENTS); null
 *  when the command cannot be given safely (helperHookCommand). */
export function helperHooksBlockFor(target: HelperHookTarget, kinds: readonly string[]): Record<string, unknown[]> | null {
  const command = helperHookCommand(target)
  if (command === null) return null
  const hooks: Record<string, unknown[]> = {}
  for (const kind of kinds) {
    hooks[kind] = [{ matcher: '', hooks: [{ type: 'command', command, timeout: HELPER_HOOK_TIMEOUT_SECS }] }]
  }
  return hooks
}

/** Concatenate per-event hook arrays across maps (source order preserved),
 *  then drop byte-identical duplicate entries within each event — a guard so
 *  a hook can never double-fire if Claude's own resolution ever also merges.
 *  The Claude package's session file for a tab through the session helper on
 *  another machine merges the host's hooks with it too (providers/claude/
 *  remote-launch.ts). */
export function concatHookMaps(...maps: Record<string, unknown[]>[]): Record<string, unknown[]> {
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
