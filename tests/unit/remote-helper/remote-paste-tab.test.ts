/**
 * What a helper tab gives the paste route (plan 2.1.3-beta.21, block 5.1, its
 * App bullet; ADR-032), with a fake holder and a fake ssh:
 *
 * - a tab whose CLI reads its pictures through the clipboard stand-in (its
 *   launch asks, on a Linux host) reads its holder's screen for the paste's
 *   placeholder: its own connection acks `screen` and `title` when the holder
 *   offers them, and the read goes on that connection (remoteTabScreen);
 *   a tab whose launch does not ask reads none, as before;
 * - its paste (remoteTabPaste): whether the stand-in serves its CLI, the key
 *   its launch gave from the host's own keybindings file (a rebound chord
 *   included), and its picture sent by file.put;
 * - an attach to a session kept for the tab (an SSH Persistent tab after the
 *   app restarts): the stand-in its own launch wrote is taken as there (it
 *   stays with the session's folder; no files exec runs at an attach), the
 *   key is read again at this start, and the holder's size is NOT read before
 *   the attach (a helper tab on another machine shows its replay as before:
 *   the screen read is for the paste only);
 * - no such tab: nothing.
 * Red on e89996bb: no screen read on a helper tab's connection, no key, no
 * route port. Mutants this must catch: the holder's size read before a kept
 * attach; the stand-in taken as there for a launch that does not ask.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { forgetRemoteHelperTab, remoteHelperPty, remoteTabPaste, remoteTabScreen, setRemoteHelperDeps } from '../../../src/main/remote-helper'
import { remoteSessionId, type RemoteHelperPty } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import { PASTE_NAME_RE } from '../../../src/main/session-helper/protocol'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result, type ExecCall } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  // A host where logind keeps a user's processes after a sign-out, so an SSH Persistent tab goes through the helper.
  logind: { kill: 'no', exclude: 'root', linger: 'no' },
}
const OFFERS = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status', 'paste']
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }
const PERSISTENT: SSHOptions = { ...SSH_TAB, detachable: true }
const CTRL_V = '\u0016'
const ESC_V = '\u001bv'
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
/** The keybindings read's answer: it is the launch's fifth host read (f4). */
const rebound = { f4: `ok ${hex(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'alt+v': 'chat:imagePaste' } }] }))}` }

let store = ''
let logs: string[] = []
let ssh: FakeSsh
const win = { webContents: { send: () => {} }, isDestroyed: () => false }

function provider(asks: boolean): SessionProvider {
  const remoteLaunch = asks ? claudeRemoteLaunch : { ...claudeRemoteLaunch, launch: (...a: Parameters<typeof claudeRemoteLaunch.launch>) => ({ ...claudeRemoteLaunch.launch(...a), clipStandIn: false }) }
  return {
    id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
    detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch,
  } as unknown as SessionProvider
}

function plugIn(asks = true): void {
  registerProvider(provider(asks))
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => MACHINE, get: () => MACHINE, list: () => [MACHINE], installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
  })
}

/** The host for `holder`: the reads answer `reads`; the files exec writes the
 *  stand-in (`clip ok`); a hold once launched exits 3 and list mode lists it
 *  (kept until it is ended, for `kept`). */
function host(holder: FakeHolder, reads: Record<string, string>, kept = false): void {
  const record = (): Record<string, unknown> => ({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock`, ...(kept ? { away: null, lifetime: 'until-ended' } : {}) })
  ssh.host = {
    answer: (c: ExecCall) => {
      const n = c.values[0]
      if (c.script === 'reads') return { stdout: result(n, reads) }
      if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\n` }
      if (c.script === 'hold') {
        if (holder.launch && !holder.ended) return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 3 }
        return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(record())}\n` }
      }
      if (c.script === 'list') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ v: 1, sessions: holder.launch && !holder.ended ? [record()] : [], removed: 0, skipped: 0 })}\n` }
      if (c.script === 'files') return { stdout: result(n, { clip: 'ok' }) }
      if (c.script === 'unsession') return { stdout: result(n, {}) }
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

function holderFor(id: string): FakeHolder {
  const h = new FakeHolder(remoteSessionId(id), id, store)
  h.caps = OFFERS
  return h
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-paste-tab-'))
  logs = []
})
afterEach(() => {
  setRemoteHelperDeps(null)
  fs.rmSync(store, { recursive: true, force: true })
})

