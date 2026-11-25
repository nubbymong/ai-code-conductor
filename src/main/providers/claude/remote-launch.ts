// Claude Code's launch of a session on another machine through the session
// helper there (2.1.3-beta.18 section 2, aicc_planning#430). Moved here from
// core unchanged: the arguments from remote-helper/index.ts's remoteCliArgs,
// the CLI's variables from its remoteCliEnv, and the program from
// remote-helper/session.ts's remoteLaunchSpec. Core keeps the login shell's
// wrapper, the host account's variables, LANG, TERM and COLORFGBG.
//
// 2.1.3-beta.18 section 3.2 (aicc_planning#431): the session's own files on
// the host. settings.json gives the status line (the helper's status mode)
// and the hooks: the host's own first (its user settings, then the session
// folder's project and local settings, then the checkout root's local
// settings, the files Claude Code itself reads, which core reads on the host
// first: hostReads), then the helper's hook mode for the nine events the app
// takes, identical entries dropped, because a --settings `hooks` key replaces
// the hooks Claude Code would otherwise apply. mcp.json gives the `conductor`
// tool server as the helper's relay, when the app serves its tools. The CLI
// is pointed at both (--settings, --mcp-config), first on its line as the
// usual SSH launch puts them. They name the helper's path, its store and the
// session id on the host: never an address, a port, a token or a path of this
// computer. The status and hook keep-lists say what of a status and of a hook
// event the app keeps.
// Pure, with no import that reaches Electron: core asks this launch under
// plain Node too (tests/live/remote-helper-device.live.ts).
import { concatHookMaps, helperHooksBlockFor, helperStatusCommand } from '../../hooks/helper-hook-commands'
import { HELPER_HOOK_KINDS } from '../../session-helper/protocol'
import type { ProviderRemoteLaunch, RemoteHelperCommands, RemoteHostFile, RemoteHostRead, RemoteLaunch, RemoteLaunchMachine, RemoteLaunchOptions, RemoteStatusLine } from '../types'

/** Where the CLI is started when the machine's check found none. */
const REMOTE_CLI_FALLBACK = '/usr/local/bin/claude'

/** The session's two files, by name, in its own folder on the host. */
export const REMOTE_SETTINGS_FILE = 'settings.json'
export const REMOTE_MCP_FILE = 'mcp.json'

/** The CLI's arguments: the config's effort, model, permission mode and extra
 *  arguments, as the usual SSH launch line gives them, and --continue on a
 *  reconnect. Values are arguments (no shell parses them on the way). */
export function claudeRemoteArgs(o: RemoteLaunchOptions): string[] {
  const args: string[] = []
  if (o.effortLevel) args.push('--effort', o.effortLevel)
  if (o.model) args.push('--model', o.model)
  if (o.permissionMode && o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode)
  if (o.reconnect) args.push('--continue')
  const extra = o.extraArgs?.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}

/** The CLI's own switches the config and the app's settings set, as the usual
 *  SSH launch sets them. */
export function claudeRemoteEnv(o: RemoteLaunchOptions): Record<string, string> {
  const env: Record<string, string> = {}
  const settings = o.settings
  if (o.disableAutoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  if (settings?.classicTerminalCopyPaste !== false) {
    env.CLAUDE_CODE_DISABLE_MOUSE = '1'
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  }
  if (settings?.clickableQuestions !== true) env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
  if (settings?.disableBackgroundTasks !== false) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  return env
}

/** The settings files Claude Code reads for a session, whose hooks the
 *  session's settings file carries first: the user's, then the session
 *  folder's project and local settings, then the checkout root's local
 *  settings (hooks/session-hooks-writer.ts resolveInheritedHooks reads the same
 *  four on this computer; the usual SSH setup reads them on the host). */
export const CLAUDE_HOST_READS: readonly RemoteHostRead[] = [
  { from: 'home', path: '.claude/settings.json' },
  { from: 'cwd', path: '.claude/settings.json' },
  { from: 'cwd', path: '.claude/settings.local.json' },
  { from: 'checkout', path: '.claude/settings.local.json' },
]

/** The `hooks` of one settings file's text, keeping only array-valued events;
 *  nothing for a file not read, not JSON, or of another shape. Data only:
 *  nothing in it is run here. */
export function hooksOfSettingsText(text: string | null): Record<string, unknown[]> {
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const hooks = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).hooks : undefined
  const out: Record<string, unknown[]> = {}
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
      if (Array.isArray(arr)) out[event] = arr.slice()
    }
  }
  return out
}

