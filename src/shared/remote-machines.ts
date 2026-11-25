/**
 * Remote step 1 (2.1.3-beta.17, plan section A2; ADR-030 S24 and S25): the
 * Linux machines a user adds on the Machines page, as the renderer sees them.
 * Nothing here names a path on this computer, a process id or a credential.
 */

/** The setting (Settings, General, under Terminal; Windows; off unless saved true). */
export const REMOTE_SESSIONS_SETTING = 'remoteSessionsThroughHelper'

/** The switch's description (Settings, General, under Terminal): what goes
 *  through the helper, and each thing such a tab does not have yet (plan
 *  finding 6). */
export const REMOTE_SWITCH_TEXT =
  'Preview, off by default. A Claude Code tab whose saved config\'s Connection is SSH (not SSH Persistent), with key sign-in, no post-connect command and no container, to a Linux machine you added and checked on the Machines page, runs through the session helper there: nothing is typed into the host\'s shell to set it up or start it, and a dropped connection comes back within two minutes with what you missed. Not through the helper yet: the Agent Canvas, the browser, the Conductor\'s other tools, hooks (the attention mark, the Watchdog) and the status line with usage, so such a tab has none of them yet. An image pasted or snapped into such a tab is not sent, and the tab says so. Prompt buttons and broadcast type into it as into any Claude Code tab. Closing the tab or quitting ends its session, and Restart on such a tab starts a new conversation (type /resume there to pick the earlier one up). Every other SSH tab, and every tab while this is off, runs the usual way. Applies to tabs opened after the change.'

/** Which tabs go through the helper, and why another does not (plan finding
 *  5): the machine's card says it in one line while the switch is on. */
export const REMOTE_ROUTE_NOTE =
  'A Claude Code tab whose saved config has Connection set to SSH, with key sign-in, no post-connect command and no container, runs through the session helper here. SSH Persistent (the default for a config that never chose), a post-connect command, a container or a password sign-in keep the usual SSH path.'

/** A machine's card reads not checked, with this line, while the machine
 *  holds another session helper than this build of the app carries (after an
 *  update): its tabs take the usual path until Check installs this one. */
export const REMOTE_OTHER_HELPER = 'this build of the app carries another version of the session helper; press Check to update it'

/** One added machine, for its card. */
export interface RemoteMachineView {
  /** The device id: what Check and Remove take. */
  did: string
  /** The saved config's name it was added from. */
  label: string
  /** `user@host:port`. */
  target: string
  /** Its last check passed and it holds this build's helper: tabs may go
   *  through the helper there (one holding another reads false, with
   *  REMOTE_OTHER_HELPER as its detail). */
  checked: boolean
  /** When it was last checked (ms since the epoch), and what that said. */
  lastCheck: { at: number; ok: boolean; detail?: string }
  helperVersion: string
  /** For example "Linux x86_64". */
  system: string
  /** How many open tabs go through the helper there now. */
  inUse: number
}

/** A saved SSH config the Add list offers, and whether it can be added. */
export interface RemoteAddCandidate {
  configId: string
  label: string
  target: string
  addable: boolean
  /** Why it cannot be, when it cannot. */
  why?: string
}

/** Everything the Machines page shows of remote machines. */
export interface RemoteMachinesState {
  /** Remote sessions through the helper exist on this computer's OS (Windows). */
  available: boolean
  /** The switch, as saved. */
  switchOn: boolean
  /** The Linux helper this build carries, or why there is none. */
  bundled: { ok: true; version: string; size: number; sha12: string } | { ok: false; why: string }
  machines: RemoteMachineView[]
  candidates: RemoteAddCandidate[]
}

/** The question asked before anything goes to a machine, or why it cannot be asked. */
export type RemoteConsent =
  | { ok: true; token: string; target: string; text: string }
  | { ok: false; message: string }

/** What an Add, a Check or a Remove did, in a plain sentence. */
export interface RemoteActionResult {
  ok: boolean
  message: string
}

/** What main sends the SSH flow overlay when a tab starts through the session
 *  helper, and answers its catch-up until the tab is closed or started again
 *  (a start that failed included): it has no SSH flow, and the overlay hides
 *  (SshFlowOverlay.tsx). */
export const SSH_THROUGH_HELPER = 'through-helper'

/** A device id, as Check and Remove take it. */
export const REMOTE_DID_RE = /^[0-9a-f]{32}$/
/** A consent token, as Add takes it. */
export const REMOTE_TOKEN_RE = /^[0-9a-f]{32}$/
