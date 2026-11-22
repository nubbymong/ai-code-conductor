import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { IPty } from 'node-pty'

/**
 * aicc_planning #363: on the ConPTY built into Windows a terminal whose
 * program ended by itself kept its console host until the app quit, because
 * node-pty forgets the pseudoconsole, unclosed, when the program exits. The
 * app now times each such terminal's start and, after node-pty reports the
 * program's exit, has the session helper's end-console-host mode end the host
 * made in that time. The helper's own rules (which host it ends, and that it
 * ends none of two) are tested in helper/tests/console_hosts.rs and
 * helper/src/consoles.rs; this is the app's side: which terminals are timed,
 * when the helper is asked, with what, and the answer. Everything runs on
 * in-memory ports and fake terminals: no process is started.
 */

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn() }))
const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

import { spawnEndingConsoleHost, filetimeOf, _setConsoleHostEndPortsForTest, type ConsoleHostEndPorts } from '../../../src/main/console-host-end'
import type { HelperRun } from '../../../src/main/console-host-leftovers'
import { spawnAgentPty, spawnPlainPty, spawnRunPty } from '../../../src/main/session-helper/manager'

const HELPER = 'C:\\Program Files\\AI Code Conductor\\resources\\helper\\aicc-helper.exe'
const OWN_PID = 4242
const ENDED_ONE: HelperRun = { ok: true, stdout: `{"pid":${OWN_PID},"created":"133000000000000000","ended":1}\n`, stderr: '' }

function fakePorts(opts: { times?: number[]; platform?: NodeJS.Platform; helper?: string | null } = {}) {
  const runs: string[][] = []
  const logs: string[] = []
  const times = [...(opts.times ?? [])]
  const state = { answer: ENDED_ONE }
  const ports: Partial<ConsoleHostEndPorts> = {
    platform: opts.platform ?? 'win32',
    ownPid: OWN_PID,
    now: () => {
      const t = times.shift()
      if (t === undefined) throw new Error('the clock was read more often than the test set')
      return t
    },
    helperPath: () => (opts.helper === undefined ? HELPER : opts.helper),
    runHelper: async (helper, args) => {
      runs.push([helper, ...args])
      return state.answer
    },
    log: (line) => { logs.push(line) },
  }
  _setConsoleHostEndPortsForTest(ports)
  return { runs, logs, times, state }
}

/** A terminal as node-pty makes one on Windows (it has node-pty's agent), or
 *  without the agent; its exit fires every listener given to onExit. */
function fakeTerminal(opts: { agent?: boolean; pid?: number } = {}) {
  const exits: Array<(e: { exitCode: number }) => void> = []
  const proc = {
    pid: opts.pid ?? 5150,
    ...(opts.agent === false ? {} : { _agent: {} }),
    onExit: (cb: (e: { exitCode: number }) => void) => {
      exits.push(cb)
      return { dispose: () => {} }
    },
  }
  return { proc: proc as unknown as IPty, exits, exit: () => { for (const cb of [...exits]) cb({ exitCode: 0 }) } }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0))
const endArgs = (from: number, toIncluded: number) => [HELPER, 'end-console-host', '--made-from', filetimeOf(from), '--made-to', filetimeOf(toIncluded + 1)]

beforeEach(() => { ptySpawn.mockReset() })
afterEach(() => { _setConsoleHostEndPortsForTest(null) })

