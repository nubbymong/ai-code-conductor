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
  bar: 'now',
}

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
  weeklyRight: number; weeklyPctRight: number; noteLeft: number; noteWidth: number; trackWidth: number
  /** Each reset text's drawn and whole widths (none for waiting meters). */
  resets: Array<{ client: number; scroll: number }>
}

async function measure(c: Classes, shape: Shape, stripWidth: number, controls: number): Promise<Reading> {
  return page.evaluate(({ c, shape, strip, stripWidth, account, controls, resetWrap, reset }) => {
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
    const telemetry = c.telemetry === null
      ? `<div class="${c.row}" data-probe-row data-probe-zone>${rowItems}${meters}</div>`
      : `<div class="${c.telemetry}" data-probe-zone><div class="${c.row}" data-probe-row>${rowItems}</div>${meters}</div>`
    host.innerHTML = `
      <div class="${strip}" style="width:${stripWidth}px;box-sizing:border-box">
        <span class="flex items-center gap-1 shrink-0" style="width:${account}px"></span>
        ${telemetry}
        <span class="${c.note}" data-probe-note title="Not available">Model limits: not available</span>
        <div class="flex items-center gap-1 shrink-0" style="width:${controls}px"></div>
      </div>`
    document.body.appendChild(host)
    const row = host.querySelector('[data-probe-row]') as HTMLElement
    const zone = host.querySelector('[data-probe-zone]') as HTMLElement
    const kids = row.children
    const r = row.getBoundingClientRect()
    const note = (host.querySelector('[data-probe-note]') as HTMLElement).getBoundingClientRect()
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
      noteLeft: note.left,
      noteWidth: note.width,
      trackWidth: (host.querySelector('[data-probe-track]') as HTMLElement).getBoundingClientRect().width,
      resets: [...host.querySelectorAll('[data-probe-reset]')].map((el) => ({ client: (el as HTMLElement).clientWidth, scroll: (el as HTMLElement).scrollWidth })),
    }
    host.remove()
    return reading
  }, { c, shape, strip: STRIP_CLASS, stripWidth, account: ACCOUNT_WIDTH, controls, resetWrap: RATE_LIMIT_RESET_WRAP_CLASS, reset: RATE_LIMIT_RESET_CLASS })
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
})
