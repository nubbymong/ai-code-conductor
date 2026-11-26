/**
 * An SSH Persistent tab through the session helper, kept until it is ended
 * (plan 2.1.3-beta.19 section 1.2; aicc_planning#437; ADR-030 S25's second
 * kind, D13, D19), against section 1.1's contract with a FAKE helper: `hold
 * ... --until-ended` (exclusive with `--away`), its record's
 * `"lifetime":"until-ended"` with `away` null, list mode's until-ended line,
 * and hold's exit 3 at a take-over.
 *
 * - its hold asks for the until-ended kind, and its flow state names the
 *   machine that keeps it, so the renderer marks its saved record at once;
 * - closing the tab (Leave running, a plain close) and a quit let go of it: a
 *   term.detach, never a term.end, and its folder stays;
 * - a re-open (the restored tab after a quit, Re-attach, a Restart) finds it
 *   by hold's exit 3 and list mode, attaches, launches nothing, writes no
 *   file, runs the host reads again, and serves a status, a hook event queued
 *   while away and a tool call under the same app session id;
 * - a clock holder left for the session is still ended first, as today;
 * - End sends term.end over a link of its own, then its folder goes;
 * - a link that stays down past every try lets go of it: no term.end, even
 *   when the link comes back for the end; an attach again that finds no
 *   holder says the session is over there;
 * - a Restart launches with --continue only when the tab has a conversation
 *   to come back to (it showed its session, or a restore brought it back),
 *   never after a first start that failed;
 * - the two record shapes read, and every other mix is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { RemoteStatusLine, SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { endRemoteSession, endRemoteTab, forgetRemoteHelperTab, listRemoteSessions, noteRestoredRemoteTabs, remoteHelperFlowState, remoteHelperLiveness, remoteHelperPty, setRemoteHelperDeps, type RemoteSignalDeps } from '../../../src/main/remote-helper'
import { RemoteHelperPty, remoteLaunchSpec, remoteSessionId } from '../../../src/main/remote-helper/session'
import { untilEnded } from '../../../src/main/remote-helper/kept'
import { readListing, readRecord } from '../../../src/main/session-helper/protocol'
import type { HostAccountRead } from '../../../src/main/remote-helper/host-reads'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { HelperToolLink } from '../../../src/main/session-helper/manager'
import type { HookEventFrame, HolderRecord } from '../../../src/main/session-helper/protocol'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import { SSH_THROUGH_HELPER } from '../../../src/shared/remote-machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
/** A machine whose last Check read logind as not ending the user's processes
 *  at logout, with no linger: the owner's Raspberry Pi 5's defaults (its
 *  setup note 3: Linger=no, KillUserProcesses=no). */
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'pi.lan', port: 22, user: 'nick', label: 'Pi', addedAt: 1,
  os: 'Linux', arch: 'aarch64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-arm64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: 'root', linger: 'no' },
}
/** A config that never chose a Connection: SSH Persistent. */
const PERSISTENT: SSHOptions = { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' }
const INSTALL = 'f'.repeat(32)

const provider = {
  id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch: claudeRemoteLaunch,
} as unknown as SessionProvider

let store = ''
let logs: string[] = []
let ssh: FakeSsh
let flow: Array<{ id: string; msg: unknown }> = []
const win = {
  webContents: { send: (ch: string, d: unknown) => { const m = /^ssh:flowState:(.+)$/.exec(ch); if (m) flow.push({ id: m[1], msg: d }) } },
  isDestroyed: () => false,
}

/** The app's side, recorded. */
function signals() {
  const status: Array<[string, RemoteStatusLine]> = []
  const events: Array<[string, HookEventFrame]> = []
  const served: Array<{ id: string; link: HelperToolLink }> = []
  const ended: string[] = []
  const accounts: Array<[string, HostAccountRead]> = []
  const deps: RemoteSignalDeps = {
    toolsServed: () => true,
    status: (id, line) => { status.push([id, line]) },
    event: (id, e) => { events.push([id, e]) },
    serve: (id, _p, link) => { served.push({ id, link }); return true },
    ended: (id) => { ended.push(id) },
    account: (id, read) => { accounts.push([id, read]) },
  }
  return { deps, status, events, served, ended, accounts }
}

function plugIn(deps: RemoteSignalDeps, machine: RemoteMachineRecord = MACHINE): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => machine, get: () => machine, list: () => [machine], installId: () => INSTALL } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
    signals: deps,
  })
}