describe('a helper tab whose CLI reads pictures through the stand-in', () => {
  it('its own connection acks screen and title, and its screen read goes on it', async () => {
    plugIn()
    const id = 'paste-tab-screen'
    const holder = holderFor(id)
    host(holder, {})
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect(holder.attached!.ackedCaps).toEqual(expect.arrayContaining(['screen', 'title', 'paste']))
    const read = remoteTabScreen(id)
    expect(typeof read).toBe('function')
    const rows = await read!()
    expect(rows.cols).toBe(100)
    expect(rows.lines.length).toBe(rows.rows)
    expect(holder.screenReads).toBe(1)
    pty.kill()
    await pty.ended
  })

  it('its paste: the stand-in serves its CLI, Ctrl+V with no keybindings file there, and its picture by file.put', async () => {
    plugIn()
    const id = 'paste-tab-default'
    const holder = holderFor(id)
    host(holder, {})
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    const tab = remoteTabPaste(id)!
    expect(tab.standIn).toBe(true)
    expect(tab.key).toEqual({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' })
    const stored = await tab.put(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png')
    expect(stored.name).toMatch(PASTE_NAME_RE)
    expect(holder.pictures.map((p) => p.name)).toEqual([stored.name])
    pty.kill()
    await pty.ended
  })

  it('the host account\'s rebound key: the chord its keybindings file binds, read at the tab\'s start', async () => {
    plugIn()
    const id = 'paste-tab-rebound'
    const holder = holderFor(id)
    host(holder, rebound)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect(ssh.calls[0].stdin.toString().split('\n')).toContain('home .claude/keybindings.json')
    expect(remoteTabPaste(id)!.key).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'keybindings' })
    pty.kill()
    await pty.ended
  })
})

describe('a helper tab whose launch does not ask for the stand-in', () => {
  it('reads no screen, as before, and its paste is not served there', async () => {
    plugIn(false)
    const id = 'paste-tab-none'
    const holder = holderFor(id)
    host(holder, {})
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect(holder.attached!.ackedCaps).not.toContain('screen')
    expect(holder.attached!.ackedCaps).not.toContain('title')
    expect(remoteTabScreen(id)).toBeUndefined()
    expect(remoteTabPaste(id)!.standIn).toBe(false)
    pty.kill()
    await pty.ended
  })
})

describe('an attach to a session kept for the tab', () => {
  it('takes the stand-in its launch wrote as there, reads the key again, and reads no holder size before the attach', async () => {
    plugIn()
    const id = 'paste-tab-kept'
    forgetRemoteHelperTab(id)
    const holder = holderFor(id)
    host(holder, {}, true)
    const first = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    first.kill()
    await until('let go', () => holder.attached === null)
    // The next start (the app restarted): the host's keybindings file now rebinds the key.
    host(holder, rebound, true)
    forgetRemoteHelperTab(id)
    const reads = holder.screenReads
    const before = ssh.calls.length
    const second = remoteHelperPty(win, id, { ssh: PERSISTENT, remoteVia: 'helper' }, 100, 30) as unknown as RemoteHelperPty
    await until('attached again', () => holder.attached !== null)
    expect(second.attachedToKept).toBe(true)
    expect(ssh.calls.slice(before).map((c) => c.script)).toEqual(['reads', 'field', 'hold', 'list', 'bridge'])
    // A helper tab on another machine shows its replay as before: no size read first.
    await new Promise((r) => setTimeout(r, 50))
    expect(holder.screenReads).toBe(reads)
    expect(holder.attached!.ackedCaps).toEqual(expect.arrayContaining(['screen', 'title']))
    const tab = remoteTabPaste(id)!
    expect(second.clipStandInReady).toBe(false)
    expect(tab.standIn).toBe(true)
    expect(tab.key).toEqual({ bytes: ESC_V, chord: 'alt+v', from: 'keybindings' })
    second.kill()
    await until('let go again', () => holder.attached === null)
  })

  it('a kept session whose launch does not ask: no stand-in taken as there, and no screen read', async () => {
    plugIn(false)
    const id = 'paste-tab-kept-none'
    forgetRemoteHelperTab(id)
    const holder = holderFor(id)
    host(holder, {}, true)
    const first = remoteHelperPty(win, id, { ssh: PERSISTENT }, 100, 30) as unknown as RemoteHelperPty
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    first.kill()
    await until('let go', () => holder.attached === null)
    forgetRemoteHelperTab(id)
    const second = remoteHelperPty(win, id, { ssh: PERSISTENT, remoteVia: 'helper' }, 100, 30) as unknown as RemoteHelperPty
    await until('attached again', () => holder.attached !== null)
    expect(second.attachedToKept).toBe(true)
    expect(remoteTabPaste(id)!.standIn).toBe(false)
    expect(holder.attached!.ackedCaps).not.toContain('screen')
    second.kill()
    await until('let go again', () => holder.attached === null)
  })
})

describe('no such tab', () => {
  it('nothing to paste through and no screen to read', () => {
    expect(remoteTabPaste('no-such-tab')).toBeNull()
    expect(remoteTabScreen('no-such-tab')).toBeUndefined()
  })
})
