// src/renderer/utils/hostAccounts.ts
//
// 2.1.3-beta.20 section 5 (Accounts across machines; the owner-approved
// mockup .ccc-canvas/accounts-machines-beta20-v1.html, frames 1 to 4, Claude
// Code rows only): what the account cards, the Machines card, the Switch
// Account list and the not-signed-in notice say of one account's sign-in on
// one Linux machine, from that machine's last read (shared/host-accounts.ts,
// phase 3). Pure, so each line is pinned by a unit test.
//
// Every machine signs in on itself (Q7, parked to nubbymong/aicc_planning#443):
// Lend from this computer is not built yet, and only Claude Code accounts
// sign in on machines in this release, so nothing here names anything else.
import type { HostAccountSignIn, HostMachineAccounts, HostSignInState } from '../../shared/host-accounts'
import { HOST_LAUNCHABLE_STATES } from '../../shared/host-accounts'
import type { SshConfig } from '../../shared/types'
import type { TerminalConfig } from '../stores/configStore'

/** The dot beside a line: signed in (`ok`), signed in as someone else
 *  (`warn`), or not signed in or not read (`none`: a hollow dot). */
export type HostLineTone = 'ok' | 'warn' | 'none'

/** One account on one machine, as a card or a row says it. */
export interface HostSignInLine {
  tone: HostLineTone
  text: string
  /** A second, smaller line. */
  sub?: string
  /** Hover text for the line. */
  title?: string
  /** The line's button: Sign in on that machine, Sign out there, or (round
   *  2, R2-1) Adopt a folder that may be this computer's own. */
  action?: 'sign-in' | 'sign-out' | 'adopt'
  /** The text is drawn muted (not signed in, not read). */
  muted: boolean
}

/** A machine as these lines name it: its card's name (its label). */
export interface HostMachineRef {
  did: string
  /** How its notices and lines name it (RemoteMachineView.name). */
  name: string
  /** `user@host:port` (RemoteMachineView.target). */
  target: string
  /** The saved config's name it was added from (RemoteMachineView.label). */
  label: string
}

/** A machine's short name, as the cards, rows and lists say it (the
 *  mockup's "Rocky"): its label, else its `user@host:port`. Sentences that
 *  must tell two machines apart (Remove's question) use its full `name`. */
export function machineLabel(m: Pick<HostMachineRef, 'label' | 'target'>): string {
  return m.label.trim() || m.target
}

/** The account's state there may start a helper tab (signed in in its own
 *  folder, or the machine's own sign-in is this account). */
export function hostLaunchable(state: HostSignInState | undefined): boolean {
  return !!state && HOST_LAUNCHABLE_STATES.includes(state)
}

/** The Sign in button's hover text (frame 1). */
export function signInOnTitle(machine: string): string {
  return `Opens a session on ${machine} and runs Claude Code's own sign-in there. The sign-in is kept on ${machine}.`
}

/**
 * The account's folder on that machine was made by the app on another
 * computer (phase 3's `elsewhere`, round 1: two of the user's computers on one
 * host login, or a shared one). This computer never reads, signs in, signs
 * out or removes it, so no surface offers Sign in there for it.
 */
export function hostElsewhere(acc: Pick<HostMachineAccounts, 'elsewhere'> | undefined, profileId: string): boolean {
  return !!acc?.elsewhere?.includes(profileId)
}

/**
 * Round 2 (R2-1): the account's folder there carries another install's mark,
 * and every such folder on that machine is named by one of this computer's
 * accounts (phase 3 round 2's `mayBeEarlierInstall`), so it may be this
 * computer's own from an earlier install of the app. The lines say so and
 * offer Adopt (the user's own choice; main's MACHINES_REMOTE_ACCOUNTS_ADOPT).
 */
export function hostEarlierInstall(acc: Pick<HostMachineAccounts, 'elsewhere' | 'mayBeEarlierInstall'> | undefined, profileId: string): boolean {
  return acc?.mayBeEarlierInstall === true && hostElsewhere(acc, profileId)
}

