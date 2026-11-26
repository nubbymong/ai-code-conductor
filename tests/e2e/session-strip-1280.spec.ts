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
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'
import {
  STRIP_CLASS,
  STRIP_MIDDLE_ROW_CLASS,
  REMOTE_USAGE_NOTE_CLASS,
  STRIP_CONTEXT_CLASS,
  STRIP_CONTEXT_TRACK_CLASS,
  STRIP_CONTEXT_PCT_CLASS,
  STRIP_METERS_CLASS,
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

interface Classes { row: string; note: string; ctx: string; track: string; pct: string; meters: string }

/** The classes the strip drew with on 38e0edcb, before this fix. */
const BEFORE: Classes = {
  row: 'flex items-center gap-3 flex-auto min-w-0 overflow-hidden',
  note: 'min-w-0 truncate shrink-[1000]',
  ctx: 'flex items-center gap-1.5 shrink-0',
  track: 'w-16 h-1.5 rounded-full overflow-hidden',
  pct: 'tabular-nums',
  meters: 'flex items-center gap-3 shrink-0',
}
/** The classes the strip draws with now. */
const NOW: Classes = {
  row: STRIP_MIDDLE_ROW_CLASS,
  note: REMOTE_USAGE_NOTE_CLASS,
  ctx: STRIP_CONTEXT_CLASS,
  track: STRIP_CONTEXT_TRACK_CLASS,
  pct: STRIP_CONTEXT_PCT_CLASS,
  meters: STRIP_METERS_CLASS,
}

/** The strip at 1280x768 in the release smoke: 1280 less the 256 px sidebar. */
const STRIP_WIDTH = 1024
const ACCOUNT_WIDTH = 123
/** How short the middle row was there, in px. */
const SHORTFALL = 15

interface Reading { content: number; rowRight: number; rowClient: number; rowScroll: number; weeklyRight: number; noteWidth: number; trackWidth: number }

async function measure(c: Classes, stripWidth: number, controls: number): Promise<Reading> {
  return page.evaluate(({ c, strip, stripWidth, account, controls }) => {
    document.querySelectorAll('[data-probe="strip-1280"]').forEach((n) => n.remove())
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'strip-1280')
    host.style.cssText = `position:fixed;left:0;bottom:0;width:${stripWidth}px;z-index:99999;`
    const meter = (label: string, probe: string) =>
      `<span class="flex items-center gap-1.5"${probe}><span class="text-subtext0 opacity-60">${label}:</span>` +
      `<span class="inline-block bg-surface1 rounded-sm" style="width:64px;height:6px"></span>` +
      `<span class="text-subtext0 tabular-nums opacity-60">--%</span></span>`
    host.innerHTML = `
      <div class="${strip}" style="width:${stripWidth}px;box-sizing:border-box">
        <span class="flex items-center gap-1 shrink-0" style="width:${account}px"></span>
        <div class="${c.row}" data-probe-row>
          <span class="tabular-nums shrink-0">500 / 1.0m</span>
          <span class="${c.ctx}"><span class="${c.track}" data-probe-track style="background:var(--surface-sunken)"></span><span class="${c.pct}">0%</span></span>
          <span class="tabular-nums shrink-0">API eq $0.5159</span>
          <span class="tabular-nums shrink-0">+0</span>
          <span class="tabular-nums shrink-0">1m 17s</span>
          <span class="${c.meters}">${meter('5h', '')}${meter('Weekly', ' data-probe-weekly')}</span>
        </div>
        <span class="${c.note}" data-probe-note title="Not available">Model limits: not available</span>
        <div class="flex items-center gap-1 shrink-0" style="width:${controls}px"></div>
      </div>`
    document.body.appendChild(host)
    const row = host.querySelector('[data-probe-row]') as HTMLElement
    const kids = row.children
    const r = row.getBoundingClientRect()
    const reading = {
      content: kids[kids.length - 1].getBoundingClientRect().right - kids[0].getBoundingClientRect().left,
      rowRight: r.right,
      rowClient: row.clientWidth,
      rowScroll: row.scrollWidth,
      weeklyRight: (host.querySelector('[data-probe-weekly]') as HTMLElement).getBoundingClientRect().right,
      noteWidth: (host.querySelector('[data-probe-note]') as HTMLElement).getBoundingClientRect().width,
      trackWidth: (host.querySelector('[data-probe-track]') as HTMLElement).getBoundingClientRect().width,
    }
    host.remove()
    return reading
  }, { c, strip: STRIP_CLASS, stripWidth, account: ACCOUNT_WIDTH, controls })
}

test.describe('the status strip of a helper tab at 1280x768', () => {
  test('the Weekly meter is not cut and the note keeps a width, where the strip had the row 15 px short', async () => {
    test.setTimeout(60_000)
    // The row's own width in this page's font, with the old classes and room to spare.
    const roomy = await measure(BEFORE, 4000, 0)
    // The controls' width that leaves the old row exactly SHORTFALL px short:
    // the strip less its 12 px padding each side, the account, the three 12 px
    // gaps (account, row, note, controls) and the note at 0 px.
    const controls = STRIP_WIDTH - 24 - ACCOUNT_WIDTH - 3 * 12 - (roomy.content - SHORTFALL)
    expect(controls, 'the controls must have a width for the case to be the release smoke\'s').toBeGreaterThan(0)

    // The fault, reproduced with the classes of 38e0edcb.
    const before = await measure(BEFORE, STRIP_WIDTH, controls)
    expect(before.noteWidth, 'the old note shrank to nothing').toBeLessThan(1)
    expect(before.rowScroll - before.rowClient, 'the old row was cut').toBeGreaterThanOrEqual(SHORTFALL - 1)
    expect(before.weeklyRight, 'the old Weekly meter passed the row\'s right edge').toBeGreaterThan(before.rowRight + 1)

    // The strip now, at the same width.
    const now = await measure(NOW, STRIP_WIDTH, controls)
    expect(now.weeklyRight, 'the Weekly meter ends within the row').toBeLessThanOrEqual(now.rowRight + 0.5)
    expect(now.rowScroll, 'nothing in the row is cut').toBeLessThanOrEqual(now.rowClient + 1)
    expect(now.noteWidth, 'the note keeps a width to see and hover').toBeGreaterThan(0)
    // It is the context track that gave way, and only down to its 24 px.
    expect(now.trackWidth).toBeLessThan(64)
    expect(now.trackWidth).toBeGreaterThanOrEqual(24)
  })

  test('with room to spare nothing gives way: the context track at 64 px, the note whole', async () => {
    const now = await measure(NOW, 1600, 200)
    expect(now.trackWidth).toBe(64)
    expect(now.rowScroll).toBeLessThanOrEqual(now.rowClient + 1)
    expect(now.weeklyRight).toBeLessThanOrEqual(now.rowRight + 0.5)
    const whole = await measure(NOW, 4000, 0)
    expect(now.noteWidth).toBeGreaterThan(100)
    expect(now.noteWidth).toBeCloseTo(whole.noteWidth, 0)
  })
})
