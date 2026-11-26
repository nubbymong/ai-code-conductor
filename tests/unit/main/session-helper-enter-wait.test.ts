/**
 * 2.1.3-beta.19 section 6.2 (aicc_planning#440): only Claude Code's held
 * terminals wait before a queued lone Enter. Since beta.18's fix round a lone
 * Enter ('\r', or the tmux leave key then '\r') typed while a held terminal
 * was detached goes PROMPT_ENTER_DELAY_MS after the frame before it at the
 * attach again (session-helper/helper-pty.ts, flushQueued): the holder writes
 * frames that come back to back into one read, and Claude Code (2.1.332,
 * measured) takes a control character as a key only in a read shorter than 64
 * characters. Until this section every held terminal waited, a plain one and a
 * Codex one too. Now a provider's run screen declares the wait
 * (SessionRunScreen.heldEnterWaitMs: Claude Code's PROMPT_ENTER_DELAY_MS), the
 * terminal asks its run's provider, and a plain terminal or a provider that
 * declares none sends what was queued at once, as before that fix round.
 *
 * PURE: the real HelperPty and HolderConnection against the fake holder, in
 * memory, with the real Claude Code and Codex packages registered (Electron
 * stood in for, as in tests/unit/providers/run-screen-doors-wired.test.ts);
 * once the link is down the clock is vitest's (setTimeout only), so the wait
 * is exact. session-helper-flow.test.ts keeps the Claude Code terminal's
 * order cases (a second drop, input typed during the wait, the tmux leave
 * key); session-helper-take-over.test.ts holds the manager's agent sessions
 * and take-overs to naming their provider.
 *
 * Red on cc36c7f3 (src/ reverted to it, this file as it is): the plain and
 * Codex terminals' Enter waited, the packages declared nothing, the remote
 * tab's terminal named no provider. Mutants this must catch (each run, each
 * red): the wait given to every provider; Claude Code's run screen declaring
 * none; a declared value that is not a positive number taken as the wait;
 * the remote tab's terminal not told its provider.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
}))

import { HolderConnection, HolderError } from '../../../src/main/session-helper/connection'
import { HelperPty, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { heldSessionId, type HolderRecord } from '../../../src/main/session-helper/protocol'
import { PROMPT_ENTER_DELAY_MS } from '../../../src/main/session-input/enter-delay'
import { TMUX_WHEEL_EXIT_KEY } from '../../../src/shared/tmux-wheel'
import { registerProvider } from '../../../src/main/providers'
import { _resetProviderRegistryForTest } from '../../../src/main/providers/core/registry'
import { ClaudeProvider } from '../../../src/main/providers/claude'
import { CodexProvider } from '../../../src/main/providers/codex'
import type { SessionProvider } from '../../../src/main/providers/types'
import type { ProviderId } from '../../../src/shared/providers/ids'
import { RemoteHelperPty, remoteLaunchSpec, type RemoteLaunchPlan } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { FakeHolder } from './session-helper-fake-holder'
import { FakeSsh } from '../remote-helper/fake-ssh'

/** An image request as the app types it: longer than 64 characters. */
const REQUEST = `Please use the fetch_host_screenshot tool to fetch ${'x'.repeat(100)} and look at it.`

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}
/** Let the streams run a while, firing only the timers due now (fake clock). */
async function turns(k = 40): Promise<void> {
  for (let i = 0; i < k; i++) {
    vi.advanceTimersByTime(0)
    await new Promise<void>((res) => setImmediate(res))
  }
}
async function untilTurns(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await turns(1)
  if (!cond()) throw new Error(`timed out waiting for ${what}`)
}

function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

const folders: string[] = []
const holders: FakeHolder[] = []
const conns: HolderConnection[] = []
let n = 0

