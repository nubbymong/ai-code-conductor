// Claude Code's launch of a session on another machine through the session
// helper there (2.1.3-beta.18 section 2, aicc_planning#430). Moved here from
// core unchanged: the arguments from remote-helper/index.ts's remoteCliArgs,
// the CLI's variables from its remoteCliEnv, and the program from
// remote-helper/session.ts's remoteLaunchSpec. Core keeps the login shell's
// wrapper, the host account's variables, LANG, TERM and COLORFGBG.
//
// 2.1.3-beta.18 section 3.2 (aicc_planning#431): the session's own files on
// the host. settings.json carries the host user's own settings, as the usual
// SSH setup's session file does, and gives the status line (the helper's
// status mode) and the hooks: the host's own first (its user settings, then the session
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
//
// 2.1.3-beta.20 section 3 (Sign in on this machine): a tab whose account is
// signed in on the host in a folder of its own (`~/.aicc/accounts/<profile
// id>/`, core's) runs with that folder as the CLI's config folder
// (CLAUDE_CONFIG_DIR, `configDir`), and its session file carries the host
// user's own settings made fit for an account's folder, as the folder's own
// settings copy does (sanitizeClaudeManagedSettings, the copy this
// computer's account homes get). A sign-in tab (`signIn`) runs the CLI's own
// `claude auth login` in that folder instead of a session. The package's
// remote accounts (CLAUDE_REMOTE_ACCOUNTS) name the rest: the sign-in's files
// and fields, the folder's links into `~/.claude` (the one shared-folder list,
// shared/account-folder.ts, and CLAUDE.md), and `claude auth logout`.
//
// 2.1.3-beta.21 (ADR-032): on a Linux host Claude Code reads a picture by
// running `xclip` or `wl-paste`, found by PATH, so a session's launch asks
// for the session helper's clipboard stand-in (`clipStandIn`): core writes
// its two scripts into the session's bin/ folder and puts that folder first
// on the CLI's PATH, and the picture the app sends with `file.put` is what
// the CLI's own image paste reads. A sign-in launch reads no picture.
import { concatHookMaps, helperHooksBlockFor, helperStatusCommand } from '../../hooks/helper-hook-commands'
import { HELPER_HOOK_KINDS } from '../../session-helper/protocol'
import { SHARED_DIR_NAMES } from '../../../shared/account-folder'
import { DEFAULT_CLI_AUTH_METHOD, isCliAuthMethod } from '../../../shared/account-web-session'
import { sanitizeClaudeManagedSettings } from './managed-launch'
import type { ProviderRemoteLaunch, RemoteAccounts, RemoteAccountUsage, RemoteHelperCommands, RemoteHostField, RemoteHostFile, RemoteHostRead, RemoteLaunch, RemoteLaunchMachine, RemoteLaunchOptions, RemoteStatusLine } from '../types'

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
  // 2.1.3-beta.20 section 3.1.7: the account's own folder on the host, when it is signed in there.
  if (o.configDir) env[CLAUDE_CONFIG_VAR] = o.configDir
  return env
}

/** The variable that names Claude Code's config folder. */
export const CLAUDE_CONFIG_VAR = 'CLAUDE_CONFIG_DIR'

/** The settings files Claude Code reads for a session, whose hooks the
 *  session's settings file carries first: the user's, then the session
 *  folder's project and local settings, then the checkout root's local
 *  settings (hooks/session-hooks-writer.ts resolveInheritedHooks reads the same
 *  four on this computer; the usual SSH setup reads them on the host). The
 *  user's own is read as Claude Code reads it, a link followed (a dotfiles
 *  link keeps its hooks); a project file only when it is no link and the host
 *  user's own, not open to others (remote-helper/scripts.ts ONE_READ). */
export const CLAUDE_HOST_READS: readonly RemoteHostRead[] = [
  { from: 'home', path: '.claude/settings.json' },
  { from: 'cwd', path: '.claude/settings.json' },
  { from: 'cwd', path: '.claude/settings.local.json' },
  { from: 'checkout', path: '.claude/settings.local.json' },
]

/** 2.1.3-beta.19 section 3 (aicc_planning#434): the account the host's
 *  Claude Code is signed in as, for the tab's status line and header: the
 *  one field the usual SSH status line reads on the host
 *  (statusline-gather.ts SHIM_GATHER_JS: `oauthAccount.emailAddress` of
 *  `~/.claude.json`), read through the session helper's field mode, never
 *  the file. Core reads it at every start of the tab, launch or attach. */
export const CLAUDE_ACCOUNT_FIELD: RemoteHostField = { file: '.claude.json', key: 'oauthAccount.emailAddress' }

/** 2.1.3-beta.20 section 3.1.6: the account field of a tab whose CLI runs in
 *  the account's own folder on the host: that folder's `.claude.json`, as a
 *  path under the home folder; the host's own (CLAUDE_ACCOUNT_FIELD) for one
 *  that runs on the host's own sign-in. None for a sign-in tab, or a folder
 *  that is not under the home folder the check read. */
