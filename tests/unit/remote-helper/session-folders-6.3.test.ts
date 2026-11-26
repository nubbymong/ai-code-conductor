/**
 * 6.3 (plan 2.1.3-beta.19 section 6.3, built in section 1.2's lane;
 * aicc_planning#437): the host folder a quit leaves goes at the next start.
 *
 * A quit does not wait for a plain SSH tab's unsession exec, so its session's
 * folder could stay until the next Check (beta.18). The list of kept sessions
 * the app takes at start-up and when the Machines page opens is one exec per
 * machine (scripts.ts `sessions`), and that same exec now removes every
 * session folder whose holder is gone and keeps a running one's; the quit
 * gets no exec of its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SCRIPT_NAMES, scriptText } from '../../../src/main/remote-helper/scripts'
import { listKept } from '../../../src/main/remote-helper/kept'
import { forgetRemoteHelperTab, listRemoteSessions, remoteHelperPty, setRemoteHelperDeps } from '../../../src/main/remote-helper'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { SessionProvider } from '../../../src/main/providers/types'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'ubuntu.lan', port: 22, user: 'nick', label: 'Ubuntu', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/bin/claude',
  path: '/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: 'root', linger: 'no' },
}
const INSTALL = 'f'.repeat(32)
const provider = {
  id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch: claudeRemoteLaunch,
} as unknown as SessionProvider

let store = ''
let logs: string[] = []
let ssh: FakeSsh
const win = { webContents: { send: () => {} }, isDestroyed: () => false }

function plugIn(): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32', settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => MACHINE, get: () => MACHINE, list: () => [MACHINE], installId: () => INSTALL } as unknown as RemoteMachines,
    runner: ssh, bundledSha256: () => SHA, systemPrefersDark: () => true, onOutput: () => {}, log: (m) => logs.push(m),
  })
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-63-'))
  logs = []
  registerProvider(provider)
})
afterEach(() => {
  setRemoteHelperDeps(null)
  fs.rmSync(store, { recursive: true, force: true })
})

describe('6.3: the list at start-up removes the folders whose holder is gone', () => {
  it('6.3: its exec runs list mode first, then removes each private session folder whose holder has no record, and keeps one whose holder runs', () => {
    const t = scriptText('sessions')
    const list = t.indexOf('"$P" list --store "$A/store"')
    const keep = t.indexOf('[ -e "$A/store/$X.json" ] && continue')
    const remove = t.indexOf('rm -rf -- "${A:?}/sessions/${X:?}"')
    expect(list).toBeGreaterThan(-1)
    expect(keep).toBeGreaterThan(list)
    expect(remove).toBeGreaterThan(keep)
    // Only a private folder of the user's, with a session id's name, is removed.
    expect(t.slice(keep, remove)).toContain('pv "$S/$X" || continue')
    expect(t).toContain('case "$X" in *[!A-Za-z0-9_-]*|"") continue;; esac')
  })

  it('6.3: `sessions` and `sweep` end with the same guarded delete, word for word (one rule of which folder may go)', () => {
    const tail = [
      'S=$A/sessions; c=0',
      '[ -d "$S" ] && [ ! -L "$S" ] || { r swept 0; r end ok; exit 0; }',
      'pv "$S" || no sessions-folder-not-private',
      'for X in $(ls -A "$S"); do case "$X" in *[!A-Za-z0-9_-]*|"") continue;; esac; [ -e "$A/store/$X.json" ] && continue; pv "$S/$X" || continue; rm -rf -- "${A:?}/sessions/${X:?}" && c=$((c+1)); done',
      'r swept $c',
      'r end ok',
    ].join('; ')
    expect(scriptText('sessions').endsWith(`; ${tail}`)).toBe(true)
    expect(scriptText('sweep').endsWith(`; ${tail}`)).toBe(true)
    // What comes before it differs in list mode's line (`sessions` prints its
    // listing) and in the earlier builds' helper folders, which `sweep` alone removes.
    expect(scriptText('sessions').slice(0, -tail.length)).toContain('"$P" list --store "$A/store" </dev/null || exit $?; ')
    expect(scriptText('sweep').slice(0, -tail.length)).toContain('"$P" list --store "$A/store" </dev/null >/dev/null 2>&1; ')
  })

  // A kept session's CLI runs the helper by the path its launch wrote: its
  // settings.json (status line and hook commands) and mcp.json name
  // ~/.aicc/<did>/helper/<folder of the build that launched it>/aicc-helper
  // (remote-launch.ts, from session.ts remoteHelperCommands' helperPath), and
  // an attach writes no file (session.ts prepare). So a Check that installs
  // another helper must leave the earlier folder while a session may use it:
  // the commit replaces only its own folder, and the Check's sweep removes the
  // earlier builds' folders only when the store holds no holder's record
  // (2.1.3-beta.19). The start-up list never removes one.
  it('the commit of another helper replaces only its own folder, and no script but the Check\'s sweep and Remove deletes a helper folder: a kept session runs the helper its launch named', () => {
    const rms = (t: string) => t.split('; ').filter((p) => /\brm(dir)?\b/.test(p))
    expect(rms(scriptText('commit'))).toEqual(['rm -f -- "$Q/aicc-helper"', 'rmdir -- "$Q" || no cannot-replace'])
    // The start-up list (`sessions`), and every other script but the sweep, name no helper folder to delete.
    expect(SCRIPT_NAMES).toContain('sessions')
    for (const name of SCRIPT_NAMES.filter((n) => n !== 'sweep')) {
      expect(rms(scriptText(name)).filter((p) => p.includes('/helper/')), name).toEqual([])
    }
    expect(rms(scriptText('sweep')).filter((p) => p.includes('/helper/'))).toHaveLength(2)
  })

  // Run as the scripts read on the real sh in tests/live/remote-helper-device.live.ts
  // (the update case); machines.test.ts drives a Check through it on DeviceTree.
  it('with a holder\'s record in the store the earlier builds\' helper folders stay; with none they go, never this build\'s, a staging folder, a link or another name (the Check\'s sweep only)', () => {
    const t = scriptText('sweep')
    const step = [
      'h=0; k=0; l=',
      'if [ -e "$A/store" ] || [ -L "$A/store" ]; then { [ -d "$A/store" ] && [ ! -L "$A/store" ] && l=$(ls -A "$A/store"); } || k=1; fi',
      'for R in $l; do case "$R" in *.json|*.json.*) k=1;; esac; done',
      'if [ "$k" = 0 ]; then for V in $(ls -A "$A/helper"); do [ "$V" = "$F" ] && continue; case "$V" in .*|*[!0-9A-Za-z.-]*|"") continue;; esac; [ -d "$A/helper/$V" ] && [ ! -L "$A/helper/$V" ] || continue; rm -f -- "${A:?}/helper/${V:?}/aicc-helper"; rmdir -- "${A:?}/helper/${V:?}" 2>/dev/null && h=$((h+1)); done; fi',
      'r helpers $h',
    ].join('; ')
    // After list mode (it drops the records of holders that are gone), before the session folders.
    const at = t.indexOf(step)
    expect(at).toBeGreaterThan(t.indexOf('"$P" list --store "$A/store" </dev/null >/dev/null 2>&1'))
    expect(at).toBeLessThan(t.indexOf('S=$A/sessions; c=0'))
    // The scripts run with globbing off, so the store is read by ls, not by a glob.
    expect(t.indexOf('; set -f; ')).toBeGreaterThan(0)
    expect(t.indexOf('; set -f; ')).toBeLessThan(at)
    expect(t).not.toContain('/*.json')
    // The sweep's deletes: those two of an earlier helper folder, and the session folders'.
    expect(t.split('; ').filter((p) => /\brm(dir)?\b/.test(p))).toEqual([
      'rm -f -- "${A:?}/helper/${V:?}/aicc-helper"',
      'rmdir -- "${A:?}/helper/${V:?}" 2>/dev/null && h=$((h+1))',
      'rm -rf -- "${A:?}/sessions/${X:?}" && c=$((c+1))',
    ])
    expect(scriptText('sessions')).not.toContain('r helpers')
  })

  it('6.3: the list the app takes is that exec, and what it removed is logged once', async () => {
    plugIn()
    ssh.host = { answer: (c) => (c.script === 'sessions' ? { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n{"v":1,"sessions":[],"removed":1,"skipped":0}\n${result(c.values[0], { swept: '2' })}` } : { code: 1 }) }
    const l = await listKept({ runner: ssh, installId: INSTALL, log: (m) => logs.push(m) }, MACHINE)
    expect(l).toEqual({ ok: true, sessions: [] })
    expect(ssh.calls.map((c) => c.script)).toEqual(['sessions'])
    expect(ssh.calls[0].values.slice(1)).toEqual([MACHINE.did, INSTALL, MACHINE.helper.folder, SHA])
    expect(logs).toEqual([`[remote-helper] ${MACHINE.host}: removed 2 session folder(s) whose holder is gone`])
  })

  it('6.3: the start-up list (listRemoteSessions) goes through it on each machine', async () => {
    plugIn()
    ssh.host = { answer: (c) => (c.script === 'sessions' ? { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n{"v":1,"sessions":[],"removed":0,"skipped":0}\n${result(c.values[0], { swept: '0' })}` } : { code: 1 }) }
    expect(await listRemoteSessions()).toEqual([{ did: MACHINE.did, ok: true, sessions: [] }])
    expect(ssh.calls.map((c) => c.script)).toEqual(['sessions'])
    expect(logs).toEqual([])
  })

  it('6.3: a quit adds no exec: a plain tab\'s end sends its term.end and its unsession, as before, and no list', async () => {
    const id = 'q63-plain'
    forgetRemoteHelperTab(id)
    plugIn()
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    ssh.host = {
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })}\n` }
        return { stdout: result(n, {}) }
      },
      bridge: () => holder.connect(),
    }
    const pty = remoteHelperPty(win, id, { ssh: { host: 'ubuntu.lan', port: 22, username: 'nick', remotePath: '~', detachable: false } }, 100, 30)!
    await until('attached', () => holder.attached !== null)
    const before = ssh.calls.length
    pty.kill()
    await until('its folder\'s removal', () => ssh.calls.slice(before).some((c) => c.script === 'unsession'))
    expect(holder.endsAsked).toBe(1)
    expect(ssh.calls.slice(before).map((c) => c.script).filter((s) => s !== 'bridge')).toEqual(['unsession'])
    forgetRemoteHelperTab(id)
  })
})