/** A record as section 1.1's helper prints it on Linux: an until-ended
 *  holder's adds `"lifetime":"until-ended"`, with `away` null. */
function linuxRecord(h: FakeHolder, untilEnded = true): Record<string, unknown> {
  const r: Record<string, unknown> = { ...h.record(), endpoint: `/tmp/aicc-1000/${h.sid}-0123456789abcdef.sock` }
  if (untilEnded) { r.away = null; r.lifetime = 'until-ended' }
  return r
}

/** A holder of this version: it offers `status` too. */
function holderFor(id: string): FakeHolder {
  const h = new FakeHolder(remoteSessionId(id), id, store)
  h.caps = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status']
  return h
}

function sendStatus(h: FakeHolder, seq: number, payload: Record<string, unknown>): boolean {
  const c = h.attached
  if (!c || !c.ackedCaps.includes('status')) return false
  c.sendJson({ t: 'status', seq, payload })
  return true
}

/**
 * The fake host for one holder. A hold starts it (its record printed) until
 * it is launched; from then on a hold exits 3, as a holder for that session
 * runs, and list mode lists it, until it has ended.
 */
function host(holder: FakeHolder, o: { untilEnded?: boolean; holds?: (c: ExecCall) => FakeAnswer | undefined; account?: () => string } = {}) {
  ssh.host = {
    answer: (c) => {
      const n = c.values[0]
      if (c.script === 'reads') return { stdout: result(n, {}) }
      // Section 1.1's field mode through the launcher (section 3's account read).
      if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${(o.account ?? (() => 'nick@example.com'))()}\n` }
      if (c.script === 'hold') {
        const own = o.holds?.(c)
        if (own) return own
        if (holder.launch && !holder.ended) return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 3 }
        return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(holder, o.untilEnded ?? true))}\n` }
      }
      if (c.script === 'list' || c.script === 'sessions') {
        const sessions = holder.launch && !holder.ended ? [linuxRecord(holder, o.untilEnded ?? true)] : []
        const line = `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })}\n`
        // The start-up and Machines list (6.3) prints its sweep after the line.
        return { stdout: c.script === 'sessions' ? `${line}${result(n, { swept: '0' })}` : line }
      }
      if (c.script === 'files' || c.script === 'unsession') return { stdout: result(n, {}) }
      return { code: 1 }
    },
    bridge: () => (holder.ended ? null : holder.connect()),
  }
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const launches = (h: FakeHolder) => h.requests.filter((r) => r.t === 'term.launch').length

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-kept-'))
  logs = []
  flow = []
  registerProvider(provider)
})
afterEach(() => {
  setRemoteHelperDeps(null)
  fs.rmSync(store, { recursive: true, force: true })
})