/** What the lines know of the account there besides its read state. */
export interface HostLineOptions {
  /** Its folder there is the app on another computer's (hostElsewhere). */
  elsewhere?: boolean
  /** Round 2 (R2-1): and it may be this computer's own (hostEarlierInstall). */
  earlierInstall?: boolean
  /** Why the machine's last read did not answer. */
  why?: string
}

/** The words for an account whose folder there another computer uses. */
export const ELSEWHERE_TEXT = 'Used by the app on another computer'
/** Round 2 (R2-1): the words for one that may be this computer's own. */
export const EARLIER_INSTALL_TEXT = 'May be this computer\'s own from an earlier install'

/** Its folder there blocks a sign-in from here: not signed in there (the
 *  machine's own sign-in as the account still starts it). */
const blockedElsewhere = (a: Pick<HostAccountSignIn, 'state'> | undefined, opts: HostLineOptions): boolean =>
  opts.elsewhere === true && a?.state === 'not-signed-in'

/**
 * An account card's line for one machine (frame 1, "On machines"): signed in
 * there (its own folder, or the machine's own sign-in, which says so), not
 * signed in with "Sign in on <machine>", signed in as another account (never
 * used; signing in again there replaces it), a folder that may be this
 * computer's own from an earlier install (Adopt), used by the app on another
 * computer (nothing offered), or not read since the app started.
 */
export function cardMachineLine(a: Pick<HostAccountSignIn, 'state' | 'facts'> | undefined, machine: string, opts: HostLineOptions = {}): HostSignInLine {
  if (blockedElsewhere(a, opts) && opts.earlierInstall) return { tone: 'warn', text: EARLIER_INSTALL_TEXT, sub: `Its folder on ${machine} carries another install's mark`, action: 'adopt', muted: false }
  if (blockedElsewhere(a, opts)) return { tone: 'none', text: ELSEWHERE_TEXT, sub: `Its folder on ${machine} is another computer's, which signs it in there`, muted: true }
  switch (a?.state) {
    case 'signed-in-here':
      return { tone: 'ok', text: `Signed in on ${machine}`, muted: false }
    case 'machine-own':
      return {
        tone: 'ok',
        text: `Signed in on ${machine}`,
        sub: `Its own sign-in, found when ${machine} was checked`,
        title: `${machine} was already signed in as this account, so the app uses that sign-in.`,
        muted: false,
      }
    case 'not-signed-in':
      return { tone: 'none', text: 'Not signed in', action: 'sign-in', muted: true }
    case 'someone-else': {
      const as = a.facts?.identity ? `As ${a.facts.identity}, so it is not used` : 'As an account it does not name, so it is not used'
      return { tone: 'warn', text: 'Signed in as another account', sub: as, action: 'sign-in', muted: false }
    }
    default:
      return { tone: 'none', text: 'Not read yet', sub: `Press Check on ${machine}'s card on the Machines page`, muted: true }
  }
}

/**
 * A row of a machine's "Accounts here" (frame 4): Sign out where the account
 * is signed in there (the machine's own sign-in too: that one asks first, Q5),
 * Sign in on that machine where it is not, and nothing while the machine was
 * not read or while its folder there is the app on another computer's. `who`
 * is the account's name on this computer.
 */
export function machineAccountLine(a: Pick<HostAccountSignIn, 'state' | 'facts'> | undefined, machine: string, who: string, opts: HostLineOptions = {}): HostSignInLine {
  if (blockedElsewhere(a, opts) && opts.earlierInstall) {
    return {
      tone: 'warn', text: EARLIER_INSTALL_TEXT,
      sub: `Its folder on ${machine} carries another install's mark. If it is this computer's own, Adopt makes it so again; if it is the app's on another computer, leave it.`,
      action: 'adopt', muted: false,
    }
  }
  if (blockedElsewhere(a, opts)) return { tone: 'none', text: ELSEWHERE_TEXT, sub: `Its folder on ${machine} was made by the app on another computer, which signs it in and out there.`, muted: true }
  const why = opts.why
  switch (a?.state) {
    case 'signed-in-here':
      return { tone: 'ok', text: `Signed in on ${machine}`, action: 'sign-out', muted: false }
    case 'machine-own':
      return { tone: 'ok', text: `Signed in on ${machine}`, sub: `${machine} was already signed in as ${who}, so that sign-in is used.`, action: 'sign-out', muted: false }
    case 'not-signed-in':
      return { tone: 'none', text: 'Not signed in', action: 'sign-in', muted: true }
    case 'someone-else': {
      const as = a.facts?.identity ? `as ${a.facts.identity}` : 'as an account it does not name'
      return { tone: 'warn', text: 'Signed in as another account', sub: `Its sign-in there is ${as}, so it is not used. Sign it out, then sign in again as ${who}.`, action: 'sign-out', muted: false }
    }
    default:
      return { tone: 'none', text: 'Not read yet', sub: why ? `Its last read did not answer: ${why}` : 'Press Check to read it.', muted: true }
  }
}

