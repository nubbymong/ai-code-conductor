// The Machines page's IPC (2.1.3-beta.6, plan section C.2): four doors answered
// by one MachinesSource. Pinned here: the default source's sentences (helper off,
// nothing held, End and Re-attach refused in plain words), that the source is
// read on every call (so setMachinesSource takes effect at once), that a source
// that throws or stays silent reads as a helper that did not answer and never as
// a rejected call, that each door waits its own time, that End and Re-attach take
// only an id of the helper protocol's session-id shape, and that only the app's
// own window (its main frame) is answered.
//
// PURE: ipcMain is the shared mock; handlers are captured and called directly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-channels'
import { HELD_SESSION_ID, MACHINES_NO_ANSWER, type MachinesSource, type MachineStatus } from '../../../src/shared/machines'

const {
  registerMachinesHandlers, defaultMachinesSource, setMachinesSource, getMachinesSource,
  MACHINES_OFF_SELF_TEST, MACHINES_OFF_END, MACHINES_OFF_REATTACH,
  MACHINES_BAD_ID, MACHINES_NOT_APP,
  MACHINES_STATUS_TIMEOUT_MS, MACHINES_ACTION_TIMEOUT_MS, MACHINES_SELF_TEST_TIMEOUT_MS,
} = await import('../../../src/main/ipc/machines-handlers')

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const handlers = new Map<string, Handler>()

// The app's own window: its web contents and that web contents' main frame.
const frame = { id: 'main-frame' }
const webContents = { mainFrame: frame }
const win = { isDestroyed: () => false, webContents } as any
const appEvent = { sender: webContents, senderFrame: frame }

const HELD = 'held-0001'

const readyStatus: MachineStatus = {
  id: 'this-computer', name: 'This computer',
  helper: { state: 'ready', version: '0.4.1' },
  sessions: [{ id: HELD, kind: 'plain', label: 'build', startedAt: 1, attached: true, tabOpen: true }],
}

function fakeSource(over: Partial<MachinesSource> = {}): MachinesSource {
  return {
    status: vi.fn(async () => readyStatus),
    runSelfTest: vi.fn(async () => ({ ok: true, at: 7, detail: 'fine' })),
    endSession: vi.fn(async () => ({ ok: true })),
    reattach: vi.fn(async () => ({ ok: true })),
    ...over,
  }
}

/** Register against the app's own window, and call a door the way the app's window does. */
function register(getSource: () => MachinesSource): void {
  registerMachinesHandlers(getSource, () => win)
}
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(appEvent, ...args)

beforeEach(() => {
  handlers.clear()
  vi.mocked(ipcMain.handle).mockReset()
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => { handlers.set(channel, fn) }) as any)
})
afterEach(() => {
  vi.useRealTimers()
  setMachinesSource(defaultMachinesSource())
})

describe('the default source', () => {
  it('says the helper is off and holds nothing; the page\'s own sentence says how to switch it on', async () => {
    const s = await defaultMachinesSource().status()
    expect(s).toEqual({
      id: 'this-computer',
      name: 'This computer',
      helper: { state: 'off' },
      sessions: [],
    })
    // No detail: it would only repeat what the page already says for Off.
    expect(s.helper.detail).toBeUndefined()
  })

  it('refuses the self-test, End and Re-attach with a plain sentence each', async () => {
    const src = defaultMachinesSource()
    const test = await src.runSelfTest()
    expect(test.ok).toBe(false)
    expect(test.detail).toBe('The session helper is off, so there is nothing to test.')
    expect(Number.isFinite(test.at)).toBe(true)
    expect(await src.endSession('x')).toEqual({ ok: false, message: 'The session helper is off, so it holds no terminal to end.' })
    expect(await src.reattach('x')).toEqual({ ok: false, message: 'The session helper is off, so it holds no terminal to re-attach.' })
    expect([MACHINES_OFF_SELF_TEST, MACHINES_OFF_END, MACHINES_OFF_REATTACH]).toEqual([
      test.detail, 'The session helper is off, so it holds no terminal to end.', 'The session helper is off, so it holds no terminal to re-attach.',
    ])
  })

  it('is what the handlers answer from until another source is plugged in', async () => {
    register(getMachinesSource)
    const s = (await call(IPC.MACHINES_STATUS)) as MachineStatus
    expect(s.helper.state).toBe('off')
    expect(s.sessions).toEqual([])
    expect(await call(IPC.MACHINES_END_SESSION, HELD)).toEqual({ ok: false, message: MACHINES_OFF_END })
  })

  it('uses no em dash in any sentence it shows', () => {
    for (const sentence of [MACHINES_OFF_SELF_TEST, MACHINES_OFF_END, MACHINES_OFF_REATTACH, MACHINES_NO_ANSWER, MACHINES_BAD_ID, MACHINES_NOT_APP]) {
      expect(sentence).not.toMatch(/—/)
    }
  })
})

