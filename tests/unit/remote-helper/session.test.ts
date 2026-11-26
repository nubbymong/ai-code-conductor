/**
 * A Claude Code SSH tab through the session helper on its machine (plan
 * 2.1.3-beta.17, section A2; aicc_planning#411), with a fake ssh whose bridge
 * exec (A1's contract: `aicc-helper bridge --store <folder> --session <sid>`,
 * exit 3 with no holder) hands back a fake holder's connection: the launch
 * goes through the host's login shell with no typed line; a dropped link
 * attaches again once, with the holder's replay; a closed tab sends
 * term.end, even one closed just as its link drops (the end goes once more
 * on a new link); a holder a crash left for the tab's session is ended
 * before a new one starts; the app's own image request is typed as it is
 * (2.1.3-beta.18 section 3.2: such a tab has the image fetch tool); a launch
 * the holder refuses names the folder and the holder's words in the tab.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { RemoteHelperPty, remoteSessionId, remoteLaunchSpec, remoteCwd, RECONNECT_DELAYS_MS } from '../../../src/main/remote-helper/session'
import { composeFetchHostScreenshotPrompt } from '../../../src/renderer/utils/imageTransfer'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { HolderRecord } from '../../../src/main/session-helper/protocol'
import { FakeSsh, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true,
  claudePath: '/home/nick/.npm-global/bin/claude', path: '/home/nick/.npm-global/bin:/usr/bin:/bin', lang: 'C.UTF-8',
  helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const INSTALL = 'f'.repeat(32)

let store: string
beforeAll(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-session-')) })
afterAll(() => { fs.rmSync(store, { recursive: true, force: true }) })

async function until(what: string, ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The record a holder's `hold --detach` prints on Linux. */
function linuxRecord(h: FakeHolder): HolderRecord {
  return { ...h.record(), endpoint: `/tmp/aicc-1000/${h.sid}-0123456789abcdef.sock` }
}

