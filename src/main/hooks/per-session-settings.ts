import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getConductorMcpPort, issueMcpSessionToken } from '../conductor-mcp-server'
import { getProvider } from '../providers'
import type { HeldToolRelay } from '../providers/types'
import { atomicWriteSecure, mkdirSecure, hardenCredentialDir } from '../account-profiles'
import { logWarn } from '../debug-logger'
import { SID_RE } from '../session-helper/protocol'

/**
 * Path to the local-session settings file. Mirrors the SSH remote layout
 * (~/.claude/settings-<sid>.json) so boot-cleanup can purge stale entries
 * from one place regardless of session type.
 */
export function getLocalSessionSettingsPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `settings-${safeSid}.json`)
}

/**
 * Path to the local-session MCP config file. Distinct from the settings
 * file because claude.exe reads MCP server config from `--mcp-config` only,
 * NOT from `--settings`.
 */
export function getLocalSessionMcpConfigPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `mcp-${safeSid}.json`)
}

/**
 * Path to the per-session status-URL file (ADR-009 token custody).
 *
 * The /status delivery URL carries `?token=<per-session HMAC>` — the same secret
 * that gates the loopback MCP server and therefore `vision_eval`. It used to be
 * baked straight into the `statusLine` command, i.e. into the argv of a process
 * Claude Code respawns every second or two, which published it to every other
 * account on this machine through the process table. It now lives here, written
 * 0600 through the same atomic secure writer as `mcp-<sid>.json`, and only the
 * PATH reaches the command line. Same `~/.claude/` layout as the remote sidecars
 * so boot-cleanup can sweep both from one place.
 */
export function getLocalSessionStatusUrlPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `ccc-status-${safeSid}.url`)
}

/**
 * Seed a local-session settings file as a full clone of the user's
 * ~/.claude/settings.json. Used for hooks/statusLine overrides only --
 * NOT for mcpServers (claude.exe ignores mcpServers in --settings files).
 *
 * Claude Code's `--settings` flag may either REPLACE user settings entirely
 * or MERGE onto them; both assumptions live in the codebase comments and
 * the docs are ambiguous. Copying every top-level key (not just the keys
 * CCC cares about) is safe under both semantics.
 */
export interface WriteSessionSettingsOptions {
  /** v1.5.12: when true, force `disableWorkflows: true` into the per-session
   *  settings so Claude Code's dynamic-workflow feature is disabled at boot.
   *  Caller (pty-manager) reads the CCC AppSettings.disableClaudeWorkflows
   *  flag and passes it through. */
  disableWorkflows?: boolean
  /** U2: when provided, inject the CCC statusLine command per-session (pointing
   *  at `<resourcesDir>/scripts/claude-multi-statusline.js`) instead of writing
   *  it into the user's global ~/.claude/settings.json. Overrides any statusLine
   *  inherited from the shared-settings clone. When the command cannot be set
   *  up (a path the shell would read as more than a path, or a deployed
   *  script a launch may not run, which the provider says in the log), the
   *  app's status line is not set up and the clone's own statusLine stays,
   *  exactly as when no resourcesDir is given (the app's status line switched
   *  off). */
  resourcesDir?: string
  /** 2026-08-14 (SEC-BATCH FLAG): union CCC's own Agent Canvas tools into
   *  permissions.allow so the render->review loop doesn't stall in approval
   *  prompts. Additive only — the user's deny/ask lists are never touched and
   *  a deny still wins under Claude's permission semantics. */
  allowCanvasTools?: boolean
}

/**
 * Canvas tools that may skip the approval prompt.
 *
 * ONLY the two READS, and only because they read CCC's own state: the snapshot
 * of a page this app rendered, and the notes the user wrote in this app's own
 * UI. Neither takes a path or any other argument that widens what it can touch.
 *
 * `canvas_render` is deliberately NOT here. It accepts `htmlPath`, an absolute
 * path the MODEL supplies, read with the app's privileges. Pre-allowing it
 * removed the last human gate on that read — adversarial review (2026-08-14)
 * drove it to a private key with no prompt and nothing on screen. The read is
 * now confined to the session's project directory (resolveInsideCanvasRoot),
 * but confinement and prompt-suppression should not land in the same change:
 * the prompt costs one keypress per render and it is the thing that would have
 * caught that. The UX problem it was added for — a 37 KB document flooding the
 * approval prompt — is already fixed by `htmlPath` being one line.
 */
