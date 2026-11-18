// The session input module's submitLine into an SSH session (2.1.3-beta.9
// section A1): the Watchdog's retry into an SSH Persistent session (its
// Claude Code wrapped in tmux on the host) goes in after tmux's leave key, so a
// pane the user scrolled up in (tmux copy-mode, which swallows input) is left
// first and the retry reaches Claude Code (#85). Any other SSH session gets the
// line and Enter only. The rest of submitLine is in session-input.test.ts; this
// half needs the SSH flow's own mocks (as pty-manager-ssh-tmux.test.ts drives
// it): the real spawnPty SSH branch and the real Claude Code provider over a
// recording stand-in for node-pty, so nothing is started and no host reached.
// These assertions held on beta, against pty-manager's writeSubmittedLine,
// before it moved.
//
// Mutants this must catch: the leave key dropped; the leave key added to a
// session that is not wrapped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))

const h = vi.hoisted(() => ({
  dataCbs: [] as Array<(d: string) => void>,
  writes: [] as string[],
}))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5656, process: 'ssh', cols: 80, rows: 24,
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose() {} } },
    onExit: () => ({ dispose() {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize() {}, kill() {},
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))

const { spawnPty, getSshFlow, killPty, _getSshNonceForTest } = await import('../../../src/main/pty-manager')
const { submitLine } = await import('../../../src/main/session-input')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { TMUX_WHEEL_EXIT_KEY } = await import('../../../src/shared/tmux-wheel')
registerProvider(new ClaudeProvider())

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const HOST = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

const feed = (text: string): void => { for (const cb of h.dataCbs) cb(text) }
/** The host's setup answer, with the session's own nonce. */
const setupOk = (sessionId: string, tmux: 'path' | 'none'): string => {
  const nonce = _getSshNonceForTest(sessionId)
  if (nonce === undefined) throw new Error(`no nonce for ${sessionId}: spawnPty must run first`)
  return `setup ok ${nonce} tmux=${tmux}\r\n`
}

let seq = 0
let SID = ''
/** An SSH session that starts Claude Code, driven through host setup to the
 *  Claude Code launch (as pty-manager-ssh-tmux.test.ts's driveToClaudeWrite
 *  does). The host reports tmux on its PATH; `detachable: false` launches
 *  Claude Code bare all the same. */
function launchClaude(sshExtra: Record<string, unknown> = {}): string {
  spawnPty(win, SID, { ssh: { ...HOST, ...sshExtra } } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300) // the host setup write, 200 ms after the click
  feed(setupOk(SID, 'path'))
  vi.advanceTimersByTime(1500) // the idle fallback after setup
  vi.advanceTimersByTime(300) // the Claude Code launch write, 200 ms later
  const launch = h.writes.find((w) => w.includes('claude '))
  if (!launch) throw new Error('the Claude Code launch was not written')
  h.writes = []
  return launch
}

beforeEach(() => {
  vi.useFakeTimers()
  SID = `sinpssh${String(++seq).padStart(17, '0')}`
  h.dataCbs = []
  h.writes = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('submitLine into an SSH session', () => {
  it('an SSH Persistent session (Claude Code wrapped in tmux): the leave key, then exactly the line and Enter, as one write', () => {
    const launch = launchClaude()
    expect(launch).toMatch(/new-session\s+-s\s+ccc-/)
    submitLine(SID, 'continue')
    expect(h.writes).toEqual([`${TMUX_WHEEL_EXIT_KEY}continue\r`])
  })

  it('an SSH session that is not wrapped: exactly the line and Enter, no leave key', () => {
    const launch = launchClaude({ detachable: false })
    expect(launch).not.toMatch(/new-session\s+-s\s+ccc-/)
    submitLine(SID, 'continue')
    expect(h.writes).toEqual(['continue\r'])
  })

  it('a repeat within 300 ms is suppressed on a wrapped session too', () => {
    launchClaude()
    submitLine(SID, 'continue')
    vi.advanceTimersByTime(100)
    submitLine(SID, 'continue')
    expect(h.writes).toEqual([`${TMUX_WHEEL_EXIT_KEY}continue\r`])
  })
})
