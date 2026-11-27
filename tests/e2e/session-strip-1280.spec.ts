/**
 * The status strip of a tab through the session helper at the default
 * 1280x768 window (PR 763 fix round 9; the 2.1.3-beta.19 release smoke
 * re-read, its item 8, j01-strip-zoom.png). On an SSH Persistent tab on Rocky
 * Linux 10.2 (x86-64) the strip was 1024 px wide (the window less the 256 px
 * sidebar), the account chip 123 px, and the note "Model limits: not
 * available" shrank to 0 px while the middle row was still 15 px short (628 px
 * for 643): the weekly meter showed "Weekly: [bar] --", its "%" cut off.
 *
 * jsdom lays nothing out (session-status-strip-remote-usage.test.tsx pins the
 * classes), so this measures them here, in the real app with its real
 * stylesheet, by mounting a strip-shaped probe built from the same class
 * constants the strip draws with (session-strip-layout.ts), with the
 * release smoke's own row: "500 / 1.0m", the context meter at 0%, "API eq
 * $0.5159", "+0", "1m 17s", and the 5h and Weekly meters waiting.
 *
 * The page's font is not the VM's, so the probe is first set to the release
 * smoke's shortfall: with the classes the strip had on 38e0edcb, the controls'
 * width is chosen so the row is exactly 15 px short with the note at 0 px,
 * and that fault is asserted (without it, a pass could come from a strip that
 * was never tight). Then, at that same width, the strip's classes now:
 * nothing in the row is cut (the Weekly meter's right edge is within the
 * row's), and the note keeps a width above 0 px that can be hovered.
 *
 * PR 763 fix round 10 (the second pass on fix round 9): fix round 9 was sized
 * to that fresh tab's waiting meters. A working session with readings adds
 * each meter's reset time and a longer row, and the row's cut, at its right
 * end where the meters were, took the Weekly meter again. The third case, at
 * the same 1024 px and controls, uses such a row and readings: with fix round
 * 9's classes (9c11d407) the Weekly "%" is cut, which is asserted first; now
 * the meters follow the text row, the reset texts give way, and the Weekly
 * "%" ends before the note, which keeps a width.
 *
 * PR 763 fix round 11 (the recheck of fix rounds 9 and 10): fix round 10 left
 * the review count and the Copilot meter as shrink-0 items of the telemetry,
 * after the meters, so the text row gave way before either lost a pixel;
 * before fix round 10 they were the row's last items and were cut first. The
 * fourth case, a local tab (no note) with readings and the Copilot meter, at
 * the same 1024 px and controls: with fix round 10's classes (4798802) the
 * row has lost more than the chip's whole width while the chip is whole,
 * which is asserted first; now the chip's tail gives way first, the row keeps
 * the space the chip held, and the Weekly "%" ends within the telemetry. (A
 * headless Chromium probe of this markup with the app's own Tailwind CSS and
 * Inter, not the app: the controls 212.9 px, the old row 164.5 px with the
 * 153.3 px chip whole, the row now 330.8 px with the chip hidden.)
 *
 * PR 763 fix round 12: the tail has no clip of its own. With room, the
 * chip's root ends the tail, so a clip there cut the button's 2 px focus
 * ring (`.focus-ring:focus-visible`); the fourth case's roomy reading now
 * asserts the nearest clip past the chip, across and up and down, leaves
 * those 2 px. And the telemetry's clip is `overflow-x-clip`, no scroll
 * container: with `overflow-hidden`, focus on the hidden chip at 1024 px
 * scrolled the telemetry 166 px (the probe), so the fourth case focuses the
 * chip and asserts the telemetry did not scroll.
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'
import {
  STRIP_CLASS,
  STRIP_TELEMETRY_CLASS,
  STRIP_MIDDLE_ROW_CLASS,
  REMOTE_USAGE_NOTE_CLASS,
  STRIP_CONTEXT_CLASS,
  STRIP_CONTEXT_TRACK_CLASS,
  STRIP_CONTEXT_PCT_CLASS,
  STRIP_METERS_CLASS,
  STRIP_TAIL_CLASS,
  RATE_LIMIT_RESET_WRAP_CLASS,
  RATE_LIMIT_RESET_CLASS,
} from '../../src/renderer/components/session-strip-layout'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

interface Classes {
  /** The telemetry around the text row and the meters; null where the meters were the row's last item. */
  telemetry: string | null
  row: string; note: string; ctx: string; track: string; pct: string; meters: string
  /** The tail around the Copilot meter, after the meters (fix round 11); null where the meter was an item of the telemetry, or of the row before fix round 10. */
  tail: string | null
  /** A meter with a reading as RateLimitBar draws it: 'old' before fix round 10, 'now' with its parts kept whole and its reset in a grid. */
  bar: 'old' | 'now'
}

