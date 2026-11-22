import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { removeHooks } from './session-hooks-writer'
import { heldAgentSessionId } from '../session-helper/protocol'
import { getResourcesDirectory } from '../ipc/setup-handlers'
import { logInfo } from '../debug-logger'

// Non-greedy before `.json` so `settings-foo.json.bak` does not match.
const SID_FROM_FILENAME = /^settings-([^.]+)\.json$/

/** The app's own session id: 12 random bytes as lowercase hex (src/shared/id.ts). */
const APP_SESSION_ID = /^[0-9a-f]{24}$/

/** The session helper's hook mode as helperHookCommand (session-hooks-writer.ts)
 *  gives it: the helper copy and its store, each one quoted word, then the id
 *  of the session's holder. */
const HELPER_HOOK_COMMAND = /^'.+' hook --store '.+' --session ([A-Za-z0-9_-]+)$/

/** The bridge script a local launch's status line runs, in the resources
 *  folder's scripts folder (buildStatuslineSetting, statusline-command.ts). */
const STATUS_LINE_BRIDGE = 'claude-multi-statusline.js'

/** Whether `statusLine` runs this install's status line bridge for session
 *  `sid`, as writeLocalSessionSettings writes it: `node "<bridge>" <sid>`, with
 *  or without one quoted word after it (the session's status-URL file, or the
 *  address an older build put there). */
function runsThisInstallsBridge(statusLine: unknown, sid: string, resourcesDir: string): boolean {
  if (!resourcesDir || !statusLine || typeof statusLine !== 'object') return false
  const { type, command } = statusLine as { type?: unknown; command?: unknown }
  if (type !== 'command' || typeof command !== 'string') return false
  const win32 = os.platform() === 'win32'
  const bridge = (win32 ? path.win32 : path.posix).join(resourcesDir, 'scripts', STATUS_LINE_BRIDGE)
  const head = `node "${win32 ? bridge.replace(/\\/g, '\\\\') : bridge}" ${sid}`
  if (!command.startsWith(head)) return false
  const tail = command.slice(head.length)
  return tail === '' || /^ "[^"]+"$/.test(tail)
}

/** Whether one of the hooks in `hooks` runs the session helper's hook mode
 *  for the holder of Claude Code session `sid` (a held session: its file may
 *  have no status line of the app's). */
function runsHelperHookModeFor(hooks: unknown, sid: string): boolean {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
  const holder = heldAgentSessionId(sid, 'claude')
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown } | null)?.hooks
      if (!Array.isArray(inner)) continue
      for (const hook of inner) {
        const { type, command } = (hook ?? {}) as { type?: unknown; command?: unknown }
        if (type !== 'command' || typeof command !== 'string') continue
        if (HELPER_HOOK_COMMAND.exec(command)?.[1] === holder) return true
      }
    }
  }
  return false
}

/**
 * Whether a local launch of this install wrote `parsed` as session `sid`'s
 * settings file: `sid` has the app's id shape, and the file runs this
 * install's status line bridge for that id, or the helper's hook mode for
 * its holder. A file that only names a /hook/ address is not taken for one:
 * an older leftover, or a file an SSH session from another computer wrote
 * here (ssh-shim.ts writes that same name and that same hook shape).
 */