/** How the Switch Account list marks an account for a helper tab (frame 3). */
export interface HostSwitchMark {
  /** After the account's name: " · <text>". */
  text: string
  /** Drawn in the warning colour: picking it asks how to sign in there. */
  warn: boolean
  /** Hover text, when it says more. */
  title?: string
  /** Picking it opens the not-signed-in notice instead of switching. */
  needsSignIn: boolean
}

/**
 * The Switch Account list's mark for one account on the tab's machine:
 * signed in there, not signed in there, or signed in there as another
 * account. None while the machine was not read (the switch's launch reads it,
 * and says why when it starts nothing).
 */
export function switchMachineMark(a: Pick<HostAccountSignIn, 'state'> | undefined, machine: string, opts: HostLineOptions = {}): HostSwitchMark | undefined {
  if (hostLaunchable(a?.state)) return { text: `signed in on ${machine}`, warn: false, needsSignIn: false }
  if (blockedElsewhere(a, opts) && opts.earlierInstall) return { text: `may be this computer's own on ${machine}`, warn: true, needsSignIn: true, title: `Its folder on ${machine} carries another install's mark, and may be this computer's own from an earlier install. Choosing it asks how this session goes on.` }
  if (blockedElsewhere(a, opts)) return { text: `used by the app on another computer on ${machine}`, warn: true, needsSignIn: true, title: `Its folder on ${machine} is used by the app on another computer. Choosing it asks how this session goes on.` }
  if (a?.state === 'not-signed-in') return { text: `not signed in on ${machine}`, warn: true, needsSignIn: true, title: `Not signed in on ${machine}. Choosing it asks how to sign in there.` }
  if (a?.state === 'someone-else') return { text: `signed in as another account on ${machine}`, warn: true, needsSignIn: true, title: `Signed in on ${machine} as another account. Choosing it asks how to sign in there.` }
  return undefined
}

/** The machine a tab runs on: its kept session's machine (`remoteDid`),
 *  else the added machine its SSH target is. */
export function sessionMachine<M extends HostMachineRef>(
  session: { remoteDid?: string; sshConfig?: Pick<SshConfig, 'host' | 'port' | 'username'> } | null | undefined,
  machines: readonly M[],
): M | undefined {
  if (!session?.sshConfig) return undefined
  if (session.remoteDid) {
    const kept = machines.find((m) => m.did === session.remoteDid)
    if (kept) return kept
  }
  const target = sshTarget(session.sshConfig)
  return machines.find((m) => m.target === target)
}

/** A saved SSH config's target as a machine's card names it: `user@host:port`. */
export function sshTarget(ssh: Pick<SshConfig, 'host' | 'port' | 'username'>): string {
  return `${ssh.username}@${ssh.host}:${ssh.port ?? 22}`
}

/**
 * The saved SSH config a sign-in tab on `machine` starts from (phase 3's open
 * item): one whose target is the machine's and that the session helper takes
 * (key sign-in, no post-connect command, no container, not a Windows host),
 * the one the machine was added from first. Null when none is.
 */