function holdAnswer(c: ExecCall, h: FakeHolder): FakeAnswer {
  return { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${JSON.stringify(linuxRecord(h))}\n` }
}

function tab(ssh: FakeSsh, appPtyId: string, logs: string[] = []) {
  const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: ['--model', 'opus[1m]'], env: { CLAUDE_CODE_DISABLE_MOUSE: '1' } }, {}, '~/work', 100, 30)
  const pty = new RemoteHelperPty({ appPtyId, machine: MACHINE, installId: INSTALL, runner: ssh, spec, log: (m) => logs.push(m), reconnectDelaysMs: [10, 10], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  let out = ''
  pty.onData((d) => { out += d })
  let exit: number | null = null
  pty.onExit((e) => { exit = e.exitCode })
  return { pty, out: () => out, exit: () => exit }
}

describe('remote session: the launch', () => {
  it('a config\'s remote path is made absolute against the host home', () => {
    expect(remoteCwd('', '/home/n')).toBe('/home/n')
    expect(remoteCwd('~', '/home/n')).toBe('/home/n')
    expect(remoteCwd('~/a b', '/home/n')).toBe('/home/n/a b')
    expect(remoteCwd('/srv/x', '/home/n')).toBe('/srv/x')
    expect(remoteCwd('proj', '/home/n/')).toBe('/home/n/proj')
  })

  it('starts the CLI through the host\'s login shell, values as arguments, with the -il PATH, in the tab\'s folder, and nothing typed', async () => {
    const sid = remoteSessionId('tab-launch')
    const holder = new FakeHolder(sid, 'tab-launch', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => holder.connect() })
    const t = tab(ssh, 'tab-launch')
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect(holder.launch?.argv).toEqual(['/bin/bash', '-il', '-c', 'exec "$0" "$@"', '/home/nick/.npm-global/bin/claude', '--model', 'opus[1m]'])
    expect(holder.launch?.cwd).toBe('/home/nick/work')
    expect(holder.launch?.env).toMatchObject({ HOME: '/home/nick', USER: 'nick', SHELL: '/bin/bash', PATH: '/home/nick/.npm-global/bin:/usr/bin:/bin', TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_MOUSE: '1' })
    // Its pid is never one on this computer.
    expect(t.pty.pid).toBe(0)
    // The hold exec names the helper folder, hash and session; the bridge too.
    expect(ssh.scripts()).toEqual(['hold', 'bridge'])
    // 2.1.3-beta.19: the holder's kind; a plain SSH tab's has the away clock.
    expect(ssh.calls[0].values.slice(1)).toEqual([MACHINE.did, INSTALL, MACHINE.helper.folder, SHA, sid, 'tab-launch', 'away'])
    expect(ssh.calls[1].values.slice(3)).toEqual([MACHINE.helper.folder, SHA, sid])
    holder.output('FAKE-CLI READY\r\n')
    await until('output', () => t.out().includes('FAKE-CLI READY'))
    t.pty.write('hello\r')
    await until('input', () => Buffer.concat(holder.input).toString() === 'hello\r')
    t.pty.resize(120, 40)
    await until('the resize', () => holder.size?.cols === 120 && holder.size.rows === 40)
    t.pty.kill()
    await t.pty.ended
  })
})

describe('remote session: a dropped link', () => {
  it('attaches again from the last byte seen, once, and the replay shows what came meanwhile, each byte once', async () => {
    const sid = remoteSessionId('tab-drop')
    const holder = new FakeHolder(sid, 'tab-drop', store)
    let bridges = 0
    let detachedAtSecond: boolean | null = null
    const ssh = new FakeSsh({
      answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }),
      bridge: () => {
        if (++bridges === 2) {
          // While the link is down the program goes on writing: only the ring has it.
          detachedAtSecond = holder.attached === null
          holder.output('two ')
        }
        return holder.connect()
      },
    })
    const logs: string[] = []
    const t = tab(ssh, 'tab-drop', logs)
    await until('attached', () => holder.attached !== null)
    holder.output('one ')
    await until('first output', () => t.out() === 'one ')
    // The ssh child of the bridge ends (a dropped link).
    const first = ssh.children[1]
    expect(t.pty.linkPid).toBe(first.pid)
    first.kill()
    await until('attached again', () => holder.attaches === 2 && t.out() === 'one two ')
    expect(detachedAtSecond).toBe(true)
    expect(t.pty.linkPid).toBe(ssh.children[2].pid)
    expect(ssh.scripts()).toEqual(['hold', 'bridge', 'bridge'])
    const attaches = holder.requests.filter((r) => r.t === 'term.attach')
    expect(attaches.map((r) => r.from)).toEqual([0, 4])
    expect(logs.some((l) => l.includes('attaching again from 4'))).toBe(true)
    holder.output('three')
    await until('live again', () => t.out() === 'one two three')
    t.pty.kill()
    await t.pty.ended
  })

  // 2.1.3-beta.18 fix round, item 3: the host line's re-attach line, with the
  // tab's local ssh killed (exit -1 on Windows, read unsigned), blamed the
  // helper on the machine. It names the ssh link on this computer now.
  it.each([
    ['ssh killed on Windows (-1, read unsigned)', { code: 4294967295 }, 'ssh exit -1'],
    ['ssh ended by a signal', { code: null, signal: 'SIGKILL' }, 'ssh ended by SIGKILL'],
  ] as const)('%s while the link is down: the re-attach line names the ssh link on this computer', async (_name, cut, end) => {
    const id = `tab-cut-${end.length}`
    const sid = remoteSessionId(id)
    const holder = new FakeHolder(sid, id, store)
    let bridges = 0
    const ssh = new FakeSsh({
      answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }),
      bridge: () => holder.connect(),
      bridgeCut: () => (++bridges === 2 ? { ...cut } : undefined),
    })
    const logs: string[] = []
    const t = tab(ssh, id, logs)
    await until('attached', () => holder.attached !== null)
    ssh.children[1].kill()
    await until('attached again', () => holder.attaches === 2)
    expect(logs.filter((l) => l.includes('is not back yet'))).toEqual([
      `[remote-helper] ${sid}: the link to rocky.lan is not back yet (the ssh link on this computer ended before the session helper answered (${end}))`,
    ])
    t.pty.kill()
    await t.pty.ended
  })

  it('a bridge that finds no holder (exit 3) is not tried again, and the tab ends', async () => {
    const sid = remoteSessionId('tab-gone')
    const holder = new FakeHolder(sid, 'tab-gone', store)
    let bridges = 0
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => (++bridges === 1 ? holder.connect() : null) })
    const t = tab(ssh, 'tab-gone')
    await until('attached', () => holder.attached !== null)
    ssh.children[1].kill()
    await until('the end', () => t.exit() !== null, 6000)
    // One try to come back (it found no holder), then the end's own try: nothing more.
    expect(ssh.scripts().filter((s) => s === 'bridge').length).toBeLessThanOrEqual(3)
    expect(RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(120_000)
  })
})

describe('remote session: the end', () => {
  it('a closed tab sends term.end, and the holder ends', async () => {
    const sid = remoteSessionId('tab-close')
    const holder = new FakeHolder(sid, 'tab-close', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => holder.connect() })
    const t = tab(ssh, 'tab-close')
    await until('attached', () => holder.attached !== null)
    t.pty.kill()
    await t.pty.ended
    expect(holder.endsAsked).toBe(1)
    expect(holder.ended).toBe(true)
    expect(t.exit()).not.toBeNull()
  })

  it('a tab closed just as its link drops still ends its holder: the end goes once more, over a link of its own', async () => {
    const sid = remoteSessionId('tab-close-drop')
    const holder = new FakeHolder(sid, 'tab-close-drop', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => holder.connect() })
    const logs: string[] = []
    const t = tab(ssh, 'tab-close-drop', logs)
    await until('attached', () => holder.attached !== null)
    // The link's ssh dies and the tab is closed in the same moment: the end
    // sent on the old link goes down with it (a dead ssh carries nothing).
    ssh.children[1].kill()
    t.pty.kill()
    await t.pty.ended
    await until('the holder ended', () => holder.ended)
    expect(holder.endsAsked).toBe(1)
    expect(ssh.scripts()).toEqual(['hold', 'bridge', 'bridge'])
    expect(logs.some((l) => l.includes('the link dropped as the tab closed; its end goes once more on a new link'))).toBe(true)
  })

  it('a tab closed as its link drops, when the end did reach the holder: the second try finds no holder and stops', async () => {
    const sid = remoteSessionId('tab-close-gone')
    const holder = new FakeHolder(sid, 'tab-close-gone', store)
    let bridges = 0
    // The second bridge finds no holder (exit 3): the end had reached it after all.
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => (++bridges === 1 ? holder.connect() : null) })
    const t = tab(ssh, 'tab-close-gone')
    await until('attached', () => holder.attached !== null)
    ssh.children[1].kill()
    t.pty.kill()
    await t.pty.ended
    await new Promise((r) => setTimeout(r, 50))
    expect(ssh.scripts()).toEqual(['hold', 'bridge', 'bridge'])
    expect(t.exit()).not.toBeNull()
  })

  it('a holder an earlier run left for the tab\'s session (hold exits 3) is ended first, then a new one starts: never two CLIs on one conversation', async () => {
    const sid = remoteSessionId('tab-left')
    const left = new FakeHolder(sid, 'tab-left', store)
    left.launch = { t: 'term.launch' }
    left.child = 'running'
    const fresh = new FakeHolder(sid, 'tab-left', store)
    let holds = 0
    const ssh = new FakeSsh({
      answer: (c) => {
        if (c.script === 'hold') return ++holds === 1 ? { code: 3, stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n` } : holdAnswer(c, fresh)
        if (c.script === 'list') return { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n{"v":1,"sessions":[${JSON.stringify(linuxRecord(left))}],"removed":0,"skipped":0}\n` }
        return { code: 1 }
      },
      bridge: (c) => (c.values[0] && left.ended ? fresh.connect() : left.connect()),
    })
    const t = tab(ssh, 'tab-left')
    await until('the new holder attached', () => fresh.attached !== null)
    expect(left.endsAsked).toBe(1)
    expect(left.ended).toBe(true)
    expect(ssh.scripts().slice(0, 4)).toEqual(['hold', 'list', 'bridge', 'hold'])
    t.pty.kill()
    await t.pty.ended
  })

  it('a helper with no bridge mode (exit 2, a usage error) is not tried again: the tab names the exit and ends', async () => {
    const sid = remoteSessionId('tab-no-bridge')
    const holder = new FakeHolder(sid, 'tab-no-bridge', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => null, bridgeExit: 2 })
    const t = tab(ssh, 'tab-no-bridge')
    await until('the end', () => t.exit() !== null)
    expect(t.out()).toContain("the session helper's bridge on rocky.lan exited 2")
    // The start's one try, then the end's one try at term.end: never the back-off.
    expect(ssh.scripts()).toEqual(['hold', 'bridge', 'bridge'])
  })

  it('a launch the holder refuses (the folder is not there) names the folder and the holder\'s words, not "it did not answer", and the holder is ended', async () => {
    const sid = remoteSessionId('tab-refused')
    const holder = new FakeHolder(sid, 'tab-refused', store)
    const ssh = new FakeSsh({
      answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }),
      // Its hello says the session is new; then it refuses the launch.
      bridge: () => { const end = holder.connect(); holder.launch = { t: 'term.launch' }; return end },
    })
    const t = tab(ssh, 'tab-refused')
    await until('the end', () => t.exit() !== null)
    expect(t.out()).toContain('Claude Code could not be started in /home/nick/work on rocky.lan: this holder has launched its session already')
    expect(t.out()).not.toContain('it did not answer')
    await until('the holder ended', () => holder.ended)
    expect(holder.endsAsked).toBe(1)
  })

  it('a helper file that fails its hash check on the host starts nothing: the tab says why and ends', async () => {
    const ssh = new FakeSsh({ answer: (c) => ({ code: 97, stdout: `AICC-HASH ${c.values[0]} mismatch ${'b'.repeat(64)}\n` }) })
    const t = tab(ssh, 'tab-bad-hash')
    await until('the end', () => t.exit() !== null)
    expect(t.exit()).toBe(1)
    expect(t.out()).toContain('could not start through the session helper on rocky.lan')
    expect(t.out()).toContain('did not pass its hash check (mismatch)')
    expect(ssh.scripts()).toEqual(['hold'])
  })
})

describe('remote session: an image paste', () => {
  it('the app\'s own image request and the storyboard\'s line are typed as they are: the tab has the image fetch tool (2.1.3-beta.18 section 3.2)', async () => {
    const sid = remoteSessionId('tab-image')
    const holder = new FakeHolder(sid, 'tab-image', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => holder.connect() })
    const t = tab(ssh, 'tab-image')
    await until('attached', () => holder.attached !== null)
    // The app's own request, as the renderer writes it (the same function), and the storyboard's line.
    const request = `${composeFetchHostScreenshotPrompt('a.png', 'I just pasted an image, please view it.')}\r`
    const frames = 'Frames (use mcp__conductor__fetch_host_screenshot for each):\n'
    t.pty.write(request)
    t.pty.write(frames)
    await until('both typed', () => Buffer.concat(holder.input).toString() === request + frames)
    expect(t.out()).not.toMatch(/nothing was typed/)
    t.pty.kill()
    await t.pty.ended
  })
})

// Found by the beta.17 final-head review: an ssh that could not be started
// was named nowhere, and the error its start got went to no log, so a blocked
// ssh.exe could not be told from a missing one.
describe('remote session: no ssh on this computer', () => {
  const noSsh = () => { throw new Error('ssh was not found in a folder PATH names (ssh.exe).') }
  const line = '[remote-helper] rocky.lan: ssh could not be started on this computer: ssh was not found in a folder PATH names (ssh.exe).'

  it('a tab start says so in its note, logs the error ssh\'s start got, and starts nothing', async () => {
    const ssh = new FakeSsh({ answer: () => ({ code: 1 }) })
    ssh.sshPath = noSsh
    const logs: string[] = []
    const t = tab(ssh, 'tab-no-ssh', logs)
    await until('the end', () => t.exit() !== null)
    expect(t.out()).toContain('could not start through the session helper on rocky.lan: rocky.lan could not be reached: ssh could not be started on this computer')
    expect(logs).toContain(line)
    expect(ssh.calls).toHaveLength(0)
  })

  it('a reconnect (the bridge exec) logs the error ssh\'s start got', async () => {
    const sid = remoteSessionId('tab-no-ssh-again')
    const holder = new FakeHolder(sid, 'tab-no-ssh-again', store)
    const ssh = new FakeSsh({ answer: (c) => (c.script === 'hold' ? holdAnswer(c, holder) : { code: 1 }), bridge: () => holder.connect() })
    const logs: string[] = []
    const t = tab(ssh, 'tab-no-ssh-again', logs)
    await until('attached', () => holder.attached !== null)
    ssh.sshPath = noSsh
    ssh.children[1].kill()
    await until('the log line', () => logs.includes(line))
    expect(ssh.scripts()).toEqual(['hold', 'bridge'])
    t.pty.kill()
    await t.pty.ended
  })
})
