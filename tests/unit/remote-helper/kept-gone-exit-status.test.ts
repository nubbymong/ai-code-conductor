/**
 * A kept tab whose holder is gone from its machine (plan 2.1.3-beta.19
 * section 1.2; aicc_planning#437; the Rocky host line's in-feature finding 1).
 *
 * On Rocky, with the holder's tree ended on the host as a restart would, the
 * tab tried for 96 s and then said its session "runs on there", while the
 * machine had answered every try: the bridge exits 3 when the session has no
 * holder. Measured cause: ssh closes its standard output when the host's side
 * ends and exits with the host's status a moment later; the bridge stream
 * (ssh-exec.ts ExecStream) ended itself on that output's end and ended ssh
 * with it, before its exit, so the exit status was a kill's (no code) and the
 * no-holder answer was lost on every try. Here the fake ssh gives that order
 * (fake-ssh.ts finishAfterOutput); kept-gone-exit-status-real.test.ts reads it
 * with a real process in ssh's place (CI and the test VM only).
 *
 * - a tab's re-attach that reaches the machine and finds no holder says the
 *   session is over at its first try, with no wait;
 * - a link that stays down 30 s, then comes back with the holder alive, is
 *   tried on until it is back, re-attaches to the same session, and the tab
 *   is never said to be over (a mutant that takes every failed try for a gone
 *   holder turns it red).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteHelperPty, remoteLaunchSpec, remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result } from './fake-ssh'

const SHA = 'a'.repeat(64)
const INSTALL = 'f'.repeat(32)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}

let work = ''
let store = ''
let logs: string[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-kept-gone-'))
  store = path.join(work, 'store')
  logs = []
})
afterEach(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})


/** The fake host for one kept holder: the hold starts it; a bridge reaches it
 *  while it runs, and finds no holder (exit 3, after its output ends, as ssh
 *  gives it) once it is gone. */
function hostOf(holder: FakeHolder, cut: () => boolean = () => false): { ssh: FakeSsh; bridges: () => number } {
  let bridges = 0
  const ssh = new FakeSsh({
    answer: (c) => {
      const n = c.values[0]
      if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock`, away: null, lifetime: 'until-ended' })}\n` }
      return { stdout: result(n, {}) }
    },
    bridge: () => (holder.ended ? null : holder.connect()),
    // The link down: ssh cannot connect, before any launcher line.
    bridgeCut: () => { bridges++; return bridges > 1 && cut() ? { code: 255 } : undefined },
  })
  return { ssh, bridges: () => bridges }
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('a kept tab whose session is gone from its machine, and one whose link is only down', () => {
  it('the machine answers that no holder runs: the tab says its session is over at the first try, with no wait and no try more', async () => {
    const id = 'kept-gone-first-try'
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    holder.caps = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status']
    const { ssh, bridges } = hostOf(holder)
    const slept: number[] = []
    const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~', 100, 30)
    // The app's own back-off (no reconnectDelaysMs): the waits are only counted.
    const pty = new RemoteHelperPty({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner: ssh, spec, kind: 'until-ended', log: (m) => logs.push(m), sleep: async (ms) => { slept.push(ms) } })
    let exit: number | null = null
    let shown = ''
    let shownAtExit = ''
    pty.onData((d) => { shown += d })
    pty.onExit((e) => { exit = e.exitCode; shownAtExit = shown })
    await until('attached', () => holder.attached !== null)
    // The holder's tree ends on the machine, as a restart would: its
    // connection closes, and from then on a bridge finds no holder.
    holder.ended = true
    holder.attached!.close()
    await until('the tab\'s end', () => exit !== null)
    expect(shownAtExit).toContain(`[This tab's session on ${MACHINE.host} is over: no session helper holds it there any more (it ended there, or the machine restarted). Restart starts a new session and resumes the conversation.]`)
    expect(shownAtExit).not.toContain('The session runs on there')
    // The bound: one bridge for the attach, one try after the drop, no wait;
    // and no link is tried for the give-up's end (only End ends it).
    await new Promise((r) => setTimeout(r, 100))
    expect(bridges()).toBe(2)
    expect(slept).toEqual([])
    expect(logs.filter((l) => l.includes('is not back yet'))).toEqual([])
    expect(holder.endsAsked).toBe(0)
  })

  it('the link down 30 s, then back with the holder alive: tried on until it is back, the same session attached again, never said to be over', async () => {
    const id = 'kept-link-down-30s'
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    holder.caps = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status']
    let clock = 0
    let down = false
    const { ssh, bridges } = hostOf(holder, () => down && clock < 30_000)
    const slept: number[] = []
    const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~', 100, 30)
    // The app's own back-off, on a clock of the test's: 1, 2, 4, 8 and 16 s
    // reach 31 s, the 31.2 s the Rocky line read for a 30 s cut.
    const pty = new RemoteHelperPty({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner: ssh, spec, kind: 'until-ended', log: (m) => logs.push(m), sleep: async (ms) => { slept.push(ms); clock += ms } })
    let exit: number | null = null
    let shown = ''
    pty.onData((d) => { shown += d })
    pty.onExit((e) => { exit = e.exitCode })
    await until('attached', () => holder.attached !== null)
    holder.output('BEFORE THE CUT\r\n')
    await until('output', () => shown.includes('BEFORE THE CUT'))
    // The link goes down: the holder's connection drops, the holder runs on.
    down = true
    const first = holder.attached!
    holder.output('DURING THE CUT\r\n')
    first.close()
    await until('attached again', () => holder.attached !== null && holder.attached !== first)
    await until('the replay', () => shown.includes('DURING THE CUT'))
    expect(slept).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(bridges()).toBe(7)
    expect(exit).toBeNull()
    expect(shown).not.toContain('is over')
    expect(shown).not.toContain('no longer attached')
    expect(holder.ended).toBe(false)
    expect(holder.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(holder.attaches).toBe(2)
    // Input reaches the same session.
    pty.write('after\r')
    await until('the input', () => Buffer.concat(holder.input).toString().includes('after'))
    pty.kill()
    await until('let go', () => holder.attached === null)
    expect(holder.endsAsked).toBe(0)
  })
})