const CANVAS_TOOL_PERMISSIONS = ['mcp__conductor__canvas_snapshot', 'mcp__conductor__canvas_review']

/**
 * The sessions whose latest launch got no status line from the app: the
 * Status line switch was off (no resourcesDir), the command could not be set
 * up, the deployed script failed its launch check, or the settings file was
 * not written. Such a session reports no usage figure, so the Usage page
 * fetches its account as it does an account no session uses (account-usage.ts,
 * setLiveUsageSessionReports; aicc_planning#378). Set at each launch's settings
 * write, or read back when a tab takes over a session an update kept running
 * (noteKeptLaunchStatusLine), and cleared when the session's settings are
 * removed at its end.
 */
const launchedWithoutAppStatusLine = new Set<string>()

/** Whether the session's latest launch got no status line from the app. False
 *  for a session neither launched nor taken over in this run. */
export function sessionLaunchedWithoutAppStatusLine(sessionId: string): boolean {
  return launchedWithoutAppStatusLine.has(sessionId)
}

/**
 * 2.1.3-beta.17 (S16 step 5, aicc_planning#412): a session an app update kept
 * running, taken over by its restored tab with no launch, so this run wrote no
 * settings file for it: whether its launch got the app's status line is read
 * back from the settings file that launch wrote and the update kept. The
 * app's statusLine runs the app's script with this session's id
 * (statusline-command.ts); a statusLine of the user's own, none, or a file that
 * does not read counts as without it.
 */
export function noteKeptLaunchStatusLine(sessionId: string): void {
  let app = false
  try {
    const v = JSON.parse(fs.readFileSync(getLocalSessionSettingsPath(sessionId), 'utf-8')) as { statusLine?: { command?: unknown } } | null
    const command = v && typeof v === 'object' ? v.statusLine?.command : undefined
    app = typeof command === 'string' && command.includes('claude-multi-statusline.js') && command.includes(` ${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
  } catch {
    app = false
  }
  if (app) launchedWithoutAppStatusLine.delete(sessionId)
  else launchedWithoutAppStatusLine.add(sessionId)
}

export function writeLocalSessionSettings(sessionId: string, opts: WriteSessionSettingsOptions = {}): string {
  // Without the app's status line until this launch's file is written with it
  // (below), so a throw on the way leaves the session counted as reporting nothing.
  launchedWithoutAppStatusLine.add(sessionId)
  let appStatusLine = false
  const claudeDir = path.join(os.homedir(), '.claude')
  // ~/.claude is created securely inside writeJsonSecurely (mkdirSecure + 0700) at
  // write time -- no plain mkdir here, which would silently accept a pre-planted
  // junction. The settings.json read below fails closed if the dir is absent.

  let shared: Record<string, unknown> = {}
  try {
    const sharedPath = path.join(claudeDir, 'settings.json')
    const raw = fs.readFileSync(sharedPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      shared = parsed as Record<string, unknown>
    }
  } catch {
    /* shared settings may not exist yet (fresh install) -- start empty */
  }

  // Clone every top-level key from shared so injectHooks can overlay the
  // `hooks` key without dropping the user's outputStyle, permissions, etc.
  const sesCfg: Record<string, unknown> = { ...shared }

  // v1.5.12: opt-in disable of CC's dynamic workflows feature. Overrides any
  // existing value in the shared settings.json -- the CCC toggle is the
  // authoritative source for newly spawned sessions. Set to undefined would
  // leave the shared value alone, which is what we want for the off path.
  if (opts.disableWorkflows) {
    sesCfg.disableWorkflows = true
  }

  // U2: deliver the statusLine PER-SESSION rather than via a global
  // ~/.claude/settings.json write. Overrides any statusLine inherited from the
  // shared clone so external `claude` runs outside CCC keep their native line.
  //
  // Local unification (harmonise-remote): deliver over the SAME channel as the
  // SSH shims — a loopback POST to the conductor MCP server, per-session HMAC in
  // the query. No tunnel locally, so the only gate is the server having bound
  // (port > 0); statusPostUrl returns '' otherwise and the bridge falls back to
  // the watched status file. try/catch because the charset guard in
  // statusPostUrl throws rather than emitting a malformed URL — a failure here
  // must degrade delivery, never break the spawn path.
  //
  // ADR-009 token custody: the URL goes into a 0600 file and only the file's
  // PATH is baked into the statusLine command (argv[3]). See
  // getLocalSessionStatusUrlPath. A write failure leaves `urlFile` empty, so the
  // command carries no argv[3] at all and the bridge degrades to the status-file
  // delivery — never a fallback that would put the URL back on the command line.
  if (opts.resourcesDir) {
    // The Claude package's statusline helpers, through the registered
    // provider (WP2 PR 4: no deep import into the package).
    const claude = getProvider('claude')
    let statusUrl = ''
    try {
      statusUrl = claude.statusPostUrl?.(sessionId, undefined, getConductorMcpPort(), true) ?? ''
    } catch {
      statusUrl = ''
    }
    let urlFile = ''
    if (statusUrl) {
      urlFile = writeLocalSessionStatusUrl(sessionId, statusUrl)
    } else {
      removeLocalSessionStatusUrl(sessionId)
    }
    const statusLine = claude.statuslineSetting?.(opts.resourcesDir, sessionId, urlFile || undefined)
    if (statusLine) {
      sesCfg.statusLine = statusLine
      appStatusLine = true
    } else if (statusLine === null) {
      // The command would carry a folder path the shell reads as more than a
      // path: the app's status line is not set up (statusline-command.ts).
      // The user's own statusLine from the shared clone stays, as it does
      // with the app's status line switched off.
      logWarn(`[per-session-settings] session ${sessionId}: the app's status line is not set up: the resources folder's or the home folder's path holds a character a shell reads as more than a path ($, a backtick, a double quote or a control character; on Windows % or !; elsewhere a backslash). A status line of your own, if you set one, stays.`)
    }
  }

  // Union the canvas tools into permissions.allow, preserving everything the
  // user already has there. Shape-defensive: a malformed permissions value in
  // the shared file is left exactly as it was (never "repaired" into shape).
  if (opts.allowCanvasTools) {
    const permissions = sesCfg.permissions
    if (permissions === undefined) {
      sesCfg.permissions = { allow: [...CANVAS_TOOL_PERMISSIONS] }
    } else if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
      const perm = { ...(permissions as Record<string, unknown>) }
      const allow = Array.isArray(perm.allow) ? perm.allow : perm.allow === undefined ? [] : null
      if (allow !== null) {
        const merged = [...allow]
        for (const tool of CANVAS_TOOL_PERMISSIONS) if (!merged.includes(tool)) merged.push(tool)
        perm.allow = merged
        sesCfg.permissions = perm
      }
    }
  }

  const sesPath = getLocalSessionSettingsPath(sessionId)
  // The launch reports usage only when the app's status line is set AND the
  // file that carries it was written: a failed write launches without
  // --settings (pty-manager), so without the status line.
  if (writeJsonSecurely(sesPath, sesCfg) && appStatusLine) launchedWithoutAppStatusLine.delete(sessionId)
  return sesPath
}