/** The classes the strip drew with on 38e0edcb, before fix round 9. */
const BEFORE: Classes = {
  telemetry: null,
  row: 'flex items-center gap-3 flex-auto min-w-0 overflow-hidden',
  note: 'min-w-0 truncate shrink-[1000]',
  ctx: 'flex items-center gap-1.5 shrink-0',
  track: 'w-16 h-1.5 rounded-full overflow-hidden',
  pct: 'tabular-nums',
  meters: 'flex items-center gap-3 shrink-0',
  tail: null,
  bar: 'old',
}
/** The classes the strip drew with on 9c11d407, fix round 9. */
const ROUND_9: Classes = {
  telemetry: null,
  row: 'flex items-center gap-2 flex-auto min-w-0 overflow-hidden',
  note: 'min-w-[3ch] truncate shrink-[1000]',
  ctx: 'contents',
  track: 'w-16 min-w-6 h-1.5 rounded-full overflow-hidden',
  pct: 'tabular-nums shrink-0',
  meters: 'flex items-center gap-3 shrink-0',
  tail: null,
  bar: 'old',
}
/** The classes the strip draws with now. */
const NOW: Classes = {
  telemetry: STRIP_TELEMETRY_CLASS,
  row: STRIP_MIDDLE_ROW_CLASS,
  note: REMOTE_USAGE_NOTE_CLASS,
  ctx: STRIP_CONTEXT_CLASS,
  track: STRIP_CONTEXT_TRACK_CLASS,
  pct: STRIP_CONTEXT_PCT_CLASS,
  meters: STRIP_METERS_CLASS,
  tail: STRIP_TAIL_CLASS,
  bar: 'now',
}
/** The classes the strip drew with on 4798802, fix round 10: today's, with the Copilot meter a shrink-0 item of the telemetry, after the meters, and the telemetry's clip `overflow-hidden` (fix round 12 made it `overflow-x-clip`). */
const ROUND_10: Classes = { ...NOW, telemetry: 'flex items-center gap-2 flex-auto min-w-0 overflow-hidden', tail: null }

/** What the strip shows beside the shape's row and meters: a helper tab's note, the Copilot meter. */
interface Parts { note: boolean; copilot: boolean }
const HELPER_TAB: Parts = { note: true, copilot: false }
const LOCAL_TAB_WITH_COPILOT: Parts = { note: false, copilot: true }

/** The release smoke's fresh tab (meters waiting), or a working session with readings and reset times. */
type Shape = 'smoke' | 'working'

/** The strip at 1280x768 in the release smoke: 1280 less the 256 px sidebar. */
const STRIP_WIDTH = 1024
const ACCOUNT_WIDTH = 123
/** How short the middle row was there, in px. */
const SHORTFALL = 15

