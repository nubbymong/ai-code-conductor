/**
 * Remote step 1 (2.1.3-beta.17, plan section A2; ADR-030 S24 and S25): the
 * Linux machines a user adds on the Machines page, as the renderer sees them.
 * Nothing here names a path on this computer, a process id or a credential.
 */

/** The setting (Settings, General, under Terminal; Windows; off unless saved true). */
export const REMOTE_SESSIONS_SETTING = 'remoteSessionsThroughHelper'

/** The switch's description (Settings, General, under Terminal): what goes
 *  through the helper, and each thing such a tab does not have yet (plan
 *  finding 6; 2.1.3-beta.18 section 3.2: its status line, hooks and the
 *  Conductor's tools go through the helper too; 2.1.3-beta.19: arm64
 *  machines, the account and its limits, and SSH Persistent tabs kept until
 *  they are ended). Short paragraphs, one blank line apart (the Settings
 *  page shows them with whitespace-pre-line; 2.1.3-beta.19 release smoke):
 *  which tabs go through, what goes through with them, SSH against SSH
 *  Persistent, and what the preview does not take yet. */
export const REMOTE_SWITCH_TEXT = [
  'Preview, off by default. A Claude Code tab whose saved config signs in by key, with no post-connect command and no container, to a Linux x86-64 or arm64 machine you added and checked on the Machines page, runs through the session helper there: nothing is typed into the host\'s shell to set it up or start it, and a dropped connection comes back within two minutes with what you missed.',
  'Its status line, its hooks (the attention mark, the Watchdog) and the Conductor\'s tools (the Agent Canvas, the browser, and image paste and Snap) go through the helper too, and no address or token of this computer is sent to the host: the session\'s own settings go in ~/.aicc on that machine and are removed when its session ends; ones left by quitting the app or by a dropped connection are removed at the next start, or at the next Check on the Machines page. Its status line names the account Claude Code\'s config names on that machine, and shows the weekly limits by model and extra usage when this computer holds that account and has a current reading for it; otherwise it says not available. Prompt buttons and broadcast type into it as into any Claude Code tab.',
  'A tab whose Connection is SSH ends its session when you close it or quit, and Restart on such a tab starts a new conversation (type /resume there to pick the earlier one up). An SSH Persistent tab (the default for a config that never chose a Connection) runs through the helper too, on a machine whose logind does not end your processes when you log out, and is kept there until you end it: close it and choose Leave running, quit the app or update it, and the next start brings it back where it was; End, in its tab\'s close question or on the Machines page, ends it. A config with a session still under tmux keeps the usual SSH path until that session is ended.',
  'Not through the helper yet: password sign-in, containers, post-connect commands, macOS and Windows machines, and Codex. Every other SSH tab, and every new tab while this is off, runs the usual way. Applies to tabs opened after the change.',
].join('\n\n')

/** Which tabs go through the helper, and why another does not (plan finding
 *  5; 2.1.3-beta.19 section 1.2: SSH Persistent too, until it is ended): the
 *  machine's card says it while the switch is on, with what the preview
 *  still lacks. */
export const REMOTE_ROUTE_NOTE =
  'A Claude Code tab whose saved config uses key sign-in, no post-connect command and no container runs through the session helper here. With Connection set to SSH it ends when you close it. SSH Persistent (the default for a config that never chose) runs until you end it: close it and choose Leave running, quit the app, or lose the connection, and it waits here for you. A config with a session still under tmux keeps the usual SSH path until that session is ended. Not through the helper yet: password sign-in, containers, post-connect commands, macOS and Windows machines, and Codex.'

/** A machine's card reads not checked, with this line, while the machine
 *  holds another session helper file than this build of the app carries
 *  (after an update): a new tab there takes the usual path until Check
 *  installs this one, and a tab whose session the helper keeps there starts
 *  nothing and names that step (2.1.3-beta.19 section 1.2). The file is
 *  compared by its SHA-256, so it can differ under the same version number
 *  (2.1.3-beta.18 to beta.19: 0.1.0 both), and the line never
 *  says another version (nor a newer one: an older app can carry it too). */
export const REMOTE_OTHER_HELPER = 'this build of the app carries a different session helper file; press Check to install it; until then a new tab there takes the usual SSH path, and a tab whose session the helper keeps there opens again after that Check and a Restart'

/** One added machine, for its card. */
export interface RemoteMachineView {
  /** The device id: what Check and Remove take. */
  did: string
  /** The saved config's name it was added from. */
  label: string
  /** How its notices name it (main's machineName): its label, then
   *  `user@host:port`; its Remove question names it so too (PR 763 fix
   *  round 9). */
  name: string
  /** `user@host:port`. */
  target: string
  /** Its last check passed and it holds this build's helper: tabs may go
   *  through the helper there (one holding another reads false, with
   *  REMOTE_OTHER_HELPER as its detail). */
  checked: boolean
  /** When it was last checked (ms since the epoch), and what that said. */
  lastCheck: { at: number; ok: boolean; detail?: string }
  helperVersion: string
  /** For example "Linux x86-64" or "Linux arm64" (as the consent names them). */
  system: string
  /** How many open tabs go through the helper there now. */
  inUse: number
  /** Why SSH Persistent tabs keep the usual SSH path there (2.1.3-beta.19
   *  section 1.2: its logind ends a user's processes at logout, or its last
   *  check did not read that); absent where they may go through the helper. */
  persistentNote?: string
}

/** One session the session helper keeps on a machine, as list mode reads it
 *  (2.1.3-beta.19 section 1.2), for the machine's card. */
export interface RemoteKeptSession {
  /** The helper's session id: what End takes. */
  sid: string
  /** The app session id its holder was started for (the holder's label),
   *  or null when the label names none. */
  appSessionId: string | null
  /** Kept until it is ended (an SSH Persistent tab's); false: its away
   *  clock ends it two minutes after its tab goes (a plain SSH tab's). */
  untilEnded: boolean
  /** A tab is attached to it now. */
  attached: boolean
  /** Its program still runs. */
  running: boolean
}

/** One machine's sessions, from one list exec, or why they were not read. */
export type RemoteMachineSessions =
  | { did: string; ok: true; sessions: RemoteKeptSession[] }
  | { did: string; ok: false; why: string }

/** Every added machine's sessions (the Machines page, at start-up and when it opens). */
export interface RemoteSessionsState {
  machines: RemoteMachineSessions[]
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
  /** The Linux helpers this build carries (one per machine architecture,
   *  x86_64 and aarch64 in a package), or why there is none. */
  bundled: { ok: true; version: string; files: Array<{ arch: string; size: number; sha12: string }> } | { ok: false; why: string }
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
