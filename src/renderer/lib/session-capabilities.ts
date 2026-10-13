/**
 * One derived description of what a session CAN do, computed from the three
 * facts every session already carries (provider, sessionType, shellOnly) plus
 * whether it has a saved config. The command bar, the command dialog, the Logs
 * button and the Settings page all read THIS and nothing else.
 *
 * Why one function: until 2.1.0-beta.16 the bar's only type-awareness was a
 * single boolean, `mainPaneIsShell`. Provider and transport never reached the
 * labels, so a Codex session was told "Claude", and on every SSH session the
 * partner shell -- then a LOCAL PTY -- was described only as "the partner
 * shell", with nothing on screen saying it ran on this PC and not on the host.
 * Three axes standing behind one flag is exactly how those lies happened;
 * deriving everything here is how they stop. A future session type is added in
 * this file alone.
 *
 * #86 (2.1.1): the partner shell runs where the session runs. An SSH session's
 * partner is a plain shell on the session's own host (its own plain
 * connection, components/PartnerTerminalPane.tsx), so the two panes are on
 * the same machine on every session type.
 */
import type { Session } from '../stores/sessionStore'

export type CommandTarget = 'claude' | 'partner'
export type AgentId = 'claude' | 'codex'
export type LogsEmptyReason = 'shell-only' | 'ssh'

export type CapabilitySource = Pick<Session, 'provider' | 'sessionType' | 'shellOnly' | 'configId' | 'sshConfig' | 'kind'>

export interface SessionCapabilities {
  /** The agent in the MAIN pane, or null for a plain shell. */
  agent: AgentId | null
  /** "Claude" / "Codex" -- the one string every label derives from. '' for a shell. */
  agentName: string
  /** What the main pane accepts when a button types into it. */
  mainAccepts: 'prompt' | 'shell'
  /** Where the main pane's process runs. */
  mainRunsOn: 'local' | 'remote'
  /** Where the partner shell runs: where the main pane runs (#86), unless an
   *  SSH tab has no ssh block to connect with (its partner is a shell here). */
  partnerRunsOn: 'local' | 'remote'
  /** Host name for wording when the main pane is remote. */
  remoteHost?: string
  /** Whether the two panes are on different computers. Since #86 the partner
   *  runs where the session runs, so this is false but for an SSH tab with no
   *  ssh block (its partner is a shell here); the labels that read it say
   *  "this PC" only then. */
  panesOnDifferentMachines: boolean
  /** Mirrors LogsPane's structural predicate: a shell has no transcript; an SSH
   *  transcript lives on the host. A local Codex session's rollout is indexed
   *  as a Claude session's transcript is (P3.12). */
  logsEmptyReason: LogsEmptyReason | null
  canIndexLogs: boolean
  /** Snap types an English prompt into the main pane -- nonsense on a shell. */
  canSendImageToAgent: boolean
  /** A session with no saved config has no "this config" to scope to. */
  hasConfig: boolean
  /** True when this is the Ask Conductor help session. */
  isAsk: boolean
  /** Where a button with this target runs. A page button has no target. */
  runsOn: (target: CommandTarget) => 'local' | 'remote'
  /** A secret argument is injected only into LOCAL shell spawns (main sets the
   *  env var when the shell starts; the SSH branch never does, the partner of
   *  an SSH session included), and a reference typed into an agent's TUI is
   *  just text. So: a local shell target only. */
  canDeliverSecret: (target: CommandTarget) => boolean
  /** Whether the main pane IS a shell (the old `mainPaneIsShell`). */
  mainPaneIsShell: boolean
}

const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' }

export function sessionCapabilities(session: CapabilitySource | null | undefined): SessionCapabilities {
  const provider: AgentId = session?.provider === 'codex' ? 'codex' : 'claude'
  const shellOnly = !!session?.shellOnly
  const ssh = session?.sessionType === 'ssh'
  const agent: AgentId | null = shellOnly ? null : provider
  const logsEmptyReason: LogsEmptyReason | null = shellOnly ? 'shell-only' : ssh ? 'ssh' : null
  const mainRunsOn: 'local' | 'remote' = ssh ? 'remote' : 'local'
  // #86: the partner shell runs on the session's own machine, exactly as
  // PartnerTerminalPane starts it (utils/partnerShell): over SSH on the host,
  // unless the tab has no ssh block to connect with (then a shell here).
  const partnerRunsOn: 'local' | 'remote' = ssh && session?.sshConfig ? 'remote' : 'local'
  const runsOn = (target: CommandTarget): 'local' | 'remote' => (target === 'partner' ? partnerRunsOn : mainRunsOn)
  return {
    agent,
    agentName: agent ? AGENT_NAMES[agent] : '',
    mainAccepts: shellOnly ? 'shell' : 'prompt',
    mainRunsOn,
    partnerRunsOn,
    remoteHost: ssh ? session?.sshConfig?.host : undefined,
    panesOnDifferentMachines: partnerRunsOn !== mainRunsOn,
    logsEmptyReason,
    canIndexLogs: logsEmptyReason === null,
    canSendImageToAgent: !shellOnly,
    hasConfig: !!session?.configId,
    isAsk: session?.kind === 'ask',
    runsOn,
    // A 'claude' target on a shell-only session IS the main shell (that is what
    // "the row the main pane is" meant); on an agent session it is the agent.
    canDeliverSecret: (target) => runsOn(target) === 'local' && (target === 'partner' || shellOnly),
    mainPaneIsShell: shellOnly,
  }
}

/** Plain words for where a target runs, for tooltips, menus and the dialog. */
export function describeTarget(caps: SessionCapabilities, target: CommandTarget): string {
  // #86: the partner runs where the session runs; over SSH, on its host.
  if (target === 'partner') {
    if (caps.partnerRunsOn === 'remote') return `the partner shell on ${caps.remoteHost ?? 'the host'}`
    return caps.panesOnDifferentMachines ? 'the partner shell (this PC)' : 'the partner shell'
  }
  if (caps.mainPaneIsShell) return caps.mainRunsOn === 'remote' ? `this shell on ${caps.remoteHost ?? 'the host'}` : 'this shell'
  return caps.mainRunsOn === 'remote' ? `${caps.agentName} on ${caps.remoteHost ?? 'the host'}` : `the ${caps.agentName} terminal`
}
