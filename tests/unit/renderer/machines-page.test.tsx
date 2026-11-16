// @vitest-environment jsdom
//
// The Machines page (2.1.3-beta.6, plan section C.2): one card, This computer.
// Driven over fixed MachineStatus answers behind a fake bridge: the helper off,
// not installed (the helper missing), starting, ready with no terminal, with one
// attached, with one a crash left behind (attached false, tabOpen false), and
// failed. Run self-test, Re-attach and End call the bridge and then read the
// status again; End asks first.
//
// PURE: the real page, a fake window.electronAPI.machines, no IPC.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { HeldSession, MachineStatus, SelfTestResult } from '../../../src/shared/machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Re-attach hands the helper's tab answer to the tab helper (its own test is
// held-terminal-tab.test.ts); here it is watched, and answers as asked.
const showTab = vi.hoisted(() => vi.fn((_tab: unknown) => true))
vi.mock('../../../src/renderer/utils/heldTerminalTab', () => ({ showHeldTerminalTab: showTab }))

const { default: MachinesPage } = await import('../../../src/renderer/components/MachinesPage')

const OFF_SENTENCE = 'The session helper is off. Switch it on in Settings, General, Plain terminals through the session helper.'
const EMPTY_SENTENCE = 'The session helper holds no terminals right now.'
const UNAVAILABLE_SENTENCE = 'The list of held terminals is not available until the session helper is ready.'
const NO_ANSWER_SENTENCE = 'The session helper did not answer.'

const held = (over: Partial<HeldSession> = {}): HeldSession => ({
  id: 'held-1', kind: 'plain', label: 'build watcher', startedAt: Date.now() - 5 * 60_000, attached: true, tabOpen: true, ...over,
})
const status = (helper: Partial<MachineStatus['helper']> = {}, sessions: HeldSession[] = []): MachineStatus => ({
  id: 'this-computer', name: 'This computer', helper: { state: 'ready', version: '0.4.1', ...helper }, sessions,
})

interface Bridge {
  status: ReturnType<typeof vi.fn>
  runSelfTest: ReturnType<typeof vi.fn>
  endSession: ReturnType<typeof vi.fn>
  reattach: ReturnType<typeof vi.fn>
}

let container: HTMLDivElement
let root: Root
let bridge: Bridge

function install(answer: MachineStatus | (() => Promise<MachineStatus>)): void {
  bridge = {
    status: vi.fn(typeof answer === 'function' ? answer : async () => answer),
    runSelfTest: vi.fn(async (): Promise<SelfTestResult> => ({ ok: true, at: Date.now(), detail: 'All checks passed.' })),
    endSession: vi.fn(async () => ({ ok: true })),
    reattach: vi.fn(async () => ({ ok: true })),
  }
  ;(window as any).electronAPI = { machines: bridge }
}