interface Reading {
  content: number; rowRight: number; rowClient: number; rowScroll: number; rowWidth: number
  zoneRight: number; zoneClient: number; zoneScroll: number
  weeklyRight: number; weeklyPctRight: number; trackWidth: number
  /** The note's left edge and width; NaN where the strip has no note. */
  noteLeft: number; noteWidth: number
  /** The Copilot chip's edges and width; NaN where the strip has no chip. */
  chipLeft: number; chipRight: number; chipWidth: number
  chipTop: number; chipBottom: number
  /** The right edge of the chip's nearest ancestor that clips (its overflow-x not visible); NaN where the strip has no chip. */
  clipRight: number
  /** The top and bottom of the chip's nearest ancestor that clips up and down (its overflow-y not visible); minus and plus Infinity where none does, NaN where the strip has no chip. */
  clipTop: number; clipBottom: number
  /** Each reset text's drawn and whole widths (none for waiting meters). */
  resets: Array<{ client: number; scroll: number }>
  /** How far the telemetry scrolled once the chip's button took the focus (0 where it has no chip, and where it cannot scroll). */
  zoneScrollOnFocus: number
}

async function measure(c: Classes, shape: Shape, stripWidth: number, controls: number, parts: Parts = HELPER_TAB): Promise<Reading> {
  return page.evaluate(({ c, shape, strip, stripWidth, account, controls, resetWrap, reset, parts }) => {
    document.querySelectorAll('[data-probe="strip-1280"]').forEach((n) => n.remove())
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'strip-1280')
    host.style.cssText = `position:fixed;left:0;bottom:0;width:${stripWidth}px;z-index:99999;`
    const weekly = (label: string) => (label === 'Weekly' ? ' data-probe-weekly' : '')
    const weeklyPct = (label: string) => (label === 'Weekly' ? ' data-probe-weekly-pct' : '')
    // RateLimitBarPending's markup.
    const waiting = (label: string) =>
      `<span class="flex items-center gap-1.5"${weekly(label)}><span class="text-subtext0 opacity-60">${label}:</span>` +
      `<span class="inline-block bg-surface1 rounded-sm" style="width:64px;height:6px"></span>` +
      `<span class="text-subtext0 tabular-nums opacity-60"${weeklyPct(label)}>--%</span></span>`
    // RateLimitBar's markup with a reading and its reset time, before fix round 10 and now.
    const live = (label: string, pct: string, at: string) =>
      c.bar === 'old'
        ? `<span class="flex items-center gap-1.5"${weekly(label)}><span class="text-subtext0">${label}:</span>` +
          `<span class="inline-block bg-surface1 rounded-sm overflow-hidden" style="width:64px;height:6px"></span>` +
          `<span class="text-subtext0 tabular-nums"${weeklyPct(label)}>${pct}</span>` +
          `<span class="tabular-nums" data-probe-reset>resets ${at}</span></span>`
        : `<span class="flex items-center gap-1.5"${weekly(label)}><span class="text-subtext0 shrink-0">${label}:</span>` +
          `<span class="inline-block bg-surface1 rounded-sm overflow-hidden shrink-0" style="width:64px;height:6px"></span>` +
          `<span class="text-subtext0 tabular-nums shrink-0"${weeklyPct(label)}>${pct}</span>` +
          `<span class="${resetWrap}"><span class="${reset}" data-probe-reset>resets ${at}</span></span></span>`
    const item = (text: string) => `<span class="tabular-nums shrink-0">${text}</span>`
    const context = (pct: string) =>
      `<span class="${c.ctx}"><span class="${c.track}" data-probe-track style="background:var(--surface-sunken)"></span><span class="${c.pct}">${pct}</span></span>`
    const rowItems = shape === 'smoke'
      ? item('500 / 1.0m') + context('0%') + item('API eq $0.5159') + item('+0') + item('1m 17s')
      : item('250.3k / 1.0m') + context('25%') + item('API eq $12.5159') + item('+152') + item('-38') + item('2h 14m')
    const meters = `<span class="${c.meters}">${shape === 'smoke'
      ? waiting('5h') + waiting('Weekly')
      : live('5h', '12%', '3:00 pm') + live('Weekly', '34%', 'Nov 30 10:00 am')}</span>`
    // The Copilot meter's separator and AiUsageChip's markup with a reading and a cap set.
    const copilot = parts.copilot
      ? `<span class="w-px self-stretch my-1.5 mx-0.5 shrink-0" style="background:var(--border-subtle)"></span>` +
        `<span class="relative flex items-center shrink-0" data-probe-chip><button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums" style="border:1px solid var(--border-subtle)">` +
        `<span>Copilot 8.1k/20k</span><span class="inline-block rounded-sm overflow-hidden shrink-0" style="width:40px;height:6px"></span></button></span>`
      : ''
    const tail = c.tail === null ? copilot : `<span class="${c.tail}">${copilot}</span>`
    const telemetry = c.telemetry === null
      ? `<div class="${c.row}" data-probe-row data-probe-zone>${rowItems}${meters}${tail}</div>`
      : `<div class="${c.telemetry}" data-probe-zone><div class="${c.row}" data-probe-row>${rowItems}</div>${meters}${tail}</div>`
    host.innerHTML = `
      <div class="${strip}" style="width:${stripWidth}px;box-sizing:border-box">
        <span class="flex items-center gap-1 shrink-0" style="width:${account}px"></span>
        ${telemetry}
        ${parts.note ? `<span class="${c.note}" data-probe-note title="Not available">Model limits: not available</span>` : ''}
        <div class="flex items-center gap-1 shrink-0" style="width:${controls}px"></div>
      </div>`
    document.body.appendChild(host)
    const row = host.querySelector('[data-probe-row]') as HTMLElement
    const zone = host.querySelector('[data-probe-zone]') as HTMLElement
    const kids = row.children
    const r = row.getBoundingClientRect()
    const noteEl = host.querySelector('[data-probe-note]') as HTMLElement | null
    const note = noteEl ? noteEl.getBoundingClientRect() : null
    const chipEl = host.querySelector('[data-probe-chip]') as HTMLElement | null
    const chip = chipEl ? chipEl.getBoundingClientRect() : null
    let clipEl: HTMLElement | null = chipEl ? chipEl.parentElement : null
    while (clipEl && getComputedStyle(clipEl).overflowX === 'visible') clipEl = clipEl.parentElement
    let clipYEl: HTMLElement | null = chipEl ? chipEl.parentElement : null
    while (clipYEl && getComputedStyle(clipYEl).overflowY === 'visible') clipYEl = clipYEl.parentElement
    const clipY = clipYEl ? clipYEl.getBoundingClientRect() : null
    const reading = {
      content: kids[kids.length - 1].getBoundingClientRect().right - kids[0].getBoundingClientRect().left,
      rowRight: r.right,
      rowClient: row.clientWidth,
      rowScroll: row.scrollWidth,
      rowWidth: r.width,
      zoneRight: zone.getBoundingClientRect().right,
      zoneClient: zone.clientWidth,
      zoneScroll: zone.scrollWidth,
      weeklyRight: (host.querySelector('[data-probe-weekly]') as HTMLElement).getBoundingClientRect().right,
      weeklyPctRight: (host.querySelector('[data-probe-weekly-pct]') as HTMLElement).getBoundingClientRect().right,
      noteLeft: note ? note.left : Number.NaN,
      noteWidth: note ? note.width : Number.NaN,
      chipLeft: chip ? chip.left : Number.NaN,
      chipRight: chip ? chip.right : Number.NaN,
      chipWidth: chip ? chip.width : Number.NaN,
      chipTop: chip ? chip.top : Number.NaN,
      chipBottom: chip ? chip.bottom : Number.NaN,
      clipRight: clipEl ? clipEl.getBoundingClientRect().right : Number.NaN,
      clipTop: !chip ? Number.NaN : clipY ? clipY.top : Number.NEGATIVE_INFINITY,
      clipBottom: !chip ? Number.NaN : clipY ? clipY.bottom : Number.POSITIVE_INFINITY,
      trackWidth: (host.querySelector('[data-probe-track]') as HTMLElement).getBoundingClientRect().width,
      resets: [...host.querySelectorAll('[data-probe-reset]')].map((el) => ({ client: (el as HTMLElement).clientWidth, scroll: (el as HTMLElement).scrollWidth })),
    }
    // Last, as it may scroll: keyboard focus on the chip's button, as a Tab would give it.
    const button = chipEl ? chipEl.querySelector('button') : null
    if (button) button.focus()
    const zoneScrollOnFocus = zone.scrollLeft
    host.remove()
    return { ...reading, zoneScrollOnFocus }
  }, { c, shape, strip: STRIP_CLASS, stripWidth, account: ACCOUNT_WIDTH, controls, resetWrap: RATE_LIMIT_RESET_WRAP_CLASS, reset: RATE_LIMIT_RESET_CLASS, parts })
}

