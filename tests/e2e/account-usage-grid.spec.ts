/**
 * The Account usage page's grid (nubbymong/aicc_planning#445, the approved
 * mockup v1): cards fill as many columns of at least 330 px as fit, three on
 * a 1280 px page, two on a 1024 px one, then one; no card is wider than its
 * column and nothing scrolls sideways, at any width.
 *
 * jsdom lays nothing out (the unit tests pin the classes and the order), so
 * this measures them here, in the real app with its real stylesheet, by
 * mounting a page-shaped probe built from the same class constants the page
 * draws with (account-usage-layout.ts): the page body, a band's grid and nine
 * cards, one of them named by a long unbroken email.
 *
 * The widths are the page's, not the window's. The window is at least 1280 px
 * wide (src/main/index.ts), and the sidebar beside the page is 200 to 420 px
 * (sessionsPanelState.ts), or collapsed:
 *  - 1280 px: the mockup's frame, three columns;
 *  - 1024 px: a 1280 px window with the default 256 px sidebar, two columns;
 *  - 860 px: the narrowest page the app gives, a 1280 px window with the
 *    widest sidebar, still two columns;
 *  - 468 px: the mockup's narrowest frame (520 px less its rail), one column;
 *  - 300 px: narrower than one card. The grid's `min(330px, 100%)` keeps the
 *    card inside the page; a plain 330 px minimum is shown to overflow there
 *    first, so a pass cannot come from a measure that never sees overflow.
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'
import {
  ACCOUNT_USAGE_BODY_CLASS,
  ACCOUNT_USAGE_GRID_CLASS,
  ACCOUNT_USAGE_CARD_CLASS,
  ACCOUNT_USAGE_NAME_CLASS,
  ACCOUNT_USAGE_CARD_MIN_PX,
} from '../../src/renderer/components/account-usage-layout'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

interface Reading {
  /** Distinct left edges of the cards: the number of columns. */
  columns: number
  /** Each card's width, px. */
  widths: number[]
  /** How far the widest card's right edge passes the grid's, px (0 or less: none). */
  overGrid: number
  /** The page body's scroll width less its client width (0: nothing scrolls sideways). */
  sideways: number
  /** The long-email card's scroll width less its client width (0: the email wraps inside it). */
  nameOverflow: number
}

/** The page probe at `width` px; `gridStyle` replaces the grid's class with an
 *  inline template (the fault case). */
async function measure(width: number, gridStyle?: string): Promise<Reading> {
  return page.evaluate(({ width, body, grid, card, name, gridStyle }) => {
    document.querySelectorAll('[data-probe="account-usage-grid"]').forEach((n) => n.remove())
    const host = document.createElement('div')
    host.setAttribute('data-probe', 'account-usage-grid')
    host.className = body
    host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;max-height:100vh;overflow:auto;box-sizing:border-box;z-index:99999;background:var(--surface-stage);`
    const cardHtml = (i: number) => {
      const label = i === 4 ? 'a-very-long-unbroken-address-for-a-shared-team-account-number-four@example.com' : `account${i}@example.com`
      return `<article class="${card} border-surface0/70 bg-surface0/20" data-probe-card${i === 4 ? ' data-probe-long' : ''}>` +
        `<div class="flex items-start gap-2 min-w-0"><span class="w-2.5 h-2.5 shrink-0"></span>` +
        `<div class="flex-1 min-w-0"><span class="${name}">${label}</span></div></div>` +
        `<div class="flex flex-col gap-2"><span class="block h-[9px] rounded-full bg-surface1"></span><span class="block h-[7px] rounded-full bg-surface1"></span></div>` +
        `</article>`
    }
    const cards = Array.from({ length: 9 }, (_, i) => cardHtml(i)).join('')
    host.innerHTML = gridStyle
      ? `<section><div style="${gridStyle}" data-probe-grid>${cards}</div></section>`
      : `<section><div class="${grid}" data-probe-grid>${cards}</div></section>`
    document.body.appendChild(host)
    const gridEl = host.querySelector('[data-probe-grid]') as HTMLElement
    const gridRect = gridEl.getBoundingClientRect()
    const cardEls = [...host.querySelectorAll('[data-probe-card]')] as HTMLElement[]
    const rects = cardEls.map((c) => c.getBoundingClientRect())
    const long = host.querySelector('[data-probe-long]') as HTMLElement
    const reading = {
      columns: new Set(rects.map((r) => Math.round(r.left))).size,
      widths: rects.map((r) => r.width),
      overGrid: Math.max(...rects.map((r) => r.right)) - gridRect.right,
      sideways: host.scrollWidth - host.clientWidth,
      nameOverflow: long.scrollWidth - long.clientWidth,
    }
    host.remove()
    return reading
  }, { width, body: ACCOUNT_USAGE_BODY_CLASS, grid: ACCOUNT_USAGE_GRID_CLASS, card: ACCOUNT_USAGE_CARD_CLASS, name: ACCOUNT_USAGE_NAME_CLASS, gridStyle })
}

/** Every card of a row is as wide as the others, within a pixel. */
function evenly(widths: number[]): boolean {
  return Math.max(...widths) - Math.min(...widths) <= 1
}

test.describe('the Account usage grid (aicc_planning#445)', () => {
  for (const [width, columns, what] of [
    [1280, 3, 'the mockup\'s 1280 px frame'],
    [1024, 2, 'a 1280 px window with the default sidebar'],
    [860, 2, 'the narrowest page the app gives'],
    [468, 1, 'the mockup\'s narrowest frame'],
  ] as const) {
    test(`${columns} column${columns === 1 ? '' : 's'} at ${width} px (${what}), every card whole, nothing sideways`, async () => {
      const r = await measure(width)
      expect(r.columns).toBe(columns)
      for (const w of r.widths) expect(w).toBeGreaterThanOrEqual(ACCOUNT_USAGE_CARD_MIN_PX)
      expect(evenly(r.widths)).toBe(true)
      expect(r.overGrid).toBeLessThanOrEqual(0.5)
      expect(r.sideways).toBeLessThanOrEqual(0)
      // The long email wraps inside its card; the card does not widen its column.
      expect(r.nameOverflow).toBeLessThanOrEqual(0)
    })
  }

  test('narrower than one card: a plain 330 px column overflows, the grid\'s does not', async () => {
    // The fault first: the measure sees overflow when there is some.
    const fault = await measure(300, `display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(${ACCOUNT_USAGE_CARD_MIN_PX}px,1fr))`)
    expect(fault.overGrid).toBeGreaterThan(0)
    expect(fault.sideways).toBeGreaterThan(0)
    // The page's grid: one column, as wide as the page allows, nothing sideways.
    const r = await measure(300)
    expect(r.columns).toBe(1)
    expect(r.overGrid).toBeLessThanOrEqual(0.5)
    expect(r.sideways).toBeLessThanOrEqual(0)
    expect(r.nameOverflow).toBeLessThanOrEqual(0)
  })
})