export function signInConfigFor(machine: Pick<HostMachineRef, 'target' | 'label'>, configs: readonly TerminalConfig[]): TerminalConfig | null {
  const usable = configs.filter((c) => {
    const s = c.sessionType === 'ssh' ? c.sshConfig : undefined
    if (!s || sshTarget(s) !== machine.target) return false
    return s.hasPassword !== true && !s.postCommand?.trim() && !s.dockerContainer?.trim() && s.runtime?.type !== 'container' && s.remoteOs !== 'windows'
  })
  return usable.find((c) => c.label === machine.label) ?? usable[0] ?? null
}

/** What Remove signs out on a machine (frame 4), from its last read: the
 *  accounts whose own folder there holds a sign-in, the account signed in by
 *  the machine's own sign-in (which Remove leaves as it is), and whether the
 *  machine was read at all since the app started. */
export interface RemoveListing {
  /** The accounts signed in there in a folder of their own: each keyed by
   *  its account (two accounts may share a name), with its name. */
  signedIn: Array<{ key: string; name: string }>
  /** The account the machine's own sign-in is, or null. */
  own: string | null
  /** The machine was read since the app started. */
  read: boolean
  /** Account folders there the app on another computer made: Remove leaves them. */
  elsewhere: number
  /** Round 2 (R2-1): the names of the accounts whose folders there may be
   *  this computer's own from an earlier install (they stay; Adopt first). */
  earlier: string[]
  /** Round 2 (R2-1): folders an earlier build made there for accounts this
   *  computer does not hold, by profile id as main names them (they stay). */
  oldMarker: string[]
}

/** How many account folders on a machine belong to accounts this computer no longer holds, as words. */
function othersName(n: number): string {
  return n === 1 ? 'an account no longer on this computer' : `${n} accounts no longer on this computer`
}

/** Remove's sentence for the folders another computer's app uses there, which stay. */
export function elsewhereStayText(n: number): string {
  return n === 1
    ? 'One account folder there is used by the app on another computer and stays.'
    : `${n} account folders there are used by the app on another computer and stay.`
}

/** Round 2 (R2-1): Remove's sentence for folders that may be this computer's
 *  own from an earlier install, in main's words (its Remove answer), with the
 *  step that works before Remove: Adopt on this card. */
export function earlierInstallStayText(names: readonly string[]): string {
  const one = names.length === 1
  return `${names.join(', ')}: ${one ? 'its folder' : 'their folders'} there ${one ? 'carries' : 'carry'} another install's mark, and may be this computer's own from an earlier install of the app; Remove leaves ${one ? 'it as it is' : 'them as they are'}. To sign ${one ? 'it' : 'them'} out from here, choose Adopt on this card first.`
}

/** Round 2 (R2-1): Remove's sentence for the folders an earlier build made
 *  there for accounts this computer does not hold, named as main names them. */
export function oldMarkerStayText(ids: readonly string[]): string {
  const one = ids.length === 1
  return `${ids.join(', ')} (${one ? 'a folder' : 'folders'} an earlier build of the app made there, for ${one ? 'an account' : 'accounts'} this computer does not hold) ${one ? 'stays' : 'stay'} signed in there as ${one ? 'it is' : 'they are'}.`
}

/** Round 2 (R2-1): the confirm before Adopt, naming the accounts and what
 *  Adopt does and does not do (only their folders' marks change). */
export function adoptConfirmText(machine: string, names: readonly string[]): string {
  const one = names.length === 1
  return `Adopt ${joinNames(names)} on ${machine}? ${one ? 'Its folder' : 'Their folders'} there ${one ? 'carries' : 'carry'} another install's mark. If ${one ? 'it is' : 'they are'} this computer's own from an earlier install of the app, Adopt makes ${one ? 'it' : 'them'} this computer's again; nothing is signed in, out or removed. If ${one ? 'it is' : 'they are'} the app's on another computer, do not adopt ${one ? 'it' : 'them'}.`
}

/** Round 2 (R2-1): the folders on machine `acc` that Adopt may take: those
 *  its last read named as another install's, for accounts this computer
 *  holds (`held`), in the machine's order. */
export function adoptableIds(acc: Pick<HostMachineAccounts, 'elsewhere'> | undefined, held: ReadonlySet<string>): string[] {
  return (acc?.elsewhere ?? []).filter((id) => held.has(id))
}

/** Remove's listing for machine `acc` (undefined: never read). `nameOf`
 *  names an account of this computer. */
