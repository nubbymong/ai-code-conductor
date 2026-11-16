// The Machines page's IPC (2.1.3-beta.6, plan section C.2): four doors answered
// by one MachinesSource. Pinned here: the default source's sentences (helper off,
// nothing held, End and Re-attach refused in plain words), that the source is
// read on every call (so setMachinesSource takes effect at once), that a source
// that throws or stays silent reads as a helper that did not answer and never as
// a rejected call, that End and Re-attach take only an id of a plausible shape,
// and that, when the app passes its window, only that window is answered.
//
// PURE: ipcMain is the shared mock; handlers are captured and called directly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-channels'
import type { MachinesSource, MachineStatus } from '../../../src/shared/machines'

const {
  registerMachinesHandlers, defaultMachinesSource, setMachinesSource, getMachinesSource,
  MACHINES_OFF_DETAIL, MACHINES_OFF_SELF_TEST, MACHINES_OFF_END, MACHINES_OFF_REATTACH,
  MACHINES_NO_ANSWER, MACHINES_BAD_ID, MACHINES_NOT_APP,
  MACHINES_STATUS_TIMEOUT_MS, MACHINES_ACTION_TIMEOUT_MS, MACHINES_SELF_TEST_TIMEOUT_MS,
} = await import('../../../src/main/ipc/machines-handlers')

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const handlers = new Map<string, Handler>()

const readyStatus: MachineStatus = {
  id: 'this-computer', name: 'This computer',
  helper: { state: 'ready', version: '0.4.1' },
  sessions: [{ id: 'h1', kind: 'plain', label: 'build', startedAt: 1, attached: true, tabOpen: true }],
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

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: 'anyone' }, ...args)

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
  it('says the helper is off, with the setting named, and holds nothing', async () => {
    const s = await defaultMachinesSource().status()
    expect(s).toEqual({
      id: 'this-computer',
      name: 'This computer',
      helper: { state: 'off', detail: MACHINES_OFF_DETAIL },
      sessions: [],
    })
    expect(MACHINES_OFF_DETAIL).toBe('The "Plain terminals through the session helper" setting is off.')
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
    registerMachinesHandlers(getMachinesSource)
    const s = (await call(IPC.MACHINES_STATUS)) as MachineStatus
    expect(s.helper.state).toBe('off')
    expect(s.sessions).toEqual([])
    expect(await call(IPC.MACHINES_END_SESSION, 'abc')).toEqual({ ok: false, message: MACHINES_OFF_END })
  })

  it('uses no em dash in any sentence it shows', () => {
    for (const sentence of [MACHINES_OFF_DETAIL, MACHINES_OFF_SELF_TEST, MACHINES_OFF_END, MACHINES_OFF_REATTACH, MACHINES_NO_ANSWER, MACHINES_BAD_ID, MACHINES_NOT_APP]) {
      expect(sentence).not.toMatch(/—/)
    }
  })
})

