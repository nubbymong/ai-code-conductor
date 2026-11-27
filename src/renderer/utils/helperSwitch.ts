// src/renderer/utils/helperSwitch.ts
//
// 2.1.3-beta.20 section 5: Switch Account on a tab through the session helper
// (frame 3). As a local tab's: pin the new account and Restart on it; the
// tab's launch on its machine then runs in that account's own folder there
// (phase 3, remote-helper/host-accounts.ts accountBinding), and its CLI
// continues the conversation (carryConversation: its SSH `reconnect`), which
// is there for every account because each account's folder links
// `~/.claude/projects` (shared/account-folder.ts).
//
// Two things a local switch does not need:
//  - An account not signed in on that machine (as its last read found it) is
//    not switched to: the not-signed-in notice opens instead (frame 2), with
//    Sign in on that machine, another account signed in there, and Cancel.
//  - A tab whose session the helper keeps until it is ended would only attach
//    again to that session, which runs on the old account; so its session is
//    ended first (End, as its close question's), then the tab starts on the
//    new account. When that End fails the tab stays on its account, starts
//    again there, and the app says why. While nothing is known of the account
//    there (the machine not read yet) nothing is ended: the app says to press
//    Check first (round 1, NIT-8).
import type { Session } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useHostAccountsStore } from '../stores/hostAccountsStore'
import { isAccountActive } from '../../shared/account-types'
import { persistLastUsedAccount } from '../session-persistence'
import { hostElsewhere, hostLaunchable, machineLabel, sessionMachine } from './hostAccounts'

/** Tabs whose switch is ending their kept session: a second pick meanwhile is ignored. */
const switching = new Set<string>()

/** The two ids name different accounts (undefined: the machine's own sign-in). */
function differs(current: string | undefined, next: string | undefined): boolean {
  return (current ?? undefined) !== (next ?? undefined)
}

/**
 * Switch helper tab `session` to account `nextId`. `restart` is the tab's
 * Restart (useRestartSession). `carry` (default on): the next start
 * continues the tab's conversation; off for a new tab whose first launch
 * started nothing (the notice's other account), which starts a new one.
 * Returns what it did: `notice` (the account is not signed in there: the
 * notice opened), `switching`, or `none` (nothing to do: the same account,
 * an account that is not active, or a switch in progress).
 */
export function switchHelperTabAccount(
  session: Session,
  nextId: string | undefined,
  restart: (overrides?: Partial<Session>) => boolean,
  opts: { carry?: boolean } = {},
): 'notice' | 'switching' | 'none' {
  if (!nextId || !differs(session.profileId, nextId) || switching.has(session.id)) return 'none'
  const target = useAccountProfilesStore.getState().profiles.find((p) => p.id === nextId)
  if (!target || !isAccountActive(target)) return 'none'
  const host = useHostAccountsStore.getState()
  // Round 1 (MAJOR-1): a switch is the tab's own next step; a wait it had for
  // a sign-in is over.
  host.dropWaits(session.id)
  const machine = sessionMachine(session, host.machines)
  const acc = machine ? host.byDid[machine.did] : undefined
  const there = acc?.accounts.find((a) => a.profileId === nextId)
  if (machine && acc && (there?.state === 'not-signed-in' || there?.state === 'someone-else')) {
    host.openNotice({
      kind: 'switch',
      sessionId: session.id,
      did: machine.did,
      machineName: machineLabel(machine),
      profileId: nextId,
      state: there.state,
      ...(there.state === 'someone-else' && there.facts?.identity ? { identity: there.facts.identity } : {}),
      signedInThere: acc.accounts.filter((a) => hostLaunchable(a.state) && a.profileId !== nextId && a.profileId !== session.profileId).map((a) => a.profileId),
      carry: opts.carry !== false,
      ...(hostElsewhere(acc, nextId) ? { elsewhere: true } : {}),
    })
    return 'notice'
  }
  // The saved mark counts on an SSH Persistent tab only (isHelperTab).
  const kept = session.remoteVia === 'helper' && session.sshConfig?.detachable !== false
  // Round 1 (NIT-8): ending a kept session before anything is known of the
  // account there could leave the tab with nothing running; Check first.
  if (kept && !hostLaunchable(there?.state)) {
    const where = machine ? machineLabel(machine) : 'its machine'
    host.showMessage({
      title: 'Switch account',
      text: `Which accounts are signed in on ${where} has not been read yet, so nothing was switched and the session this tab keeps there runs on. Press Check on ${where}'s card on the Machines page, then switch again.`,
    })
    return 'none'
  }
  const sessionId = session.id
  switching.add(sessionId)
  void (async () => {
    try {
      if (kept) {
        let ended = false
        let why = ''
        try {
          const r = await window.electronAPI?.machines?.remote?.endTab?.(sessionId, session.remoteDid)
          ended = r?.ok === true
          why = r?.message ?? ''
        } catch {
          why = 'The app did not answer.'
        }
        if (!ended) {
          useHostAccountsStore.getState().showMessage({
            title: 'Switch account',
            text: `The switch did not happen: the session this tab keeps on ${machine ? machineLabel(machine) : 'its machine'} could not be ended first, so the tab stays on its account and starts again there.${why ? ` ${why}` : ''}`,
          })
          restart()
          return
        }
      }
      void persistLastUsedAccount(sessionId, nextId)
      restart(opts.carry === false ? { profileId: nextId } : { profileId: nextId, carryConversation: true })
    } finally {
      switching.delete(sessionId)
    }
  })()
  return 'switching'
}
