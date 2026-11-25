// Claude Code's launch of a session on another machine through the session
// helper there (2.1.3-beta.18 section 2, aicc_planning#430). Moved here from
// core unchanged: the arguments from remote-helper/index.ts's remoteCliArgs,
// the CLI's variables from its remoteCliEnv, and the program from
// remote-helper/session.ts's remoteLaunchSpec. The launch is the same, byte
// for byte; core keeps the login shell's wrapper, the host account's
// variables, LANG, TERM and COLORFGBG. Nothing goes to the host for it yet:
// no file is read there or written, and no status or hook field is kept.
import type { ProviderRemoteLaunch, RemoteLaunch, RemoteLaunchMachine, RemoteLaunchOptions } from '../types'

/** Where the CLI is started when the machine's check found none. */
const REMOTE_CLI_FALLBACK = '/usr/local/bin/claude'

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

export const claudeRemoteLaunch: ProviderRemoteLaunch = {
  hostReads: () => [],
  launch: (o: RemoteLaunchOptions, m: RemoteLaunchMachine): RemoteLaunch => ({
    program: m.claudePath ?? REMOTE_CLI_FALLBACK,
    args: claudeRemoteArgs(o),
    env: claudeRemoteEnv(o),
    files: [],
    statusKeep: [],
    hookKeep: [],
  }),
}
