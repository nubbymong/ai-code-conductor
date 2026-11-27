// tests/unit/renderer/host-accounts-lines.test.ts
//
// 2.1.3-beta.20 section 5 (Accounts across machines, the approved mockup
// frames 1 to 4, Claude Code rows only): what an account card, a machine's
// "Accounts here" row, the Switch Account list and Remove's question say of
// one account's sign-in on one machine, per state of its last read.
//
// PURE: utils/hostAccounts.ts only, no React, no IPC.
import { describe, it, expect } from 'vitest'
import {
  cardMachineLine, machineAccountLine, switchMachineMark, sessionMachine, signInConfigFor, sshTarget,
  removeListing, removeNotAnsweringText, machineOwnSignOutText, toSignInCount, joinNames, hostLaunchable, signInOnTitle,
  elsewhereStayText, hostElsewhere, hostEarlierInstall, earlierInstallStayText, oldMarkerStayText, adoptConfirmText, adoptButtonTitle,
  hostAccountName, adoptTitleOn, adoptNextText,
} from '../../../src/renderer/utils/hostAccounts'
import type { HostMachineAccounts, HostSignInFacts } from '../../../src/shared/host-accounts'
import type { TerminalConfig } from '../../../src/renderer/stores/configStore'

const facts = (identity: string | null): HostSignInFacts => ({ identity, plan: 'max', tier: null, expiresAt: 1, credentials: true })
const DID = 'a'.repeat(32)
const ROCKY = { did: DID, name: 'Rocky', target: 'nick@rocky.lan:22', label: 'Rocky' }

describe('an account card\'s line for one machine (frame 1)', () => {
  it('signed in in its own folder: "Signed in on <machine>", no button', () => {
    expect(cardMachineLine({ state: 'signed-in-here', facts: facts('w@x.io') }, 'Rocky')).toEqual({ tone: 'ok', text: 'Signed in on Rocky', muted: false })
  })
  it('the machine\'s own sign-in: signed in, and says it is the machine\'s own', () => {
    const l = cardMachineLine({ state: 'machine-own', facts: facts('w@x.io') }, 'Rocky')
    expect(l.tone).toBe('ok')
    expect(l.text).toBe('Signed in on Rocky')
    expect(l.sub).toBe('Its own sign-in, found when Rocky was checked')
    expect(l.title).toBe('Rocky was already signed in as this account, so the app uses that sign-in.')
    expect(l.action).toBeUndefined()
  })
  it('not signed in: muted, with "Sign in on <machine>"', () => {
    expect(cardMachineLine({ state: 'not-signed-in', facts: null }, 'Rocky')).toEqual({ tone: 'none', text: 'Not signed in', action: 'sign-in', muted: true })
    expect(signInOnTitle('Rocky')).toBe('Opens a session on Rocky and runs Claude Code\'s own sign-in there. The sign-in is kept on Rocky.')
  })
  it('signed in as another account: marked, never used, and signing in again there is offered', () => {
    const l = cardMachineLine({ state: 'someone-else', facts: facts('other@x.io') }, 'Rocky')
    expect(l).toEqual({ tone: 'warn', text: 'Signed in as another account', sub: 'As other@x.io, so it is not used', action: 'sign-in', muted: false })
    expect(cardMachineLine({ state: 'someone-else', facts: facts(null) }, 'Rocky').sub).toBe('As an account it does not name, so it is not used')
  })
  it('not read since the app started (or no row): muted, no button, names Check', () => {
    for (const a of [{ state: 'not-read' as const, facts: null }, undefined]) {
      const l = cardMachineLine(a, 'Rocky')
      expect(l).toEqual({ tone: 'none', text: 'Not read yet', sub: 'Press Check on Rocky\'s card on the Machines page', muted: true })
    }
  })
})