export function removeListing(acc: HostMachineAccounts | undefined, nameOf: (profileId: string) => string): RemoveListing {
  if (!acc || acc.readAt === null) return { signedIn: [], own: null, read: false, elsewhere: 0, earlier: [], oldMarker: [] }
  // A read that did not answer keeps each account's folder as the last one
  // that did found it (machineAccounts), so a folder there is listed.
  const signedIn = acc.accounts
    .filter((a) => a.folder && (acc.ok ? a.state === 'signed-in-here' || a.state === 'someone-else' : true))
    .map((a) => ({ key: a.profileId, name: nameOf(a.profileId) }))
  if (acc.others.length > 0) signedIn.push({ key: 'others', name: othersName(acc.others.length) })
  const own = acc.ok ? acc.accounts.find((a) => a.state === 'machine-own') : undefined
  const elsewhere = acc.elsewhere ?? []
  const earlier = acc.mayBeEarlierInstall === true ? elsewhere.map(nameOf) : []
  return {
    signedIn, own: own ? nameOf(own.profileId) : null, read: true,
    elsewhere: earlier.length > 0 ? 0 : elsewhere.length,
    earlier,
    oldMarker: [...(acc.oldMarker ?? [])],
  }
}

/** Names joined as a sentence lists them: "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Where to end a sign-in the app could not sign out (main's END_IT_THERE). */
export const END_SIGN_IN_THERE = 'in your Claude account settings on claude.ai'

/**
 * Remove's question when the machine did not answer (frame 4's second
 * variant): nothing can be signed out there now, each account left signed in
 * there and where to end it, and that the app forgets the machine while its
 * folder in ~/.aicc stays. "Remove anyway" forgets it.
 */
export function removeNotAnsweringText(machine: string, listing: RemoveListing): string {
  const head = `${machine} did not answer, so nothing can be signed out there now.`
  const tail = `The app forgets ${machine}; its folder in ~/.aicc stays.`
  if (!listing.read) return `${head} The app has not read which accounts are signed in on ${machine} since it started; any signed in there stay signed in until you sign them out there, or end those sign-ins ${END_SIGN_IN_THERE}. ${tail}`
  const n = listing.signedIn.length
  if (n === 0) return `${head} ${tail}`
  const one = n === 1
  return `${head} ${joinNames(listing.signedIn.map((x) => x.name))} ${one ? 'stays' : 'stay'} signed in on ${machine} until you sign ${one ? 'it' : 'them'} out there, or end ${one ? 'that sign-in' : 'those sign-ins'} ${END_SIGN_IN_THERE}. ${tail}`
}

/**
 * The confirm before signing out a machine's own sign-in (Q5): it names it as
 * the machine's own sign-in (its ~/.claude, not a folder the app made), and
 * that signing it out signs Claude Code out there for everything that uses it.
 */
export function machineOwnSignOutText(machine: string, who: string): string {
  return `${who} is signed in on ${machine} by that machine's own sign-in (its ~/.claude), not one the app made. Signing it out signs Claude Code out on ${machine} for everything that uses that sign-in.`
}

/** What This computer's card on the Machines page says of its accounts
 *  (frame 4). Lend from this computer is not built yet, so it is not named. */
export function thisComputerAccountsLine(n: number): string {
  return `${n === 1 ? 'Your Claude Code account signs' : `Your ${n} Claude Code accounts sign`} in on this computer. Add or remove accounts in Settings › Accounts; each Linux machine below keeps its own sign-ins.`
}

/** How many of this computer's Claude Code accounts are not signed in on a
 *  machine, counted once per machine (frame 1's summary). `active`: the
 *  accounts the page offers (a parked one is never signed in from it). */
export function toSignInCount(machines: readonly Pick<HostMachineRef, 'did'>[], byDid: Readonly<Record<string, HostMachineAccounts | undefined>>, active: ReadonlySet<string>): number {
  let n = 0
  for (const m of machines) {
    for (const a of byDid[m.did]?.accounts ?? []) if (active.has(a.profileId) && a.state === 'not-signed-in') n++
  }
  return n
}
