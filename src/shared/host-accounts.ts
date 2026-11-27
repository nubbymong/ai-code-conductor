/**
 * Sign in on this machine (2.1.3-beta.20 section 3; ADR-030 D7, Standard
 * login on a remote machine): each Claude Code account this computer holds
 * can be signed in on a Linux machine added on the Machines page, by the
 * CLI's own sign-in run in a helper tab there. The sign-in stays on that
 * machine, in the account's own folder (`~/.aicc/accounts/<profile id>/`,
 * owner-only, the account's CLAUDE_CONFIG_DIR there); everything else the
 * CLI keeps is shared with the machine's own `~/.claude`. Nothing is copied
 * between machines.
 *
 * This file is the shape main and the renderer share (section 3.1.1): one
 * account's sign-in state on one machine, what a read of the machine found
 * (identity, plan, expiry, read time), why a helper tab started nothing for
 * its account (the not-signed-in notice), and what a sign-out did.
 *
 * Everything a machine reports here is the host's and display text only:
 * main reads it through the session helper's field mode, which prints only
 * the fields on its list (never a token), and checks each value before it
 * lands in these shapes. Nothing here names a path on this computer, a
 * process id or a credential.
 */

/**
 * One account's sign-in on one machine, as the machine's last read found it.
 *
 * - `signed-in-here`: its own folder on the machine holds a sign-in as this
 *   account. A helper tab on this account starts in that folder.
 * - `machine-own`: the machine's own Claude Code sign-in (its `~/.claude`) is
 *   this account (section 3.1.5), and it has no sign-in of its own folder
 *   there. A helper tab on this account starts on the machine's own folder.
 * - `not-signed-in`: neither. A helper tab on this account starts nothing
 *   and the notice offers Sign in on that machine.
 * - `someone-else`: its own folder there is signed in as another account
 *   (a sign-in that chose a different account). Marked, never used: a helper
 *   tab on this account starts nothing, and Sign out is offered.
 * - `not-read`: the machine has not been read since the app started, or its
 *   last read did not answer. A helper tab reads it again at its launch.
 */
export type HostSignInState = 'signed-in-here' | 'machine-own' | 'not-signed-in' | 'someone-else' | 'not-read'

/** Every state, in the order a card lists them. */
export const HOST_SIGN_IN_STATES: readonly HostSignInState[] = ['signed-in-here', 'machine-own', 'not-signed-in', 'someone-else', 'not-read']

/** The states a helper tab may start on (section 3.1.7). */
export const HOST_LAUNCHABLE_STATES: readonly HostSignInState[] = ['signed-in-here', 'machine-own']

/**
 * What one read found of one sign-in on a machine (its account folder's, or
 * the machine's own): the fields the provider package names, each checked by
 * main. All display text: never compared with anything but an account's
 * email, and never put on a command line.
 */
export interface HostSignInFacts {
  /** The account the sign-in names (Claude Code: `oauthAccount.emailAddress`
   *  of its `.claude.json`); null when the file names none. */
  identity: string | null
  /** The plan the sign-in carries (Claude Code: `claudeAiOauth.subscriptionType`
   *  of its `.credentials.json`, for example `max`); null when none. */
  plan: string | null
  /** The plan's usage tier (Claude Code: `claudeAiOauth.rateLimitTier`, for
   *  example `default_claude_max_20x`); null when none. */
  tier: string | null
  /** When the sign-in's current access lapses, ms since the epoch (Claude
   *  Code: `claudeAiOauth.expiresAt`); the CLI renews it itself while its
   *  renewal holds. Null when none. */
  expiresAt: number | null
  /** The sign-in's credentials file is there and names a sign-in (Claude
   *  Code: its `.credentials.json` carries an expiry). False with an identity:
   *  the folder names an account but holds no sign-in for it. */
  credentials: boolean
}

/** One account of this computer on one machine. */
export interface HostAccountSignIn {
  /** The account's profile id on this computer (its folder's name on the machine). */
  profileId: string
  state: HostSignInState
  /** The sign-in the state is about: its own folder's for `signed-in-here`
   *  and `someone-else` (who it is signed in as), the machine's own for
   *  `machine-own`; null for `not-signed-in` and `not-read`. */
  facts: HostSignInFacts | null
  /** Its own folder is there on the machine (Sign out removes it). True for
   *  `signed-in-here` and `someone-else`, and for a folder whose sign-in ended
   *  (read `not-signed-in`, or `machine-own` when the machine's own sign-in is
   *  this account too). */
  folder: boolean
}

/** One machine's accounts, from its last read (section 3.1.6: at Check, at
 *  the start-up list, at the end of a sign-in tab, and at each launch of a
 *  helper tab on an account; and a sign-out reads it before and after, to
 *  decide and then to show the result; one exec per read, never polled). */
