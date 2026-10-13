// @vitest-environment jsdom
// The content side of x-ray Off (#367): the bridge's hover surface can be
// switched off, and while it is off the page does no per-mousemove work.
//
// This is what the host CANNOT do for itself. The host can drop a report it did
// not want (and does — see canvas-xray-pane), but only the content can decline
// to hit-test, measure and structured-clone a message on every mouse move. "The
// page behaves like a normal browser tab" is a claim about the PAGE's work, so
// it is pinned here, against the BUNDLED bridge that ccc-ux:// actually serves.
//
// What must survive being switched off is pinned too: viewport reporting and
// the request/response surface. A canvas whose scroll position stopped updating
// would be a broken pane, not a quiet one.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { bridgeRequest, installBridge, stubLayout } from './canvas-bridge-harness'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

/** jsdom has no hit testing; the fixture decides what is "under" the pointer. */
function pointAt(el: Element | null): void {
  ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => el
}

function moveMouse(times = 3): void {
  for (let i = 0; i < times; i++) document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
}

async function setHoverReporting(enabled: unknown): Promise<{ ok: boolean; result?: unknown }> {
  return bridgeRequest('hoverReporting', { enabled })
}

/** How long a NEGATIVE assertion watches for an event that must not come. */
const SILENCE_WINDOW_MS = 300
/** How long a POSITIVE assertion will wait for one that must. Generous because
 *  it is only ever paid when something is wrong: the wait resolves the moment
 *  the event lands. A fixed window here is what made the first version of this
 *  file fail on a loaded CI box while passing everywhere else — the bridge
 *  reports on a rAF, and 300ms is a claim about the machine, not about the
 *  bridge. */
const ARRIVAL_TIMEOUT_MS = 5000

/**
 * Events of `kind` seen in a window — resolving EARLY once `min` have arrived.
 * `min: 0` (the default) is the negative form: watch the whole window and
 * report what came, which must be nothing.
 */
function watchEvents(kind: string, { min = 0, ms }: { min?: number; ms: number }): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const seen: Record<string, unknown>[] = []
    const done = () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(seen)
    }
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as { ns?: string; type?: string } | undefined
      if (msg?.ns !== CANVAS_BRIDGE_NS || msg.type !== kind) return
      seen.push(msg as Record<string, unknown>)
      if (min > 0 && seen.length >= min) done()
    }
    const timer = setTimeout(done, ms)
    window.addEventListener('message', onMessage)
  })
}

/** The bridge is reporting again — the control every silence assertion is
 *  paired with, so "nothing arrived" can never pass for "the bridge is dead". */