export function claudeAccountField(o: RemoteLaunchOptions, m: RemoteLaunchMachine): RemoteHostField | null {
  if (o.signIn) return null
  if (!o.configDir) return CLAUDE_ACCOUNT_FIELD
  const home = `${m.home.replace(/\/+$/, '')}/`
  return o.configDir.startsWith(home) && o.configDir.length > home.length
    ? { file: `${o.configDir.slice(home.length).replace(/\/+$/, '')}/${CLAUDE_ACCOUNT_FIELD.file}`, key: CLAUDE_ACCOUNT_FIELD.key }
    : null
}

/** The host user's own settings (the `home` host read) as an account's
 *  folder takes them: sanitizeClaudeManagedSettings's copy, which leaves out
 *  every key that would carry another sign-in into the account (an
 *  `apiKeyHelper`, an `env` entry naming a token or an endpoint), as this
 *  computer's account homes get theirs (account-profiles.ts
 *  writeSanitisedSettingsCopy). Null: no such file, or one the sanitiser
 *  refuses (not JSON, not an object, too deep): then no copy at all. */
export function claudeAccountSettingsText(reads: readonly RemoteHostFile[]): string | null {
  const home = CLAUDE_HOST_READS[0]
  const text = reads.find((r) => r.from === home.from && r.path === home.path)?.content ?? null
  if (text === null) return null
  return sanitizeClaudeManagedSettings(text).text
}

/** 2.1.3-beta.20 section 3: Claude Code's accounts on a host (RemoteAccounts):
 *  the machine's own sign-in is `~/.claude.json` and `~/.claude/.credentials.json`;
 *  an account folder's, its own `.claude.json` and `.credentials.json`
 *  (CLAUDE_CONFIG_DIR keeps both there). Its fields: the account
 *  (`oauthAccount.emailAddress`) and the plan, tier and expiry of its
 *  credentials, every one on the helper's field-mode list (helper/src/field.rs
 *  ALLOWED_KEYS), never a token. The folder links the shared folders and
 *  CLAUDE.md to `~/.claude`, and keeps settings.json as the sanitised copy. */
export const CLAUDE_REMOTE_ACCOUNTS: RemoteAccounts = Object.freeze({
  profiles: async () => (await import('../../account-profiles')).listProfiles(),
  files: {
    own: { identity: CLAUDE_ACCOUNT_FIELD.file, credentials: '.claude/.credentials.json' },
    folder: { identity: '.claude.json', credentials: '.credentials.json' },
  },
  keys: { identity: CLAUDE_ACCOUNT_FIELD.key, plan: 'claudeAiOauth.subscriptionType', tier: 'claudeAiOauth.rateLimitTier', expiresAt: 'claudeAiOauth.expiresAt' },
  links: { home: '.claude', folders: SHARED_DIR_NAMES, files: ['CLAUDE.md'] },
  configVar: CLAUDE_CONFIG_VAR,
  signOut: { program: 'claude', args: ['auth', 'logout'] },
  settingsCopy: (reads: readonly RemoteHostFile[]) => ({ name: 'settings.json', content: claudeAccountSettingsText(reads) }),
})

/** The CLI's own sign-in, in the words claude-cli-auth.ts claudeAuthCommand
 *  gives a sign-in on this computer: `claude auth login --<method>`, the
 *  account's own method (2.1.3-beta.20 fix round, MINOR-5: a Claude
 *  subscription, the Anthropic Console or single sign-on; the default for
 *  one never told otherwise, and for anything that is not one of the CLI's
 *  choices), with `--email` for an address-shaped email, so the sign-in page
 *  asks for that account. */
