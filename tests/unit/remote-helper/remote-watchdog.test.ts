/**
 * The Session Watchdog for a Claude Code tab through the session helper on
 * another machine (2.1.3-beta.19 fix round, item WD; pre-existing since
 * beta.18). A usual SSH tab arms its Watchdog at its claude-running latch
 * inside the SSH flow (pty-manager.ts setFlowState); a tab through the helper
 * leaves the SSH branch before that flow exists, so it was never armed: on
 * the Rocky Linux 10.2 (x86-64) host line, a safeguard-flagged answer in a
 * helper tab got no retry, no Watchdog pill and no Watchdog log line, while a
 * usual SSH tab of the same build did.
 *
 * Its arm point is the helper's own "the CLI runs" signal: the tab's first
 * attach to its holder (after the holder launched the CLI; for section 1.2's
 * SSH Persistent tabs, also an attach to a session kept for the tab). It is
 * armed as an SSH tab (the pane is drawn by a remote host, so the send gate
 * needs Claude Code's own chrome), and fed exactly what the tab is sent.
 *
 * Against section 3.1's helper contract with a fake holder and a fake ssh,
 * as remote-signals.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const H = vi.hoisted(() => ({ logs: [] as string[] }))
// The Watchdog is on (Settings, Session Watchdog), as on the host line.
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ watchdog: { enabled: true } }) }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { H.logs.push(m) }, logWarn: (m: string) => { H.logs.push(m) }, logError: (m: string) => { H.logs.push(m) }, logDebug: () => {},
}))
vi.mock('../../../src/main/session-signals/hooks', () => ({ onHookEvent: () => () => {} }))

import type { SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { endRemoteTab, forgetRemoteHelperTab, remoteHelperPty, setRemoteHelperDeps, type RemoteHelperDeps } from '../../../src/main/remote-helper'
import { RemoteHelperPty, remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { HolderRecord } from '../../../src/main/session-helper/protocol'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { IPC } from '../../../src/shared/ipc-channels'
import { WatchdogManager, setWatchdogManagerForTest } from '../../../src/main/watchdog/watchdog-manager'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }
const INSTALL = 'f'.repeat(32)

const provider = {
  id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch: claudeRemoteLaunch,
} as unknown as SessionProvider

let store = ''
let ssh: FakeSsh
const sent: Array<[string, unknown]> = []
const win = { webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } }, isDestroyed: () => false }

function plugIn(watchdog: RemoteHelperDeps['watchdog']): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => MACHINE, installId: () => INSTALL } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => H.logs.push(m),
    ...(watchdog ? { watchdog } : {}),
  })
}

function answering(holder: FakeHolder): void {
  ssh.host = {
    answer: (c) => {
      const n = c.values[0]
      if (c.script === 'reads') return { stdout: result(n, {}) }
      if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\n` }
      if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` } satisfies HolderRecord)}\n` }
      if (c.script === 'files') return { stdout: result(n, {}) }
      if (c.script === 'unsession') return { stdout: result(n, {}) }
      return { code: 1 }
    },
    bridge: () => holder.connect(),
  }
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Claude Code's screen after a safeguard-flagged answer: the flag, the empty prompt box and its footer. */
const FLAGGED = [
  '> fix the build',
  '',
  "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). They may flag safe, normal content as well. Claude Code can't respond to this request with Fable 5.",
  '  Double press esc to edit your last message, or try a different model with /model.',
  '',
  '╭──────────────────────────────────────────────────────────╮',
  '│ >                                                        │',
  '╰──────────────────────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\r\n')

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-watchdog-'))
  H.logs.length = 0
  sent.length = 0
  registerProvider(provider)
})
afterEach(() => {
  setRemoteHelperDeps(null)
  setWatchdogManagerForTest(null)
  fs.rmSync(store, { recursive: true, force: true })
})