function writtenByLocalLaunch(sid: string, parsed: unknown, resourcesDir: () => string): boolean {
  if (!APP_SESSION_ID.test(sid) || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const p = parsed as Record<string, unknown>
  return runsHelperHookModeFor(p.hooks, sid) || (p.statusLine !== undefined && runsThisInstallsBridge(p.statusLine, sid, resourcesDir()))
}

/** The resources folder, read once and only when a file needs it ('' when it
 *  cannot be read: then no status line is taken for this install's). */
function resourcesDirOnce(): () => string {
  let dir: string | undefined
  return () => {
    if (dir === undefined) {
      try { dir = getResourcesDirectory() || '' } catch { dir = '' }
    }
    return dir
  }
}

/** Remove `full` when a local launch of this install wrote it for `sid`;
 *  whether it was removed. */
function removeIfWrittenByLocalLaunch(full: string, sid: string, parsed: unknown, resourcesDir: () => string): boolean {
  if (!writtenByLocalLaunch(sid, parsed, resourcesDir)) return false
  try {
    fs.unlinkSync(full)
    return true
  } catch {
    return false /* already gone, or cannot be removed: left as it is */
  }
}

/**
 * Scan ~/.claude/settings-*.json at start-up for files of sessions not in the
 * active set. A file a local launch of this install wrote for its session
 * (writtenByLocalLaunch) is removed: that session is over, and its file is
 * passed to nothing again (aicc_planning#385). Any other file keeps its place;
 * when its hooks name a /hook/ address its whole `hooks` block is taken out
 * (removeHooks), so a crashed previous run can't leave stale hook entries
 * pointing at our (possibly new) port. Called at gateway startup.
 *
 * Returns the number of files removed or cleaned.
 */
export function cleanupStaleHookEntries(activeSessionIds: ReadonlySet<string>): number {
  const dir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir)
  const resourcesDir = resourcesDirOnce()
  let removed = 0
  let cleaned = 0
  for (const name of files) {
    const m = SID_FROM_FILENAME.exec(name)
    if (!m) continue
    const sid = m[1]
    if (activeSessionIds.has(sid)) continue
    const full = path.join(dir, name)
    try {
      const raw = fs.readFileSync(full, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (removeIfWrittenByLocalLaunch(full, sid, parsed, resourcesDir)) {
        removed++
        continue
      }
      if (!parsed.hooks) continue
      const s = JSON.stringify(parsed.hooks)
      if (!s.includes('/hook/')) continue
      removeHooks({ settingsPath: full })
      cleaned++
    } catch {
      /* skip unreadable / malformed */
    }
  }
  if (removed + cleaned > 0) {
    logInfo(`[hooks] At start-up: removed ${removed} settings file(s) an earlier run of the app left for its sessions, and took the app's hooks out of ${cleaned} other file(s), which stay`)
  }
  return removed + cleaned
}

// Non-greedy before the extension so `mcp-foo.json.bak` does not match.
//
// Both token-bearing per-session sidecars are swept by one pass: the MCP config
// (`?token=` in its server URL) and the status-URL file (ADR-009 token custody
// — the same secret, moved off the statusLine command line and into a 0600
// file). A crash that leaves one behind leaves the other behind for the same
// reason, and neither should outlive its session.
const MCP_SID_FROM_FILENAME = /^mcp-([^.]+)\.json$/
const STATUS_URL_SID_FROM_FILENAME = /^ccc-status-([^.]+)\.url$/

/**
 * Sweep leaked per-session ~/.claude/mcp-<sid>.json and ccc-status-<sid>.url
 * sidecars. These are removed on normal session dispose
 * (removeLocalSessionMcpConfig / removeLocalSessionStatusUrl) but a crash leaves
 * them behind. Deletes any whose sid is not in the active set. The same pass
 * removes a settings-<sid>.json a local launch of this install wrote for a
 * session not in the active set (as cleanupStaleHookEntries does), since this
 * pass also runs with the hooks switched off. Returns the count.
 */
export function cleanupStaleMcpConfigs(activeSessionIds: ReadonlySet<string>): number {
  const dir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir)
  const resourcesDir = resourcesDirOnce()
  let cleaned = 0
  let settingsRemoved = 0
  for (const name of files) {
    const settings = SID_FROM_FILENAME.exec(name)
    if (settings) {
      if (activeSessionIds.has(settings[1])) continue
      const full = path.join(dir, name)
      try {
        if (removeIfWrittenByLocalLaunch(full, settings[1], JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown, resourcesDir)) settingsRemoved++
      } catch {
        /* skip unreadable / malformed */
      }
      continue
    }
    const m = MCP_SID_FROM_FILENAME.exec(name) ?? STATUS_URL_SID_FROM_FILENAME.exec(name)
    if (!m) continue
    if (activeSessionIds.has(m[1])) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      cleaned++
    } catch {
      /* skip unreadable / already-gone */
    }
  }
  if (settingsRemoved > 0) {
    logInfo(`[hooks] At start-up: removed ${settingsRemoved} settings file(s) an earlier run of the app left for its sessions`)
  }
  return cleaned + settingsRemoved
}