describe('a terminal on the ConPTY built into Windows', () => {
  it('has its console host ended once its program has ended, once, for the time its start took', async () => {
    const { runs, logs } = fakePorts({ times: [1_000, 1_003] })
    const t = fakeTerminal()
    expect(spawnEndingConsoleHost({ useConpty: true }, () => t.proc)).toBe(t.proc)
    await settle()
    expect(runs).toEqual([])
    t.exit()
    await settle()
    expect(runs).toEqual([endArgs(1_000, 1_003)])
    expect(logs).toContain('[console-hosts] Ended the console host of a terminal whose program ended (process 5150)')
    // node-pty reports an exit once; asked again, nothing more runs.
    t.exit()
    await settle()
    expect(runs).toHaveLength(1)
  })

  it('whose program still runs is never asked for', async () => {
    const { runs } = fakePorts({ times: [1_000, 1_001] })
    const t = fakeTerminal()
    spawnEndingConsoleHost({}, () => t.proc)
    await settle()
    expect(t.exits).toHaveLength(1)
    expect(runs).toEqual([])
  })

  it('started in the same millisecond as another: neither is asked for, a later one is', async () => {
    const { runs } = fakePorts({ times: [5, 7, 7, 9, 12, 13] })
    const a = fakeTerminal()
    const b = fakeTerminal()
    const c = fakeTerminal()
    spawnEndingConsoleHost({}, () => a.proc)
    spawnEndingConsoleHost({}, () => b.proc)
    spawnEndingConsoleHost({}, () => c.proc)
    a.exit()
    b.exit()
    c.exit()
    await settle()
    expect(runs).toEqual([endArgs(12, 13)])
  })

  it('whose start took ten seconds or more, or whose clock was set back, is not asked for', async () => {
    const { runs } = fakePorts({ times: [0, 10_000, 20_000, 19_000, 30_000, 39_999] })
    const slow = fakeTerminal()
    const back = fakeTerminal()
    const almost = fakeTerminal()
    spawnEndingConsoleHost({}, () => slow.proc)
    spawnEndingConsoleHost({}, () => back.proc)
    spawnEndingConsoleHost({}, () => almost.proc)
    slow.exit()
    back.exit()
    almost.exit()
    await settle()
    expect(runs).toEqual([endArgs(30_000, 39_999)])
  })

  it('in an install with no session helper: nothing runs, said once', async () => {
    const { runs, logs } = fakePorts({ times: [1, 2, 10, 11], helper: null })
    const a = fakeTerminal()
    const b = fakeTerminal()
    spawnEndingConsoleHost({}, () => a.proc)
    spawnEndingConsoleHost({}, () => b.proc)
    a.exit()
    b.exit()
    await settle()
    expect(runs).toEqual([])
    expect(logs.filter((l) => l.includes('not in this install'))).toHaveLength(1)
  })

  it('takes only an answer that names this process, and says when the helper failed', async () => {
    const { runs, logs, state } = fakePorts({ times: [1, 2, 10, 11, 20, 21] })
    state.answer = { ok: true, stdout: '{"pid":99,"created":"1","ended":1}', stderr: '' }
    const other = fakeTerminal()
    spawnEndingConsoleHost({}, () => other.proc)
    other.exit()
    await settle()
    expect(logs.some((l) => l.includes('could not be read, or names another process'))).toBe(true)
    expect(logs.some((l) => l.startsWith('[console-hosts] Ended'))).toBe(false)

    state.answer = { ok: false, stdout: '', stderr: '', why: 'no answer within 10 s' }
    const failed = fakeTerminal({ pid: 77 })
    spawnEndingConsoleHost({}, () => failed.proc)
    failed.exit()
    await settle()
    expect(logs).toContain('[console-hosts] The session helper could not end the console host of a terminal whose program ended (process 77): no answer within 10 s')

    // Nothing ended, with the helper's note: the note is logged, no "Ended" line.
    state.answer = { ok: true, stdout: `{"pid":${OWN_PID},"created":"1","ended":0}`, stderr: 'aicc-helper: note: 2 console hosts were made in that time, so none was ended\n' }
    const two = fakeTerminal({ pid: 78 })
    spawnEndingConsoleHost({}, () => two.proc)
    two.exit()
    await settle()
    expect(runs).toHaveLength(3)
    expect(logs).toContain('[console-hosts] About a terminal whose program ended (process 78): aicc-helper: note: 2 console hosts were made in that time, so none was ended')
    expect(logs.filter((l) => l.startsWith('[console-hosts] Ended'))).toHaveLength(0)
  })
})