describe('a machine\'s "Accounts here" row (frame 4)', () => {
  it('signed in: Sign out; the machine\'s own sign-in says so and offers Sign out too (it asks first)', () => {
    expect(machineAccountLine({ state: 'signed-in-here', facts: facts('w@x.io') }, 'Rocky', 'Work')).toEqual({ tone: 'ok', text: 'Signed in on Rocky', action: 'sign-out', muted: false })
    expect(machineAccountLine({ state: 'machine-own', facts: facts('w@x.io') }, 'Rocky', 'Work')).toEqual({
      tone: 'ok', text: 'Signed in on Rocky', sub: 'Rocky was already signed in as Work, so that sign-in is used.', action: 'sign-out', muted: false,
    })
  })
  it('not signed in: Sign in on that machine', () => {
    expect(machineAccountLine({ state: 'not-signed-in', facts: null }, 'Rocky', 'Personal')).toEqual({ tone: 'none', text: 'Not signed in', action: 'sign-in', muted: true })
  })
  it('signed in as another account: marked, Sign out offered, and what to do next', () => {
    expect(machineAccountLine({ state: 'someone-else', facts: facts('other@x.io') }, 'Rocky', 'Personal')).toEqual({
      tone: 'warn', text: 'Signed in as another account', sub: 'Its sign-in there is as other@x.io, so it is not used. Sign it out, then sign in again as Personal.', action: 'sign-out', muted: false,
    })
  })
  it('not read: no button; says why the last read did not answer, or to press Check', () => {
    expect(machineAccountLine({ state: 'not-read', facts: null }, 'Rocky', 'Work')).toEqual({ tone: 'none', text: 'Not read yet', sub: 'Press Check to read it.', muted: true })
    expect(machineAccountLine({ state: 'not-read', facts: null }, 'Rocky', 'Work', { why: 'rocky.lan could not be reached' }).sub).toBe('Its last read did not answer: rocky.lan could not be reached')
  })
})

describe('the Switch Account list\'s mark on a helper tab (frame 3)', () => {
  it('signed in there (its own folder or the machine\'s own): " · signed in on <machine>", picked as a switch', () => {
    for (const state of ['signed-in-here', 'machine-own'] as const) {
      expect(switchMachineMark({ state }, 'Rocky')).toEqual({ text: 'signed in on Rocky', warn: false, needsSignIn: false })
      expect(hostLaunchable(state)).toBe(true)
    }
  })
  it('not signed in there: warned, and picking it asks how to sign in there', () => {
    expect(switchMachineMark({ state: 'not-signed-in' }, 'Rocky')).toEqual({ text: 'not signed in on Rocky', warn: true, needsSignIn: true, title: 'Not signed in on Rocky. Choosing it asks how to sign in there.' })
    expect(switchMachineMark({ state: 'someone-else' }, 'Rocky')).toMatchObject({ warn: true, needsSignIn: true })
    expect(hostLaunchable('not-signed-in')).toBe(false)
    expect(hostLaunchable('someone-else')).toBe(false)
  })
  it('not read: no mark (the launch reads it)', () => {
    expect(switchMachineMark({ state: 'not-read' }, 'Rocky')).toBeUndefined()
    expect(switchMachineMark(undefined, 'Rocky')).toBeUndefined()
    expect(hostLaunchable(undefined)).toBe(false)
  })
})