/**
 * Write a per-session MCP config file containing the conductor entry
 * pointed at THIS CCC instance's MCP server port. Passed to claude.exe via
 * `--mcp-config <path>` so it overrides the global ~/.claude.json entry
 * (which may be stale due to dev/prod CCC instance race).
 *
 * Schema mirrors `claude mcp add --transport sse` output:
 *   { mcpServers: { 'conductor': { type: 'sse', url: '...' } } }
 *
 * P7.7.10: bake `cccSessionId=<sid>` into the URL query string so the
 * server can resolve the CCC session from the MCP transport itself
 * (rather than trusting an LLM-supplied tool arg, which Claude has been
 * observed to cache stale from prior conversations). Global
 * ~/.claude.json entries do NOT include the query (so external `claude`
 * invocations outside CCC fail closed -- codex_review returns a clean
 * "no session bound" error rather than dispatching against a stranger's
 * session id).
 *
 * Returns the path even if mcpPort is 0 (MCP server not yet bound) so the
 * caller can still pass --mcp-config; the file simply has an empty
 * mcpServers object in that case.
 */
export function writeLocalSessionMcpConfig(sessionId: string, includeConductor = true): string {
  const mcpPort = getConductorMcpPort()
  const mcpServers: Record<string, unknown> = {}
  // includeConductor=false (conductorToolsEnabled master off) writes an empty
  // mcpServers object -- same shape as the port-0 fallback -- so the session
  // launches with no built-in tools instead of a dangling endpoint.
  if (mcpPort > 0 && includeConductor) {
    const encodedSid = encodeURIComponent(sessionId)
    // &token=<per-session HMAC> authenticates this session against the gated MCP
    // server (GHSA-q83v-phcc-hgv4): the token is HMAC(secret, sessionId), so it
    // authorises THIS session and no other, and the install secret is never
    // written here. The SSE transport preserves the query on its /messages
    // endpoint, so follow-up POSTs carry it too.
    mcpServers['conductor'] = {
      type: 'sse',
      url: `http://localhost:${mcpPort}/sse?cccSessionId=${encodedSid}&token=${issueMcpSessionToken(sessionId, 'claude')}`,
    }
  }
  const cfg = { mcpServers }
  const cfgPath = getLocalSessionMcpConfigPath(sessionId)
  return atomicJsonWrite(cfgPath, cfg)
}