describe('left as it was', () => {
  it('node-pty\'s bundled ConPTY, another system, and what node-pty did not make on Windows', async () => {
    const { runs, times } = fakePorts({ times: [1, 2] })
    const bundled = fakeTerminal()
    expect(spawnEndingConsoleHost({ useConpty: true, useConptyDll: true }, () => bundled.proc)).toBe(bundled.proc)
    expect(bundled.exits).toHaveLength(0)
    expect(times).toEqual([1, 2])

    const notOurs = fakeTerminal({ agent: false })
    expect(spawnEndingConsoleHost({}, () => notOurs.proc)).toBe(notOurs.proc)
    expect(notOurs.exits).toHaveLength(0)

    fakePorts({ platform: 'linux' })
    const unix = fakeTerminal()
    expect(spawnEndingConsoleHost({}, () => unix.proc)).toBe(unix.proc)
    expect(unix.exits).toHaveLength(0)
    bundled.exit()
    notOurs.exit()
    unix.exit()
    await settle()
    expect(runs).toEqual([])
  })
})

describe('the time the helper is given', () => {
  it('is the FILETIME count of each millisecond, exactly', () => {
    expect(filetimeOf(0)).toBe('116444736000000000')
    const ms = Date.UTC(2026, 10, 22, 13, 27, 30, 843)
    expect(filetimeOf(ms)).toBe(((BigInt(ms) + 11_644_473_600_000n) * 10_000n).toString())
  })
})

describe('the PTY manager\'s terminals started the usual way (session-helper/manager.ts)', () => {
  it('go through it: a Terminal only tab, a local agent session and a run of the app\'s own, with their arguments as given', async () => {
    const { runs } = fakePorts({ times: [100, 101, 200, 201, 300, 301] })
    const plain = fakeTerminal()
    const agent = fakeTerminal()
    const run = fakeTerminal()
    ptySpawn.mockReturnValueOnce(plain.proc).mockReturnValueOnce(agent.proc).mockReturnValueOnce(run.proc)
    const opts = { name: 'xterm-256color', cols: 120, rows: 30, cwd: 'C:\\work', env: {}, useConpty: true as const }
    expect(spawnPlainPty({ sessionId: 'tab-1', plain: false }, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo'], opts)).toBe(plain.proc)
    expect(spawnAgentPty({ sessionId: 'tab-2', kind: 'claude' }, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [], opts)).toBe(agent.proc)
    expect(spawnRunPty({ runId: 'insights--default', kind: 'claude' }, 'C:\\Users\\A\\.local\\bin\\claude.exe', [], opts)).toBe(run.proc)
    expect(ptySpawn.mock.calls).toEqual([
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo'], opts],
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [], opts],
      ['C:\\Users\\A\\.local\\bin\\claude.exe', [], opts],
    ])
    plain.exit()
    agent.exit()
    run.exit()
    await settle()
    expect(runs).toEqual([endArgs(100, 101), endArgs(200, 201), endArgs(300, 301)])
  })
})

describe('node-pty, as this works around it (1.2.0-beta.15)', () => {
  // When node-pty no longer forgets the pseudoconsole as its program exits,
  // its own kill closes it again and this end is no longer needed: this fails
  // then, to say so.
  const root = resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty')
  it('drops the pseudoconsole, unclosed, when the program exits, and its kill closes only one it still has', () => {
    const cc = readFileSync(resolve(root, 'src', 'win', 'conpty.cc'), 'utf8')
    const exitThread = cc.slice(cc.indexOf('void SetupExitCallback('), cc.indexOf('Napi::Error errorWithCode('))
    expect(exitThread).toContain('WaitForSingleObject(baton->hShell, INFINITE)')
    expect(exitThread).toContain('std::erase_if(ptyHandles')
    expect(exitThread).not.toContain('ClosePseudoConsole')
    const kill = cc.slice(cc.indexOf('static Napi::Value PtyKill('))
    expect(kill).toMatch(/pty_baton\* handle = get_pty_baton\(lock, id\);\s*\n\s*if \(handle != nullptr\) \{/)
  })
  it('keeps its ConPTY agent where this looks for it', () => {
    const js = readFileSync(resolve(root, 'lib', 'windowsTerminal.js'), 'utf8')
    expect(js).toContain('_this._agent = new windowsPtyAgent_1.WindowsPtyAgent(')
  })
})
