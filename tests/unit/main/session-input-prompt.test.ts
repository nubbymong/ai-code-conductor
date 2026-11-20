// A command bar prompt button, typed by main (2.1.3-beta.10 section A1,
// #333): session-input submitPrompt, one rule for every session, on this
// computer and over SSH. Against fake ports and a fake clock. The fake write
// port stands in for writePty: one write up to 256 units, and above that the
// REAL 256-unit, 12 ms chunked writer (pty-chunked-write.ts), so a long text's
// slices and its Enter can be told apart in time.
//
//  - Send, a session that is not Codex: exactly the text in one write, then
//    exactly one Enter as its own write 300 ms after the text's last slice
//    went: on this computer, held by the session helper, and over SSH (an SSH
//    Persistent session gets the tmux leave key first, in the text's write, as
//    submitLine does, and again at the start of the Enter's write, so a wheel
//    turn between the two cannot leave the Enter to tmux's copy-mode). A
//    600-byte text's Enter comes 300 ms after its third slice, not 300 ms
//    after the call.
//  - Type: the text only, and no Enter at all, on each kind (Codex included);
//    a long text is answered only once it has settled, so a next press cannot
//    land between its slices.
//  - The same text pressed twice within 300 ms is typed once; a press past the
//    window goes again. Two different presses keep their order: the second
//    waits for the first one's Enter.
//  - A press types only into the terminal process the session had when it was
//    pressed: one replaced before the Enter gets no Enter, and neither does the
//    new one; a press that waited behind another while the session restarted
//    types nothing (Codex's refused-text fallback included). A session with no
//    terminal process takes nothing.
//  - A press while a local launch line is pending (writePty holds the writes
//    and replays them on a 300 ms timer set at the start, as pty-manager's
//    releaseLaunchHold does): the Enter comes after the held text's last slice.
//  - Send, a Codex session: the Codex run screen's submit with a 5 s ready
//    wait, its answer back, and no raw write; a text the primitive refuses
//    before typing is typed with no Enter and answered as typed, not sent; a
//    text over 8,000 code points never reaches it, nothing is typed, and it is
//    answered not sent (refused-text). The count is code points, not units.
//  - The log names a prompt by its length only.
//  - Before the PTY manager registers its ports the door throws.
//
// Red on beta (no such door). Mutants this must catch: the Enter in the
// text's write; the Enter counted from the call, not from the last slice;
// type mode that still sends Enter; the double-press guard removed; an Enter
// into a replaced terminal process; a Codex prompt written raw with Enter;
// type mode answered before its text settled; a queued press that types into
// whatever process the session has when its turn comes; an SSH Persistent
// Enter written bare; a Codex text over the cap handed to the primitive.
//
// Not checked here: a main process held up between two slices. A fake clock
// cannot hold the event loop; textSettled sets each slice wait after the
// timer of any slice still to go, so it follows that slice
// (session-input/index.ts says why).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  submits: [] as Array<{ sessionId: string; text: string; readyWaitMs: number }>,
  submitAnswer: { delivered: true } as Record<string, unknown>,
  /** When set, a submit waits for it (a Codex turn still running). */
  submitGate: null as Promise<void> | null,
  infos: [] as string[],
}))

vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => {
    if (id !== 'codex') throw new Error(`no provider ${id}`)
    return {
      runScreen: {
        submit: async (sessionId: string, text: string, opts: { readyWaitMs: number }) => {
          h.submits.push({ sessionId, text, readyWaitMs: opts.readyWaitMs })
          if (h.submitGate) await h.submitGate
          return h.submitAnswer
        },
        has: () => true,
        open: () => {}, close: () => {}, resize: () => {}, feed: () => {},
      },
    }
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (msg: string) => { h.infos.push(msg) },
  logWarn: () => {},
  logError: () => {},
}))