afterEach(async () => {
  vi.useRealTimers()
  for (const h of holders.splice(0)) h.vanish()
  for (const c of conns.splice(0)) c.close()
  await tick(10)
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * A held terminal run by `provider` (a plain one when absent), attached, then
 * its connection dropped with the attach again held until `open()`. Every
 * frame HelperPty hands a connection is noted in `sent`, in order.
 */
async function dropped(provider?: ProviderId): Promise<{ p: HelperPty; h: FakeHolder; sent: string[]; open: () => void }> {
  const store = mkdtempSync(join(tmpdir(), 'aicc-enter-wait-'))
  folders.push(store)
  const app = `abcdef0123456789abcdef${String(n++ % 100).padStart(2, '0')}`
  const h = new FakeHolder(heldSessionId(app), app, store)
  holders.push(h)
  const sent: string[] = []
  const gate = { wait: null as Promise<void> | null, open: () => {} }
  const driver: HelperPtyDriver = {
    hold: async () => { h.writeRecord(); return h.record() },
    connect: async (record: HolderRecord) => {
      if (gate.wait) await gate.wait
      const c = await HolderConnection.open({
        record,
        os: 'windows',
        openStream: async () => {
          if (h.gone || h.ended) throw new HolderError('io', 'no holder at that endpoint')
          return h.connect()
        },
        replyTimeoutMs: 2000,
        pingEveryMs: 0,
      })
      conns.push(c)
      const send = c.sendInput.bind(c)
      c.sendInput = (b: Buffer) => { sent.push(b.toString('utf8')); send(b) }
      return c
    },
    direct: () => fakeDirect(),
    ending: () => {},
    attachedChanged: () => {},
    log: () => {},
  }
  const p = new HelperPty({
    sid: h.sid,
    label: app,
    spec: { argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, cols: 80, rows: 24 },
    driver,
    ...(provider ? { provider } : {}),
  })
  await until(() => p.isAttached, 'the terminal to attach')
  gate.wait = new Promise<void>((res) => { gate.open = () => { gate.wait = null; res() } })
  h.fallBehind()
  await until(() => !p.isAttached, 'the drop')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return { p, h, sent, open: () => gate.open() }
}

/** The request and a lone Enter typed during the drop, then the link back:
 *  what went at the attach again, before any timer ran. */
async function requestThenEnter(provider?: ProviderId): Promise<{ sent: string[]; h: FakeHolder; p: HelperPty }> {
  const { p, h, sent, open } = await dropped(provider)
  p.write(REQUEST)
  p.write('\r')
  open()
  await untilTurns(() => sent.length > 0 && p.isAttached, 'the attach again')
  await turns()
  return { sent, h, p }
}

describe('the packages declare the wait a held terminal\'s queued lone Enter keeps', () => {
  it('Claude Code\'s run screen declares PROMPT_ENTER_DELAY_MS (300 ms); Codex\'s declares none', () => {
    expect(PROMPT_ENTER_DELAY_MS).toBe(300)
    expect(new ClaudeProvider().runScreen?.heldEnterWaitMs).toBe(PROMPT_ENTER_DELAY_MS)
    const codex = new CodexProvider().runScreen
    expect(codex).toBeDefined()
    expect(codex?.heldEnterWaitMs).toBeUndefined()
  })
})

describe('a request and its lone Enter typed while detached, at the attach again, by the run\'s provider (the real packages registered)', () => {
  beforeAll(() => {
    registerProvider(new ClaudeProvider() as unknown as SessionProvider)
    registerProvider(new CodexProvider() as unknown as SessionProvider)
  })
  afterAll(() => { _resetProviderRegistryForTest() })

  it('a plain terminal: both go at once, each its own frame, in order', async () => {
    expect(REQUEST.length).toBeGreaterThan(64)
    const { sent, h, p } = await requestThenEnter()
    expect(p.provider).toBeUndefined()
    expect(sent).toEqual([REQUEST, '\r'])
    await untilTurns(() => Buffer.concat(h.input).toString('utf8') === `${REQUEST}\r`, 'both at the holder')
  })

  it('a Codex terminal: both go at once, as for a plain terminal', async () => {
    const { sent, h, p } = await requestThenEnter('codex')
    expect(p.provider).toBe('codex')
    expect(sent).toEqual([REQUEST, '\r'])
    await untilTurns(() => Buffer.concat(h.input).toString('utf8') === `${REQUEST}\r`, 'both at the holder')
  })

  it('a Claude Code terminal: the request at once, the Enter as its own frame PROMPT_ENTER_DELAY_MS later', async () => {
    const { sent, h, p } = await requestThenEnter('claude')
    expect(p.provider).toBe('claude')
    expect(sent).toEqual([REQUEST])
    vi.advanceTimersByTime(PROMPT_ENTER_DELAY_MS - 1)
    await turns()
    expect(sent).toEqual([REQUEST])
    vi.advanceTimersByTime(1)
    await turns()
    expect(sent).toEqual([REQUEST, '\r'])
    await untilTurns(() => Buffer.concat(h.input).toString('utf8') === `${REQUEST}\r`, 'both at the holder')
  })

  it('a Claude Code terminal over SSH Persistent: the tmux leave key then Enter waits too; a Codex one\'s goes at once', async () => {
    const leaveEnter = `${TMUX_WHEEL_EXIT_KEY}\r`
    const claude = await dropped('claude')
    claude.p.write(REQUEST)
    claude.p.write(leaveEnter)
    claude.open()
    await untilTurns(() => claude.sent.length > 0 && claude.p.isAttached, 'the Claude Code attach again')
    await turns()
    expect(claude.sent).toEqual([REQUEST])
    vi.advanceTimersByTime(PROMPT_ENTER_DELAY_MS)
    await turns()
    expect(claude.sent).toEqual([REQUEST, leaveEnter])
    vi.useRealTimers()
    const codex = await dropped('codex')
    codex.p.write(REQUEST)
    codex.p.write(leaveEnter)
    codex.open()
    await untilTurns(() => codex.sent.length > 0 && codex.p.isAttached, 'the Codex attach again')
    await turns()
    expect(codex.sent).toEqual([REQUEST, leaveEnter])
  })
})

describe('a provider whose answer is no wait: what was queued goes at once', () => {
  afterEach(() => { _resetProviderRegistryForTest() })

  /** A stand-in for the Claude Code id whose run screen declares `ms`. */
  function declaring(ms: unknown): void {
    registerProvider({ id: 'claude', runScreen: { heldEnterWaitMs: ms } } as unknown as SessionProvider)
  }

  it.each([
    ['0', 0],
    ['a negative number', -300],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '300'],
    ['nothing', undefined],
  ])('declared as %s', async (_what, ms) => {
    declaring(ms)
    const { sent } = await requestThenEnter('claude')
    expect(sent).toEqual([REQUEST, '\r'])
  })

  it('the provider is not registered', async () => {
    const { sent } = await requestThenEnter('claude')
    expect(sent).toEqual([REQUEST, '\r'])
  })

  it('the provider has no run screen', async () => {
    const id: ProviderId = 'codex'
    registerProvider({ id } as unknown as SessionProvider)
    const { sent } = await requestThenEnter(id)
    expect(sent).toEqual([REQUEST, '\r'])
  })

  it('reading its run screen throws: the flush goes on, at once', async () => {
    const odd = { id: 'claude' }
    Object.defineProperty(odd, 'runScreen', { get: () => { throw new Error('no run screen today') } })
    registerProvider(odd as unknown as SessionProvider)
    const { sent } = await requestThenEnter('claude')
    expect(sent).toEqual([REQUEST, '\r'])
  })

  it('a declared wait of another length is kept as declared', async () => {
    declaring(120)
    const { sent } = await requestThenEnter('claude')
    expect(sent).toEqual([REQUEST])
    vi.advanceTimersByTime(119)
    await turns()
    expect(sent).toEqual([REQUEST])
    vi.advanceTimersByTime(1)
    await turns()
    expect(sent).toEqual([REQUEST, '\r'])
  })
})

describe('a tab through the session helper on its machine names its provider to its terminal', () => {
  const SHA = 'a'.repeat(64)
  const MACHINE: RemoteMachineRecord = {
    did: '0123456789abcdef0123456789abcdef', host: 'ubuntu.lan', port: 22, user: 'nick', label: 'Ubuntu', addedAt: 1,
    os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true,
    claudePath: '/home/nick/.npm-global/bin/claude', path: '/home/nick/.npm-global/bin:/usr/bin:/bin', lang: 'C.UTF-8',
    helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  }
  const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~/work', 100, 30)
  /** Its terminal, read past the class's private field. */
  const innerOf = (pty: RemoteHelperPty): HelperPty => (pty as unknown as { inner: HelperPty }).inner

  async function opened(plan?: RemoteLaunchPlan): Promise<RemoteHelperPty> {
    const ssh = new FakeSsh({ answer: () => ({ code: 1 }), bridge: () => null })
    const pty = new RemoteHelperPty({ appPtyId: `tab-enter-wait-${n++}`, machine: MACHINE, installId: 'f'.repeat(32), runner: ssh, spec, log: () => {}, ...(plan ? { plan } : {}), reconnectDelaysMs: [10], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    // Its start fails (the stand-in launch below, or the fake ssh) and it
    // shows the tab why; then it is closed.
    await until(() => !pty.throughHelper, 'the start to settle')
    return pty
  }

  it('with its provider\'s launch: the terminal runs that provider (Claude Code\'s)', async () => {
    // Only `provider` is read here; the launch refuses, so nothing is started.
    const plan = { provider: 'claude', reads: [], via: { launch: () => { throw new Error('not in this test') } } } as unknown as RemoteLaunchPlan
    const pty = await opened(plan)
    expect(innerOf(pty).provider).toBe('claude')
    pty.kill()
    await pty.ended
  })

  it('with no launch of its provider\'s (a test\'s tab): none', async () => {
    const pty = await opened()
    expect(innerOf(pty).provider).toBeUndefined()
    pty.kill()
    await pty.ended
  })
})
