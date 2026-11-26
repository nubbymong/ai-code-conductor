/**
 * The setup notes the owner's Raspberry Pi 5 (arm64) gave for a host the
 * session helper runs on (plan 2.1.3-beta.19, the Pi bullet; section 1.2's
 * notes 3, 6, 7 and 8), each checked against the app's own scripts and route:
 *
 * - note 3: no linger by default, and systemd --user units and /run/user do
 *   not outlive the user's last session: an SSH Persistent tab goes through
 *   the helper on a machine with Linger no and KillUserProcesses no, and no
 *   script asks for linger, a systemd unit or /run/user;
 * - note 6: no privilege: no script calls sudo, su, doas or pkexec, and
 *   every path a script writes is under the user's own home (or the
 *   helper's own run folder, which only Remove's rmdir names);
 * - note 7: only the helper's own sessions, by its own ids: no script names
 *   tmux or screen, End on a card takes only a helper session id, and a tab's
 *   session id is the helper's own (rm and 30 hex), never another program's;
 * - note 8: no TCP listener: every exec is one ssh with no forwarding flag,
 *   and no script starts a listener.
 */
import { describe, it, expect } from 'vitest'
import { scriptText, type ScriptName } from '../../../src/main/remote-helper/scripts'
import { execArgv } from '../../../src/main/remote-helper/ssh-exec'
import { remoteSessionId } from '../../../src/main/remote-helper/session'
import { routeSshTab } from '../../../src/main/remote-helper/route'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'

const NAMES: ScriptName[] = ['probe', 'install', 'commit', 'discard', 'remove', 'version', 'selftest', 'list', 'hold', 'bridge', 'reads', 'files', 'unsession', 'sweep']
const SHA = 'a'.repeat(64)
const PI: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'pi.lan', port: 22, user: 'nick', label: 'Pi', addedAt: 1,
  os: 'Linux', arch: 'aarch64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: '', linger: 'no' },
}

describe('the Pi\'s note 3: no linger, no systemd --user, no /run/user', () => {
  it('an SSH Persistent tab goes through the helper, kept until it is ended, on a machine with Linger no and KillUserProcesses no', () => {
    expect(routeSshTab({ platform: 'win32', switchOn: true, ssh: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~' }, shellOnly: false, machine: PI, bundledSha256: SHA })).toMatchObject({ via: 'helper', kind: 'until-ended' })
  })
  for (const name of NAMES) {
    it(`${name}: asks for no linger, starts no systemd unit, and uses no /run/user`, () => {
      const t = scriptText(name)
      expect(t).not.toMatch(/enable-linger|systemctl|systemd-run|\/run\/user/)
    })
  }
})

describe('the Pi\'s note 6: no privilege', () => {
  for (const name of NAMES) {
    it(`${name}: calls no sudo, su, doas or pkexec`, () => {
      expect(scriptText(name)).not.toMatch(/\b(sudo|su|doas|pkexec)\b/)
    })
  }
  it('no script names a system folder, and the only one outside the home folder is the helper\'s own run folder, named by Remove alone (an rmdir of an empty, private folder of the user\'s)', () => {
    for (const name of NAMES) {
      const t = scriptText(name)
      expect(t, name).not.toMatch(/\/(etc|var|opt|usr|root|srv|run)\//)
      if (name === 'remove') expect(t).toContain('rmdir -- "/tmp/aicc-$u"')
      else expect(t, name).not.toContain('/tmp')
    }
  })
})

describe('the Pi\'s note 7: only the helper\'s own sessions, by its own ids', () => {
  for (const name of NAMES) {
    it(`${name}: names no tmux or screen session`, () => {
      expect(scriptText(name)).not.toMatch(/\btmux\b|\bscreen\b/)
    })
  }
  it('a tab\'s session id is the helper\'s own: rm and 30 hex, from the app session id, never a tmux name', () => {
    expect(remoteSessionId('tab-1')).toMatch(/^rm[0-9a-f]{30}$/)
    expect(remoteSessionId('tab-1')).not.toContain('ccc-')
  })
})

describe('the Pi\'s note 8: no TCP listener', () => {
  it('every exec is one ssh with no forwarding flag', () => {
    const args = execArgv({ host: 'pi.lan', port: 22, user: 'nick' }, { version: [9, 2] }, 'true')
    for (const flag of ['-L', '-R', '-D', '-W', '-N', '-f', '-M', '-S']) expect(args).not.toContain(flag)
    // Each forwarding option the exec gives turns one off, and every forwarding is cleared.
    expect(args).toContain('ClearAllForwardings=yes')
    expect(args.filter((a) => /^Forward/i.test(a)).every((a) => /=no$/i.test(a))).toBe(true)
    expect(args).toContain('Tunnel=no')
  })
  for (const name of NAMES) {
    it(`${name}: starts no listener (no nc, socat or a --listen mode)`, () => {
      expect(scriptText(name)).not.toMatch(/\bnc\b|\bsocat\b|--listen|\blisten\b/)
    })
  }
})