/**
 * The controls' width that leaves the old row exactly SHORTFALL px short in
 * this page's font: the strip less its 12 px padding each side, the account,
 * the three 12 px gaps (account, row, note, controls), the note at 0 px and
 * the row's own width with the old classes and room to spare.
 */
async function smokeControls(): Promise<number> {
  const roomy = await measure(BEFORE, 'smoke', 4000, 0)
  return STRIP_WIDTH - 24 - ACCOUNT_WIDTH - 3 * 12 - (roomy.content - SHORTFALL)
}

test.describe('the status strip of a helper tab at 1280x768', () => {
  test('the Weekly meter is not cut and the note keeps a width, where the strip had the row 15 px short', async () => {
    test.setTimeout(60_000)
    const controls = await smokeControls()
    expect(controls, 'the controls must have a width for the case to be the release smoke\'s').toBeGreaterThan(0)

    // The fault, reproduced with the classes of 38e0edcb.
    const before = await measure(BEFORE, 'smoke', STRIP_WIDTH, controls)
    expect(before.noteWidth, 'the old note shrank to nothing').toBeLessThan(1)
    expect(before.rowScroll - before.rowClient, 'the old row was cut').toBeGreaterThanOrEqual(SHORTFALL - 1)
    expect(before.weeklyRight, 'the old Weekly meter passed the row\'s right edge').toBeGreaterThan(before.rowRight + 1)

    // The strip now, at the same width.
    const now = await measure(NOW, 'smoke', STRIP_WIDTH, controls)
    expect(now.weeklyRight, 'the Weekly meter ends within the telemetry').toBeLessThanOrEqual(now.zoneRight + 0.5)
    expect(now.weeklyRight, 'the Weekly meter ends before the note').toBeLessThanOrEqual(now.noteLeft + 0.5)
    expect(now.rowScroll, 'nothing in the row is cut').toBeLessThanOrEqual(now.rowClient + 1)
    expect(now.zoneScroll, 'nothing in the telemetry is cut').toBeLessThanOrEqual(now.zoneClient + 1)
    expect(now.noteWidth, 'the note keeps a width to see and hover').toBeGreaterThan(0)
    // It is the context track that gave way, and only down to its 24 px.
    expect(now.trackWidth).toBeLessThan(64)
    expect(now.trackWidth).toBeGreaterThanOrEqual(24)
  })

  test('with room to spare nothing gives way: the context track at 64 px, the note whole', async () => {
    const now = await measure(NOW, 'smoke', 1600, 200)
    expect(now.trackWidth).toBe(64)
    expect(now.rowScroll).toBeLessThanOrEqual(now.rowClient + 1)
    expect(now.weeklyRight).toBeLessThanOrEqual(now.zoneRight + 0.5)
    const whole = await measure(NOW, 'smoke', 4000, 0)
    expect(now.noteWidth).toBeGreaterThan(100)
    expect(now.noteWidth).toBeCloseTo(whole.noteWidth, 0)
  })

  test('a working session whose meters have readings: the Weekly "%" ends before the note, the reset texts give way first', async () => {
    test.setTimeout(60_000)
    const controls = await smokeControls()
    expect(controls).toBeGreaterThan(0)

    // The fault, with the classes of 9c11d407: the row's cut takes the Weekly "%".
    const round9 = await measure(ROUND_9, 'working', STRIP_WIDTH, controls)
    expect(round9.weeklyPctRight, 'fix round 9\'s row cut the Weekly "%"').toBeGreaterThan(round9.rowRight + 1)

    // Now, at the same width.
    const now = await measure(NOW, 'working', STRIP_WIDTH, controls)
    expect(now.weeklyPctRight, 'the Weekly "%" ends before the note').toBeLessThanOrEqual(now.noteLeft + 0.5)
    expect(now.weeklyPctRight, 'the Weekly "%" is not clipped by the telemetry').toBeLessThanOrEqual(now.zoneRight + 0.5)
    expect(now.noteWidth, 'the note keeps a width to see and hover').toBeGreaterThan(0)
    // The reset texts gave way (each is drawn narrower than its text), and
    // the text row still holds something: its cut came after them.
    expect(now.resets).toHaveLength(2)
    for (const r of now.resets) expect(r.scroll, 'a reset text gave way').toBeGreaterThan(r.client + 1)
    expect(now.rowWidth, 'the text row still holds its first items').toBeGreaterThan(0)

    // With room, the reset texts are whole and nothing gives way.
    const roomy = await measure(NOW, 'working', 1600, 200)
    for (const r of roomy.resets) expect(r.scroll).toBeLessThanOrEqual(r.client + 1)
    expect(roomy.trackWidth).toBe(64)
    expect(roomy.rowScroll).toBeLessThanOrEqual(roomy.rowClient + 1)
    expect(roomy.weeklyRight).toBeLessThanOrEqual(roomy.noteLeft + 0.5)
  })

  test('a local tab with the Copilot meter: the meter gives way first, before the reset texts and the text row', async () => {
    test.setTimeout(60_000)
    const controls = await smokeControls()
    expect(controls).toBeGreaterThan(0)
    // With room: the row and the chip whole, the chip within the telemetry.
    const roomy = await measure(NOW, 'working', 4000, 0, LOCAL_TAB_WITH_COPILOT)
    expect(roomy.chipWidth).toBeGreaterThan(100)
    expect(roomy.chipRight).toBeLessThanOrEqual(roomy.zoneRight + 0.5)
    // The nearest clip past the chip leaves room for its button's 2 px focus
    // ring, across and up and down.
    expect(roomy.clipRight, 'the chip\'s focus ring is not cut when there is room').toBeGreaterThanOrEqual(roomy.chipRight + 2)
    expect(roomy.clipTop, 'the ring\'s top is not cut').toBeLessThanOrEqual(roomy.chipTop - 2)
    expect(roomy.clipBottom, 'the ring\'s bottom is not cut').toBeGreaterThanOrEqual(roomy.chipBottom + 2)

    // The fault, with the classes of 4798802: the chip keeps its whole width
    // while the text row has lost more than the chip's width.
    const round10 = await measure(ROUND_10, 'working', STRIP_WIDTH, controls, LOCAL_TAB_WITH_COPILOT)
    expect(round10.chipWidth, 'fix round 10\'s chip keeps its whole width').toBeCloseTo(roomy.chipWidth, 0)
    expect(round10.chipRight, 'fix round 10\'s chip is not cut by the telemetry').toBeLessThanOrEqual(round10.zoneRight + 0.5)
    expect(round10.rowWidth, 'fix round 10\'s text row gave way first, by more than the chip\'s width').toBeLessThan(roomy.rowWidth - roomy.chipWidth)

    // Now, at the same width: the chip's tail gave way first, down to
    // nothing, so the chip starts at or past the telemetry's right edge, and
    // the text row keeps the space the chip held.
    const now = await measure(NOW, 'working', STRIP_WIDTH, controls, LOCAL_TAB_WITH_COPILOT)
    expect(now.chipLeft, 'the chip gave way first').toBeGreaterThanOrEqual(now.zoneRight - 0.5)
    expect(now.rowWidth, 'the text row keeps its first items').toBeGreaterThan(100)
    expect(now.rowWidth, 'the text row keeps the space the chip held').toBeGreaterThan(round10.rowWidth + round10.chipWidth - 1)
    expect(now.weeklyPctRight, 'the Weekly "%" is not clipped by the telemetry').toBeLessThanOrEqual(now.zoneRight + 0.5)
    // Keyboard focus on the hidden chip does not scroll the row out of view.
    expect(now.zoneScrollOnFocus, 'the telemetry did not scroll to the focused chip').toBe(0)
  })
})