describe('the Watchdog of a tab through the session helper on another machine', () => {
  it('is armed once, at the tab\'s first attach to its holder (the CLI runs there), as an SSH tab; and is fed what the tab is sent', async () => {
    const id = 'wd-arm'
    const arms: Array<[string, unknown]> = []
    const fed: Array<[string, string]> = []
    plugIn({ arm: (sid, tab) => { arms.push([sid, tab]) }, feed: (sid, data) => { fed.push([sid, data]) } })
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    let armedAtLaunch: number | null = null
    holder.onLaunch = () => { armedAtLaunch = arms.length }
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    expect(pty).not.toBeNull()
    await until('the attach', () => holder.attached !== null)
    await until('the arm', () => arms.length > 0)
    // Not before the holder launched the CLI.
    expect(armedAtLaunch).toBe(0)
    expect(arms).toEqual([[id, { provider: DEFAULT_PROVIDER_ID, shellOnly: false, ask: false, cols: 100, rows: 30 }]])
    holder.output('the CLI draws')
    await until('the feed', () => fed.some(([, d]) => d.includes('the CLI draws')))
    expect(fed.every(([sid]) => sid === id)).toBe(true)
    // Once only: more output does not arm it again.
    holder.output('more')
    await until('the second feed', () => fed.some(([, d]) => d.includes('more')))
    expect(arms).toHaveLength(1)
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a tab closed before its holder attached is never armed', async () => {
    const id = 'wd-closed'
    const arms: string[] = []
    plugIn({ arm: (sid) => { arms.push(sid) }, feed: () => {} })
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    pty!.kill()
    await new Promise((r) => setTimeout(r, 300))
    expect(holder.attached).toBeNull()
    expect(arms).toEqual([])
  })

  // 2.1.3-beta.19 section 1.2's join: an SSH Persistent tab kept by the
  // helper. Its re-open (the restored tab after a quit, Re-attach, a Restart)
  // launches nothing: it attaches to the CLI the holder kept, and that first
  // attach is the same "the CLI runs" signal, so the Watchdog arms there too.
  it('an SSH Persistent tab re-opened onto the session the helper kept is armed at its first attach to it, with nothing launched', async () => {
    const id = 'wd-kept'
    forgetRemoteHelperTab(id)
    const arms: Array<[string, unknown]> = []
    plugIn(undefined)
    // A machine whose last Check read that logind does not end the user's
    // processes at logout: an SSH Persistent tab goes through the helper there.
    const kept: RemoteMachineRecord = { ...MACHINE, helper: { ...MACHINE.helper, path: 'linux-x64/aicc-helper' }, logind: { kill: 'no', exclude: 'root', linger: 'no' } }
    setRemoteHelperDeps({
      platform: 'win32',
      settings: () => ({ remoteSessionsThroughHelper: true }),
      machines: { findByTarget: () => kept, get: () => kept, list: () => [kept], installId: () => INSTALL } as unknown as RemoteMachines,
      runner: ssh,
      bundledSha256: () => SHA,
      systemPrefersDark: () => true,
      onOutput: () => {},
      log: (m) => H.logs.push(m),
      watchdog: { arm: (sid, tab) => { arms.push([sid, tab]) }, feed: () => {} },
    })
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    // Section 1.1's until-ended record on Linux; once launched, a hold for the
    // session exits 3 and list mode names it, as on a real machine.
    const record = () => ({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock`, away: null, lifetime: 'until-ended' })
    ssh.host = {
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'reads') return { stdout: result(n, {}) }
        if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\n` }
        if (c.script === 'hold') {
          if (holder.launch && !holder.ended) return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 3 }
          return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(record())}\n` }
        }
        if (c.script === 'list' || c.script === 'sessions') {
          const sessions = holder.launch && !holder.ended ? [record()] : []
          return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })}\n` }
        }
        if (c.script === 'files' || c.script === 'unsession') return { stdout: result(n, {}) }
        return { code: 1 }
      },
      bridge: () => (holder.ended ? null : holder.connect()),
    }
    const persistent: SSHOptions = { ...SSH_TAB, detachable: true }
    // The first start launches the CLI and arms once; a quit lets go of it.
    const first = remoteHelperPty(win, id, { ssh: persistent }, 100, 30)!
    await until('the first attach', () => holder.attached !== null)
    await until('the first arm', () => arms.length === 1)
    first.kill()
    await until('let go', () => holder.attached === null)
    expect(holder.endsAsked).toBe(0)
    arms.length = 0
    // The next start: the restored tab, with its saved mark.
    forgetRemoteHelperTab(id)
    const second = remoteHelperPty(win, id, { ssh: persistent, remoteVia: 'helper' }, 120, 40)!
    await until('the attach to the kept session', () => holder.attached !== null)
    await until('the arm at that attach', () => arms.length > 0)
    expect((second as RemoteHelperPty).attachedToKept).toBe(true)
    expect(holder.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(arms).toEqual([[id, { provider: DEFAULT_PROVIDER_ID, shellOnly: false, ask: false, cols: 120, rows: 40 }]])
    await endRemoteTab(id)
    forgetRemoteHelperTab(id)
  })

  it('end to end: a safeguard-flagged answer gets the Watchdog pill state and its retry, typed into the holder', async () => {
    const id = 'wd-e2e'
    let clock = 1_000_000
    const timers: Array<() => void> = []
    const typed: string[] = []
    let tab: ReturnType<typeof remoteHelperPty> = null
    const manager = new WatchdogManager({
      getWindow: () => win as never,
      isSessionAlive: () => true,
      // The host's send types the retry into the session (session-input submitRetry, which
      // writes into the tab's terminal); here straight into the tab's terminal.
      send: (_sid, text) => { tab?.write(`${text}\r`) },
      getStalls: () => 0,
      now: () => clock,
      setTimer: (cb) => { timers.push(cb); return 0 as unknown as ReturnType<typeof setTimeout> },
      clearTimer: () => {},
    })
    setWatchdogManagerForTest(manager)
    // The app's own wiring (remote-machines-handlers.ts gives it as the deps' watchdog).
    const { remoteHelperWatchdog } = await import('../../../src/main/watchdog/remote-helper-tab')
    plugIn(remoteHelperWatchdog)
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    holder.onTyped = (b) => { typed.push(b.toString('utf8')) }
    answering(holder)
    tab = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the arm', () => manager.isActive(id))
    // Armed: the pill's first state reaches the window.
    expect(sent.some(([ch, s]) => ch === IPC.WATCHDOG_STATE && (s as { sessionId: string }).sessionId === id)).toBe(true)
    holder.output(FLAGGED)
    const stateOf = () => manager.getStates().find((s) => s.sessionId === id)
    await until('the safeguard state', () => stateOf()?.status === 'safeguard', 3000)
    expect(sent.some(([ch, s]) => ch === IPC.WATCHDOG_STATE && (s as { status: string; sessionId: string }).status === 'safeguard' && (s as { sessionId: string }).sessionId === id)).toBe(true)
    // Its retry is due after the safeguard's delay: the next tick types it.
    clock += 60_000
    for (const run of timers.splice(0)) run()
    await until('the retry typed into the holder', () => typed.join('').includes('continue\r'))
    expect(H.logs.some((l) => l.includes(`[watchdog:${id}]`))).toBe(true)
    tab!.kill()
    await until('the holder to end', () => holder.ended)
  })
})