/** The session's settings file: the status line is the helper's status mode,
 *  and the hooks are the host's own (in `reads`' order), then the helper's
 *  hook mode for the nine events, identical entries dropped. Throws when the
 *  helper's path or store cannot be put in a command safely: the tab then
 *  takes the usual SSH path. */
export function claudeRemoteSettings(helper: RemoteHelperCommands, reads: readonly RemoteHostFile[]): Record<string, unknown> {
  const target = { helperPath: helper.helperPath, store: helper.store, sid: helper.sid, launcher: 'sh' as const }
  const statusCommand = helperStatusCommand(target)
  // The nine events the app takes, as buildHelperHooksBlock gives a held session on this computer.
  const own = helperHooksBlockFor(target, HELPER_HOOK_KINDS)
  if (statusCommand === null || own === null) throw new Error('the session helper\'s path on the host cannot be put in a status line or hook command safely')
  const hooks = concatHookMaps(...reads.map((r) => hooksOfSettingsText(r.content)), own)
  return { statusLine: { type: 'command', command: statusCommand }, hooks }
}

/** The session's tool config: the `conductor` server is the helper's relay
 *  (the same entry hooks/per-session-settings.ts relayConductorEntry gives a
 *  held session on this computer), so the tools' name and the tools a
 *  session is allowed are unchanged. */
export function claudeRemoteMcp(helper: RemoteHelperCommands): Record<string, unknown> {
  return { mcpServers: { conductor: { type: 'stdio', command: helper.helperPath, args: ['mcp', '--store', helper.store, '--session', helper.sid] } } }
}

/**
 * What of a status the app keeps (docs/remote/helper-protocol.md, payload
 * allow-lists, version 1, Claude Code): the model's id and name; the context
 * used, its size and percentage; the cost and duration totals and the lines
 * changed; the CLI's version; the remote CLI session id; the remote paths
 * (display text only); and, beside them, the five-hour and seven-day usage
 * figures and their resets. Everything else is dropped first.
 */
export const CLAUDE_STATUS_KEEP: readonly string[] = [
  'model.id', 'model.display_name',
  'context_window.used_percentage', 'context_window.remaining_percentage', 'context_window.context_window_size',
  'context_window.current_usage.input_tokens', 'context_window.current_usage.output_tokens',
  'context_window.current_usage.cache_creation_input_tokens', 'context_window.current_usage.cache_read_input_tokens',
  'cost.total_cost_usd', 'cost.total_duration_ms', 'cost.total_lines_added', 'cost.total_lines_removed',
  'version', 'session_id', 'cwd', 'transcript_path', 'workspace.current_dir', 'workspace.project_dir',
  'rate_limits.five_hour.used_percentage', 'rate_limits.five_hour.resets_at',
  'rate_limits.seven_day.used_percentage', 'rate_limits.seven_day.resets_at',
]

/**
 * What of a hook event the app keeps (the same section): the hook's name,
 * the remote CLI session id, the notification's text and kind, the tool's
 * name; the transcript path and agent id as display text, which the canvas
 * marker queue and the background-context rule compare; the effort level the
 * status strip shows; a StopFailure's error words, which the Watchdog reads;
 * a SessionStart's source. Prompts, tool inputs and results are dropped.
 */
