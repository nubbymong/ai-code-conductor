/**
 * The route for an SSH Persistent tab (plan 2.1.3-beta.19 section 1.2;
 * aicc_planning#437; D13): with the switch on, it goes through the session
 * helper, kept until it is ended, when every other check passes, the
 * machine's last Check read logind as not ending the user's processes at
 * logout, and the tab is not under tmux (its own session last started on the
 * usual path, or its config has a session there). A plain SSH tab keeps
 * beta.18's away clock. A marked tab never takes the usual path: where the
 * helper cannot take it, nothing starts and the tab says the step.
 */
import { describe, it, expect } from 'vitest'
import { MARKED_STEP, ROUTE_WHY, routeSshTab, type PersistentStanding, type RouteInput } from '../../../src/main/remote-helper/route'
import { logoutCleanUp, persistentNote, type RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'ubuntu.lan', port: 22, user: 'nick', label: 'Ubuntu', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/bin/claude',
  path: '/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: 'root', linger: 'no' },
}
const PERSISTENT: SSHOptions = { host: 'ubuntu.lan', port: 22, username: 'nick', remotePath: '~' }
const PLAIN: SSHOptions = { ...PERSISTENT, detachable: false }
const NEW: PersistentStanding = { marked: false, sessionUnderTmux: false, configUnderTmux: false }
const MARKED: PersistentStanding = { marked: true, sessionUnderTmux: false, configUnderTmux: false }

const route = (o: Partial<RouteInput> = {}) => routeSshTab({ platform: 'win32', switchOn: true, ssh: PERSISTENT, shellOnly: false, machine: MACHINE, bundledSha256: () => SHA, standing: NEW, ...o })

describe('route: an SSH Persistent tab, switch on', () => {
  it('goes through the helper, kept until it is ended, on a machine whose logind does not end processes at logout', () => {
    expect(route()).toEqual({ via: 'helper', machine: MACHINE, kind: 'until-ended' })
  })

  it('needs no linger (the owner\'s Raspberry Pi 5\'s setup note 3: Linger no, KillUserProcesses no): admitted', () => {
    expect(route({ machine: { ...MACHINE, logind: { kill: 'no', exclude: '', linger: 'no' } } })).toMatchObject({ via: 'helper', kind: 'until-ended' })
  })

  it('a config that chose SSH Persistent explicitly goes the same way', () => {
    expect(route({ ssh: { ...PERSISTENT, detachable: true } })).toMatchObject({ via: 'helper', kind: 'until-ended' })
  })

  it('a user KillExcludeUsers names is admitted where KillUserProcesses is yes', () => {
    expect(route({ machine: { ...MACHINE, logind: { kill: 'yes', exclude: 'root nick', linger: 'no' } } })).toMatchObject({ via: 'helper' })
  })

  const today: Array<[string, Partial<RouteInput>, string]> = [
    ['its config has a tmux entry (or an open tab on the usual path)', { standing: { ...NEW, configUnderTmux: true } }, ROUTE_WHY.configUnderTmux],
    ['its own session last started on the usual path (a Restart, or a restored tab with no mark)', { standing: { ...NEW, sessionUnderTmux: true } }, ROUTE_WHY.sessionUnderTmux],
    ['logind ends the user\'s processes at logout (clean-up on)', { machine: { ...MACHINE, logind: { kill: 'yes', exclude: 'root', linger: 'yes' } } }, ROUTE_WHY.cleanUpOn],
    ['logind was not read at the last Check (clean-up unreadable)', { machine: { ...MACHINE, logind: { kill: '', exclude: '', linger: '' } } }, ROUTE_WHY.cleanUpUnknown],
    ['a record no Check of this build wrote (no logind at all)', { machine: { ...MACHINE, logind: undefined } }, ROUTE_WHY.cleanUpUnknown],
  ]
  for (const [name, over, why] of today) {
    it(`keeps today's path when ${name}, saying why`, () => {
      expect(route(over)).toEqual({ via: 'today', why })
    })
  }

  it('the reason for a tab under tmux names the step', () => {
    expect(ROUTE_WHY.sessionUnderTmux).toBe('this tab\'s session runs under tmux; End it to move this config to the helper')
  })
})