const input = await import('../../../src/main/session-input')
const { runChunkedWrite, WRITE_CHUNK_SIZE } = await import('../../../src/main/pty-chunked-write')
const { TMUX_WHEEL_EXIT_KEY, TMUX_WHEEL_UP_KEY } = await import('../../../src/shared/tmux-wheel')

/** A terminal process: what was written to it, and when. */
class FakeRun {
  constructor(readonly kind: 'local' | 'helper') {}
  readonly writes: Array<{ at: number; data: string }> = []
  write(data: string): void { this.writes.push({ at: Date.now(), data }) }
}

const runs = new Map<string, FakeRun>()
const tmux = new Set<string>()
const codex = new Set<string>()
/** Sessions whose launch line is still pending: writePty holds their writes. */
const held = new Map<string, string[]>()
/** Every write the port was handed, in order, and the process it went to. */
const portWrites: Array<{ sessionId: string; data: string }> = []

/** One write as writePty delivers it: whole, or through the real chunked writer above 256 units. */
const deliver = (sessionId: string, run: FakeRun, data: string): void => {
  if (data.length > WRITE_CHUNK_SIZE) runChunkedWrite(data, { write: (slice) => run.write(slice), isAlive: () => runs.get(sessionId) === run })
  else run.write(data)
}

const ports = {
  // writePty, as these tests need it: straight to the session's process, or
  // held while its launch line is pending.
  write: (sessionId: string, data: string): void => {
    portWrites.push({ sessionId, data })
    const run = runs.get(sessionId)
    if (!run) return
    const hold = held.get(sessionId)
    if (hold) hold.push(data)
    else deliver(sessionId, run, data)
  },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: (sessionId: string) => tmux.has(sessionId),
  isCodexSession: (sessionId: string) => codex.has(sessionId),
  isCodexAskSession: () => false,
}

let n = 0
/** A fresh session id for each case, so no press of one case is in another's window. */
const fresh = (prefix: string): string => `${prefix}${++n}`
const startRun = (sessionId: string, kind: 'local' | 'helper' = 'local'): FakeRun => {
  const run = new FakeRun(kind)
  runs.set(sessionId, run)
  return run
}
const datas = (run: FakeRun): string[] => run.writes.map((w) => w.data)
/** A local Claude Code start, as pty-manager makes it: writes held until a
 *  300 ms timer set now writes the launch line and replays them, in order,
 *  each as writePty would (releaseLaunchHold). */
const startLaunching = (sessionId: string): FakeRun => {
  const run = startRun(sessionId)
  held.set(sessionId, [])
  setTimeout(() => {
    const hold = held.get(sessionId) ?? []
    held.delete(sessionId)
    run.write('LAUNCH-LINE')
    for (const data of hold) deliver(sessionId, run, data)
  }, 300)
  return run
}

describe('before the PTY manager registers its ports', () => {
  it('the door throws, rather than drop the prompt silently', () => {
    expect(() => input.submitPrompt('early1', 'hello', 'send')).toThrow(/has not registered its ports/)
    expect(() => input.submitPrompt('early1', 'hello', 'type')).toThrow(/has not registered its ports/)
  })
})