describe('registerMachinesHandlers', () => {
  it('registers exactly the four Machines channels', () => {
    registerMachinesHandlers(() => fakeSource())
    expect([...handlers.keys()].sort()).toEqual([
      IPC.MACHINES_END_SESSION, IPC.MACHINES_REATTACH, IPC.MACHINES_SELF_TEST, IPC.MACHINES_STATUS,
    ].sort())
  })

  it('passes each answer through from the source, and the id to End and Re-attach', async () => {
    const src = fakeSource()
    registerMachinesHandlers(() => src)
    expect(await call(IPC.MACHINES_STATUS)).toEqual(readyStatus)
    expect(await call(IPC.MACHINES_SELF_TEST)).toEqual({ ok: true, at: 7, detail: 'fine' })
    expect(await call(IPC.MACHINES_END_SESSION, 'h1')).toEqual({ ok: true })
    expect(await call(IPC.MACHINES_REATTACH, 'h1')).toEqual({ ok: true })
    expect(src.endSession).toHaveBeenCalledWith('h1')
    expect(src.reattach).toHaveBeenCalledWith('h1')
  })

  it('reads the source on every call, so a later setMachinesSource shows at once', async () => {
    registerMachinesHandlers(getMachinesSource)
    expect(((await call(IPC.MACHINES_STATUS)) as MachineStatus).helper.state).toBe('off')
    setMachinesSource(fakeSource())
    expect(((await call(IPC.MACHINES_STATUS)) as MachineStatus).helper.state).toBe('ready')
    expect(getMachinesSource()).not.toBe(undefined)
  })

  it('a source that throws reads as a helper that did not answer, never as a rejected call', async () => {
    const boom = () => Promise.reject(new Error('pipe closed'))
    registerMachinesHandlers(() => fakeSource({ status: boom, runSelfTest: boom, endSession: boom, reattach: boom }))
    const s = (await call(IPC.MACHINES_STATUS)) as MachineStatus
    expect(s.helper).toEqual({ state: 'failed', detail: MACHINES_NO_ANSWER })
    expect(s.sessions).toEqual([])
    const t = await call(IPC.MACHINES_SELF_TEST)
    expect(t.ok).toBe(false)
    expect(t.detail).toBe(MACHINES_NO_ANSWER)
    expect(await call(IPC.MACHINES_END_SESSION, 'h1')).toEqual({ ok: false, message: MACHINES_NO_ANSWER })
    expect(await call(IPC.MACHINES_REATTACH, 'h1')).toEqual({ ok: false, message: MACHINES_NO_ANSWER })
    // The raw error text never reaches the page.
    expect(JSON.stringify([s, t])).not.toContain('pipe closed')
  })

  it('a source that stays silent is read as not answering, after each door\'s own wait', async () => {
    vi.useFakeTimers()
    const never = () => new Promise<never>(() => {})
    registerMachinesHandlers(() => fakeSource({ status: never, runSelfTest: never, endSession: never, reattach: never }))

    const status = call(IPC.MACHINES_STATUS)
    await vi.advanceTimersByTimeAsync(MACHINES_STATUS_TIMEOUT_MS - 1)
    let settled = false
    void status.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(((await status) as MachineStatus).helper).toEqual({ state: 'failed', detail: MACHINES_NO_ANSWER })

    const end = call(IPC.MACHINES_END_SESSION, 'h1')
    await vi.advanceTimersByTimeAsync(MACHINES_ACTION_TIMEOUT_MS)
    expect(await end).toEqual({ ok: false, message: MACHINES_NO_ANSWER })

    const again = call(IPC.MACHINES_REATTACH, 'h1')
    await vi.advanceTimersByTimeAsync(MACHINES_ACTION_TIMEOUT_MS)
    expect(await again).toEqual({ ok: false, message: MACHINES_NO_ANSWER })

    const test = call(IPC.MACHINES_SELF_TEST)
    await vi.advanceTimersByTimeAsync(MACHINES_SELF_TEST_TIMEOUT_MS)
    expect((await test).detail).toBe(MACHINES_NO_ANSWER)
    // The self-test is allowed longer than a status read.
    expect(MACHINES_SELF_TEST_TIMEOUT_MS).toBeGreaterThan(MACHINES_STATUS_TIMEOUT_MS)
  })

  it('refuses an id that is not a plausible held-terminal id, without asking the source', async () => {
    const src = fakeSource()
    registerMachinesHandlers(() => src)
    for (const bad of [undefined, null, 42, {}, ['h1'], '', 'x'.repeat(201)]) {
      expect(await call(IPC.MACHINES_END_SESSION, bad), `end ${String(bad).slice(0, 12)}`).toEqual({ ok: false, message: MACHINES_BAD_ID })
      expect(await call(IPC.MACHINES_REATTACH, bad), `reattach ${String(bad).slice(0, 12)}`).toEqual({ ok: false, message: MACHINES_BAD_ID })
    }
    expect(src.endSession).not.toHaveBeenCalled()
    expect(src.reattach).not.toHaveBeenCalled()
    // The longest id allowed still goes through.
    await call(IPC.MACHINES_END_SESSION, 'x'.repeat(200))
    expect(src.endSession).toHaveBeenCalledTimes(1)
  })
})

describe('who may ask', () => {
  const frame = { id: 'main-frame' }
  const webContents = { mainFrame: frame }
  const win = { isDestroyed: () => false, webContents } as any
  const appEvent = { sender: webContents, senderFrame: frame }

  it('answers the app window\'s main frame, and refuses anything else without reaching the source', async () => {
    const src = fakeSource()
    registerMachinesHandlers(() => src, () => win)
    const doors: Array<[string, unknown[]]> = [
      [IPC.MACHINES_STATUS, []], [IPC.MACHINES_SELF_TEST, []], [IPC.MACHINES_END_SESSION, ['h1']], [IPC.MACHINES_REATTACH, ['h1']],
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
    ]
    for (const stranger of strangers) {
      expect(((await handlers.get(IPC.MACHINES_STATUS)!(stranger)) as MachineStatus).helper.detail).toBe(MACHINES_NOT_APP)
      expect((await handlers.get(IPC.MACHINES_SELF_TEST)!(stranger)).detail).toBe(MACHINES_NOT_APP)
      expect(await handlers.get(IPC.MACHINES_END_SESSION)!(stranger, 'h1')).toEqual({ ok: false, message: MACHINES_NOT_APP })
      expect(await handlers.get(IPC.MACHINES_REATTACH)!(stranger, 'h1')).toEqual({ ok: false, message: MACHINES_NOT_APP })
    }
    expect(src.status).toHaveBeenCalledTimes(1)
    expect(src.endSession).toHaveBeenCalledTimes(1)
  })

  it('refuses while there is no window', async () => {
    const src = fakeSource()
    registerMachinesHandlers(() => src, () => null)
    expect(await handlers.get(IPC.MACHINES_END_SESSION)!(appEvent, 'h1')).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(src.endSession).not.toHaveBeenCalled()
  })

  it('the app registers the handlers with its window (index.ts passes getWindow)', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(index).toMatch(/registerMachinesHandlers\(getMachinesSource,\s*getWindow\)/)
  })
})