describe('which machine a tab runs on, and which saved config a sign-in tab starts from', () => {
  const PI = { did: 'b'.repeat(32), name: 'Pi', target: 'tester@pi.lan:22', label: 'Pi' }
  it('the kept session\'s machine first, else the machine its SSH target is', () => {
    expect(sessionMachine({ remoteDid: PI.did, sshConfig: { host: 'rocky.lan', port: 22, username: 'nick' } }, [ROCKY, PI])).toBe(PI)
    expect(sessionMachine({ sshConfig: { host: 'rocky.lan', port: 22, username: 'nick' } }, [ROCKY, PI])).toBe(ROCKY)
    expect(sessionMachine({ sshConfig: { host: 'other.lan', port: 22, username: 'nick' } }, [ROCKY, PI])).toBeUndefined()
    expect(sessionMachine({}, [ROCKY])).toBeUndefined()
    expect(sshTarget({ host: 'rocky.lan', port: 2222, username: 'nick' })).toBe('nick@rocky.lan:2222')
  })
  it('a config the helper takes, to the machine\'s target, the one it was added from first', () => {
    const base = { workingDirectory: '', color: '#fff', sessionType: 'ssh' as const }
    const cfg = (id: string, label: string, ssh: Partial<NonNullable<TerminalConfig['sshConfig']>>): TerminalConfig => ({ ...base, id, label, sshConfig: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', ...ssh } }) as TerminalConfig
    const password = cfg('p', 'Rocky', { hasPassword: true })
    const post = cfg('q', 'Rocky', { postCommand: 'docker exec -it x bash' })
    const container = cfg('c', 'Rocky', { runtime: { type: 'container', container: 'x' } })
    const windows = cfg('w', 'Rocky', { remoteOs: 'windows' })
    const other = cfg('o', 'Rocky other', {})
    const added = cfg('a', 'Rocky', {})
    const elsewhere = cfg('e', 'Rocky', { host: 'pi.lan' })
    expect(signInConfigFor(ROCKY, [password, post, container, windows, elsewhere])).toBeNull()
    expect(signInConfigFor(ROCKY, [password, other, added])?.id).toBe('a')
    expect(signInConfigFor(ROCKY, [password, other])?.id).toBe('o')
  })
})

describe('Remove\'s question lists the accounts signed in there (frame 4)', () => {
  const nameOf = (id: string) => ({ p1: 'Work', p2: 'Personal', p3: 'Spare' } as Record<string, string>)[id] ?? id
  const acc = (over: Partial<HostMachineAccounts> = {}): HostMachineAccounts => ({
    did: DID, readAt: 1, ok: true, own: null, others: [],
    accounts: [
      { profileId: 'p1', state: 'signed-in-here', facts: facts('w@x.io'), folder: true },
      { profileId: 'p2', state: 'machine-own', facts: facts('p@x.io'), folder: false },
      { profileId: 'p3', state: 'not-signed-in', facts: null, folder: true },
    ],
    ...over,
  })
  const names = (l: { signedIn: Array<{ name: string }> }) => l.signedIn.map((x) => x.name)
  it('lists each account with a sign-in of its own there, and names the machine\'s own sign-in apart', () => {
    expect(removeListing(acc(), nameOf)).toEqual({ signedIn: [{ key: 'p1', name: 'Work' }], own: 'Personal', read: true, elsewhere: 0, earlier: [], oldMarker: [] })
  })
  it('a folder signed in as another account is signed out too; folders of removed accounts are counted', () => {
    const l = removeListing(acc({ accounts: [{ profileId: 'p3', state: 'someone-else', facts: facts('o@x.io'), folder: true }], others: ['p9', 'p8'] }), nameOf)
    expect(names(l)).toEqual(['Spare', '2 accounts no longer on this computer'])
    expect(names(removeListing(acc({ accounts: [], others: ['p9'] }), nameOf))).toEqual(['an account no longer on this computer'])
  })
  // NIT-7 (round 1): two accounts may share a name; each item keys by its account, not its name.
  it('each item keys by its account, so two accounts of one name are two items', () => {
    const same = (id: string) => (id === 'p1' || id === 'p3' ? 'Work' : id)
    const l = removeListing(acc({ accounts: [
      { profileId: 'p1', state: 'signed-in-here', facts: facts('w@x.io'), folder: true },
      { profileId: 'p3', state: 'signed-in-here', facts: facts('w2@x.io'), folder: true },
    ] }), same)
    expect(l.signedIn).toEqual([{ key: 'p1', name: 'Work' }, { key: 'p3', name: 'Work' }])
    expect(new Set(l.signedIn.map((x) => x.key)).size).toBe(2)
  })
  // MINOR-2 (round 1): folders the app on another computer made there stay, and the question says so.
  it('counts the folders used by the app on another computer, which Remove leaves', () => {
    expect(removeListing(acc({ elsewhere: ['p2', 'x9'] }), nameOf).elsewhere).toBe(2)
    expect(elsewhereStayText(1)).toBe('One account folder there is used by the app on another computer and stays.')
    expect(elsewhereStayText(2)).toBe('2 account folders there are used by the app on another computer and stay.')
  })
  it('never read since the app started: nothing listed, and it says so', () => {
    expect(removeListing(undefined, nameOf)).toEqual({ signedIn: [], own: null, read: false, elsewhere: 0, earlier: [], oldMarker: [] })
    expect(removeListing(acc({ readAt: null }), nameOf).read).toBe(false)
  })
  it('a last read that did not answer: the folders the last answer found are listed', () => {
    const l = removeListing(acc({ ok: false, why: 'no answer', accounts: [
      { profileId: 'p1', state: 'not-read', facts: null, folder: true },
      { profileId: 'p2', state: 'not-read', facts: null, folder: false },
    ] }), nameOf)
    expect(l).toEqual({ signedIn: [{ key: 'p1', name: 'Work' }], own: null, read: true, elsewhere: 0, earlier: [], oldMarker: [] })
  })
  it('the machine did not answer: what stays signed in there, where to end it, and that the folder stays', () => {
    const l = (n: string[], read = true) => ({ signedIn: n.map((name) => ({ key: name, name })), own: null, read, elsewhere: 0, earlier: [], oldMarker: [] })
    expect(removeNotAnsweringText('Pi', l(['Work']))).toBe(
      'Pi did not answer, so nothing can be signed out there now. Work stays signed in on Pi until you sign it out there, or end that sign-in in your Claude account settings on claude.ai. The app forgets Pi; its folder in ~/.aicc stays.')
    expect(removeNotAnsweringText('Pi', l(['Work', 'Personal']))).toContain('Work and Personal stay signed in on Pi until you sign them out there, or end those sign-ins')
    expect(removeNotAnsweringText('Pi', l([]))).toBe('Pi did not answer, so nothing can be signed out there now. The app forgets Pi; its folder in ~/.aicc stays.')
    expect(removeNotAnsweringText('Pi', l([], false))).toContain('The app has not read which accounts are signed in on Pi since it started')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C')
  })
})

// MINOR-2 (round 1): an account of this computer whose folder on that machine
// the app on another computer made (phase 3's `elsewhere`): main never reads,
// signs in or signs out that folder, so no surface offers Sign in there.
describe('an account whose folder there is the app on another computer\'s', () => {
  it('the card, the Machines row and the Switch Account list say so, and offer no Sign in', () => {
    const card = cardMachineLine({ state: 'not-signed-in', facts: null }, 'Rocky', { elsewhere: true })
    expect(card).toEqual({ tone: 'none', text: 'Used by the app on another computer', sub: 'Its folder on Rocky is another computer\'s, which signs it in there', muted: true })
    const here = machineAccountLine({ state: 'not-signed-in', facts: null }, 'Rocky', 'Personal', { elsewhere: true })
    expect(here).toEqual({ tone: 'none', text: 'Used by the app on another computer', sub: 'Its folder on Rocky was made by the app on another computer, which signs it in and out there.', muted: true })
    expect(here.action).toBeUndefined()
    expect(switchMachineMark({ state: 'not-signed-in' }, 'Rocky', { elsewhere: true })).toEqual({
      text: 'used by the app on another computer on Rocky', warn: true, needsSignIn: true,
      title: 'Its folder on Rocky is used by the app on another computer. Choosing it asks how this session goes on.',
    })
  })
  it('the machine\'s own sign-in as that account still starts it, and says so', () => {
    expect(cardMachineLine({ state: 'machine-own', facts: facts('p@x.io') }, 'Rocky', { elsewhere: true }).text).toBe('Signed in on Rocky')
    expect(machineAccountLine({ state: 'machine-own', facts: facts('p@x.io') }, 'Rocky', 'Personal', { elsewhere: true }).action).toBe('sign-out')
    expect(switchMachineMark({ state: 'machine-own' }, 'Rocky', { elsewhere: true })?.needsSignIn).toBe(false)
  })
  it('hostElsewhere reads the machine\'s list', () => {
    const acc = { did: DID, readAt: 1, ok: true, own: null, others: [], accounts: [], elsewhere: ['p2'] } as HostMachineAccounts
    expect(hostElsewhere(acc, 'p2')).toBe(true)
    expect(hostElsewhere(acc, 'p1')).toBe(false)
    expect(hostElsewhere({ ...acc, elsewhere: undefined }, 'p2')).toBe(false)
    expect(hostElsewhere(undefined, 'p2')).toBe(false)
  })
})

// R2-1 (round 2): phase 3's round 2 says, by `mayBeEarlierInstall`, that every
// folder there carrying another install's mark is named by one of this
// computer's accounts, so they may be its own from an earlier install. Then
// the lines say so and offer Adopt (the user's own choice), in main's words;
// only when it is false do they say "another computer" with nothing offered.
describe('a folder that may be this computer\'s own from an earlier install', () => {
  const read = (may: boolean) => ({ did: DID, readAt: 1, ok: true, own: null, others: [], accounts: [], elsewhere: ['p2'], mayBeEarlierInstall: may }) as HostMachineAccounts
  it('hostEarlierInstall: its folder is another install\'s and the machine may be this computer\'s own', () => {
    expect(hostEarlierInstall(read(true), 'p2')).toBe(true)
    expect(hostEarlierInstall(read(false), 'p2')).toBe(false)
    expect(hostEarlierInstall(read(true), 'p1')).toBe(false)
    expect(hostEarlierInstall(undefined, 'p2')).toBe(false)
  })
  it('the card, the Machines row and the Switch Account list say so, with Adopt', () => {
    const o = { elsewhere: true, earlierInstall: true }
    expect(cardMachineLine({ state: 'not-signed-in', facts: null }, 'Rocky', o)).toEqual({
      tone: 'warn', text: 'May be this computer\'s own from an earlier install', sub: 'Its folder on Rocky carries another install\'s mark', action: 'adopt', muted: false,
    })
    expect(machineAccountLine({ state: 'not-signed-in', facts: null }, 'Rocky', 'Personal', o)).toEqual({
      tone: 'warn', text: 'May be this computer\'s own from an earlier install',
      sub: 'Its folder on Rocky carries another install\'s mark. If it is this computer\'s own, Adopt makes it so again; if it is the app\'s on another computer, leave it.',
      action: 'adopt', muted: false,
    })
    expect(switchMachineMark({ state: 'not-signed-in' }, 'Rocky', o)).toEqual({
      text: 'may be this computer\'s own on Rocky', warn: true, needsSignIn: true,
      title: 'Its folder on Rocky carries another install\'s mark, and may be this computer\'s own from an earlier install. Choosing it asks how this session goes on.',
    })
    // Not adoptable: the plain "another computer" words, with nothing offered.
    expect(cardMachineLine({ state: 'not-signed-in', facts: null }, 'Rocky', { elsewhere: true, earlierInstall: false }).action).toBeUndefined()
    expect(machineAccountLine({ state: 'not-signed-in', facts: null }, 'Rocky', 'Personal', { elsewhere: true }).text).toBe('Used by the app on another computer')
  })
  it('Remove names them as main does, and the old-marker folders main leaves', () => {
    const nameOf = (id: string) => ({ p2: 'Personal', p3: 'Spare' } as Record<string, string>)[id] ?? id
    const l = removeListing({ ...read(true), elsewhere: ['p2', 'p3'], oldMarker: ['zz9'] }, nameOf)
    expect(l.earlier).toEqual(['Personal', 'Spare'])
    expect(l.elsewhere).toBe(0)
    expect(l.oldMarker).toEqual(['zz9'])
    expect(removeListing({ ...read(false), elsewhere: ['p2', 'x8'] }, nameOf)).toMatchObject({ earlier: [], elsewhere: 2 })
    expect(earlierInstallStayText(['Personal'])).toBe('Personal: its folder there carries another install\'s mark, and may be this computer\'s own from an earlier install of the app; Remove leaves it as it is. To sign it out from here, choose Adopt on this card first.')
    expect(earlierInstallStayText(['Personal', 'Spare'])).toBe('Personal, Spare: their folders there carry another install\'s mark, and may be this computer\'s own from an earlier install of the app; Remove leaves them as they are. To sign them out from here, choose Adopt on this card first.')
    expect(oldMarkerStayText(['zz9'])).toBe('zz9 (a folder an earlier build of the app made there, for an account this computer does not hold) stays signed in there as it is.')
    expect(oldMarkerStayText(['zz9', 'zz8'])).toBe('zz9, zz8 (folders an earlier build of the app made there, for accounts this computer does not hold) stay signed in there as they are.')
  })
  it('Adopt asks first, naming the accounts and what it does and does not do', () => {
    expect(adoptConfirmText('Rocky', ['Personal'])).toBe('Adopt Personal on Rocky? Its folder there carries another install\'s mark. If it is this computer\'s own from an earlier install of the app, Adopt makes it this computer\'s again; nothing is signed in, out or removed. If it is the app\'s on another computer, do not adopt it.')
    expect(adoptConfirmText('Rocky', ['Personal', 'Spare'])).toContain('Adopt Personal and Spare on Rocky? Their folders there carry')
  })
  // R3-3 (round 3): the Adopt button's hover text names every folder it adopts on that machine.
  // R4-6 (round 4): and says what Adopt does with them, not only the button's label again.
  it('the Adopt button names what it adopts, and what Adopt does', () => {
    expect(adoptButtonTitle('Rocky', ['Personal'])).toBe("Asks first, then makes the folder for Personal on Rocky this computer's again. It carries another install's mark and may be this computer's own from an earlier install.")
    expect(adoptButtonTitle('Rocky', ['Personal', 'Spare'])).toBe("Asks first, then makes the folders for Personal and Spare on Rocky this computer's again. They carry another install's mark and may be this computer's own from an earlier install.")
  })
  // R4-5 (round 4): the hover text names the accounts as Adopt's confirm
  // names them (the profile's name, else its alias, else its email), so the
  // two always match; R4-7: one helper, the card's and the row's.
  it('the hover text names the accounts as the confirm does', () => {
    const profiles = [
      { id: 'p2', name: 'Personal', accountEmail: 'p@x.io' },
      { id: 'p3', name: '', accountEmail: 's@x.io' },
      { id: 'p4', name: '', accountEmail: 'n@x.io' },
    ]
    const nameOf = hostAccountName(profiles, { 's@x.io': 'Spare' })
    expect(['p2', 'p3', 'p4', 'p9'].map(nameOf)).toEqual(['Personal', 'Spare', 'n@x.io', 'That account'])
    const acc = { ...read(true), elsewhere: ['p2', 'p3', 'zz9'] }
    expect(adoptTitleOn('Rocky', acc, profiles, { 's@x.io': 'Spare' })).toBe("Asks first, then makes the folders for Personal and Spare on Rocky this computer's again. They carry another install's mark and may be this computer's own from an earlier install.")
  })
  // R4-1, R4-3, R4-4 (round 4): Adopt's next step names the tab only when its
  // own account was adopted, by why it asked (a start: Restart it; a switch:
  // Switch it again); else a tab on the account adopted, or on one of them.
  // The accounts are named: main's answer may name one it did not adopt.
  it('Adopt\'s next step', () => {
    const nameOf = (id: string) => ({ p2: 'Personal', p3: 'Spare', p4: 'Work' } as Record<string, string>)[id] ?? id
    const launch = { label: 'web-app', profileId: 'p2', kind: 'launch' as const }
    const sw = { ...launch, kind: 'switch' as const }
    expect(adoptNextText([], nameOf, launch)).toBe('')
    expect(adoptNextText([], nameOf)).toBe('')
    expect(adoptNextText(['p2'], nameOf, launch)).toBe('Restart web-app to start it there.')
    expect(adoptNextText(['p2', 'p3'], nameOf, launch)).toBe('Restart web-app to start it there.')
    expect(adoptNextText(['p2'], nameOf, sw)).toBe('Switch web-app to Personal again to move it there.')
    expect(adoptNextText(['p3'], nameOf, launch)).toBe('Restart a tab on Spare to start it there.')
    expect(adoptNextText(['p3'], nameOf, sw)).toBe('Restart a tab on Spare to start it there.')
    expect(adoptNextText(['p3', 'p4'], nameOf, launch)).toBe('Restart a tab on one of those accounts, Spare or Work, to start it there.')
    expect(adoptNextText(['p2'], nameOf)).toBe('Restart a tab on Personal to start it there.')
    expect(adoptNextText(['p2', 'p3', 'p4'], nameOf)).toBe('Restart a tab on one of those accounts, Personal, Spare or Work, to start it there.')
  })
})

describe('signing out a machine\'s own sign-in asks first, naming it so (Q5)', () => {
  it('names it as the machine\'s own sign-in and what signing it out does', () => {
    expect(machineOwnSignOutText('Rocky', 'Work')).toBe('Work is signed in on Rocky by that machine\'s own sign-in (its ~/.claude), not one the app made. Signing it out signs Claude Code out on Rocky for everything that uses that sign-in.')
  })
})

describe('the summary\'s "to sign in on a machine" count (frame 1)', () => {
  it('counts each active account not signed in, once per machine', () => {
    const PI = 'b'.repeat(32)
    const byDid: Record<string, HostMachineAccounts> = {
      [DID]: { did: DID, readAt: 1, ok: true, own: null, others: [], accounts: [
        { profileId: 'p1', state: 'signed-in-here', facts: null, folder: true },
        { profileId: 'p2', state: 'not-signed-in', facts: null, folder: false },
        { profileId: 'p3', state: 'not-signed-in', facts: null, folder: false },
      ] },
      [PI]: { did: PI, readAt: 1, ok: true, own: null, others: [], accounts: [
        { profileId: 'p1', state: 'not-signed-in', facts: null, folder: false },
        { profileId: 'p2', state: 'not-read', facts: null, folder: false },
      ] },
    }
    expect(toSignInCount([{ did: DID }, { did: PI }], byDid, new Set(['p1', 'p2']))).toBe(2)
    expect(toSignInCount([{ did: DID }], byDid, new Set(['p1', 'p2', 'p3']))).toBe(2)
    expect(toSignInCount([], byDid, new Set(['p1']))).toBe(0)
  })
})