describe('submitPrompt: a command bar prompt button, by one rule', () => {
  beforeAll(() => { input.setSessionInputPorts(ports) })
  beforeEach(() => {
    vi.useFakeTimers()
    h.submits = []
    h.submitAnswer = { delivered: true }
    h.submitGate = null
    h.infos = []
    portWrites.length = 0
  })
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
  })

  describe('send, a session that is not Codex', () => {
    it.each([['on this computer', 'local'], ['held by the session helper', 'helper']] as const)('%s: exactly the text, then exactly one Enter 300 ms later as its own write', async (_name, kind) => {
      const id = fresh('cc')
      const run = startRun(id, kind)
      const t0 = Date.now()
      const answer = input.submitPrompt(id, 'explain this file', 'send')
      expect(datas(run)).toEqual(['explain this file'])
      await vi.advanceTimersByTimeAsync(299)
      expect(datas(run)).toEqual(['explain this file'])
      await vi.advanceTimersByTimeAsync(1)
      expect(datas(run)).toEqual(['explain this file', '\r'])
      expect(run.writes[1].at - t0).toBe(300)
      expect(await answer).toEqual({ outcome: 'sent' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(datas(run)).toEqual(['explain this file', '\r'])
    })

    it('an SSH Persistent session: the tmux leave key and the text, then the leave key and the Enter', async () => {
      const id = fresh('sshp')
      const run = startRun(id)
      tmux.add(id)
      const answer = input.submitPrompt(id, 'run the tests', 'send')
      await vi.advanceTimersByTimeAsync(300)
      expect(datas(run)).toEqual([`${TMUX_WHEEL_EXIT_KEY}run the tests`, `${TMUX_WHEEL_EXIT_KEY}\r`])
      expect(await answer).toEqual({ outcome: 'sent' })
    })

    it('an SSH Persistent session whose wheel opens the scrollback between the text and the Enter: the Enter\'s write still starts with the leave key', async () => {
      const id = fresh('sshw')
      const run = startRun(id)
      tmux.add(id)
      const answer = input.submitPrompt(id, 'run the tests', 'send')
      await vi.advanceTimersByTimeAsync(150)
      // The renderer's wheel, through pty:write, while the Enter waits.
      ports.write(id, TMUX_WHEEL_UP_KEY)
      await vi.advanceTimersByTimeAsync(150)
      expect(datas(run)).toEqual([`${TMUX_WHEEL_EXIT_KEY}run the tests`, TMUX_WHEEL_UP_KEY, `${TMUX_WHEEL_EXIT_KEY}\r`])
      expect(datas(run)[2].startsWith(TMUX_WHEEL_EXIT_KEY)).toBe(true)
      expect(await answer).toEqual({ outcome: 'sent' })
    })

    it('a plain SSH session: no leave key', async () => {
      const id = fresh('ssh')
      const run = startRun(id)
      const answer = input.submitPrompt(id, 'run the tests', 'send')
      await vi.advanceTimersByTimeAsync(300)
      expect(datas(run)).toEqual(['run the tests', '\r'])
      expect(await answer).toEqual({ outcome: 'sent' })
    })

    it('a 600-byte text: its Enter comes 300 ms after its third slice, not 300 ms after the call', async () => {
      const id = fresh('long')
      const run = startRun(id)
      const text = 'x'.repeat(600)
      const t0 = Date.now()
      const answer = input.submitPrompt(id, text, 'send')
      await vi.advanceTimersByTimeAsync(323)
      expect(run.writes.map((w) => w.data.length)).toEqual([256, 256, 88])
      await vi.advanceTimersByTimeAsync(1)
      expect(datas(run).slice(3)).toEqual(['\r'])
      const third = run.writes[2].at
      const enter = run.writes[3].at
      expect(third - t0).toBe(24)
      expect(enter - third).toBe(300)
      expect(datas(run).slice(0, 3).join('')).toBe(text)
      expect(await answer).toEqual({ outcome: 'sent' })
      // The text in one write to the port (writePty slices it), the Enter in another.
      expect(portWrites.filter((w) => w.sessionId === id).map((w) => w.data)).toEqual([text, '\r'])
    })
  })

  describe('type only', () => {
    it.each([
      ['on this computer', 'local', false, false],
      ['held by the session helper', 'helper', false, false],
      ['an SSH Persistent session', 'local', true, false],
      ['a Codex session', 'local', false, true],
    ] as const)('%s: the text, and no Enter at all', async (_name, kind, wrapped, isCodex) => {
      const id = fresh('type')
      const run = startRun(id, kind)
      if (wrapped) tmux.add(id)
      if (isCodex) codex.add(id)
      const answer = input.submitPrompt(id, 'draft a reply', 'type')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(datas(run)).toEqual([`${wrapped ? TMUX_WHEEL_EXIT_KEY : ''}draft a reply`])
      expect(datas(run).join('')).not.toContain('\r')
      expect(h.submits).toEqual([])
      expect(await answer).toEqual({ outcome: 'typed' })
    })

    it('a 600-byte text is answered only once it has settled, so the next press cannot land between its slices', async () => {
      const id = fresh('typelong')
      const run = startRun(id)
      const text = 'y'.repeat(600)
      const t0 = Date.now()
      let answered = false
      const first = input.submitPrompt(id, text, 'type').then((r) => { answered = true; return r })
      const second = input.submitPrompt(id, 'next', 'type')
      await vi.advanceTimersByTimeAsync(323)
      expect(answered).toBe(false)
      expect(datas(run).map((d) => d.length)).toEqual([256, 256, 88])
      await vi.advanceTimersByTimeAsync(1)
      expect(await first).toEqual({ outcome: 'typed' })
      expect(datas(run)).toEqual([text.slice(0, 256), text.slice(256, 512), text.slice(512), 'next'])
      expect(run.writes.map((w) => w.at - t0)).toEqual([0, 12, 24, 324])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await second).toEqual({ outcome: 'typed' })
      expect(datas(run).join('')).not.toContain('\r')
    })
  })

  describe('presses', () => {
    it('the same text twice within 300 ms is typed once; past the window it goes again', async () => {
      const id = fresh('dup')
      const run = startRun(id)
      const first = input.submitPrompt(id, 'continue', 'send')
      await vi.advanceTimersByTimeAsync(120)
      expect(await input.submitPrompt(id, 'continue', 'send')).toEqual({ outcome: 'dropped' })
      await vi.advanceTimersByTimeAsync(400)
      expect(datas(run)).toEqual(['continue', '\r'])
      expect(await first).toEqual({ outcome: 'sent' })
      const again = input.submitPrompt(id, 'continue', 'send')
      await vi.advanceTimersByTimeAsync(300)
      expect(await again).toEqual({ outcome: 'sent' })
      expect(datas(run)).toEqual(['continue', '\r', 'continue', '\r'])
    })

    it('a different text within 300 ms is not a repeat', async () => {
      const id = fresh('diff')
      const run = startRun(id)
      void input.submitPrompt(id, 'one', 'send')
      const second = input.submitPrompt(id, 'two', 'send')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await second).toEqual({ outcome: 'sent' })
      expect(datas(run)).toEqual(['one', '\r', 'two', '\r'])
    })

    it('two presses keep their order: the second is typed only after the first one\'s Enter', async () => {
      const id = fresh('order')
      const run = startRun(id)
      const t0 = Date.now()
      const first = input.submitPrompt(id, 'first', 'send')
      const second = input.submitPrompt(id, 'second', 'send')
      expect(datas(run)).toEqual(['first'])
      await vi.advanceTimersByTimeAsync(300)
      expect(datas(run)).toEqual(['first', '\r', 'second'])
      await vi.advanceTimersByTimeAsync(300)
      expect(datas(run)).toEqual(['first', '\r', 'second', '\r'])
      expect(run.writes.map((w) => w.at - t0)).toEqual([0, 300, 300, 600])
      expect(await first).toEqual({ outcome: 'sent' })
      expect(await second).toEqual({ outcome: 'sent' })
    })

    it('presses on two sessions do not wait for each other', async () => {
      const a = fresh('pa')
      const b = fresh('pb')
      const runA = startRun(a)
      const runB = startRun(b)
      void input.submitPrompt(a, 'same words', 'send')
      void input.submitPrompt(b, 'same words', 'send')
      expect(datas(runA)).toEqual(['same words'])
      expect(datas(runB)).toEqual(['same words'])
      await vi.advanceTimersByTimeAsync(300)
      expect(datas(runA)).toEqual(['same words', '\r'])
      expect(datas(runB)).toEqual(['same words', '\r'])
    })
  })

  describe('the terminal process the text went to', () => {
    it('replaced before the Enter: no Enter into the old one or the new one', async () => {
      const id = fresh('swap')
      const old = startRun(id)
      const answer = input.submitPrompt(id, 'explain this', 'send')
      await vi.advanceTimersByTimeAsync(150)
      const next = startRun(id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(datas(old)).toEqual(['explain this'])
      expect(datas(next)).toEqual([])
      expect(await answer).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    })

    it('ended before the Enter: no Enter', async () => {
      const id = fresh('gone')
      const run = startRun(id)
      const answer = input.submitPrompt(id, 'explain this', 'send')
      await vi.advanceTimersByTimeAsync(100)
      runs.delete(id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(datas(run)).toEqual(['explain this'])
      expect(portWrites.filter((w) => w.sessionId === id).map((w) => w.data)).toEqual(['explain this'])
      expect(await answer).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    })

    it('replaced while a press waits behind another: it types nothing into the new one', async () => {
      const id = fresh('queue')
      const old = startRun(id)
      const first = input.submitPrompt(id, 'first', 'send')
      const second = input.submitPrompt(id, 'second', 'send')
      await vi.advanceTimersByTimeAsync(100)
      const next = startRun(id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await first).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
      expect(await second).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
      expect(datas(old)).toEqual(['first'])
      expect(datas(next)).toEqual([])
    })

    it('pressed for the new one after a restart: typed and sent there', async () => {
      const id = fresh('restart')
      startRun(id)
      const next = startRun(id)
      const answer = input.submitPrompt(id, 'hello', 'send')
      await vi.advanceTimersByTimeAsync(300)
      expect(await answer).toEqual({ outcome: 'sent' })
      expect(datas(next)).toEqual(['hello', '\r'])
    })

    it.each(['send', 'type'] as const)('none at the press (%s): nothing is typed, so nothing waits for a later start', async (mode) => {
      const id = fresh('none')
      const answer = input.submitPrompt(id, 'explain this', mode)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(portWrites.filter((w) => w.sessionId === id)).toEqual([])
      expect(await answer).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    })
  })

  describe('send, a Codex session', () => {
    it('goes to the run screen\'s submit with a 5 s ready wait, its answer comes back, and nothing is written raw', async () => {
      const id = fresh('cx')
      const run = startRun(id)
      codex.add(id)
      const answer = input.submitPrompt(id, 'summarise the diff', 'send')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.submits).toEqual([{ sessionId: id, text: 'summarise the diff', readyWaitMs: 5000 }])
      expect(input.PROMPT_CODEX_READY_WAIT_MS).toBe(5000)
      expect(await answer).toEqual({ outcome: 'sent' })
      expect(datas(run)).toEqual([])
      expect(portWrites.filter((w) => w.sessionId === id)).toEqual([])
    })

    it.each(['busy-timeout', 'prompt-on-screen', 'too-tall', 'not-drawn', 'session-gone'])('not delivered (%s): answered not sent, and nothing typed', async (reason) => {
      const id = fresh('cxn')
      const run = startRun(id)
      codex.add(id)
      h.submitAnswer = { delivered: false, reason }
      const answer = input.submitPrompt(id, 'summarise the diff', 'send')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await answer).toEqual({ outcome: 'not-sent', reason })
      expect(datas(run)).toEqual([])
    })

    it('a text over 8,000 code points: never handed to the primitive, nothing typed, and answered not sent (refused-text)', async () => {
      const id = fresh('cxl')
      const run = startRun(id)
      codex.add(id)
      expect(input.PROMPT_CODEX_MAX_CODE_POINTS).toBe(8000)
      const answer = input.submitPrompt(id, 'a'.repeat(8_001), 'send')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await answer).toEqual({ outcome: 'not-sent', reason: 'refused-text' })
      expect(h.submits).toEqual([])
      expect(datas(run)).toEqual([])
      expect(portWrites.filter((w) => w.sessionId === id)).toEqual([])
    })

    it('the cap counts code points: 8,000 of them in 16,000 UTF-16 units still reach the primitive', async () => {
      const id = fresh('cxc')
      startRun(id)
      codex.add(id)
      const text = String.fromCodePoint(0x1f600).repeat(8_000)
      expect(text.length).toBe(16_000)
      const answer = input.submitPrompt(id, text, 'send')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await answer).toEqual({ outcome: 'sent' })
      expect(h.submits.map((s) => s.text)).toEqual([text])
    })

    it('a text the primitive refuses before typing: typed with no Enter, and answered as typed, not sent', async () => {
      const id = fresh('cxr')
      const run = startRun(id)
      codex.add(id)
      h.submitAnswer = { delivered: false, reason: 'refused-text' }
      const answer = input.submitPrompt(id, 'line one\nline two', 'send')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(datas(run)).toEqual(['line one\nline two'])
      expect(datas(run).join('')).not.toContain('\r')
      expect(await answer).toEqual({ outcome: 'typed', reason: 'refused-text' })
    })

    it('a refused text that waited behind another submission while the session restarted: nothing typed into the new run', async () => {
      const id = fresh('cxq')
      startRun(id)
      codex.add(id)
      let release!: () => void
      h.submitGate = new Promise<void>((r) => { release = r })
      h.submitAnswer = { delivered: false, reason: 'refused-text' }
      const first = input.submitPrompt(id, 'first', 'send')
      const second = input.submitPrompt(id, 'line one\nline two', 'send')
      await vi.advanceTimersByTimeAsync(100)
      const next = startRun(id)
      release()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await first).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
      expect(await second).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
      expect(datas(next)).toEqual([])
      // The second never reached the primitive: its run had gone.
      expect(h.submits.map((s) => s.text)).toEqual(['first'])
    })
  })

  describe('a press while a local launch line is still pending (writePty holds the writes)', () => {
    it.each([0, 100, 299])('pressed %s ms after the start, a 600-byte text: its Enter comes after the held text\'s last slice', async (after) => {
      const id = fresh('held')
      const run = startLaunching(id)
      await vi.advanceTimersByTimeAsync(after)
      const text = 'z'.repeat(600)
      const answer = input.submitPrompt(id, text, 'send')
      await vi.advanceTimersByTimeAsync(5_000)
      // In this order, the Enter last: at the same moment as the last slice
      // only when pressed in the start's own millisecond, and still after it.
      expect(datas(run)).toEqual(['LAUNCH-LINE', text.slice(0, 256), text.slice(256, 512), text.slice(512), '\r'])
      expect(run.writes[4].at).toBeGreaterThanOrEqual(run.writes[3].at)
      expect(await answer).toEqual({ outcome: 'sent' })
    })

    it('a short text pressed at the start: the text, then the Enter', async () => {
      const id = fresh('heldshort')
      const run = startLaunching(id)
      const answer = input.submitPrompt(id, 'hello', 'send')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(datas(run)).toEqual(['LAUNCH-LINE', 'hello', '\r'])
      expect(await answer).toEqual({ outcome: 'sent' })
    })
  })

  it('the log names a prompt by its length only', async () => {
    const id = fresh('log')
    startRun(id)
    void input.submitPrompt(id, 'SECRET-WORDS here', 'send')
    await vi.advanceTimersByTimeAsync(100)
    void input.submitPrompt(id, 'SECRET-WORDS here', 'send')
    await vi.advanceTimersByTimeAsync(1_000)
    const logged = h.infos.join('\n')
    expect(logged).toContain(`[prompt-button] ${id}: a prompt of 17 characters sent`)
    expect(logged).toContain(`[prompt-button] ${id}: a prompt of 17 characters pressed again within the repeat window, so dropped`)
    expect(logged).not.toContain('SECRET')
  })
})