describe('registerMachinesHandlers', () => {
  it('registers exactly the four Machines channels', () => {
    register(() => fakeSource())
    expect([...handlers.keys()].sort()).toEqual([
      IPC.MACHINES_END_SESSION, IPC.MACHINES_REATTACH, IPC.MACHINES_SELF_TEST, IPC.MACHINES_STATUS,
    ].sort())
  })

  it('passes each answer through from the source, and the id to End and Re-attach', async () => {
    const src = fakeSource()
    register(() => src)
    expect(await call(IPC.MACHINES_STATUS)).toEqual(readyStatus)
    expect(await call(IPC.MACHINES_SELF_TEST)).toEqual({ ok: true, at: 7, detail: 'fine' })
    expect(await call(IPC.MACHINES_END_SESSION, HELD)).toEqual({ ok: true })
    expect(await call(IPC.MACHINES_REATTACH, HELD)).toEqual({ ok: true })
    expect(src.endSession).toHaveBeenCalledWith(HELD)
    expect(src.reattach).toHaveBeenCalledWith(HELD)
  })

  it('reads the source on every call, so a later setMachinesSource shows at once', async () => {
    register(getMachinesSource)
    expect(((await call(IPC.MACHINES_STATUS)) as MachineStatus).helper.state).toBe('off')
    setMachinesSource(fakeSource())
    expect(((await call(IPC.MACHINES_STATUS)) as MachineStatus).helper.state).toBe('ready')
    expect(getMachinesSource()).not.toBe(undefined)
  })

  it('a source that throws reads as a helper that did not answer, never as a rejected call', async () => {
    const boom = () => Promise.reject(new Error('pipe closed'))
    register(() => fakeSource({ status: boom, runSelfTest: boom, endSession: boom, reattach: boom }))
    const s = (await call(IPC.MACHINES_STATUS)) as MachineStatus
    expect(s.helper).toEqual({ state: 'failed', detail: MACHINES_NO_ANSWER })
    expect(s.sessions).toEqual([])
    const t = await call(IPC.MACHINES_SELF_TEST)
    expect(t.ok).toBe(false)
    expect(t.detail).toBe(MACHINES_NO_ANSWER)
    expect(await call(IPC.MACHINES_END_SESSION, HELD)).toEqual({ ok: false, message: MACHINES_NO_ANSWER })
    expect(await call(IPC.MACHINES_REATTACH, HELD)).toEqual({ ok: false, message: MACHINES_NO_ANSWER })
    // The raw error text never reaches the page.
    expect(JSON.stringify([s, t])).not.toContain('pipe closed')
  })

  it('a source that stays silent is read as not answering, after each door\'s own wait and not a moment before', async () => {
    vi.useFakeTimers()
    const never = () => new Promise<never>(() => {})
    register(() => fakeSource({ status: never, runSelfTest: never, endSession: never, reattach: never }))

    // Each door: still waiting one millisecond short of its own limit, answered at it.
    const doors: Array<[string, unknown[], number, (answer: any) => unknown, unknown]> = [
      [IPC.MACHINES_STATUS, [], MACHINES_STATUS_TIMEOUT_MS, (a) => a.helper, { state: 'failed', detail: MACHINES_NO_ANSWER }],
      [IPC.MACHINES_END_SESSION, [HELD], MACHINES_ACTION_TIMEOUT_MS, (a) => a, { ok: false, message: MACHINES_NO_ANSWER }],
      [IPC.MACHINES_REATTACH, [HELD], MACHINES_ACTION_TIMEOUT_MS, (a) => a, { ok: false, message: MACHINES_NO_ANSWER }],
      [IPC.MACHINES_SELF_TEST, [], MACHINES_SELF_TEST_TIMEOUT_MS, (a) => a.detail, MACHINES_NO_ANSWER],
    ]
    for (const [channel, args, limit, pick, expected] of doors) {
      let settled = false
      const pending = call(channel, ...args)
      void pending.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(limit - 1)
      expect(settled, `${channel} still waiting at ${limit - 1} ms`).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(pick(await pending), `${channel} answered at ${limit} ms`).toEqual(expected)
    }
    // The self-test is allowed longer than a status read, and End and Re-attach longer than a read.
    expect(MACHINES_SELF_TEST_TIMEOUT_MS).toBeGreaterThan(MACHINES_STATUS_TIMEOUT_MS)
    expect(MACHINES_ACTION_TIMEOUT_MS).toBeGreaterThan(MACHINES_STATUS_TIMEOUT_MS)
  })

  it('refuses an id that is not the helper protocol\'s session-id shape, without asking the source', async () => {
    const src = fakeSource()
    register(() => src)
    const bad: unknown[] = [
      undefined, null, 42, {}, ['held-0001'], '',
      'abcdefg',                 // 7 characters: one short
      'x'.repeat(33),            // 33 characters: one long
      ' held-0001', 'held 0001', // spaces
      '-held-0001', '_held-0001', // must start with a letter or digit
      'held-0001\n', 'held\n0001', 'held-0001\r', 'held\u00000001', // newlines and control characters
      'held-0001; ls', '../held-01', 'held/0001', 'held.0001',
    ]
    for (const id of bad) {
      expect(await call(IPC.MACHINES_END_SESSION, id), `end ${JSON.stringify(id)?.slice(0, 20)}`).toEqual({ ok: false, message: MACHINES_BAD_ID })
      expect(await call(IPC.MACHINES_REATTACH, id), `reattach ${JSON.stringify(id)?.slice(0, 20)}`).toEqual({ ok: false, message: MACHINES_BAD_ID })
    }
    expect(src.endSession).not.toHaveBeenCalled()
    expect(src.reattach).not.toHaveBeenCalled()
  })

  it('takes the shortest and the longest id the protocol allows, and the shapes in between', async () => {
    const src = fakeSource()
    register(() => src)
    const good = ['abcdefgh', 'x'.repeat(32), 'Held_0001-ab', '0123456789abcdef0123456789abcdef']
    for (const id of good) {
      expect(HELD_SESSION_ID.test(id), id).toBe(true)
      expect(await call(IPC.MACHINES_END_SESSION, id)).toEqual({ ok: true })
    }
    expect(src.endSession).toHaveBeenCalledTimes(good.length)
  })
})