export function claudeSignInArgs(email: string | undefined, method?: string): string[] {
  const args = ['auth', 'login', `--${isCliAuthMethod(method) ? method : DEFAULT_CLI_AUTH_METHOD}`]
  if (email && /^[^\s"'`;&|<>$()\\]+@[^\s"'`;&|<>$()\\]+$/.test(email) && email.length <= 254) args.push('--email', email)
  return args
}

/** 2.1.3-beta.19 section 3: the weekly bars and extra usage of a tab whose
 *  account field named an account this computer holds: its Claude Code
 *  account profiles (account-profiles.ts listProfiles) and the Account usage
 *  page's read of one (usage/account-usage.ts fetchAccountUsage). Both load
 *  when first asked, so this file still loads in plain Node. One object for
 *  every start, so one reading serves every tab on an account. */
const CLAUDE_ACCOUNT_USAGE: RemoteAccountUsage = Object.freeze({
  profiles: async () => (await import('../../account-profiles')).listProfiles(),
  usage: async (profileId: string) => (await import('../../usage/account-usage')).fetchAccountUsage(profileId),
})

/** One settings file's text as an object; null for a file not read, not
 *  JSON, or of another shape. Data only: nothing in it is run here. */
function settingsOfText(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

/** The `hooks` of one settings file's text, keeping only array-valued events;
 *  nothing for a file not read, not JSON, or of another shape. Data only:
 *  nothing in it is run here. */
export function hooksOfSettingsText(text: string | null): Record<string, unknown[]> {
  const hooks = settingsOfText(text)?.hooks
  const out: Record<string, unknown[]> = {}
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
      if (Array.isArray(arr)) out[event] = arr.slice()
    }
  }
  return out
}

/** The session's settings file: the host user's own settings (the `home`
 *  read, ~/.claude/settings.json) less mcpServers, as the usual SSH setup
 *  copies them into its session file (ssh-shim.ts generateRemoteSetupScript),
 *  then over them the status line, the helper's status mode, and the hooks,
 *  the host's own (in `reads`' order) then the helper's hook mode for the nine
 *  events, identical entries dropped. Claude Code reads some keys differently
 *  by source: a top-level effortLevel in the user's own settings is a
 *  legacy effort it applies to some models only, while in a --settings file it
 *  is the session's effort (2.1.3-beta.18 fix round, item 2: without the copy
 *  a helper tab ran at the model's default effort, today's SSH tab at the
 *  user's). Throws when the helper's path or store cannot be put in a command
 *  safely: the tab then takes the usual SSH path. `account` (2.1.3-beta.20
 *  section 3.1.7): the tab runs in an account's own folder, so the user's
 *  settings are its sanitised copy (claudeAccountSettingsText), as that
 *  folder's settings.json is: a --settings file must not carry back what the
 *  copy leaves out. */
export function claudeRemoteSettings(helper: RemoteHelperCommands, reads: readonly RemoteHostFile[], account = false): Record<string, unknown> {
  const target = { helperPath: helper.helperPath, store: helper.store, sid: helper.sid, launcher: 'sh' as const }
  const statusCommand = helperStatusCommand(target)
  // The nine events the app takes, as buildHelperHooksBlock gives a held session on this computer.
  const own = helperHooksBlockFor(target, HELPER_HOOK_KINDS)
  if (statusCommand === null || own === null) throw new Error('the session helper\'s path on the host cannot be put in a status line or hook command safely')
  const hooks = concatHookMaps(...reads.map((r) => hooksOfSettingsText(r.content)), own)
  const home = CLAUDE_HOST_READS[0]
  const userText = account ? claudeAccountSettingsText(reads) : reads.find((r) => r.from === home.from && r.path === home.path)?.content ?? null
  const user = { ...settingsOfText(userText) }
  delete user.mcpServers
  return { ...user, statusLine: { type: 'command', command: statusCommand }, hooks }
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
 * gives it. No transcript path, no account label, no usage buckets and no
 * extra usage: a remote path is display text, never the transcript binder's;
 * the label comes from the account field read at the tab's start
 * (CLAUDE_ACCOUNT_FIELD), and the per-model weekly buckets and extra usage
 * from this computer's own usage read of that account, never from the host
 * (2.1.3-beta.19 section 3, aicc_planning#434: statusline-watcher.ts
 * setHelperAccount). Null when the status holds nothing to show.
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

/** 2.1.3-beta.20 section 3.1.4: a sign-in tab's launch: the CLI's own sign-in
 *  in the account's folder (its CLAUDE_CONFIG_DIR, from claudeRemoteEnv),
 *  with no session files and nothing kept of a status or hook event. Throws
 *  for a sign-in with no account folder: it would sign in the host's own. */
function claudeSignInLaunch(o: RemoteLaunchOptions, m: RemoteLaunchMachine): RemoteLaunch {
  if (!o.configDir) throw new Error('a sign-in on the host needs the account\'s own folder there')
  return { program: m.claudePath ?? REMOTE_CLI_FALLBACK, args: claudeSignInArgs(o.signIn?.email, o.signIn?.method), env: claudeRemoteEnv(o), files: [], statusKeep: [], hookKeep: [] }
}

export const claudeRemoteLaunch: ProviderRemoteLaunch = {
  hostReads: (o: RemoteLaunchOptions) => (o.signIn ? [] : CLAUDE_HOST_READS),
  accountField: claudeAccountField,
  accountUsage: () => CLAUDE_ACCOUNT_USAGE,
  accounts: () => CLAUDE_REMOTE_ACCOUNTS,
  // 2.1.3-beta.21 (aicc_planning#446): a Claude Code tab asks for a review
  // on its machine, run there.
  reviewsOnMachine: true,
  launch: (o: RemoteLaunchOptions, m: RemoteLaunchMachine, helper: RemoteHelperCommands, reads: readonly RemoteHostFile[]): RemoteLaunch => (o.signIn ? claudeSignInLaunch(o, m) : {
    program: m.claudePath ?? REMOTE_CLI_FALLBACK,
    args: [...sessionFileArgs(helper, o.tools), ...claudeRemoteArgs(o)],
    env: claudeRemoteEnv(o),
    files: [
      { name: REMOTE_SETTINGS_FILE, content: `${JSON.stringify(claudeRemoteSettings(helper, reads, !!o.configDir), null, 2)}\n` },
      ...(o.tools ? [{ name: REMOTE_MCP_FILE, content: `${JSON.stringify(claudeRemoteMcp(helper), null, 2)}\n` }] : []),
    ],
    statusKeep: CLAUDE_STATUS_KEEP,
    hookKeep: CLAUDE_HOOK_KEEP,
    clipStandIn: true,
  }),
  statusLine: claudeRemoteStatusLine,
}