/** What switchMcpConfigToHelper did (2.1.3-beta.11, plan section B2). */
export type HelperMcpConfigResult =
  /** The file's `conductor` entry now starts the helper's relay. */
  | 'switched'
  /** The file holds no `conductor` entry in the loopback form
   *  writeLocalSessionMcpConfig writes for this session (the built-in tools
   *  are off, the server was not started at the spawn, or the file was not
   *  written): nothing to switch. */
  | 'no-conductor'
  /** A path the relay needs cannot be written into the file exactly. */
  | 'unsafe-path'
  /** The file could not be written; it was left as it was. */
  | 'not-written'

/** Whether `entry` is the `conductor` entry writeLocalSessionMcpConfig writes
 *  for `sessionId`: its two fields alone, the SSE type, and a loopback URL
 *  naming this session and carrying a token. */
function isLoopbackConductorEntry(entry: unknown, sessionId: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const e = entry as Record<string, unknown>
  const keys = Object.keys(e)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('url') || e.type !== 'sse' || typeof e.url !== 'string') return false
  const head = 'http://localhost:'
  let mid: string
  try { mid = `/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=` } catch { return false }
  if (!e.url.startsWith(head)) return false
  const at = e.url.indexOf(mid, head.length)
  if (at < 0) return false
  const token = e.url.slice(at + mid.length)
  return /^[0-9]{1,5}$/.test(e.url.slice(head.length, at)) && token.length > 0 && !/[&\s]/.test(token)
}

/** A control character anywhere (C0, DEL, C1). */
const RELAY_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
/** Half of a surrogate pair on its own: not Unicode, so no program reads it back as written. */
const RELAY_LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Whether `p` can be the helper's path or its store's in a session's MCP
 *  config exactly: absolute (on Windows from a drive's root, never a network
 *  or device path), with no control character and no lone surrogate. */
function relayPathWritable(p: unknown, win32: boolean): p is string {
  if (typeof p !== 'string' || p.length === 0 || RELAY_CONTROL_RE.test(p) || RELAY_LONE_SURROGATE_RE.test(p)) return false
  return win32 ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/')
}

/** The `conductor` entry that starts the helper's relay mode as the
 *  session's tool server. The name stays, so the tools a session is allowed
 *  (CANVAS_TOOL_PERMISSIONS above) apply unchanged. */
function relayConductorEntry(relay: HeldToolRelay): Record<string, unknown> {
  return { type: 'stdio', command: relay.helperPath, args: ['mcp', '--store', relay.store, '--session', relay.sid] }
}

/**
 * Point a Claude Code session's per-session MCP config at the session
 * helper's relay, in place (2.1.3-beta.11, plan section B2). The file was
 * written for the loopback server by writeLocalSessionMcpConfig in the same
 * synchronous run as the spawn call (pty-manager.ts: spawnAgentPty, then
 * writeLocalSessionMcpConfig), so always before the holder answers
 * term.launched. Once the session's holder has launched it and before the
 * launch line reaches it (Claude Code reads the file when it starts), this
 * replaces the `conductor` entry's loopback address and credential with the
 * relay (`<helper> mcp --store <store> --session <sid>`); every other key and
 * entry stays as it was. Only a file that holds the app's own loopback entry
 * for this session is switched (the tools are on). Written through the same
 * owner-only writer. FAIL-SAFE: on anything but 'switched' the file is as it
 * was, and the session keeps its loopback route. The paths go into this
 * session's own file and nowhere else.
 */