describe('who may ask', () => {
  it('answers the app window\'s main frame, and refuses anything else without reaching the source', async () => {
    const src = fakeSource()
    register(() => src)
    const doors: Array<[string, unknown[]]> = [
      [IPC.MACHINES_STATUS, []], [IPC.MACHINES_SELF_TEST, []], [IPC.MACHINES_END_SESSION, [HELD]], [IPC.MACHINES_REATTACH, [HELD]],
    ]
    for (const [channel, args] of doors) {
      const ok = await handlers.get(channel)!(appEvent, ...args)
      expect(JSON.stringify(ok), channel).not.toContain(MACHINES_NOT_APP)
    }
    expect(src.status).toHaveBeenCalledTimes(1)
    expect(src.runSelfTest).toHaveBeenCalledTimes(1)
    expect(src.endSession).toHaveBeenCalledTimes(1)
    expect(src.reattach).toHaveBeenCalledTimes(1)

    const strangers = [
      { sender: { mainFrame: frame }, senderFrame: frame },   // another webContents
      { sender: webContents, senderFrame: { id: 'sub-frame' } }, // a frame inside the window
      { sender: webContents, senderFrame: null },
      { sender: 'anyone' },                                    // not a web contents at all
    ]
    for (const stranger of strangers) {
      expect(((await handlers.get(IPC.MACHINES_STATUS)!(stranger)) as MachineStatus).helper.detail).toBe(MACHINES_NOT_APP)
      expect((await handlers.get(IPC.MACHINES_SELF_TEST)!(stranger)).detail).toBe(MACHINES_NOT_APP)
      expect(await handlers.get(IPC.MACHINES_END_SESSION)!(stranger, HELD)).toEqual({ ok: false, message: MACHINES_NOT_APP })
      expect(await handlers.get(IPC.MACHINES_REATTACH)!(stranger, HELD)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    }
    // None of the strangers' calls reached the source: every count is still one.
    expect(src.status).toHaveBeenCalledTimes(1)
    expect(src.runSelfTest).toHaveBeenCalledTimes(1)
    expect(src.endSession).toHaveBeenCalledTimes(1)
    expect(src.reattach).toHaveBeenCalledTimes(1)
  })

  it('refuses every door while there is no window', async () => {
    const src = fakeSource()
    registerMachinesHandlers(() => src, () => null)
    expect(await handlers.get(IPC.MACHINES_END_SESSION)!(appEvent, HELD)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(await handlers.get(IPC.MACHINES_REATTACH)!(appEvent, HELD)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(((await handlers.get(IPC.MACHINES_STATUS)!(appEvent)) as MachineStatus).helper.detail).toBe(MACHINES_NOT_APP)
    expect((await handlers.get(IPC.MACHINES_SELF_TEST)!(appEvent)).detail).toBe(MACHINES_NOT_APP)
    expect(src.status).not.toHaveBeenCalled()
    expect(src.runSelfTest).not.toHaveBeenCalled()
    expect(src.endSession).not.toHaveBeenCalled()
    expect(src.reattach).not.toHaveBeenCalled()
  })
})