/** Let promises that the page started settle, inside act so React flushes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

async function open(active = true): Promise<void> {
  await act(async () => { root.render(<MachinesPage active={active} />) })
  await flush()
}

const text = () => container.textContent ?? ''
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const byLabel = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
const byText = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined

async function click(el: Element | null | undefined): Promise<void> {
  expect(el, 'the control to click exists').toBeTruthy()
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  delete (window as any).electronAPI
})

describe('Machines page: what it shows for each helper state', () => {
  it('reads the status once on open and names the one machine, This computer', async () => {
    install(status())
    await open()
    expect(bridge.status).toHaveBeenCalledTimes(1)
    expect(container.querySelector('h2')?.textContent).toBe('This computer')
    expect(text()).toContain('Machines')
  })

  it('says it is reading until the first answer arrives', async () => {
    let release: (s: MachineStatus) => void = () => {}
    install(() => new Promise<MachineStatus>((r) => { release = r }))
    await open()
    expect(text()).toContain('Reading the session helper...')
    expect(byTestId('machines-state')).toBeNull()
    await act(async () => { release(status()) })
    await flush()
    expect(text()).not.toContain('Reading the session helper...')
    expect(byTestId('machines-state')?.textContent).toContain('Ready')
  })

  it('off: says how to switch it on, lists nothing and cannot run the self-test', async () => {
    install(status({ state: 'off', version: undefined }))
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Off')
    expect(byTestId('machines-state-text')?.textContent).toBe(OFF_SENTENCE)
    // The default source gives no detail for Off: the sentence above already says it all.
    expect(byTestId('machines-detail')).toBeNull()
    expect(byTestId('machines-empty')?.textContent).toBe(EMPTY_SENTENCE)
    expect(byTestId('machines-version')?.textContent).toBe('Not known')
    expect(byText('Run self-test')?.disabled).toBe(true)
    expect(container.querySelectorAll('[data-testid="machines-session"]')).toHaveLength(0)
  })

  it('off with a detail of its own: the source\'s words are shown under the sentence, not hidden', async () => {
    install(status({ state: 'off', detail: 'Turned off by a setting on this computer.' }))
    await open()
    expect(byTestId('machines-state-text')?.textContent).toBe(OFF_SENTENCE)
    expect(byTestId('machines-detail')?.textContent).toBe('Turned off by a setting on this computer.')
  })

  it('not installed (the helper missing): says so, with its detail, and offers no self-test', async () => {
    install(status({ state: 'not-installed', version: undefined, detail: 'The helper file is not in this install.' }))
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Not installed')
    expect(byTestId('machines-state-text')?.textContent).toBe('The session helper is not installed on this computer.')
    expect(byTestId('machines-detail')?.textContent).toBe('The helper file is not in this install.')
    expect(byTestId('machines-empty')?.textContent).toBe(EMPTY_SENTENCE)
    expect(byText('Run self-test')?.disabled).toBe(true)
  })

  it('starting: says it is starting and holds the self-test back', async () => {
    install(status({ state: 'starting' }))
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Starting')
    expect(byTestId('machines-state-text')?.textContent).toBe('The session helper is starting.')
    expect(byText('Run self-test')?.disabled).toBe(true)
    // An empty list from a helper that is still starting is not "holds none".
    expect(byTestId('machines-empty')?.textContent).toBe(UNAVAILABLE_SENTENCE)
    expect(text()).not.toContain(EMPTY_SENTENCE)
  })

  it('ready with no terminal: the version, no self-test yet, one plain sentence for the empty list', async () => {
    install(status())
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Ready')
    expect(byTestId('machines-state-text')?.textContent).toBe('The session helper is ready.')
    expect(byTestId('machines-version')?.textContent).toBe('0.4.1')
    expect(byTestId('machines-self-test-result')?.textContent).toBe('Not run yet.')
    expect(byTestId('machines-empty')?.textContent).toBe(EMPTY_SENTENCE)
    expect(byText('Run self-test')?.disabled).toBe(false)
  })

  it('ready with one attached terminal: its name, kind, start time and state, with Re-attach off and End on', async () => {
    install(status({}, [held()]))
    await open()
    const row = byTestId('machines-session')!
    expect(row).toBeTruthy()
    expect(byTestId('machines-empty')).toBeNull()
    expect(row.textContent).toContain('build watcher')
    expect(row.textContent).toContain('Terminal')
    expect(row.textContent).toMatch(/Started /)
    expect(byTestId('machines-session-state')?.textContent).toBe('Attached to the app')
    expect(byLabel('Re-attach build watcher')?.disabled).toBe(true)
    expect(byLabel('End build watcher')?.disabled).toBe(false)
  })

  it('one left by a crash (attached false, tabOpen false): waiting for the app, with no tab, and Re-attach on', async () => {
    install(status({}, [held({ attached: false, tabOpen: false })]))
    await open()
    expect(byTestId('machines-session-state')?.textContent).toBe('Waiting for the app. No tab shows it.')
    expect(byLabel('Re-attach build watcher')?.disabled).toBe(false)
    expect(byLabel('End build watcher')?.disabled).toBe(false)
  })

  it('attached to the app with no tab open: says so in two short sentences', async () => {
    install(status({}, [held({ attached: true, tabOpen: false })]))
    await open()
    expect(byTestId('machines-session-state')?.textContent).toBe('Attached to the app. No tab shows it.')
    expect(byLabel('Re-attach build watcher')?.disabled).toBe(true)
  })

  it('shows the start time alone for today, with the day for another day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0))
    const today = new Date(2026, 10, 16, 9, 5, 0)
    const earlier = new Date(2026, 10, 14, 9, 5, 0)
    const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const day = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    install(status({}, [
      held({ id: 'today', label: 'from today', startedAt: today.getTime() }),
      held({ id: 'earlier', label: 'from two days ago', startedAt: earlier.getTime() }),
    ]))
    await open()
    const rows = Array.from(container.querySelectorAll('[data-testid="machines-session"]')) as HTMLElement[]
    expect(rows[0].textContent).toContain(`Started at ${time(today)}`)
    expect(rows[0].textContent).not.toContain(day(today))
    expect(rows[1].textContent).toContain(`Started at ${day(earlier)}, ${time(earlier)}`)
  })

  it('a start time that is not a number reads as an unknown time, not as "Invalid Date"', async () => {
    install(status({}, [held({ startedAt: Number.NaN })]))
    await open()
    const row = byTestId('machines-session')!
    expect(row.textContent).toContain('Started at an unknown time')
    expect(row.textContent).not.toMatch(/Invalid|NaN/)
  })

  it('a partner terminal is named as one, and every held terminal gets its own row', async () => {
    install(status({}, [
      held({ id: 'a', label: 'one', kind: 'partner' }),
      held({ id: 'b', label: 'two', kind: 'plain', attached: false, tabOpen: true }),
    ]))
    await open()
    const rows = Array.from(container.querySelectorAll('[data-testid="machines-session"]')) as HTMLElement[]
    expect(rows.map((r) => r.getAttribute('data-session-id'))).toEqual(['a', 'b'])
    expect(rows[0].textContent).toContain('Partner terminal')
    expect(rows[1].textContent).toContain('Waiting for the app')
    expect(rows[1].textContent).not.toContain('No tab shows it')
  })

  it('failed: says it failed, gives the reason, and still lets you run the self-test', async () => {
    install(status({ state: 'failed', detail: 'It stopped answering after the last update.', selfTest: { ok: false, at: Date.now(), detail: 'No reply.' } }))
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Failed')
    expect(byTestId('machines-state-text')?.textContent).toBe('The session helper failed.')
    expect(byTestId('machines-detail')?.textContent).toBe('It stopped answering after the last update.')
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Failed at .+\. No reply\.$/)
    expect(byText('Run self-test')?.disabled).toBe(false)
  })

  it('failed with an empty list (what main sends when the helper does not answer) never says it holds no terminals', async () => {
    // The helper may well still hold the terminal that survived a crash; the page cannot know.
    install(status({ state: 'failed', version: undefined, detail: NO_ANSWER_SENTENCE }, []))
    await open()
    expect(byTestId('machines-detail')?.textContent).toBe(NO_ANSWER_SENTENCE)
    expect(byTestId('machines-empty')?.textContent).toBe(UNAVAILABLE_SENTENCE)
    expect(text()).not.toContain(EMPTY_SENTENCE)
  })

  it('failed that still lists terminals shows them, not the unavailable sentence', async () => {
    install(status({ state: 'failed', detail: 'It stopped answering.' }, [held({ attached: false, tabOpen: false })]))
    await open()
    expect(container.querySelectorAll('[data-testid="machines-session"]')).toHaveLength(1)
    expect(byTestId('machines-empty')).toBeNull()
  })

  it('a state this version does not know reads as unknown, says so, and offers nothing', async () => {
    install(status({ state: 'weird' as any }))
    await open()
    expect(byTestId('machines-state')?.textContent).toContain('Unknown')
    expect(byTestId('machines-state-text')?.textContent).toBe('The session helper is in a state this version does not know.')
    expect(byText('Run self-test')?.disabled).toBe(true)
    expect(byTestId('machines-empty')?.textContent).toBe(UNAVAILABLE_SENTENCE)
  })

  it('shows the self-test the helper reports, with its time', async () => {
    install(status({ selfTest: { ok: true, at: Date.now(), detail: 'Every check passed.' } }))
    await open()
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Passed at .+\. Every check passed\.$/)
  })

  it('says the page could not read the helper when the bridge fails, and recovers on Refresh', async () => {
    install(status())
    bridge.status.mockRejectedValueOnce(new Error('no bridge'))
    await open()
    expect(byTestId('machines-read-failed')?.textContent).toContain('could not read the session helper')
    await click(byLabel('Refresh'))
    expect(byTestId('machines-read-failed')).toBeNull()
    expect(byTestId('machines-state')?.textContent).toContain('Ready')
  })

  it('treats a malformed list as no terminals instead of breaking', async () => {
    install({ ...status(), sessions: undefined as unknown as HeldSession[] })
    await open()
    expect(byTestId('machines-empty')?.textContent).toBe(EMPTY_SENTENCE)
  })
})

describe('Machines page: Refresh and the actions', () => {
  it('Refresh reads the status again', async () => {
    install(status())
    await open()
    await click(byLabel('Refresh'))
    expect(bridge.status).toHaveBeenCalledTimes(2)
  })

  it('an older answer that arrives late does not replace a newer one', async () => {
    const pending: Array<(s: MachineStatus) => void> = []
    install(() => new Promise<MachineStatus>((r) => { pending.push(r) }))
    await open()
    await act(async () => { byLabel('Refresh')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(pending).toHaveLength(2)
    await act(async () => { pending[1](status({}, [held({ label: 'newer' })])) })
    await flush()
    await act(async () => { pending[0](status({}, [])) })
    await flush()
    expect(text()).toContain('newer')
  })

  it('Run self-test calls the bridge, shows its answer and reads the status again', async () => {
    install(status())
    await open()
    await click(byText('Run self-test'))
    expect(bridge.runSelfTest).toHaveBeenCalledTimes(1)
    expect(bridge.status).toHaveBeenCalledTimes(2)
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Passed at .+\. All checks passed\.$/)
  })

  it('a failed self-test reads as failed, and a bridge that throws reads as no answer', async () => {
    install(status())
    await open()
    bridge.runSelfTest.mockResolvedValueOnce({ ok: false, at: Date.now(), detail: 'The check timed out.' })
    await click(byText('Run self-test'))
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Failed at .+\. The check timed out\.$/)
    bridge.runSelfTest.mockRejectedValueOnce(new Error('gone'))
    await click(byText('Run self-test'))
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/The session helper did not answer\.$/)
  })

  it('a self-test that passed is dropped once the helper is no longer running: Off never sits beside "Passed"', async () => {
    install(status())
    await open()
    await click(byText('Run self-test'))
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Passed at /)
    // The helper is switched off (or restarts and reports nothing yet), then the page reads again.
    bridge.status.mockResolvedValue(status({ state: 'off', version: undefined }))
    await click(byLabel('Refresh'))
    expect(byTestId('machines-state')?.textContent).toContain('Off')
    expect(byTestId('machines-self-test-result')?.textContent).toBe('Not run yet.')
  })

  it('a self-test result stays while the helper is still running and a later read does not carry one', async () => {
    install(status())
    await open()
    await click(byText('Run self-test'))
    await click(byLabel('Refresh'))
    expect(byTestId('machines-self-test-result')?.textContent).toMatch(/^Passed at /)
  })

  it('Re-attach calls the bridge with that terminal and reads the status again', async () => {
    install(status({}, [held({ id: 'left-over', attached: false, tabOpen: false })]))
    await open()
    await click(byLabel('Re-attach build watcher'))
    expect(bridge.reattach).toHaveBeenCalledTimes(1)
    expect(bridge.reattach).toHaveBeenCalledWith('left-over')
    expect(bridge.status).toHaveBeenCalledTimes(2)
    expect(byTestId('machines-notice')?.textContent).toContain('build watcher')
  })

  it('Re-attach shows the tab the helper named: the new Terminal only tab bound to it', async () => {
    showTab.mockClear()
    install(status({}, [held({ id: 'left-over', attached: false, tabOpen: false })]))
    const tab = { id: 'newtab0123456789abcdef01', label: 'build watcher', open: true, partner: false }
    bridge.reattach.mockResolvedValueOnce({ ok: true, tab })
    await open()
    await click(byLabel('Re-attach build watcher'))
    expect(showTab).toHaveBeenCalledTimes(1)
    expect(showTab).toHaveBeenCalledWith(tab)
    expect(byTestId('machines-notice')?.textContent).toBe('Attached build watcher to the app.')
  })

  it('Re-attach whose tab cannot be shown says so', async () => {
    showTab.mockClear()
    showTab.mockReturnValueOnce(false)
    install(status({}, [held({ id: 'left-over', attached: false, tabOpen: false })]))
    bridge.reattach.mockResolvedValueOnce({ ok: true, tab: { id: 'not a tab id', label: 'x', open: true, partner: false } })
    await open()
    await click(byLabel('Re-attach build watcher'))
    expect(showTab).toHaveBeenCalledTimes(1)
    expect(byTestId('machines-notice')?.textContent).toBe('Could not attach build watcher.')
  })

  it('Re-attach that is refused says why, in the source\'s own words', async () => {
    install(status({}, [held({ attached: false })]))
    bridge.reattach.mockResolvedValueOnce({ ok: false, message: 'That terminal has already ended.' })
    await open()
    await click(byLabel('Re-attach build watcher'))
    expect(byTestId('machines-notice')?.textContent).toBe('That terminal has already ended.')
  })

  it('End asks first: nothing is ended until you confirm, and Keep it backs out', async () => {
    install(status({}, [held({ id: 'to-end' })]))
    await open()
    await click(byLabel('End build watcher'))
    expect(bridge.endSession).not.toHaveBeenCalled()
    expect(byTestId('machines-end-confirm')?.textContent).toContain('End this terminal?')
    // The row's own buttons give way to the question.
    expect(byLabel('End build watcher')).toBeNull()
    await click(byText('Keep it'))
    expect(bridge.endSession).not.toHaveBeenCalled()
    expect(byTestId('machines-end-confirm')).toBeNull()
    expect(byLabel('End build watcher')).toBeTruthy()
  })

  it('confirming End calls the bridge with that terminal, reads the status again and says it ended', async () => {
    install(status({}, [held({ id: 'to-end' })]))
    await open()
    // Once it is ended, the helper holds nothing.
    bridge.status.mockResolvedValue(status({}, []))
    await click(byLabel('End build watcher'))
    await click(byLabel('End terminal build watcher'))
    expect(bridge.endSession).toHaveBeenCalledTimes(1)
    expect(bridge.endSession).toHaveBeenCalledWith('to-end')
    expect(bridge.status).toHaveBeenCalledTimes(2)
    expect(byTestId('machines-notice')?.textContent).toBe('Ended build watcher.')
    expect(byTestId('machines-end-confirm')).toBeNull()
    expect(byTestId('machines-empty')?.textContent).toBe(EMPTY_SENTENCE)
  })

  it('an End that is refused says why and keeps the terminal listed', async () => {
    install(status({}, [held({ id: 'stuck' })]))
    bridge.endSession.mockResolvedValueOnce({ ok: false, message: 'The helper could not stop it.' })
    await open()
    await click(byLabel('End build watcher'))
    await click(byLabel('End terminal build watcher'))
    expect(byTestId('machines-notice')?.textContent).toBe('The helper could not stop it.')
    expect(container.querySelectorAll('[data-testid="machines-session"]')).toHaveLength(1)
  })

  it('a Re-attach whose bridge call throws says the helper did not answer, and the controls come back', async () => {
    install(status({}, [held({ attached: false })]))
    bridge.reattach.mockRejectedValueOnce(new Error('bridge gone'))
    await open()
    await click(byLabel('Re-attach build watcher'))
    expect(byTestId('machines-notice')?.textContent).toBe(NO_ANSWER_SENTENCE)
    expect(byLabel('Re-attach build watcher')?.disabled).toBe(false)
    expect(byLabel('End build watcher')?.disabled).toBe(false)
    expect(byText('Run self-test')?.disabled).toBe(false)
    expect(bridge.status).toHaveBeenCalledTimes(2)
  })

  it('an End whose bridge call throws says the helper did not answer, keeps the terminal and brings the controls back', async () => {
    install(status({}, [held({ id: 'stays-listed' })]))
    bridge.endSession.mockRejectedValueOnce(new Error('bridge gone'))
    await open()
    await click(byLabel('End build watcher'))
    await click(byLabel('End terminal build watcher'))
    expect(byTestId('machines-notice')?.textContent).toBe(NO_ANSWER_SENTENCE)
    expect(container.querySelectorAll('[data-testid="machines-session"]')).toHaveLength(1)
    expect(byTestId('machines-end-confirm')).toBeNull()
    expect(byLabel('End build watcher')?.disabled).toBe(false)
    expect(bridge.status).toHaveBeenCalledTimes(2)
  })

  it('holds every control while an action is running, so a second click cannot double it', async () => {
    install(status({}, [held({ id: 'slow', attached: false })]))
    let release: (r: { ok: boolean }) => void = () => {}
    bridge.reattach.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await open()
    await act(async () => { byLabel('Re-attach build watcher')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(byLabel('Re-attach build watcher')?.disabled).toBe(true)
    expect(byLabel('End build watcher')?.disabled).toBe(true)
    expect(byText('Run self-test')?.disabled).toBe(true)
    await act(async () => { release({ ok: true }) })
    await flush()
    expect(byLabel('End build watcher')?.disabled).toBe(false)
    expect(bridge.reattach).toHaveBeenCalledTimes(1)
  })
})

describe('Machines page: staying true to what is on screen', () => {
  it('reads again each time its tab comes back to the front, not only when it mounts', async () => {
    install(status())
    await open(true)
    expect(bridge.status).toHaveBeenCalledTimes(1)
    // Another tab takes the front: the page stays mounted and reads nothing.
    await open(false)
    expect(bridge.status).toHaveBeenCalledTimes(1)
    // It comes back: the list is read again.
    bridge.status.mockResolvedValue(status({}, [held({ label: 'started meanwhile' })]))
    await open(true)
    expect(bridge.status).toHaveBeenCalledTimes(2)
    expect(text()).toContain('started meanwhile')
  })

  it('does not read at all while it is mounted behind another tab', async () => {
    install(status())
    await open(false)
    expect(bridge.status).not.toHaveBeenCalled()
  })

  it('opening the End question puts focus on Keep it, and backing out puts it back on End', async () => {
    install(status({}, [held()]))
    await open()
    byLabel('End build watcher')!.focus()
    await click(byLabel('End build watcher'))
    expect(document.activeElement).toBe(byText('Keep it'))
    await click(byText('Keep it'))
    expect(document.activeElement).toBe(byLabel('End build watcher'))
  })

  it('after End is confirmed, focus lands on the list heading, not on the page body', async () => {
    install(status({}, [held({ id: 'to-end' })]))
    await open()
    bridge.status.mockResolvedValue(status({}, []))
    byLabel('End build watcher')!.focus()
    await click(byLabel('End build watcher'))
    await click(byLabel('End terminal build watcher'))
    expect(byTestId('machines-session')).toBeNull()
    const focused = document.activeElement as HTMLElement
    expect(focused).not.toBe(document.body)
    expect(container.contains(focused)).toBe(true)
    expect(focused.tagName).toBe('H3')
    expect(focused.textContent).toBe('Held terminals')
  })

  it('after an End that was refused, focus also lands on the heading, and the terminal is still listed', async () => {
    install(status({}, [held({ id: 'stuck-one' })]))
    bridge.endSession.mockResolvedValueOnce({ ok: false, message: 'The helper could not stop it.' })
    await open()
    await click(byLabel('End build watcher'))
    await click(byLabel('End terminal build watcher'))
    expect((document.activeElement as HTMLElement).textContent).toBe('Held terminals')
    expect(byLabel('End build watcher')).toBeTruthy()
  })

  it('opening the question on the first row while the second row\'s is open puts focus on the first row\'s Keep it', async () => {
    install(status({}, [held({ id: 'row-one', label: 'first' }), held({ id: 'row-two', label: 'second' })]))
    await open()
    // Open the second row's question first, then the first row's. The old code handed
    // focus back to the second row's End when its question closed, after the first
    // row had taken it.
    await click(byLabel('End second'))
    await click(byLabel('End first'))
    const first = container.querySelector('[data-session-id="row-one"]') as HTMLElement
    expect(first.querySelector('[data-testid="machines-end-confirm"]')).toBeTruthy()
    expect(document.activeElement).toBe(first.querySelector('[data-machines-keep]'))
    expect(container.querySelectorAll('[data-testid="machines-end-confirm"]')).toHaveLength(1)
  })

  it('Keep it on one row puts focus back on that row\'s own End, not on another row\'s', async () => {
    install(status({}, [held({ id: 'row-one', label: 'first' }), held({ id: 'row-two', label: 'second' })]))
    await open()
    await click(byLabel('End second'))
    await click(byText('Keep it'))
    expect(document.activeElement).toBe(byLabel('End second'))
  })

  it('ties the warning to the question and to both of its buttons', async () => {
    install(status({}, [held()]))
    await open()
    await click(byLabel('End build watcher'))
    const group = byTestId('machines-end-confirm')!
    const id = group.getAttribute('aria-describedby')!
    expect(id).toBeTruthy()
    expect(document.getElementById(id)?.textContent).toContain('End this terminal?')
    expect(byLabel('End terminal build watcher')?.getAttribute('aria-describedby')).toBe(id)
    expect(byText('Keep it')?.getAttribute('aria-describedby')).toBe(id)
  })

  it('announces a finished self-test: its result sits in a live region that was already there', async () => {
    install(status())
    await open()
    const before = byTestId('machines-self-test-result')!
    const region = before.closest('[role="status"]')
    expect(region, 'the self-test result is inside a status region').toBeTruthy()
    expect(region!.getAttribute('aria-live')).toBe('polite')
    await click(byText('Run self-test'))
    // The same region element is still there, now holding the answer.
    expect(byTestId('machines-self-test-result')!.closest('[role="status"]')).toBe(region)
    expect(region!.textContent).toMatch(/Passed at /)
  })

  it('keeps the action notice region mounted, in the accessibility tree and out of the card\'s spacing, until an action reports', async () => {
    install(status({}, [held({ attached: false })]))
    await open()
    const notice = byTestId('machines-notice')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.getAttribute('aria-live')).toBe('polite')
    expect(notice.textContent).toBe('')
    // Never display:none while empty (that takes it out of the accessibility tree and a
    // screen reader would miss the first notice), and never the card's last child (the
    // card's space-y would then leave an empty gap under the list).
    expect(notice.className).not.toMatch(/hidden/)
    expect(notice.parentElement).not.toBe(container.querySelector('section'))
    expect(notice.nextElementSibling).toBeNull()
    await click(byLabel('Re-attach build watcher'))
    expect(byTestId('machines-notice')).toBe(notice)
    expect(notice.textContent).toContain('build watcher')
  })
})