describe('an SSH Persistent tab through the session helper, kept until it is ended', () => {
  it('its hold asks for the until-ended kind, and its flow state names the machine that keeps it (no linger needed: the Pi\'s note 3)', async () => {
    const id = 'kept-hold'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    const holder = holderFor(id)
    host(holder)
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    expect(pty).not.toBeNull()
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    const hold = ssh.calls.find((c) => c.script === 'hold')!
    expect(hold.values.at(-1)).toBe('until-ended')
    expect(flow).toContainEqual({ id, msg: { state: SSH_THROUGH_HELPER, kept: { did: MACHINE.did } } })
    expect(remoteHelperFlowState(id)).toEqual({ state: SSH_THROUGH_HELPER, kept: { did: MACHINE.did } })
    expect(logs.some((l) => l.includes(`${id}: through the session helper`) && l.includes('kept until it is ended'))).toBe(true)
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  it('closing the tab (Leave running or a plain close) and a quit let go of it: a term.detach, no term.end, and its folder stays', async () => {
    const id = 'kept-close'
    forgetRemoteHelperTab(id)
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    host(holder)
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    await until('attached', () => holder.attached !== null)
    pty.kill()
    await until('let go', () => holder.attached === null)
    await new Promise((r) => setTimeout(r, 50))
    expect(holder.endsAsked).toBe(0)
    expect(holder.ended).toBe(false)
    expect(holder.requests.map((r) => r.t)).toContain('term.detach')
    expect(ssh.scripts()).not.toContain('unsession')
    expect(logs.some((l) => l.includes('let go of; its session runs on until it is ended'))).toBe(true)
    await endRemoteTab(id, MACHINE.did)
    forgetRemoteHelperTab(id)
  })

  it('a re-open attaches, launches nothing, writes no file, reads the host files again, and serves a status, a queued hook event and a tool call under the same app session id', async () => {
    const id = 'kept-reopen'
    forgetRemoteHelperTab(id)
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    let account = 'nick@example.com'
    host(holder, { account: () => account })
    let shown = ''
    const first = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    first.onData((d) => { shown += d })
    await until('attached', () => holder.attached !== null)
    holder.output('BEFORE THE QUIT\r\n')
    await until('output', () => shown.includes('BEFORE THE QUIT'))
    // A quit: let go of; meanwhile the CLI writes and a hook event waits.
    first.kill()
    await until('let go', () => holder.attached === null)
    holder.output('WHILE AWAY\r\n')
    holder.hookEvent('Notification', { hook_event_name: 'Notification', message: 'waiting' })
    const before = ssh.calls.length
    // The host's CLI signed in as another account meanwhile.
    account = 'home@example.com'
    // The next start: the restored tab, its saved mark with its spawn.
    forgetRemoteHelperTab(id)
    let again = ''
    const second = remoteHelperPty(win, id, { ssh: PERSISTENT, remoteVia: 'helper' }, 100, 30)!
    second.onData((d) => { again += d })
    await until('attached again', () => holder.attached !== null)
    await until('the replay', () => again.includes('WHILE AWAY'))
    expect(launches(holder)).toBe(1)
    // 1.1's contract: the host reads and the field read run at every start,
    // launch or attach (section 3's readHostForStart), so the label is set again.
    expect(ssh.calls.slice(before).map((c) => c.script)).toEqual(['reads', 'field', 'hold', 'list', 'bridge'])
    expect(s.accounts).toEqual([[id, { account: 'nick@example.com' }], [id, { account: 'home@example.com' }]])
    expect((second as RemoteHelperPty).attachedToKept).toBe(true)
    // The queued hook event comes once, as this tab's.
    await until('the hook event', () => s.events.length === 1)
    expect(s.events[0][0]).toBe(id)
    // A status, as this tab's.
    expect(sendStatus(holder, 7, { model: { display_name: 'Opus' } })).toBe(true)
    await until('the status', () => s.status.length >= 1)
    expect(s.status.every(([sid]) => sid === id)).toBe(true)
    // A tool call, served as this tab's session.
    expect(holder.openToolStream()).not.toBeNull()
    await until('the tool stream', () => s.served.length === 1)
    expect(s.served[0].id).toBe(id)
    expect(logs).toContain(`[remote-helper] ${remoteSessionId(id)}: a session kept for this tab runs on pi.lan; attaching to it, nothing is launched`)
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  // 1.2b: an until-ended holder whose program was never launched (an app
  // that ended between its hold and its launch, inside the 120 s such a
  // holder waits for it) holds nothing to come back to: it is ended first, as
  // a clock leftover is, never attached to with nothing launched.
  for (const [what, id, untilEndedOld] of [
    ['a clock holder left for the session (beta.18\'s kind)', 'kept-clock-left', false],
    ['an until-ended holder left for the session with nothing launched in it', 'kept-waiting-left', true],
  ] as const) it(`${what} is still ended first, and a new one started`, async () => {
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    const old = holderFor(id)
    if (!untilEndedOld) {
      old.launch = { t: 'term.launch' }
      old.child = 'running'
    }
    const fresh = holderFor(id)
    let holds = 0
    ssh.host = {
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'reads' || c.script === 'files' || c.script === 'unsession') return { stdout: result(n, {}) }
        if (c.script === 'hold') {
          holds++
          if (holds === 1) return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 3 }
          return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(fresh))}\n` }
        }
        if (c.script === 'list') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ v: 1, sessions: old.ended ? [] : [linuxRecord(old, untilEndedOld)], removed: 0, skipped: 0 })}\n` }
        return { code: 1 }
      },
      bridge: () => (old.ended ? fresh.connect() : old.connect()),
    }
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('the new launch', () => fresh.launch !== null && fresh.attached !== null)
    expect(old.endsAsked).toBe(1)
    expect(launches(fresh)).toBe(1)
    expect(logs).toContain(`[remote-helper] ${remoteSessionId(id)}: a holder an earlier run left for this tab is ended first`)
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  // 2.1.3-beta.19 section 1.2b: the record a hold prints says the kind it
  // started; a holder of the other kind is never used.
  for (const [what, ssh0, kept] of [
    ['an SSH Persistent tab whose hold starts a clock holder', PERSISTENT, false],
    ['a plain SSH tab whose hold starts an until-ended holder', { ...PERSISTENT, detachable: false }, true],
  ] as const) {
    it(`${what}: that holder is ended at once, nothing is launched, and the start says why`, async () => {
      const id = `kept-kind-${kept ? 'until' : 'clock'}`
      forgetRemoteHelperTab(id)
      plugIn(signals().deps)
      const holder = holderFor(id)
      host(holder, { untilEnded: kept })
      remoteHelperPty(win, id, { ssh: ssh0 }, 100, 30)
      await until('the holder ended', () => holder.ended)
      expect(holder.endsAsked).toBe(1)
      expect(launches(holder)).toBe(0)
      await until('the reason', () => logs.some((l) => l.includes('started a holder of another kind than this tab asked for')))
      expect(ssh.scripts()).not.toContain('files')
      forgetRemoteHelperTab(id)
    })
  }

  it('End sends term.end over a link of its own, then its folder goes and the app\'s hook state for the tab', async () => {
    const id = 'kept-end'
    forgetRemoteHelperTab(id)
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    host(holder)
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    await until('attached', () => holder.attached !== null)
    const r = await endRemoteTab(id)
    expect(r.ok).toBe(true)
    expect(holder.endsAsked).toBe(1)
    expect(holder.ended).toBe(true)
    const unsession = ssh.calls.find((c) => c.script === 'unsession')
    expect(unsession?.values.at(-1)).toBe(remoteSessionId(id))
    expect(s.ended).toContain(id)
    await (pty as RemoteHelperPty).ended
    forgetRemoteHelperTab(id)
  })

  it('a kept tab whose start fails names the steps that reach it again, never the usual SSH path', async () => {
    const id = 'kept-fail'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    ssh.host = { answer: (c) => (c.script === 'reads' ? { stdout: result(c.values[0], {}) } : { code: 255, stderr: 'ssh: connect to host pi.lan port 22: Connection timed out' }) }
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    let out = ''
    pty.onData((d) => { out += d })
    await until('the note', () => out.includes('could not start through the session helper'))
    expect(out).toContain('Press Check on the Machines page, then Restart')
    expect(out).not.toContain('usual SSH path')
    forgetRemoteHelperTab(id)
  })

  it('a link that stays down past every try lets go of it: no term.end, even when the link is back for the end', async () => {
    const id = 'kept-lost'
    const holder = holderFor(id)
    let bridges = 0
    const ssh2 = new FakeSsh({
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(holder))}\n` }
        return { stdout: result(n, {}) }
      },
      bridge: () => holder.connect(),
      // The first bridge attaches; the next three (the re-attach's tries) are
      // cut on this computer; from the fifth on the link is back.
      bridgeCut: () => { bridges++; return bridges >= 2 && bridges <= 4 ? { code: 255 } : undefined },
    })
    const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~', 100, 30)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner: ssh2, spec, kind: 'until-ended', log: (m) => logs.push(m), reconnectDelaysMs: [10, 10], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    let exit: number | null = null
    let shown = ''
    let shownAtExit = ''
    pty.onData((d) => { shown += d })
    pty.onExit((e) => { exit = e.exitCode; shownAtExit = shown })
    await until('attached', () => holder.attached !== null)
    // The link drops on the holder's side.
    holder.attached!.close()
    await until('given up', () => exit !== null)
    // The tab says, before its exit, that its session runs on and how to reach it.
    expect(shownAtExit).toContain('[This tab is no longer attached to its session on pi.lan (the link stayed down, or another tab took it). The session runs on there, kept by the session helper: Restart attaches to it again, and the Machines page lists it, with End.]')
    // Time for any end it might send over the link that is back.
    await until('the link back', () => bridges >= 5, 3000).catch(() => { /* no try made: no end either */ })
    await new Promise((r) => setTimeout(r, 100))
    expect(holder.endsAsked).toBe(0)
    expect(holder.ended).toBe(false)
  })

  // Fix round 2: an attach again that finds no holder (the bridge's exit 3)
  // means the session is over on the machine; the tab says that, not that it
  // runs on there (the plan's Ubuntu host line: the tab says the session
  // ended and a Restart resumes the conversation).
  it('an attach again that finds no holder says the session is over, never that it runs on there', async () => {
    const id = 'kept-gone'
    const holder = holderFor(id)
    let bridges = 0
    const ssh2 = new FakeSsh({
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(holder))}\n` }
        return { stdout: result(n, {}) }
      },
      // The first bridge attaches; every later one finds no holder (exit 3).
      bridge: () => (++bridges === 1 ? holder.connect() : null),
    })
    const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~', 100, 30)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner: ssh2, spec, kind: 'until-ended', log: (m) => logs.push(m), reconnectDelaysMs: [10, 10], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    let exit: number | null = null
    let shown = ''
    let shownAtExit = ''
    pty.onData((d) => { shown += d })
    pty.onExit((e) => { exit = e.exitCode; shownAtExit = shown })
    await until('attached', () => holder.attached !== null)
    // The holder's tree ends on the machine: the link drops and no holder is left.
    holder.attached!.close()
    await until('given up', () => exit !== null)
    expect(shownAtExit).toContain(`[This tab's session on pi.lan is over: no session helper holds it there any more (it ended there, or the machine restarted). Restart starts a new session and resumes the conversation.]`)
    expect(shownAtExit).not.toContain('The session runs on there')
    expect(bridges).toBeGreaterThanOrEqual(2)
    expect(holder.endsAsked).toBe(0)
  })

  // Fix round 2: --continue only for a marked tab that has a conversation of
  // its own to come back to. A tab whose first start failed had none.
  it('a marked tab whose first start failed starts fresh at its Restart: no --continue', async () => {
    const id = 'kept-first-fail'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    // The first start: the hold gets no answer.
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    let out = ''
    pty.onData((d) => { out += d })
    await until('the note', () => out.includes('could not start through the session helper'))
    pty.kill()
    forgetRemoteHelperTab(id, true)
    // The host answers now; the Restart carries the tab's mark.
    const holder = holderFor(id)
    host(holder)
    remoteHelperPty(win, id, { ssh: PERSISTENT, remoteVia: 'helper' }, 100, 30)
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect((holder.launch as { argv: string[] }).argv).not.toContain('--continue')
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  it('a marked tab that showed its session, whose kept session then ended, launches again on its conversation: --continue', async () => {
    const id = 'kept-shown-gone'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    const first = holderFor(id)
    host(first)
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    await until('attached', () => first.launch !== null && first.attached !== null)
    expect((first.launch as { argv: string[] }).argv).not.toContain('--continue')
    // A Restart lets go of it; meanwhile its holder ended on the machine.
    pty.kill()
    await until('let go', () => first.attached === null)
    forgetRemoteHelperTab(id, true)
    await endRemoteSession(MACHINE.did, remoteSessionId(id))
    expect(first.ended).toBe(true)
    const second = holderFor(id)
    host(second)
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('the new launch', () => second.launch !== null && second.attached !== null)
    expect((second.launch as { argv: string[] }).argv).toContain('--continue')
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  it('a kept tab whose session ended on the machine while it showed it says so, and its Restart launches again on its conversation (--continue)', async () => {
    const id = 'kept-over-restart'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    const first = holderFor(id)
    host(first)
    const pty = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)!
    let out = ''
    pty.onData((d) => { out += d })
    await until('attached', () => first.launch !== null && first.attached !== null)
    // Its holder's tree ends on the machine: the link drops, and the attach
    // again finds no holder (the bridge's exit 3, after its output ends, as
    // ssh gives it: the Rocky host line's finding 1).
    first.ended = true
    first.attached!.close()
    await until('the note', () => out.includes('is over: no session helper holds it there any more'))
    expect(out).not.toContain('The session runs on there')
    expect(logs.filter((l) => l.includes(`${remoteSessionId(id)}: the link to`))).toEqual([])
    // The Restart: its terminal is over already, so no kill reaches it.
    forgetRemoteHelperTab(id, true)
    const second = holderFor(id)
    host(second)
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('the new launch', () => second.launch !== null && second.attached !== null)
    expect((second.launch as { argv: string[] }).argv).toContain('--continue')
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  // A tab the app restores after its kept session ended (the machine
  // restarted while the app was closed) has a conversation to come back to,
  // though it never showed its session this run.
  it('a restored marked tab whose kept session is gone launches again on its conversation: --continue', async () => {
    const id = 'kept-restored-gone'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    noteRestoredRemoteTabs([{ id }])
    const holder = holderFor(id)
    host(holder)
    remoteHelperPty(win, id, { ssh: PERSISTENT, remoteVia: 'helper' }, 100, 30)
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect((holder.launch as { argv: string[] }).argv).toContain('--continue')
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  // End asked while the tab's start still finds its holder (the tab is in
  // openTabs already): the answer waits for that start. It used to answer ok
  // with nothing ended, so the close dropped the left-running entry while the
  // kept session ran on.
  it('End asked before the hold answers, the host then not answering: not ended, and the answer says so', async () => {
    const id = 'kept-end-early-down'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    let ending: ReturnType<typeof endRemoteTab> | undefined
    ssh.host = {
      answer: (c) => {
        if (c.script === 'reads') return { stdout: result(c.values[0], {}) }
        if (c.script === 'hold') ending ??= endRemoteTab(id)
        return { code: 255, stderr: 'ssh: connect to host pi.lan port 22: Connection timed out' }
      },
    }
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('End asked', () => ending !== undefined)
    const r = await ending!
    expect(r.ok).toBe(false)
    expect(r.message).toContain('The session was not ended: pi.lan could not be reached')
    expect(ssh.scripts()).not.toContain('unsession')
    forgetRemoteHelperTab(id)
  })

  it('End asked before the hold answers, a kept holder listed: one term.end, the unsession exec, then ok', async () => {
    const id = 'kept-end-early-up'
    forgetRemoteHelperTab(id)
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    holder.launch = { t: 'term.launch' }
    holder.child = 'running'
    host(holder)
    const base = ssh.host.answer
    // What had been done when End answered.
    let ending: Promise<{ ok: boolean; endsAsked: number; ended: boolean; unsession: string | undefined; hookStateGone: boolean }> | undefined
    ssh.host = {
      ...ssh.host,
      answer: (c) => {
        if (c.script === 'hold') {
          ending ??= endRemoteTab(id).then((r) => ({
            ok: r.ok, endsAsked: holder.endsAsked, ended: holder.ended,
            unsession: ssh.calls.find((x) => x.script === 'unsession')?.values.at(-1), hookStateGone: s.ended.includes(id),
          }))
        }
        return base(c)
      },
    }
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('End asked', () => ending !== undefined)
    // Answered once the end was done, not before.
    expect(await ending!).toEqual({ ok: true, endsAsked: 1, ended: true, unsession: remoteSessionId(id), hookStateGone: true })
    // Nothing else reaches for it (no terminal is made for a start End
    // already ends: End's own link is the one bridge), and nothing is launched.
    await new Promise((res) => setTimeout(res, 50))
    expect(holder.endsAsked).toBe(1)
    expect(ssh.scripts().filter((x) => x === 'bridge')).toHaveLength(1)
    expect(ssh.scripts().filter((x) => x === 'unsession')).toHaveLength(1)
    expect(launches(holder)).toBe(0)
    forgetRemoteHelperTab(id)
  })
})

describe('list mode on the machines: the Machines rows and a left-running entry\'s liveness', () => {
  function listing(sessions: unknown[]) {
    ssh.host = { answer: (c) => (c.script === 'sessions' ? { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })}\n${result(c.values[0], { swept: '0' })}` } : { code: 1 }) }
  }
  it('the rows: each listed session with its kind, its app session id (the holder\'s label), whether a tab is attached and whether its program runs', async () => {
    plugIn(signals().deps)
    const kept = holderFor('row-kept')
    kept.launch = { t: 'term.launch' }
    kept.child = 'running'
    const clock = holderFor('row-clock')
    clock.child = 'exited'
    clock.code = 0
    listing([linuxRecord(kept), { ...linuxRecord(clock, false) }])
    const [m] = await listRemoteSessions()
    expect(m).toEqual({ did: MACHINE.did, ok: true, sessions: [
      { sid: kept.sid, appSessionId: 'row-kept', untilEnded: true, attached: false, running: true },
      { sid: clock.sid, appSessionId: 'row-clock', untilEnded: false, attached: false, running: false },
    ] })
    expect(ssh.calls.map((c) => c.script)).toEqual(['sessions'])
  })

  it('a machine whose list does not read is listed with why, not as empty', async () => {
    plugIn(signals().deps)
    listing([{ not: 'a record' }])
    const [m] = await listRemoteSessions()
    expect(m.ok).toBe(false)
  })

  it('a left-running entry\'s liveness: verified with the app ids whose holder is listed; unverified when the list does not answer', async () => {
    plugIn(signals().deps)
    const kept = holderFor('live-kept')
    listing([linuxRecord(kept)])
    expect(await remoteHelperLiveness({ host: 'pi.lan', port: 22, username: 'nick' }, ['live-kept', 'live-gone'])).toEqual({ outcome: 'verified', liveSessionIds: ['live-kept'] })
    ssh.host = { answer: () => ({ code: 255, stderr: 'Connection timed out' }) }
    expect(await remoteHelperLiveness({ host: 'pi.lan', port: 22, username: 'nick' }, ['live-kept'])).toEqual({ outcome: 'unverified', liveSessionIds: [] })
  })

  it('End on a card is refused for a session a tab shows (End it from its tab)', async () => {
    const id = 'kept-card-open'
    forgetRemoteHelperTab(id)
    plugIn(signals().deps)
    const holder = holderFor(id)
    host(holder)
    remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30)
    await until('attached', () => holder.attached !== null)
    const r = await endRemoteSession(MACHINE.did, remoteSessionId(id))
    expect(r.ok).toBe(false)
    expect(holder.endsAsked).toBe(0)
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })
})

describe('the two record shapes (section 1.1\'s contract), read strictly by protocol.ts', () => {
  const base = { v: 1, session: 'rm0123456789abcdef0123456789abcd', label: 'tab-1', pid: 4242, endpoint: '/tmp/aicc-1000/rm0123456789abcdef0123456789abcd-0123456789abcdef.sock', nonce: '0123456789abcdef0123456789abcdef', helper: '0.1.0', started: 1, attached: false, child: 'running', code: null }
  it('a clock record has today\'s fields and reads as the clock kind', () => {
    const r = readRecord({ ...base, away: 120 }, 'unix')
    expect(r?.away).toBe(120)
    expect(r && untilEnded(r)).toBe(false)
  })
  it('an until-ended record (away null, lifetime until-ended) reads as the until-ended kind', () => {
    const r = readRecord({ ...base, away: null, lifetime: 'until-ended' }, 'unix')
    expect(r && untilEnded(r)).toBe(true)
    expect(r?.session).toBe(base.session)
  })
  const refused: Array<[string, Record<string, unknown>]> = [
    ['a lifetime with an away clock', { ...base, away: 120, lifetime: 'until-ended' }],
    ['another lifetime word', { ...base, away: null, lifetime: 'forever' }],
    ['a null away with no lifetime', { ...base, away: null }],
    ['an until-ended record with a field off', { ...base, away: null, lifetime: 'until-ended', pid: 0 }],
    ['an until-ended record with an extra field', { ...base, away: null, lifetime: 'until-ended', extra: 1 }],
  ]
  for (const [name, value] of refused) it(`refuses ${name}`, () => { expect(readRecord(value, 'unix')).toBeNull() })
  it('list mode\'s line with both kinds reads; one record off refuses the line', () => {
    const line = (sessions: unknown[]) => JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })
    const both = readListing(line([{ ...base, away: 120 }, { ...base, session: 'rmffffffffffffffffffffffffffffff', endpoint: '/tmp/aicc-1000/rmffffffffffffffffffffffffffffff-0123456789abcdef.sock', away: null, lifetime: 'until-ended' }]), 'unix')
    expect(both?.sessions.map(untilEnded)).toEqual([false, true])
    expect(readListing(line([{ ...base, away: null }]), 'unix')).toBeNull()
  })
})
