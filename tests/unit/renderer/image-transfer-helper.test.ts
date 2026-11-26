/**
 * 2.1.3-beta.18 fix round, item 1 (section 3.2's host line, aicc_planning#431):
 * an image's fetch request (Alt+V, Snap) into a Claude Code tab that runs
 * through the session helper on its machine.
 *
 * The host line: the request was typed into the helper tab and not sent (2 of
 * 2); one more Enter sent it. In today's SSH tab the same request sent itself,
 * and in the same helper tab a canvas marker sent itself.
 *
 * The measured cause. Claude Code (2.1.332, its input tokenizer as read from
 * its own binary) makes a control character a key of its own only when the
 * whole read it arrives in is shorter than 64 characters
 * (`F=e.length<64`); in a longer read a CR stays in the text, so it is not the
 * Enter. A helper tab hands each write to the holder as one frame
 * (helper-pty.ts write, sendInput), and the holder writes each frame to the
 * program's terminal whole (helper/src/holder.rs, the input thread), so the
 * request and its CR, written together (about 175 characters), reached Claude
 * Code as one read. That marker's line and its CR were under 64 characters, so its CR was the
 * Enter (one of 63 characters or more would not have sent itself; since
 * 2.1.3-beta.19 section 6.1 a marker's Enter is its own write in a helper
 * tab). Today's SSH tab sends the same one write through ConPTY and ssh.exe
 * and submits; how they split it was not measured.
 *
 * The fix: for a tab main says goes through the helper (ssh.getState answers
 * `through-helper`), the request, then its Enter as its own write
 * HELPER_ENTER_DELAY_MS later, as a prompt button's Enter goes into a Claude
 * Code session (#333). Any other tab gets the one write it always got.
 * Red on 1656fe80: the helper tab got the request and its Enter in one write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type FlowListener = (msg: { state: string }) => void
const h = vi.hoisted(() => ({
  writeSessionInput: vi.fn(),
  submitImage: vi.fn(),
  getState: vi.fn(),
  listeners: new Map<string, Set<(msg: { state: string }) => void>>(),
}))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: h.writeSessionInput }))
const ssh = {
  getState: h.getState,
  onFlowState: (sessionId: string, cb: FlowListener) => {
    const set = h.listeners.get(sessionId) ?? new Set<FlowListener>()
    set.add(cb)
    h.listeners.set(sessionId, set)
    return () => { set.delete(cb) }
  },
}
const api: { pty: { submitImage: typeof h.submitImage }; ssh?: typeof ssh } = { pty: { submitImage: h.submitImage }, ssh }
;(globalThis as unknown as { window: unknown }).window = { electronAPI: api }

const { sendImageToSession, composeFetchHostScreenshotPrompt } = await import('../../../src/renderer/utils/imageTransfer')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

/**
 * Whether a CR in one read reaches Claude Code as the Enter key: Claude Code
 * 2.1.332's tokenizer makes it a key of its own only in a read shorter than 64
 * characters (string length, as its tokenizer counts); in a longer read it
 * stays in the text run.
 */
function crIsEnter(read: string): boolean {
  return read.includes('\r') && read.length < 64
}

/** What Claude Code reads on the host for a helper tab: each write is one read
 *  (one frame, written whole), when the writes are apart in time. */
const readsOf = (): string[] => h.writeSessionInput.mock.calls.map((c) => String(c[1]))

const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\clipboard-1795606094143-e7db9b91.jpg'
const ALT_V = 'I just pasted an image \u2014 please view it.'
const SNAP_REGION = 'I just snapped a region of my screen \u2014 please view it.'
const SNAP_WINDOW = 'I just captured a window from my screen \u2014 please view it.'
const requestFor = (sentence: string): string => composeFetchHostScreenshotPrompt('clipboard-1795606094143-e7db9b91.jpg', sentence)

const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => {
  vi.useFakeTimers()
  h.writeSessionInput.mockReset()
  h.submitImage.mockReset()
  h.getState.mockReset()
  h.listeners.clear()
  api.ssh = ssh
  useSessionStore.setState({ sessions: [{ id: 'rh1' }, { id: 'ss1' }] } as never)
})
afterEach(() => {
  vi.useRealTimers()
  useSessionStore.setState({ sessions: [] } as never)
})