describe('route: a plain SSH tab keeps beta.18\'s away clock', () => {
  it('through the helper with the away kind, whatever logind says and whatever its standing', () => {
    expect(route({ ssh: PLAIN, machine: { ...MACHINE, logind: undefined }, standing: undefined })).toEqual({ via: 'helper', machine: { ...MACHINE, logind: undefined }, kind: 'away' })
    expect(route({ ssh: PLAIN, standing: { marked: true, sessionUnderTmux: true, configUnderTmux: true } })).toMatchObject({ via: 'helper', kind: 'away' })
  })
})

describe('route: a marked tab never takes the usual path', () => {
  const nothing: Array<[string, Partial<RouteInput>, string, string]> = [
    ['the switch off', { switchOn: false }, ROUTE_WHY.off, MARKED_STEP.switchOff],
    ['another helper on its machine (an update that changed it)', { machine: { ...MACHINE, helper: { ...MACHINE.helper, sha256: 'b'.repeat(64) } } }, ROUTE_WHY.oldHelper, MARKED_STEP.check],
    ['a failed Check', { machine: { ...MACHINE, check: { at: 1, ok: false, detail: 'x' } } }, ROUTE_WHY.notChecked, MARKED_STEP.check],
    ['no helper in this build', { bundledSha256: () => null }, ROUTE_WHY.noHelper, MARKED_STEP.check],
    ['its machine not added', { machine: undefined }, ROUTE_WHY.notAdded, MARKED_STEP.end],
    ['a post-connect command added since', { ssh: { ...PERSISTENT, postCommand: 'cd /srv' } }, ROUTE_WHY.postCommand, MARKED_STEP.end],
  ]
  for (const [name, over, why, step] of nothing) {
    it(`${name}: nothing starts, and the step is named`, () => {
      expect(route({ standing: MARKED, ...over })).toEqual({ via: 'nothing', why, step })
    })
  }

  it('the tmux and logind checks are for new sessions: a marked one is held already and goes through the helper', () => {
    expect(route({ standing: { marked: true, sessionUnderTmux: true, configUnderTmux: true }, machine: { ...MACHINE, logind: { kill: 'yes', exclude: '', linger: 'no' } } })).toMatchObject({ via: 'helper', kind: 'until-ended' })
  })

  it('an unmarked tab with the switch off takes the usual path, as before', () => {
    expect(route({ switchOn: false })).toEqual({ via: 'today', why: ROUTE_WHY.off })
  })
})

describe('logind as the last Check read it', () => {
  const cases: Array<[RemoteMachineRecord['logind'], 'on' | 'off' | 'unknown']> = [
    [{ kill: 'no', exclude: '', linger: '' }, 'off'],
    [{ kill: 'yes', exclude: 'root', linger: 'yes' }, 'on'],
    [{ kill: 'yes', exclude: 'root nick', linger: 'no' }, 'off'],
    [{ kill: '', exclude: 'root', linger: 'no' }, 'unknown'],
    [undefined, 'unknown'],
  ]
  for (const [logind, want] of cases) {
    it(`${JSON.stringify(logind)} reads ${want}`, () => { expect(logoutCleanUp({ user: 'nick', logind })).toBe(want) })
  }
  it('the card says why SSH Persistent keeps the usual path, and nothing where it may go through the helper', () => {
    expect(persistentNote({ user: 'nick', logind: { kill: 'no', exclude: '', linger: 'no' } })).toBeUndefined()
    expect(persistentNote({ user: 'nick', logind: { kill: 'yes', exclude: 'root', linger: 'no' } })).toContain('KillUserProcesses yes, Linger no')
    expect(persistentNote({ user: 'nick', logind: undefined })).toContain('Press Check')
  })
})