export const CLAUDE_HOOK_KEEP: readonly string[] = [
  'hook_event_name', 'session_id', 'message', 'notification_type', 'tool_name',
  'transcript_path', 'agent_id', 'effort.level', 'error', 'reason', 'error_type', 'source',
]

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** A reset time as the status line shims give it: epoch seconds made ISO, a string as it is. */
const resetsAt = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : typeof v === 'string' ? v : '')

/**
 * The tab's status line from one status, already cut to CLAUDE_STATUS_KEEP:
 * the fields the usual SSH status line shim builds (providers/claude/
 * ssh-shim.ts), with the model's id beside its name as the local bridge
 * gives it. No transcript path and no usage buckets: a remote path is display
 * text, never the transcript binder's, and the account label, the per-model
 * weekly buckets and extra usage are not fetched for such a tab (the helper
 * reads no credential and calls no network). Null when the status holds
 * nothing to show.
 */
export function claudeRemoteStatusLine(payload: Readonly<Record<string, unknown>>): RemoteStatusLine | null {
  const m = obj(payload.model)
  const cw = obj(payload.context_window)
  const u = obj(cw.current_usage)
  const cost = obj(payload.cost)
  const rl = obj(payload.rate_limits)
  const input = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0)
  const s: RemoteStatusLine = {
    model: str(m.display_name) ?? str(m.id),
    modelId: str(m.id),
    contextUsedPercent: num(cw.used_percentage),
    contextRemainingPercent: num(cw.remaining_percentage),
    contextWindowSize: num(cw.context_window_size),
    inputTokens: input || undefined,
    outputTokens: num(u.output_tokens),
    costUsd: num(cost.total_cost_usd),
    totalDurationMs: num(cost.total_duration_ms),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
  }
  const five = num(obj(rl.five_hour).used_percentage)
  if (five !== undefined) {
    s.rateLimitCurrent = Math.round(five)
    s.rateLimitCurrentResets = resetsAt(obj(rl.five_hour).resets_at)
  }
  const seven = num(obj(rl.seven_day).used_percentage)
  if (seven !== undefined) {
    s.rateLimitWeekly = Math.round(seven)
    s.rateLimitWeeklyResets = resetsAt(obj(rl.seven_day).resets_at)
  }
  for (const k of Object.keys(s) as Array<keyof RemoteStatusLine>) if (s[k] === undefined) delete s[k]
  return Object.keys(s).length > 0 ? s : null
}

/** The CLI's arguments for the session's files. */
function sessionFileArgs(helper: RemoteHelperCommands, tools: boolean): string[] {
  const at = (name: string): string => `${helper.folder.replace(/\/+$/, '')}/${name}`
  return ['--settings', at(REMOTE_SETTINGS_FILE), ...(tools ? ['--mcp-config', at(REMOTE_MCP_FILE)] : [])]
}

export const claudeRemoteLaunch: ProviderRemoteLaunch = {
  hostReads: () => CLAUDE_HOST_READS,
  launch: (o: RemoteLaunchOptions, m: RemoteLaunchMachine, helper: RemoteHelperCommands, reads: readonly RemoteHostFile[]): RemoteLaunch => ({
    program: m.claudePath ?? REMOTE_CLI_FALLBACK,
    args: [...sessionFileArgs(helper, o.tools), ...claudeRemoteArgs(o)],
    env: claudeRemoteEnv(o),
    files: [
      { name: REMOTE_SETTINGS_FILE, content: `${JSON.stringify(claudeRemoteSettings(helper, reads), null, 2)}\n` },
      ...(o.tools ? [{ name: REMOTE_MCP_FILE, content: `${JSON.stringify(claudeRemoteMcp(helper), null, 2)}\n` }] : []),
    ],
    statusKeep: CLAUDE_STATUS_KEEP,
    hookKeep: CLAUDE_HOOK_KEEP,
  }),
  statusLine: claudeRemoteStatusLine,
}
