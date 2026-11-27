// src/renderer/utils/hostSignIn.ts
//
// 2.1.3-beta.20 section 5: "Sign in on <machine>" (an account card, a
// machine's "Accounts here" row, the not-signed-in notice). It opens a
// sign-in tab: a pty spawn with the machine's saved SSH config, the account
// (`profileId`) and HOST_SIGN_IN_SPAWN_FIELD, which main runs through the
// session helper as the CLI's own sign-in in that account's folder there
// (phase 3, remote-helper/index.ts signInPty). Its end reads the machine
// again, and the cards and the Machines page follow from that read.
//
// The tab is transient (never saved, so never resumed) and shell-only (never
// switched, never asked for an account at its start), and its SSH config is
// a plain SSH one (its close asks nothing; main runs it so anyway).
import { generateId } from './id'
import { useSessionStore } from '../stores/sessionStore'
import { useConfigStore } from '../stores/configStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { goToSession } from '../lib/goToSession'
import { hostAccountNamer, machineLabel, signInConfigFor, type HostMachineRef } from './hostAccounts'

/** The account's name as the app's lists name it (its profile's name, else
 *  its alias, else its email), over the stores. Phase 5 round 5 (R5-2): by
 *  the one naming rule, hostAccountNamer. Final review round 3 (F3-1): with
 *  its words for an account with no name, or one this computer does not
 *  hold, in lower case, as they end the tab's name. */
export function hostAccountName(profileId: string): string {
  return hostAccountNamer(useAccountProfilesStore.getState().profiles, useSettingsStore.getState().settings.accountAliases)(profileId)
}

/** The sign-in tab's name. */
export function hostSignInTabLabel(machine: string, who: string): string {
  return `Sign in on ${machine}: ${who}`
}

/**
 * Open a sign-in tab for `profileId` on `machine` and bring it forward.
 * Refused, saying why, when no saved SSH config that the session helper
 * takes reaches that machine.
 */
export function openHostSignInTab(machine: HostMachineRef, profileId: string): { ok: true; sessionId: string } | { ok: false; why: string } {
  const config = signInConfigFor(machine, useConfigStore.getState().configs)
  const where = machineLabel(machine)
  if (!config?.sshConfig) {
    return { ok: false, why: `No saved SSH config with key sign-in reaches ${where}, so no sign-in tab can open there. Save one for it (no post-connect command, no container), then try again.` }
  }
  const s = config.sshConfig
  const id = generateId()
  useSessionStore.getState().addSession({
    id,
    label: hostSignInTabLabel(where, hostAccountName(profileId)),
    workingDirectory: '',
    model: '',
    // The default colour of tabs the app opens itself (as useReauthAccount).
    color: '#89B4FA',
    status: 'idle',
    createdAt: Date.now(),
    sessionType: 'ssh',
    shellOnly: true,
    transient: true,
    provider: 'claude',
    profileId,
    remoteAccountSignIn: true,
    sshConfig: {
      host: s.host,
      port: s.port,
      username: s.username,
      remotePath: s.remotePath,
      hasPassword: s.hasPassword,
      remoteOs: s.remoteOs,
      detachable: false,
    },
  })
  goToSession(id)
  return { ok: true, sessionId: id }
}