describe('the model of Claude Code\'s reads agrees with the host line', () => {
  it('a canvas marker and its Enter in one write: the Enter is read (it sent itself in the helper tab)', () => {
    expect(crIsEnter('Review #1 \u2014 1 note \u00b7 canvas_review R1\r')).toBe(true)
  })
  it('the image request and its Enter in one write: the Enter is not read (typed and not sent, 2 of 2)', () => {
    expect(crIsEnter(`${requestFor(ALT_V)}\r`)).toBe(false)
  })
})

describe('an image request into a tab through the session helper', () => {
  it.each([['Alt+V', ALT_V], ['Snap, Rectangle', SNAP_REGION], ['Snap, Window', SNAP_WINDOW]])('%s: the request, then its Enter as its own write 300 ms later, which Claude Code reads as the Enter', async (_name, sentence) => {
    h.getState.mockResolvedValue({ state: 'through-helper' })
    sendImageToSession('rh1', PATH, sentence, 'ssh')
    await settle()
    expect(h.getState).toHaveBeenCalledWith('rh1')
    expect(h.submitImage).not.toHaveBeenCalled()
    expect(readsOf()).toEqual([requestFor(sentence)])
    await vi.advanceTimersByTimeAsync(299)
    expect(readsOf()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf()).toEqual([requestFor(sentence), '\r'])
    expect(h.writeSessionInput.mock.calls.every((c) => c[0] === 'rh1')).toBe(true)
    // Claude Code takes no Enter from the request and one from the write after it.
    expect(readsOf().map(crIsEnter)).toEqual([false, true])
  })

  it('a new run of the tab while the Enter waits (main pushes a flow state at every start): no Enter', async () => {
    h.getState.mockResolvedValue({ state: 'through-helper' })
    sendImageToSession('rh1', PATH, ALT_V, 'ssh')
    await settle()
    expect(readsOf()).toEqual([requestFor(ALT_V)])
    for (const cb of h.listeners.get('rh1') ?? []) cb({ state: 'through-helper' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(readsOf()).toEqual([requestFor(ALT_V)])
    expect(h.listeners.get('rh1')?.size ?? 0).toBe(0)
  })

  it('the tab closed while the Enter waits: no Enter', async () => {
    h.getState.mockResolvedValue({ state: 'through-helper' })
    sendImageToSession('rh1', PATH, ALT_V, 'ssh')
    await settle()
    useSessionStore.setState({ sessions: [{ id: 'ss1' }] } as never)
    await vi.advanceTimersByTimeAsync(1000)
    expect(readsOf()).toEqual([requestFor(ALT_V)])
  })
})

describe('every other tab types what it always typed', () => {
  it.each([['connected'], ['claude-running'], ['connecting']])('today\'s SSH tab (its flow reads %s): the request and its Enter in one write, byte for byte', async (state) => {
    h.getState.mockResolvedValue({ state })
    sendImageToSession('ss1', PATH, ALT_V, 'ssh')
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.writeSessionInput.mock.calls).toEqual([['ss1', `${requestFor(ALT_V)}\r`]])
  })

  it('no session type given: the same one write', async () => {
    h.getState.mockResolvedValue({ state: 'connected' })
    sendImageToSession('ss1', PATH, ALT_V)
    await settle()
    expect(h.writeSessionInput.mock.calls).toEqual([['ss1', `${requestFor(ALT_V)}\r`]])
  })

  it('a preload with no ssh bridge: the one write, at once', () => {
    api.ssh = undefined
    sendImageToSession('ss1', PATH, ALT_V, 'ssh')
    expect(h.writeSessionInput.mock.calls).toEqual([['ss1', `${requestFor(ALT_V)}\r`]])
  })

  it('an ask that fails: the one write', async () => {
    h.getState.mockRejectedValue(new Error('no handler'))
    sendImageToSession('ss1', PATH, ALT_V, 'ssh')
    await settle()
    expect(h.writeSessionInput.mock.calls).toEqual([['ss1', `${requestFor(ALT_V)}\r`]])
  })

  it('a tab on this computer: main\'s image door, and the flow is not asked', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'sent' })
    sendImageToSession('cl1', PATH, ALT_V, 'local')
    await settle()
    expect(h.submitImage).toHaveBeenCalledTimes(1)
    expect(h.getState).not.toHaveBeenCalled()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
  })
})