export function switchMcpConfigToHelper(a: { configPath: string; sessionId: string; relay: HeldToolRelay; platform?: NodeJS.Platform }): HelperMcpConfigResult {
  const cfgPath = a.configPath
  let cfg: unknown
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  } catch {
    return 'no-conductor'
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'no-conductor'
  const servers = (cfg as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'no-conductor'
  if (!Object.prototype.hasOwnProperty.call(servers, 'conductor') || !isLoopbackConductorEntry((servers as Record<string, unknown>).conductor, a.sessionId)) return 'no-conductor'
  const win32 = (a.platform ?? process.platform) === 'win32'
  if (!relayPathWritable(a.relay.helperPath, win32) || !relayPathWritable(a.relay.store, win32) || !SID_RE.test(a.relay.sid)) return 'unsafe-path'
  // Each key keeps its place: an existing key set again in a literal stays
  // where it was, so only the `conductor` entry's own text changes.
  const next = { ...(cfg as Record<string, unknown>), mcpServers: { ...(servers as Record<string, unknown>), conductor: relayConductorEntry(a.relay) } }
  return writeJsonSecurely(cfgPath, next) ? 'switched' : 'not-written'
}

/**
 * Write the per-session status-URL file, 0600, through the same
 * mkdirSecure + hardenCredentialDir + atomic-rename writer the token-bearing
 * `mcp-<sid>.json` uses. Returns the path, or '' when the write failed — the
 * caller then omits argv[3] entirely rather than falling back to putting the URL
 * on the command line.
 *
 * Unlink-first so the rename lands on a fresh inode rather than through a
 * pre-existing symlink at the target (atomicWriteSecure stages and renames, but
 * a stale entry here is ours to clear either way).
 */
export function writeLocalSessionStatusUrl(sessionId: string, statusUrl: string): string {
  const filePath = getLocalSessionStatusUrlPath(sessionId)
  try {
    mkdirSecure(path.dirname(filePath))
    hardenCredentialDir(path.dirname(filePath))
    try { fs.unlinkSync(filePath) } catch { /* absent is the normal case */ }
    atomicWriteSecure(filePath, statusUrl, 0o600)
    return filePath
  } catch (err) {
    logWarn(`[per-session] secure write of ${path.basename(filePath)} failed (${String(err)}); statusline will use file delivery`)
    return ''
  }
}

export function removeLocalSessionStatusUrl(sessionId: string): void {
  try {
    fs.unlinkSync(getLocalSessionStatusUrlPath(sessionId))
  } catch {
    /* file may already be gone or never written */
  }
}

export function removeLocalSessionSettings(sessionId: string): void {
  // The session has ended (or its spawn failed): forget how it was launched.
  launchedWithoutAppStatusLine.delete(sessionId)
  try {
    fs.unlinkSync(getLocalSessionSettingsPath(sessionId))
  } catch {
    /* file may already be gone or never written */
  }
}

export function removeLocalSessionMcpConfig(sessionId: string): void {
  try {
    fs.unlinkSync(getLocalSessionMcpConfigPath(sessionId))
  } catch {
    /* file may already be gone or never written */
  }
}

/**
 * Write a per-session file under ~/.claude atomically and owner-only.
 *
 * mcp-<sid>.json carries the Conductor MCP bearer token (`?token=<secret>`) --
 * the sole gate on the loopback MCP server, and thus on `vision_eval` (arbitrary
 * JS in the embedded browser). Written with no file mode it landed 0644 on
 * POSIX: any other local user could read the token and drive the server. So
 * create ~/.claude through mkdirSecure (refuse a pre-planted reparse point) +
 * hardenCredentialDir (0700), stage-and-rename via atomicWriteSecure with an
 * explicit 0600, and do NOT fall back to a plain writeFileSync -- the old
 * fallback followed a planted symlink at the target and dropped the mode. Fail
 * closed: leave the previous file, log, and never throw (this runs on the spawn
 * path).
 */
function atomicJsonWrite(filePath: string, data: unknown): string {
  writeJsonSecurely(filePath, data)
  return filePath
}

/** atomicJsonWrite's write, answering whether it wrote. */
function writeJsonSecurely(filePath: string, data: unknown): boolean {
  const dir = path.dirname(filePath)
  try {
    mkdirSecure(dir)
    hardenCredentialDir(dir)
    atomicWriteSecure(filePath, JSON.stringify(data, null, 2), 0o600)
    return true
  } catch (err) {
    logWarn(`[per-session] secure write of ${path.basename(filePath)} failed (${String(err)}); left the previous file`)
    return false
  }
}