export interface HostMachineAccounts {
  /** The machine's device id (RemoteMachineView.did). */
  did: string
  /** When the machine was last read, ms since the epoch; null: not read
   *  since the app started. */
  readAt: number | null
  /** The last read answered. False: every account reads `not-read`, and `why`
   *  says why (absent when it was never read). */
  ok: boolean
  why?: string
  /** The machine's own Claude Code sign-in (its `~/.claude`), or null when it
   *  has none (or was not read). Its identity may be an account this computer
   *  does not hold. */
  own: HostSignInFacts | null
  /** Every Claude Code account this computer holds, in its accounts' order. */
  accounts: HostAccountSignIn[]
  /** Account folders on the machine for profile ids this computer no longer
   *  holds (an account removed here), made by this computer: Remove signs
   *  them out too. */
  others: string[]
  /** 2.1.3-beta.20 fix round (MAJOR-1): account folders the app on another
   *  computer made on this host login (two computers of the user on one
   *  machine, or a shared login), by profile id. This computer never reads,
   *  signs out or removes them; Remove names them as used by another
   *  computer. Absent: none (or a shape from before this field). */
  elsewhere?: string[]
}

/** Every added machine's accounts (MACHINES_REMOTE_ACCOUNTS: the last reads,
 *  no exec). */
export interface HostAccountsState {
  machines: HostMachineAccounts[]
}

/**
 * Why a helper tab started nothing for its account (section 3.1.7): the
 * config's account is not signed in on that machine (`not-signed-in`), its
 * folder there is signed in as another account (`someone-else`), or the
 * machine's accounts could not be read at the launch (`not-read`). No CLI was
 * spawned. Phase 5's notice reads it: sign in there, start on another account
 * signed in there, or Cancel.
 */
export interface HostLaunchRefusal {
  /** The machine (RemoteMachineView.did) and how its notices name it. */
  did: string
  machineName: string
  /** The config's account. */
  profileId: string
  state: Exclude<HostSignInState, 'signed-in-here' | 'machine-own'>
  /** `someone-else`: who its folder there is signed in as. */
  identity?: string
  /** The accounts of this computer that are signed in on that machine now
   *  (`signed-in-here` or `machine-own`): the notice's "start it on another
   *  account" list. Empty when none is, or the machine was not read. */
  signedInThere: string[]
  /** The plain sentence the tab shows in its terminal. */
  text: string
}

/**
 * What main tells the renderer about a helper tab's account
 * (REMOTE_ACCOUNT_NOTICE, one payload per event):
 * - `launch-refused`: the tab started nothing (HostLaunchRefusal);
 * - `sign-in-ended`: a sign-in tab ended and the machine was read again:
 *   the account's state there now (`signed-in-here` on a sign-in as the
 *   account; `someone-else` when it signed in as another: marked, never
 *   used, Sign out offered; `not-signed-in` when it was left unfinished;
 *   `not-read` when the read did not answer).
 */
export type HostAccountNotice =
  | { kind: 'launch-refused'; sessionId: string; refusal: HostLaunchRefusal }
  | { kind: 'sign-in-ended'; sessionId: string; did: string; profileId: string; state: HostSignInState; identity?: string }

/**
 * A sign-out on a machine (section 3.1.8; MACHINES_REMOTE_ACCOUNT_SIGN_OUT):
 * the CLI's own `claude auth logout` there, in the account's folder, then that
 * folder goes (only that one). The machine's own sign-in (`machine-own`) is
 * signed out only with `confirmMachineOwn` (Q5): the renderer asks first,
 * naming it as the machine's own sign-in, and its folder (`~/.claude`) stays.
 */
export interface HostSignOutRequest {
  did: string
  profileId: string
  /** The user confirmed signing out the machine's own sign-in. */
  confirmMachineOwn?: boolean
}

/**
 * What a sign-out did. `needsConfirm: 'machine-own'`: nothing ran; the
 * account is signed in by the machine's own sign-in, and the renderer must
 * ask first (Q5). `signedOutWithService`: the CLI's sign-out ran to its end
 * (the service was told); false when it could not run or failed, in which
 * case `message` names where to end the sign-in. `state`: the account's
 * state on the machine after it (from a read made after the sign-out).
 */
export interface HostSignOutResult {
  ok: boolean
  message: string
  needsConfirm?: 'machine-own'
  signedOutWithService?: boolean
  state?: HostSignInState
}

/**
 * The spawn option that makes a helper tab a sign-in tab (section 3.1.4):
 * with the tab's `profileId` (the account) and its SSH config (the machine),
 * the tab runs the CLI's own sign-in in that account's folder there instead
 * of a session. Its end reads the machine again (`sign-in-ended`). Only a
 * Claude Code tab through the session helper takes it; any other spawn with
 * it starts nothing.
 */
export const HOST_SIGN_IN_SPAWN_FIELD = 'remoteAccountSignIn'

/** Where an account's sign-in on a machine lives there: its profile id
 *  under `~/.aicc/accounts/` (Q4: by profile id, never by email; on the
 *  machine only the CLI's own files hold the email). */
export const HOST_ACCOUNTS_FOLDER = '.aicc/accounts'