async function expectStillReports(): Promise<void> {
  const events = watchEvents('pointer', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
  moveMouse(5)
  expect((await events).length, 'the bridge reports once it is switched back on').toBeGreaterThanOrEqual(1)
}

beforeAll(() => {
  stubLayout({ x: 10, y: 20, width: 100, height: 30 })
  document.body.innerHTML = `<main><button data-ux-id="save-btn">Save draft</button></main>`
  pointAt(document.querySelector('[data-ux-id="save-btn"]'))
  installBridge()
})

// Module state in the bundled script: every test leaves it as it found it.
afterEach(async () => {
  await setHoverReporting(true)
})

describe('the hover surface is live by default', () => {
  it('reports pointer moves before the host has said anything', async () => {
    const events = watchEvents('pointer', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    moveMouse(5)
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })

  it('reports clicks before the host has said anything', async () => {
    const events = watchEvents('contentClick', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })
})

describe('switched off, the page does no hover work at all', () => {
  it('acknowledges the request with what it is now doing', async () => {
    const reply = await setHoverReporting(false)
    expect(reply.ok).toBe(true)
    // Clicks follow hover when the request names no click setting of its own:
    // the request shape from before aicc_planning#107 keeps exactly its old
    // meaning.
    expect(reply.result).toEqual({ enabled: false, clicks: false })
  })

  it('emits no pointer events however much the mouse moves', async () => {
    await setHoverReporting(false)
    const events = watchEvents('pointer', { ms: SILENCE_WINDOW_MS })
    moveMouse(25)
    expect(await events).toEqual([])
    // The control: that silence was the switch, not a dead bridge, a dead
    // fixture or a window nobody is listening on. Without this, deleting the
    // whole hover surface would pass every assertion above.
    await setHoverReporting(true)
    await expectStillReports()
  })

  it('emits nothing on mouseleave either — the same gate covers the clear', async () => {
    await setHoverReporting(false)
    const events = watchEvents('pointer', { ms: SILENCE_WINDOW_MS })
    document.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    expect(await events).toEqual([])
  })

  it('emits no contentClick — in Off a click selects nothing, so there is nothing to report', async () => {
    await setHoverReporting(false)
    const events = watchEvents('contentClick', { ms: SILENCE_WINDOW_MS })
    for (let i = 0; i < 5; i++) document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await events).toEqual([])

    await setHoverReporting(true)
    const loud = watchEvents('contentClick', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect((await loud).length, 'clicks are reported again once switched on').toBeGreaterThanOrEqual(1)
  })

  it('drops a move that was queued a frame before the switch', async () => {
    // The rAF the move scheduled is still pending when the host switches off;
    // without the re-check on the frame it would land after Off took effect.
    const events = watchEvents('pointer', { ms: SILENCE_WINDOW_MS })
    moveMouse(1)
    await setHoverReporting(false)
    expect(await events).toEqual([])
  })
})

describe('switching off silences the hover surface and nothing else', () => {
  it('keeps reporting the viewport — a pane that stopped tracking scroll is broken, not quiet', async () => {
    await setHoverReporting(false)
    const events = watchEvents('viewport', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    window.dispatchEvent(new Event('scroll'))
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })

  it('still answers requests — snapshots and anchor resolution are not hover', async () => {
    await setHoverReporting(false)
    const reply = await bridgeRequest('boxMap')
    expect(reply.ok).toBe(true)
    expect(Array.isArray(reply.result)).toBe(true)
  })
})

describe('the switch is reversible and fails live', () => {
  it('resumes reporting when asked to', async () => {
    await setHoverReporting(false)
    await setHoverReporting(true)
    await expectStillReports()
  })

  it('takes only a literal false for an answer — a malformed request cannot blind the pane', async () => {
    for (const value of [undefined, null, 0, '', 'false', 'off'] as unknown[]) {
      const reply = await setHoverReporting(value)
      expect(reply.result, String(value)).toEqual({ enabled: true, clicks: true })
    }
    await expectStillReports()
  })
})

// -- Clicks are their own switch (aicc_planning#107) ------------------------
//
// A PLAN resolves no hover (it flashed and corrupted the pane on every mouse
// move), so the host asks its frame to stop the pointer stream. In beta.2 that
// one switch silenced contentClick as well, so clicking a plan section did
// nothing at all although the toolbar says "click a section to point a note at
// it". The pointer stream and the click report are now separate: a plan keeps
// clicks and drops the stream; x-ray Off drops both.
//
// Mutation to prove these can fail: gate the click listener on `hoverReporting`
// again (canvas/bridge/index.ts), or stop reading `clicks` from the request.
describe('clicks are their own switch (aicc_planning#107)', () => {
  async function setReporting(enabled: unknown, clicks: unknown): Promise<{ ok: boolean; result?: unknown }> {
    return bridgeRequest('hoverReporting', { enabled, clicks })
  }

  function click(times = 1): void {
    for (let i = 0; i < times; i++) document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  it('a PLAN (pointer stream off, clicks on) reports a click and no pointer move', async () => {
    const reply = await setReporting(false, true)

    const pointer = watchEvents('pointer', { ms: SILENCE_WINDOW_MS })
    moveMouse(25)
    expect(await pointer, 'no per-mousemove work on a plan').toEqual([])

    const clicks = watchEvents('contentClick', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    click()
    const seen = await clicks
    expect(seen.length, 'a click on a plan section reaches the host').toBeGreaterThanOrEqual(1)
    // The same message, with the same hit, that stealth has always sent.
    expect(seen[0]).toMatchObject({ type: 'contentClick', hit: { role: 'button', name: 'Save draft' } })
    // ...and the bridge says so in its answer.
    expect(reply.result).toEqual({ enabled: false, clicks: true })
  })

  it('x-ray Off (both off) reports neither a click nor a pointer move', async () => {
    const reply = await setReporting(false, false)
    expect(reply.result).toEqual({ enabled: false, clicks: false })
    const pointer = watchEvents('pointer', { ms: SILENCE_WINDOW_MS })
    const clicks = watchEvents('contentClick', { ms: SILENCE_WINDOW_MS })
    moveMouse(25)
    click(5)
    expect(await pointer).toEqual([])
    expect(await clicks).toEqual([])

    // The control: the silence was the switch, not a dead bridge.
    await setReporting(true, true)
    const loud = watchEvents('contentClick', { min: 1, ms: ARRIVAL_TIMEOUT_MS })
    click()
    expect((await loud).length).toBeGreaterThanOrEqual(1)
    await expectStillReports()
  })

  it('moving from a plan to x-ray Off silences the clicks it had kept', async () => {
    await setReporting(false, true)
    await setReporting(false, false)
    const clicks = watchEvents('contentClick', { ms: SILENCE_WINDOW_MS })
    click(3)
    expect(await clicks).toEqual([])
  })

  it('the click switch takes only a literal false too: a malformed value cannot blind a plan', async () => {
    for (const value of [null, 0, '', 'false', 'off'] as unknown[]) {
      const reply = await setReporting(false, value)
      expect(reply.result, String(value)).toEqual({ enabled: false, clicks: true })
    }
  })
})
