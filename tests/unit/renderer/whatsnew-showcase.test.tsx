// @vitest-environment jsdom
/**
 * The What's New feature showcase (owner design, 2026-08-24): the summary is
 * page 0 and each flagship feature gets a full page behind it, paged by footer
 * dots / Next, escapable by Skip, with the harness CTA only on the last page.
 *
 * Since 2026-10-11 (findings O1, O2, O3) the summary lines and the pages are
 * chosen by WHERE THE USER COMES FROM: every line and page carries the first
 * build that shipped it (`since`), and the page shows what is newer than the
 * anchor (whatsNewAnchorFor, keyed to the FINAL release). The beta.2 page
 * chose by release line: a 2.1.0 user on 2.1.1 saw "What's new in 2.1" and
 * the whole 2.1 story again, and nothing about what 2.1.1 brought.
 *
 * What this file holds shut:
 *  - the cohort matrix: 2.1.0 -> 2.1.1 (and every 2.1.1 prerelease) sees the
 *    2.1.1 story and none of 2.1.0's; a 2.0 user sees both; a fresh install
 *    keeps the 2.1 story; a fixes-only update gets one line and no pages;
 *  - that fixes-only page is decided after the cohort, provider and Codex
 *    answer filters, on a curated history of the test's own (summaryContent);
 *  - the heading names the anchor ("What's new since 2.1.0");
 *  - the harness contract is untouched: onNext fires exactly when the run is
 *    left (last-page CTA, or Skip), never on internal paging;
 *  - the "See it" chips only render for items whose showcase page shows, so
 *    the two curated files cannot drift into a dead button;
 *  - section headings stay unique after the provider headings apply;
 *  - every tag is pinned (frozen table) and the newest changelog release has
 *    curated content (drift guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const CURRENT = '2.1.1-beta.3'
;(globalThis as any).__APP_VERSION__ = CURRENT

// The beta.2 page read the stamp from this store; the render helper keeps it
// equal to the anchor, so a red run against beta.2 fails on behaviour.
const metaState: any = { meta: { lastSeenVersion: '2.1.0' } }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const settingsState: any = { settings: { updateChannel: 'stable' } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const W = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
const { WhatsNewV2Step, sectionsFor, showRenamePageFor } = W
const S = await import('../../../src/renderer/onboarding/showcase-pages')
const { SHOWCASES_21, showcasesFor } = S
const { ShowcaseVignette } = await import('../../../src/renderer/onboarding/ShowcaseVignette')
const { changelog } = await import('../../../src/renderer/changelog')
const { whatsNewAnchorFor, seenVersionFor } = await import('../../../src/renderer/onboarding/upgrade-flow')
const { finalRelease, compareVersions } = await import('../../../src/shared/version-order')

type Page = (typeof SHOWCASES_21)[number]
const SHOWCASES: readonly Page[] = (S as any).SHOWCASES ?? SHOWCASES_21
const SHOWCASES_211: Page[] = (S as any).SHOWCASES_211 ?? []
const ALL_SECTIONS: readonly any[] = (W as any).WHATS_NEW_SECTIONS ?? []

// The anchors (what whatsNewAnchorFor hands the page), by cohort.
const FROM_210 = '2.1.0' //          a stable 2.1.0 user, and every 2.1.1 prerelease tester
const FROM_20 = '2.0.5' //           a 2.0 user: before the rename
const POST_RENAME = '2.1.0-beta.6' // a component input: every 2.1 and 2.1.1 item, no rename page

let container: HTMLDivElement
let root: Root
let nexts: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  nexts = 0
  metaState.meta = { lastSeenVersion: FROM_210 }
  settingsState.settings = { updateChannel: 'stable' }
  ;(globalThis as any).__APP_VERSION__ = CURRENT
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ;(globalThis as any).__APP_VERSION__ = CURRENT
})

const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)
const click = (el: Element | null) => act(() => { (el as HTMLElement).click() })
const remount = () => { act(() => root.unmount()); root = createRoot(container) }
const EM_DASH = String.fromCharCode(0x2014)

function render(props: Partial<React.ComponentProps<typeof WhatsNewV2Step>> = {}) {
  const p = { anchor: props.fresh ? undefined : FROM_210, ...props }
  metaState.meta = p.anchor ? { lastSeenVersion: p.anchor } : {}
  act(() => {
    root.render(<WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." {...p} />)
  })
}

/** The pages shown to a view, in order (the component's own selection). */
function visiblePages(anchor: string | undefined, opts: { fresh?: boolean; withClaude?: boolean } = {}): Page[] {
  return (W as any).summaryShowcases({ anchor, fresh: !!opts.fresh, withClaude: opts.withClaude ?? true })
}

// ── the curated data ───────────────────────────────────────────────
describe('showcase-pages — the curated set', () => {
  it('showcasesFor picks the pages new since the anchor, never by release line', () => {
    const ids = (ps: Page[]) => ps.map((p) => p.id)
    // A 2.1.0 user on any 2.1.1 build: the 2.1.1 pages, none of 2.1.0's.
    expect(ids(showcasesFor(FROM_210 as any))).toEqual(ids(SHOWCASES_211))
    expect(SHOWCASES_211.length).toBeGreaterThan(0)
    // A 2.0 user: the 2.1 pages, then the 2.1.1 ones, the order the app changed in.
    expect(ids(showcasesFor(FROM_20 as any))).toEqual([...ids(SHOWCASES_21), ...ids(SHOWCASES_211)])
    // A fresh install: the 2.1 flagships only (the 2.1.1 pages are told against 2.1.0).
    expect(ids((showcasesFor as any)(undefined, { fresh: true }))).toEqual(ids(SHOWCASES_21))
    // Nothing curated since the anchor: no pages, never an older set.
    expect((showcasesFor as any)('2.1.1')).toEqual([])
    expect((showcasesFor as any)('2.2.0')).toEqual([])
  })

  it('page ids are unique and every page keeps to 3-4 points', () => {
    const ids = SHOWCASES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of SHOWCASES) {
      expect(p.points.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.points.length, p.id).toBeLessThanOrEqual(4)
    }
  })

  it('every See-it chip on a line shown resolves to a page shown to the same view: no dead chips', () => {
    const views = [
      { anchor: undefined, fresh: true },
      { anchor: FROM_20, fresh: false },
      { anchor: FROM_210, fresh: false },
      { anchor: POST_RENAME, fresh: false },
    ]
    for (const v of views) {
      for (const withClaude of [true, false]) {
        const lines = (W as any).summarySections({ ...v, withClaude, withCodex: true }).flatMap((s: any) => s.items)
        const pageIds = new Set(visiblePages(v.anchor, { fresh: v.fresh, withClaude }).map((p) => p.id))
        for (const it of lines) {
          if (it.seeIt) expect(pageIds.has(it.seeIt), `${JSON.stringify(v)} claude=${withClaude}: seeIt "${it.seeIt}" on "${it.title}"`).toBe(true)
        }
      }
    }
    // And the flagships are actually linked, not merely linkable.
    const linked = (anchor: string | undefined, fresh: boolean) =>
      (W as any).summarySections({ anchor, fresh, withClaude: true, withCodex: true }).flatMap((s: any) => s.items).filter((i: any) => i.seeIt).map((i: any) => i.seeIt)
    expect(linked(undefined, true)).toEqual(expect.arrayContaining(['canvas', 'watchdog', 'oneRow']))
    expect(linked(FROM_210, false)).toEqual(expect.arrayContaining(SHOWCASES_211.map((p) => p.id)))
  })

  it('P3.4 (row 14): with Claude Code off, what needs Claude Code in this release is not shown', () => {
    // P3.6 lifted the accounts page and the Switch mid-session line (a Codex
    // account switches mid-session too); claude.ai in the app stays Claude's.
    // P3.10 lifted the watchdog page and its line (the Watchdog arms for Codex).
    // WP2 PR 4, P4.1 lifted the canvas page and its line (the Agent Canvas
    // works in Codex sessions).
    // P4.3 lifted the Ask Conductor page and its line (Ask runs on Codex).
    // 2.1.1: a review asks the OTHER assistant, so the review page and line
    // need both; the 5.5 models and remote scrolling are Claude Code's.
    const CLAUDE_ONLY_PAGES = ['remoteResume', 'codeReview']
    // The two remote lines (VM round, M1): SSH Persistent keeps the remote
    // session alive by wrapping the remote claude command, and the only agent
    // an SSH session runs in this release is Claude Code, so both go with the
    // remote resume page.
    const REMOTE_ITEMS = ['SSH Persistent.', 'Remote Resumable.', 'Remote scrolling.']
    // P4.7 lifted the Insights line (Insights runs for Codex accounts too).
    const CLAUDE_ONLY_ITEMS = ['claude.ai in the app.', 'Claude reviews Codex too.', 'Claude 5.5 models.', ...REMOTE_ITEMS]
    // Claude Code on: everything, as before.
    render({ anchor: POST_RENAME })
    expect(container.textContent).toContain('Working with Claude')
    for (const t of CLAUDE_ONLY_ITEMS) expect(container.textContent, t).toContain(t)
    expect(q('see-remoteResume')).not.toBeNull()
    const allPages = visiblePages(POST_RENAME) // every 2.1 and 2.1.1 page
    expect(allPages.length).toBe(SHOWCASES.length)
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + allPages.length}`)
    const claudeOnlyText = container.textContent!
    remount()
    // Both on: what Claude Code alone shows, but the heading over the canvas,
    // Watchdog and Ask lines names both (P4.11, INT-7: each works for both).
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: true, codexEnabled: true }
    render({ anchor: POST_RENAME })
    expect(container.textContent).toBe(claudeOnlyText.replace('Working with Claude', 'Working with Claude and Codex'))
    remount()
    // Claude Code off: those items and pages go; a section left empty goes too.
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render({ anchor: POST_RENAME })
    expect(container.textContent).not.toContain('Working with Claude')
    // The section stays for the switch line (P3.6).
    expect(container.textContent).toContain('Accounts & usage')
    expect(container.textContent).toContain('Switch mid-session.')
    for (const t of CLAUDE_ONLY_ITEMS) expect(container.textContent, t).not.toContain(t)
    const shown = allPages.filter((p) => !CLAUDE_ONLY_PAGES.includes(p.id))
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + shown.length}`)
    // The Sessions section stays for the lines that do not need Claude Code;
    // the remote resume page and its chip go with the two remote lines.
    expect(q('section-sessions')).not.toBeNull()
    expect(q('section-sessions')!.textContent).toContain('Partner terminal.')
    expect(q('see-remoteResume')).toBeNull()
    expect(q('see-codeReview')).toBeNull()
    expect(q('see-oneRow')).not.toBeNull()
    const all = ALL_SECTIONS.flatMap((s) => s.items)
    for (const t of REMOTE_ITEMS) expect(all.find((i: any) => i.title === t)?.needsClaude, t).toBe(true)
    // The 2.0 set's guide line promises Ask ("a session that has read the
    // docs"), which runs on Codex too since P4.3; the partner terminal works
    // beside a Codex session too. Both stay.
    const everything = sectionsFor(undefined).flatMap((s) => s.items)
    expect(everything.find((i) => i.title === 'A guide that answers back.')?.needsClaude).toBeUndefined()
    expect(everything.find((i) => i.title === 'Partner terminal.')?.needsClaude).toBeUndefined()
    // ...and names no provider (row 64 did the same for the strip and tips).
    expect(everything.find((i) => i.title === 'Partner terminal.')?.desc).toBe('A plain shell beside your session, labelled so you always know which is which.')
  })

  it('WP2 PR 4, P4.1 (row 51): the Agent Canvas is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor(POST_RENAME).flatMap((s) => s.items)
    const canvas = lines.find((i) => i.title === 'Agent Canvas.')!
    expect(canvas.needsClaude).toBeUndefined()
    expect(canvas.seeIt).toBe('canvas')
    expect(canvas.desc).not.toMatch(/claude|codex/i)
    const page = SHOWCASES_21.find((p) => p.id === 'canvas')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|codex/i)
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render({ anchor: POST_RENAME })
    expect(container.textContent).toContain('Agent Canvas.')
    expect(q('see-canvas')).not.toBeNull()
  })

  it('P4.3 (row 53): Ask Conductor is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor(POST_RENAME).flatMap((s) => s.items)
    const ask = lines.find((i) => i.title === 'Ask Conductor.')!
    expect(ask.needsClaude).toBeUndefined()
    expect(ask.seeIt).toBe('askConductor')
    const page = SHOWCASES_21.find((p) => p.id === 'askConductor')!
    expect(page.needsClaude).toBeUndefined()
    for (const pt of page.points) expect(pt.needsClaude, pt.lead).toBeUndefined()
    // No point says it is Claude's alone.
    expect(page.points.map((pt) => `${pt.lead} ${pt.rest}`).join(' ')).not.toMatch(/every Claude session|Claude Code itself/)
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render({ anchor: POST_RENAME })
    expect(container.textContent).toContain('Ask Conductor.')
    click(q('see-askConductor'))
    expect(q('showcase-page-askConductor')).not.toBeNull()
  })

  it('P3.10 (row 43): the Watchdog is told for both providers, and shows with Claude Code off', () => {
    const lines = sectionsFor(POST_RENAME).flatMap((s) => s.items)
    const wd = lines.find((i) => i.title === 'Session Watchdog.')!
    expect(wd.needsClaude).toBeUndefined()
    expect(wd.seeIt).toBe('watchdog')
    expect(wd.desc).not.toMatch(/claude|codex/i)
    const page = SHOWCASES_21.find((p) => p.id === 'watchdog')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|codex/i)
    for (const pt of page.points) expect(pt.needsClaude, pt.lead).toBeUndefined()
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render({ anchor: POST_RENAME })
    expect(container.textContent).toContain('Session Watchdog.')
    // Its section no longer says Claude with Claude Code off.
    expect(container.textContent).toContain('Working with Codex')
    expect(container.textContent).not.toContain('Working with Claude')
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
  })

  it('P3.6 (row 22): the switch is told for both providers; with Claude Code off, nothing about Claude\'s own services', () => {
    const lines = sectionsFor(POST_RENAME).flatMap((s) => s.items)
    const sw = lines.find((i) => i.title === 'Switch mid-session.')!
    expect(sw.needsClaude).toBeUndefined()
    expect(sw.seeIt).toBe('accounts')
    expect(sw.desc).not.toMatch(/claude/i)
    expect(lines.find((i) => i.title === 'claude.ai in the app.')?.needsClaude).toBe(true)
    const page = SHOWCASES_21.find((p) => p.id === 'accounts')!
    expect(page.needsClaude).toBeUndefined()
    expect(`${page.heading} ${page.tagline} ${page.where.pre}${page.where.em}${page.where.post}`).not.toMatch(/claude|insights/i)
    // P4.7 lifted its Insights point: no point of it is Claude Code's now.
    for (const pt of page.points) {
      const claudeOnly = /claude/i.test(`${pt.lead} ${pt.rest}`)
      expect(pt.needsClaude, pt.lead).toBe(claudeOnly ? true : undefined)
    }
    expect(page.points.filter((pt) => !pt.needsClaude).length).toBeGreaterThanOrEqual(3)
    // Codex only: the page shows, without its Claude-only point.
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render({ anchor: POST_RENAME })
    click(q('see-accounts'))
    expect(q('showcase-heading')!.textContent).toBe('Every account, one app')
    expect(q('showcase-points')!.textContent).toContain('Switch mid-session.')
    // P4.7: Run all covers Codex accounts too, so the Insights point shows.
    expect(q('showcase-points')!.textContent).toContain('Insights across accounts.')
    remount()
    // Claude Code on: the Insights point is there.
    settingsState.settings = { updateChannel: 'stable' }
    render({ anchor: POST_RENAME })
    click(q('see-accounts'))
    expect(q('showcase-points')!.textContent).toContain('Insights across accounts.')
  })

  it('P3.4 (row 14): a run that goes on with Codex only (setup found no Claude Code) reads it the same way', async () => {
    const { noteClaudeMissingAtSetup, resetProviderChoiceForTests } = await import('../../../src/renderer/onboarding/provider-choice')
    noteClaudeMissingAtSetup()
    try {
      render({ anchor: POST_RENAME })
      expect(container.textContent).toContain('One row.') // the summary page is the one shown
      expect(container.textContent).not.toContain('Working with Claude')
      // WP2 PR 4, P4.1: the Agent Canvas line stays (the canvas works in Codex sessions).
      expect(container.textContent).toContain('Agent Canvas.')
      expect(container.textContent).not.toContain('SSH Persistent.')
      expect(container.textContent).not.toContain('Remote Resumable.')
    } finally {
      resetProviderChoiceForTests()
    }
  })
})

// ── the paged step (the 2.1.0 -> 2.1.1 run: the main update path) ──────
describe('WhatsNewV2Step — multi-page showcase', () => {
  it('opens on the summary, with dots and a positional hint', () => {
    render()
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(q('showcase-heading')).toBeNull()
    expect(q('whatsnew-dots')).not.toBeNull()
    // Derived, not hardcoded: 1 summary + one page per page new since 2.1.0.
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + SHOWCASES_211.length}`)
  })

  it('Next pages inward without leaving the run; the last page carries the harness CTA', () => {
    render()
    const cta = () => q('whatsnew-cta')!
    expect(cta().textContent).toContain('Next')
    click(cta()) // -> the first page
    expect(nexts).toBe(0)
    expect(q(`showcase-page-${SHOWCASES_211[0].id}`)).not.toBeNull()
    expect(q('showcase-eyebrow')!.textContent).toContain(`1 of ${SHOWCASES_211.length}`)
    for (let i = 1; i < SHOWCASES_211.length; i++) click(cta()) // -> walk to the last
    expect(q(`showcase-page-${SHOWCASES_211[SHOWCASES_211.length - 1].id}`)).not.toBeNull()
    expect(cta().textContent).toBe('Continue')
    expect(q('whatsnew-hint')!.textContent).toBe('Nothing to set up.')
    expect(q('whatsnew-skip'), 'skip duplicates the CTA on the last page').toBeNull()
    expect(nexts).toBe(0)
    click(cta())
    expect(nexts).toBe(1)
  })

  it('a "See it" chip jumps straight to its page', () => {
    render()
    click(q('see-codexSessions'))
    expect(q('showcase-page-codexSessions')).not.toBeNull()
    const ix = SHOWCASES_211.findIndex((pg) => pg.id === 'codexSessions')
    expect(q('showcase-eyebrow')!.textContent).toContain(`${ix + 1} of ${SHOWCASES_211.length}`)
    expect(nexts).toBe(0)
  })

  it('the dots jump anywhere, including back to the summary', () => {
    render()
    click(q('whatsnew-dot-usageBoth'))
    expect(q('showcase-page-usageBoth')).not.toBeNull()
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(nexts).toBe(0)
  })

  it('Skip leaves the run from an inner page', () => {
    render()
    click(q('whatsnew-cta'))
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })

  it('each showcase page draws its vignette', () => {
    render()
    for (const p of SHOWCASES_211) {
      click(q(`whatsnew-dot-${p.id}`))
      expect(q(`showcase-art-${p.art}`), p.id).not.toBeNull()
    }
  })

  it('a chip renders ONLY when its showcase page exists — the anti-drift guard', async () => {
    // Serve a page set holding only one page: the summary still carries
    // seeIt ids for the others, so an unguarded chip would render for pages
    // that cannot be jumped to. Deleting the `showcases.some` guard in
    // WhatsNewV2Step fails this test.
    vi.resetModules()
    vi.doMock('../../../src/renderer/onboarding/showcase-pages', async (importOriginal) => {
      const real: any = await importOriginal()
      return { ...real, showcasesFor: () => real.SHOWCASES_211.filter((p: any) => p.id === 'codexAssistant') }
    })
    try {
      const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
      act(() => {
        root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="h" anchor={FROM_210} />)
      })
      expect(container.querySelector('[data-ux-id="see-codexAssistant"]')).not.toBeNull()
      expect(container.querySelector('[data-ux-id="see-codexAccounts"]')).toBeNull()
      expect(container.querySelector('[data-ux-id="see-codexSessions"]')).toBeNull()
    } finally {
      // resetModules does NOT clear the mock registry — without the unmock a
      // failed assertion above would leak the reduced page set into the next
      // test's fresh import and fail it with a misleading message.
      vi.doUnmock('../../../src/renderer/onboarding/showcase-pages')
      vi.resetModules()
    }
  })

  it('an update with no page for this user collapses to the old single-page step', () => {
    // 2.1.1 -> 2.1.2 with no 2.1.2 set curated: the fixes line, no showcase.
    ;(globalThis as any).__APP_VERSION__ = '2.1.2'
    render({ anchor: '2.1.1' })
    expect(q('whatsnew-dots')).toBeNull()
    expect(q('whatsnew-skip')).toBeNull()
    const cta = q('whatsnew-cta')!
    expect(cta.textContent).toBe('Continue')
    click(cta)
    expect(nexts).toBe(1)
  })
})

// ── O1/O2: what is new since where the user came from ────────────────
describe('O1/O2: the summary and showcase diff from the anchor', () => {
  const OLD_21_LINES = ['SSH Persistent.', 'Partner terminal.', 'Multi Spawn.', 'Agent Canvas.', 'Session Watchdog.', 'Switch mid-session.', 'Insights.', 'New name.', 'Signed and notarised.']

  it('O1: the heading names where the user comes from: "What\'s new since 2.1.0" on a 2.1.1 build', () => {
    render({ anchor: FROM_210 })
    expect(q('whatsnew-heading')!.textContent).toBe("What's new since 2.1.0")
  })

  it('O1/O2: 2.1.0 -> 2.1.1 shows the 2.1.1 story and none of 2.1.0\'s, lines or pages', () => {
    render({ anchor: FROM_210 })
    const text = container.textContent!
    for (const t of OLD_21_LINES) expect(text, t).not.toContain(t)
    expect(text).toContain('Codex, no longer Beta.')
    expect(text).toContain('Claude reviews Codex too.')
    // Pages: the 2.1.1 ones only, never a 2.1 flagship.
    const dots = [...container.querySelectorAll('[data-ux-id^="whatsnew-dot-"]')].map((d) => d.getAttribute('data-ux-id'))
    expect(dots).toEqual(['whatsnew-dot-summary', ...SHOWCASES_211.map((p) => `whatsnew-dot-${p.id}`)])
    expect(q('whatsnew-dot-canvas')).toBeNull()
  })

  it('O2 (owner rule): a beta tester moving beta.2 -> beta.3 sees the whole 2.1.1 story, and no rename page', () => {
    // The anchor App hands the page: the boot snapshot's seen version, keyed
    // to the final release (no prerelease counts as having seen its release).
    const anchor = whatsNewAnchorFor({ seenVersion: '2.1.1-beta.2', currentVersion: CURRENT, releases: changelog })
    expect(anchor).toBe('2.1.0')
    settingsState.settings = { updateChannel: 'beta' }
    // The beta.2 page read the raw stamp and the channel: give it both.
    metaState.meta = { lastSeenVersion: '2.1.1-beta.2' }
    act(() => {
      root.render(<WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="h" anchor={anchor} />)
    })
    expect(q('rename-page'), 'the beta-channel tester arm is gone').toBeNull()
    expect(q('whatsnew-heading')!.textContent).toBe("What's new since 2.1.0")
    expect(container.textContent).toContain('Codex, no longer Beta.')
    for (const t of OLD_21_LINES) expect(container.textContent, t).not.toContain(t)
  })

  it('O2: the final 2.1.1 still shows the 2.1.1 story to someone who ran its prereleases', () => {
    expect(whatsNewAnchorFor({ seenVersion: '2.1.1-beta.3', currentVersion: '2.1.1', releases: changelog })).toBe('2.1.0')
  })

  it('O1 (owner rule): a prerelease of an OLDER release counts as that release: rc.17 -> 2.1.1 gets 2.1.1 only', () => {
    const anchor = whatsNewAnchorFor({ seenVersion: '2.1.0-rc.17', currentVersion: CURRENT, releases: changelog })
    expect(anchor).toBe('2.1.0')
    render({ anchor })
    for (const t of OLD_21_LINES) expect(container.textContent, t).not.toContain(t)
    expect(q('whatsnew-dot-canvas')).toBeNull()
  })

  it('O2: a stamp written ahead of its build diffs from the build that last ran', () => {
    // Values that do not floor to 2.1.0, so the clamp is what decides them:
    // a run of 2.0.0 under a stamp of this build, and a final build stamped
    // ahead (no prerelease floor there).
    const seen = seenVersionFor({ lastSeenVersion: CURRENT, lastRunVersion: '2.0.0' })
    expect(whatsNewAnchorFor({ seenVersion: seen, currentVersion: CURRENT, releases: changelog })).toBe('2.0.0')
    const seenFinal = seenVersionFor({ lastSeenVersion: '2.1.1', lastRunVersion: '2.1.0' })
    expect(whatsNewAnchorFor({ seenVersion: seenFinal, currentVersion: '2.1.1', releases: changelog })).toBe('2.1.0')
  })

  it('2.0 -> 2.1.1: the rename page, then the 2.1 story and the 2.1.1 one; nothing from 2.0', () => {
    render({ anchor: '2.0.4' })
    expect(q('rename-page')).not.toBeNull()
    click(q('whatsnew-cta'))
    expect(q('whatsnew-heading')!.textContent).toBe("What's new since 2.0.4")
    const text = container.textContent!
    expect(text).toContain('Agent Canvas.')
    expect(text).toContain('New name.')
    expect(text).toContain('Codex, no longer Beta.')
    expect(text).not.toContain('Guided setup.')
    // One "Codex accounts." line: the fresh-install one stays out.
    expect(text.split('Codex accounts.').length - 1).toBe(1)
  })

  it('a fixes-only update gets ONE line from the changelog, never an older set, and no pages', () => {
    // 2.1.1 -> 2.1.2, on the curated lines the 2.1.2 build shipped: the
    // sources now also hold later releases' lines (2.1.3 on), which a 2.1.2
    // build never carried, so they are left out of its history here.
    const upTo212 = ALL_SECTIONS
      .map((s: any) => ({ ...s, items: s.items.filter((it: any) => compareVersions(String(finalRelease(it.since)), '2.1.2') <= 0) }))
      .filter((s: any) => s.items.length > 0)
    const view = { anchor: '2.1.1', fresh: false, withClaude: true, withCodex: false }
    const out = (W as any).summaryContent(view, changelog, '2.1.2', upTo212)
    expect(out.fixesOnly).toBe(true)
    expect(out.showcases).toEqual([])
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0].items.map((it: any) => it.title)).toEqual(['Fixes and polish.'])
  })

  it('fixesAndPolish counts the changelog entries since the anchor; fixesEntries falls back to the running build\'s own', () => {
    const entries: any[] = [
      { version: '2.1.2', date: 'x', changes: [{ type: 'fix', description: 'a' }, { type: 'fix', description: 'b' }, { type: 'improvement', description: 'c' }] },
      { version: '2.1.2-beta.1', date: 'x', changes: [{ type: 'fix', description: 'd' }] },
      { version: '2.1.1', date: 'x', changes: [{ type: 'feature', description: 'old' }] },
    ]
    const since = (W as any).fixesEntries(entries, '2.1.1', '2.1.2')
    expect(since.map((e: any) => e.version)).toEqual(['2.1.2', '2.1.2-beta.1'])
    expect((W as any).fixesAndPolish(since, '2.1.2').items[0].desc).toBe('3 fixes and 1 improvement in this update.')
    // A downgrade (nothing since): the running build's own entry.
    expect((W as any).fixesEntries(entries, '2.1.2', '2.1.1').map((e: any) => e.version)).toEqual(['2.1.1'])
    expect((W as any).fixesAndPolish([], '2.1.1').items[0].desc).toBe('Small fixes in this update.')
    expect((W as any).fixesAndPolish([entries[1]], '2.1.2').items[0].desc).toBe('1 fix in this update.')
    // A feature is counted as one, not passed off as an improvement.
    expect((W as any).fixesAndPolish(entries, '2.1.2').items[0].desc).toBe('3 fixes, 1 improvement and 1 new feature in this update.')
    expect((W as any).fixesAndPolish([entries[2]], '2.1.2').items[0].desc).toBe('1 new feature in this update.')
  })

  it('the sub-line is singular for one line, and counts pages honestly', () => {
    const sub = (W as any).whatsNewSubLine
    expect(sub(1, 0, false)).toBe('1 thing worth knowing, in one line.')
    expect(sub(13, 5, false)).toBe('13 things worth knowing, in one line each, and 5 of them have a page of their own, just behind this one.')
    expect(sub(2, 1, false)).toBe('2 things worth knowing, in one line each, and 1 of them has a page of its own, just behind this one.')
    expect(sub(1, 0, true)).toBe('This update is fixes and polish.')
  })

  it('the heading never claims a "since" it cannot: a downgrade or an unreadable stamp reads plain', () => {
    const h = (W as any).whatsNewHeading
    expect(h('2.1.0', CURRENT)).toBe("What's new since 2.1.0")
    expect(h('2.1.2', '2.1.1')).toBe("What's new")
    expect(h('garbage', CURRENT)).toBe("What's new")
    expect(h(undefined, CURRENT)).toBe("What's new")
  })

  it('section headings stay unique after the provider headings apply (React key and data-ux-id)', () => {
    const anchors = [undefined, '1.5.45', FROM_20, POST_RENAME, FROM_210, '2.1.1']
    for (const anchor of anchors) {
      for (const fresh of anchor === undefined ? [true] : [false]) {
        for (const [withClaude, withCodex] of [[true, false], [true, true], [false, true]]) {
          const sections = (W as any).summarySections({ anchor, fresh, withClaude, withCodex })
          const ids = sections.map((s: any) => (W as any).sectionUxId(s.heading))
          expect(new Set(ids).size, `${anchor} claude=${withClaude} codex=${withCodex}: ${ids.join(', ')}`).toBe(ids.length)
          // Each line's title is its React key inside a section, and merged
          // sections concatenate lines from two sets ("Codex accounts." is in
          // both, split today only by freshOnly / upgradeOnly).
          for (const s of sections) {
            const titles = s.items.map((it: any) => it.title)
            expect(new Set(titles).size, `${anchor} fresh=${fresh} claude=${withClaude} codex=${withCodex} ${s.heading}: ${titles.join(', ')}`).toBe(titles.length)
          }
        }
      }
    }
    // The 2.0 user sees "Accounts & usage" from both 2.1 and 2.1.1, as ONE section.
    render({ anchor: FROM_20 })
    click(q('whatsnew-dot-summary'))
    expect(container.querySelectorAll('[data-ux-id="section-accounts-usage"]').length).toBe(1)
    expect(q('section-accounts-usage')!.textContent).toContain('Switch mid-session.')
    expect(q('section-accounts-usage')!.textContent).toContain('Usage for Codex.')
  })
})

// ── the fixes-only page is decided after the filters ──────────────────
describe('O2: the fixes-only page is decided AFTER the cohort, provider and Codex-answer filters', () => {
  // A curated history of the test's own (summaryContent's `sets`), so no case
  // hangs on which real line carries which flag. Each history has an old line
  // (not new since the anchor) and exactly ONE line newer than it, which the
  // view's filter then hides: the delta is not empty before the filters, and
  // is empty after them. Judged before the filters, the page would show no
  // line at all, under a "0 things worth knowing" sub-line, with pages.
  const ANCHOR = FROM_210
  const ENTRIES: any[] = [
    { version: CURRENT, date: 'x', changes: [{ type: 'fix', description: 'a' }, { type: 'fix', description: 'b' }] },
    { version: '2.1.0', date: 'x', changes: [{ type: 'feature', description: 'told already' }] },
  ]
  const historyWith = (flags: object): any[] => [
    { heading: 'Earlier', items: [{ since: '2.0.0', title: 'Old line.', desc: 'Told on 2.0.' }] },
    { heading: 'Later', items: [{ since: CURRENT, title: 'The only new line.', desc: 'New since the anchor.', ...flags }] },
  ]
  const content = (view: object, sets: any[]) =>
    (W as any).summaryContent({ anchor: ANCHOR, fresh: false, withClaude: true, withCodex: true, ...view }, ENTRIES, CURRENT, sets)
  const titles = (c: any): string[] => c.sections.flatMap((s: any) => s.items.map((i: any) => i.title))

  /** The unfiltered delta is the one line, and this view has pages to drop:
   *  without both, the fixes-only assertions below would hold vacuously. */
  function expectNonEmptyBeforeFilters(sets: any[], withClaude: boolean) {
    expect(sectionsFor(ANCHOR, sets).flatMap((s) => s.items.map((i) => i.title))).toEqual(['The only new line.'])
    expect(visiblePages(ANCHOR, { withClaude }).length, 'no real page is new since the anchor').toBeGreaterThan(0)
  }

  function expectFixesOnly(c: any) {
    expect(c.fixesOnly).toBe(true)
    expect(titles(c)).toEqual(['Fixes and polish.'])
    expect(c.sections[0].items[0].desc).toBe('2 fixes in this update.')
    expect(c.showcases).toEqual([])
  }

  it('(a) the only new line needs Claude Code, viewed with Claude Code off: one "Fixes and polish." line, no pages', () => {
    const sets = historyWith({ needsClaude: true })
    expectNonEmptyBeforeFilters(sets, false)
    expectFixesOnly(content({ withClaude: false }, sets))
    // Control: with Claude Code on, the same line IS the page.
    const on = content({ withClaude: true }, sets)
    expect(on.fixesOnly).toBe(false)
    expect(titles(on)).toEqual(['The only new line.'])
    expect(on.showcases.length).toBeGreaterThan(0)
  })

  it('(b) the only new line waits on the Codex question, which is answered: one "Fixes and polish." line, no pages', () => {
    const sets = historyWith({ upgradeOnly: true, untilCodexAnswered: true })
    expectNonEmptyBeforeFilters(sets, true)
    expectFixesOnly(content({ codexAnswered: true }, sets))
    // Control: still to answer (or no answer recorded), the line shows.
    for (const view of [{ codexAnswered: false }, {}]) {
      const due = content(view, sets)
      expect(due.fixesOnly, JSON.stringify(view)).toBe(false)
      expect(titles(due)).toEqual(['The only new line.'])
    }
  })

  it('(c) the only new line is for fresh installs, viewed by an upgrader: fixes only; a fresh install never is', () => {
    const sets = historyWith({ freshOnly: true })
    expectNonEmptyBeforeFilters(sets, true)
    expectFixesOnly(content({}, sets))
    // The fresh cohort is never fixes-only: nothing is "new" to it, every line for it shows.
    const fresh = (W as any).summaryContent({ fresh: true, withClaude: true, withCodex: true }, ENTRIES, CURRENT, sets)
    expect(fresh.fixesOnly).toBe(false)
    expect(titles(fresh)).toEqual(['Old line.', 'The only new line.'])
  })
})

// ── the tags themselves ───────────────────────────────────────────────
describe('since tags: pinned, parseable, and curated for the newest release', () => {
  // FROZEN. Adding a line or page, or retagging one, fails this until the
  // table is updated, which is where the rule is read again: tag with the
  // first build that shipped it, prerelease included (O2's table). A copied
  // neighbour's tag is the silent failure this exists to stop.
  const LINE_TAGS: Record<string, string> = {
    'Setup & privacy / Guided setup.': '2.0.0',
    'Setup & privacy / A privacy pass.': '2.0.0',
    'Tools / Built-in Tools, your call.': '2.0.0',
    'Tools / Codex support.': '2.0.0',
    'Help / A guide that answers back.': '2.0.0',
    'Under the hood / A modern engine.': '2.0.0',
    'Sessions / SSH Persistent.': '2.1.0-rc.12',
    'Sessions / Partner terminal.': '2.1.0-beta.16',
    'Sessions / One row.': '2.1.0-rc.1',
    'Sessions / Two-mode panel.': '2.1.0-rc.3',
    'Sessions / Multi Spawn.': '2.1.0-rc.12',
    'Sessions / Remote Resumable.': '2.1.0-rc.12',
    'Sessions / Marks you can read.': '2.1.0-rc.12',
    'Sessions / Always a new conversation.': '2.1.3',
    'Working with Claude / Agent Canvas.': '2.1.0-beta.16',
    'Working with Claude / Session Watchdog.': '2.1.0-rc.1',
    'Working with Claude / Ask Conductor.': '2.1.0-beta.16',
    'Accounts & usage / Codex accounts.': '2.1.1-beta.2',
    'Accounts & usage / Switch mid-session.': '2.1.0-beta.16',
    'Accounts & usage / claude.ai in the app.': '2.1.0-beta.16',
    'Accounts & usage / Insights.': '2.1.0-beta.16',
    'The app itself / New name.': '2.1.0-beta.6',
    'The app itself / Signed and notarised.': '2.1.0-beta.16',
    'Codex, a full assistant / Codex, no longer Beta.': '2.1.1-beta.2',
    'Codex, a full assistant / Codex accounts.': '2.1.1-beta.2',
    'Codex, a full assistant / Sessions that carry on.': '2.1.1-beta.2',
    'Codex, a full assistant / Claude reviews Codex too.': '2.1.1-beta.2',
    'Codex, a full assistant / The tools you know.': '2.1.1-beta.2',
    'Accounts & usage / Usage for Codex.': '2.1.1-beta.2',
    'Accounts & usage / Tokenomics by account.': '2.1.1-beta.2',
    'Accounts & usage / chatgpt.com in the app.': '2.1.1-beta.2',
    'Across the app / Ask Conductor on Codex.': '2.1.1-beta.2',
    'Across the app / Three more for Codex.': '2.1.1-beta.2',
    'Across the app / Claude 5.5 models.': '2.1.1-beta.2',
    'Across the app / Remote scrolling.': '2.1.1-beta.1',
    'Before you start / Codex asks once.': '2.1.1-beta.2',
  }
  const PAGE_TAGS: Record<string, string> = {
    canvas: '2.1.0-rc.1', oneRow: '2.1.0-rc.1', panel: '2.1.0-rc.3', multiSpawn: '2.1.0-rc.12',
    remoteResume: '2.1.0-rc.12', sidebarMarks: '2.1.0-rc.12', accounts: '2.1.0-rc.3', watchdog: '2.1.0-rc.1',
    askConductor: '2.1.0-rc.14',
    codexAssistant: '2.1.1-beta.2', codexAccounts: '2.1.1-beta.2', codexSessions: '2.1.1-beta.2', codeReview: '2.1.1-beta.2', usageBoth: '2.1.1-beta.2',
  }

  it('every line and page carries the tag in the frozen table', () => {
    const lines: Record<string, string> = {}
    for (const s of ALL_SECTIONS) for (const it of s.items) {
      const key = `${s.heading} / ${it.title}`
      expect(key in lines, `duplicate key ${key}`).toBe(false)
      lines[key] = it.since
    }
    expect(lines).toEqual(LINE_TAGS)
    expect(Object.fromEntries(SHOWCASES.map((p) => [p.id, (p as any).since]))).toEqual(PAGE_TAGS)
  })

  it('every tag parses as a version (an unreadable tag would rank oldest and never show)', () => {
    for (const t of [...Object.values(LINE_TAGS), ...Object.values(PAGE_TAGS)]) expect(finalRelease(t), t).not.toBeNull()
  })

  // A release that is fixes only is named here, frozen like the tags above:
  // its page shows the fixes line (the fixes-only cases above) and no
  // curated set, on purpose rather than by accident.
  const FIXES_ONLY_RELEASES: readonly string[] = ['2.1.2']

  it('DRIFT GUARD: the newest changelog release has curated lines for upgraders, or is a fixes-only release named here', () => {
    // A release cannot ship with the page falling back to the fixes line by
    // accident, the way the "Changelog in sync" check guards the changelog.
    // Writing the next release's changelog entry fails this until its lines
    // (tagged with its first build) are added here, or, for a release whose
    // every change is a fix, until it is named in FIXES_ONLY_RELEASES.
    const release = finalRelease(changelog[0].version)
    const curated = ALL_SECTIONS.flatMap((s) => s.items).filter((it: any) => !it.freshOnly && finalRelease(it.since) === release)
    if (FIXES_ONLY_RELEASES.includes(String(release))) {
      expect(curated, `${release} is named fixes only, so it has no curated lines`).toEqual([])
      const changes = changelog.filter((e) => finalRelease(e.version) === release).flatMap((e) => e.changes)
      expect(changes.length, `${release} has no changelog lines`).toBeGreaterThan(0)
      expect(changes.filter((c) => c.type !== 'fix'), `${release} is named fixes only`).toEqual([])
      return
    }
    expect(curated.length, `no What's New lines for ${release}`).toBeGreaterThan(0)
  })
})

// ── O3: the 2.1.1 content ─────────────────────────────────────────────
describe('O3: the 2.1.1 lines and pages', () => {
  const set211Lines = () => ALL_SECTIONS.flatMap((s) => s.items).filter((it: any) => finalRelease(it.since) === '2.1.1' && !it.freshOnly)
  const pageCopy = (p: Page) => [p.heading, p.tagline, p.where.pre + p.where.em + p.where.post, ...p.points.flatMap((pt) => [pt.lead, pt.rest])]

  it('the copy is plain ASCII, no em dash, and no line or page offers the computer\'s own Codex sign-in', () => {
    const copy = [...set211Lines().flatMap((it: any) => [it.title, it.desc]), ...SHOWCASES_211.flatMap(pageCopy)]
    expect(copy.length).toBeGreaterThan(20)
    for (const line of copy) {
      expect(line.includes(EM_DASH), line).toBe(false)
      expect(/^[\x20-\x7e]*$/.test(line), `non-ASCII: ${line}`).toBe(true)
      expect(line, line).not.toMatch(/~\/\.codex|existing sign-in|this computer's (own )?(codex|sign-in)|sign-in (already )?on this computer|use this sign-in/i)
    }
  })

  it('it is told against 2.1.0: no heading or lead presents 2.0-era Codex as new', () => {
    // O3 verdict: Codex beside Claude, the Claude-to-Codex review and the
    // resume picker all shipped before 2.1.1; leading with them is the
    // complaint itself.
    const leads = [...set211Lines().map((it: any) => it.title), ...SHOWCASES_211.flatMap((p) => [p.heading, ...p.points.map((pt) => pt.lead)])]
    for (const l of leads) expect(l, l).not.toMatch(/beside claude|codex support|multi spawn|from a claude session|resume where/i)
  })

  it('the 2.1.1 lines and pages are for upgraders only; a fresh install keeps the 2.1 story', () => {
    for (const it of set211Lines()) expect((it as any).upgradeOnly, it.title).toBe(true)
    for (const p of SHOWCASES_211) expect((p as any).upgradeOnly, p.id).toBe(true)
    render({ fresh: true })
    click(q('whatsnew-cta')) // rename -> summary
    const text = container.textContent!
    expect(text).toContain('Codex accounts.') // the fresh-install line
    expect(text).not.toContain('Codex, no longer Beta.')
    expect(text).not.toContain('Codex asks once.')
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 2 of ${2 + SHOWCASES_21.length}`)
  })

  it('every art kind renders a drawn vignette, Claude Code on or off', () => {
    for (const claudeOn of [true, false]) {
      for (const p of SHOWCASES) {
        act(() => { root.render(<ShowcaseVignette kind={p.art} claudeOn={claudeOn} />) })
        expect(container.querySelector(`[data-ux-id="showcase-art-${p.art}"]`), `no vignette for "${p.art}"`).toBeTruthy()
      }
    }
    // The Codex drawing follows Claude Code: a Codex-only user sees no Claude tab.
    act(() => { root.render(<ShowcaseVignette kind="codexHello" claudeOn={false} />) })
    expect(container.textContent).toContain('docs (Codex)')
    act(() => { root.render(<ShowcaseVignette kind="codexHello" claudeOn />) })
    expect(container.textContent).not.toContain('docs (Codex)')
    // The accounts drawing has no row for the computer's own sign-in.
    act(() => { root.render(<ShowcaseVignette kind="codexAccounts" />) })
    expect(container.textContent).not.toMatch(/~\/\.codex|This computer|Existing sign-in|Confirm each launch/)
  })

  it('P3.4: the usage drawing shows nothing of Claude Code with Claude Code off', () => {
    // The usage page has no needsClaude flag, so it shows to a Codex-only
    // user; its drawing must follow claudeOn as the Codex drawing does.
    act(() => { root.render(<ShowcaseVignette kind="usage" claudeOn={false} />) })
    expect(q('showcase-art-usage')).toBeTruthy()
    expect(container.textContent).toContain('Codex')
    expect(container.textContent).not.toMatch(/Claude/)
    act(() => { root.render(<ShowcaseVignette kind="usage" claudeOn />) })
    expect(container.textContent).toContain('Claude Code')
    // And through the page itself: a Codex-only user on the usage page.
    settingsState.settings = { updateChannel: 'stable', claudeEnabled: false, codexEnabled: true }
    render()
    const ix = visiblePages(FROM_210, { withClaude: false }).findIndex((p) => p.id === 'usageBoth')
    expect(ix).toBeGreaterThanOrEqual(0)
    click(q('whatsnew-dot-usageBoth'))
    expect(q('showcase-art-usage')).toBeTruthy()
    expect(q('showcase-art')!.textContent).not.toMatch(/Claude/)
  })

  it('A13 (O3 verdict): "Codex asks once." tells an upgrader to add a Codex account', () => {
    // Worded so it never reads as a pointer to the retired tab: the source
    // sweep in settings-codex-tab-retired.test.tsx fails on "Codex tab".
    const line = ALL_SECTIONS.flatMap((s) => s.items).find((it: any) => it.title === 'Codex asks once.')
    expect(line.desc).toBe('Codex no longer has its own Settings tab or single sign-in: answer once, then add a Codex account.')
  })

  it('A13: "Codex asks once." shows only while the Codex question is still to come', () => {
    // Every 2.1.1 prerelease anchors at 2.1.0 (owner rule), so a tester who
    // answered the Codex question on beta.2 gets the 2.1.1 story again on
    // beta.3, and the question does not follow (decideCodexReconfirm:
    // 'answered'). The line must not promise it.
    const anchor = whatsNewAnchorFor({ seenVersion: '2.1.1-beta.2', currentVersion: CURRENT, releases: changelog })
    const titles = (codexAnswered: boolean) =>
      (W as any).summarySections({ anchor, fresh: false, withClaude: true, withCodex: true, codexAnswered })
        .flatMap((s: any) => s.items.map((i: any) => i.title))
    expect(titles(false)).toContain('Codex asks once.')
    expect(titles(true)).not.toContain('Codex asks once.')
    expect(titles(true)).toContain('Codex, no longer Beta.')
    // Through the page, reading the answer from the settings store.
    settingsState.settings = { updateChannel: 'beta', codexAnswered: true }
    render({ anchor })
    expect(container.textContent).not.toContain('Codex asks once.')
    expect(q('section-before-you-start'), 'its section goes with its only line').toBeNull()
    expect(container.textContent).toContain('Codex, no longer Beta.')
    remount()
    settingsState.settings = { updateChannel: 'beta', codexAnswered: false }
    render({ anchor })
    expect(container.textContent).toContain('Codex asks once.')
    expect(q('section-before-you-start')).not.toBeNull()
  })

  it('the "New name." line no longer says nothing else changes, and has no em dash', () => {
    // It shows to the same pre-rename cohort as the rename bullet (O3 C12),
    // just before the one-time Codex question says the Codex setting does
    // not carry over.
    const line = ALL_SECTIONS.flatMap((s) => s.items).find((it: any) => it.title === 'New name.')
    expect(line.desc).not.toMatch(/nothing else changes/i)
    expect(line.desc.includes(EM_DASH)).toBe(false)
    expect(line.desc).toContain('AI Code Conductor')
  })
})

// ── #463: the showcase tours everything since 2.0, for both audiences ──
describe('#463 — since-2.0 coverage and the first-run cohort', () => {
  it('the flagship set covers the full 2.1-over-2.0 story, canvas first', () => {
    const ids = SHOWCASES_21.map((p) => p.id)
    for (const flagship of ['canvas', 'oneRow', 'panel', 'accounts', 'watchdog']) {
      expect(ids, `missing flagship page "${flagship}"`).toContain(flagship)
    }
    expect(ids[0]).toBe('canvas')
  })

  it('no heading or tagline a first-runner sees uses upgrade-only diff framing', () => {
    // "Three rows became one" reads as gibberish to someone who never saw
    // three rows. A tripwire, not a proof: it catches the phrasings that have
    // actually slipped in ("became", "grew", "used to", "no longer", "now X"
    // comparatives, "new to this line") — review still owns the judgment call.
    for (const p of SHOWCASES.filter((pg) => !(pg as any).upgradeOnly)) {
      const copy = `${p.heading} ${p.tagline}`.toLowerCase()
      for (const phrase of ['became', 'grew', 'used to', 'no longer', 'renamed', 'new to this line']) {
        expect(copy, `${p.id}: "${phrase}"`).not.toContain(phrase)
      }
    }
    // O3 C3: the canvas page says what it is, not that it is new.
    expect(SHOWCASES_21.find((p) => p.id === 'canvas')!.heading).toBe('The Agent Canvas')
  })

  it('the fresh cohort gets an introduction heading and the FULL story, not a diff', () => {
    render({ fresh: true })
    // #525: fresh installs open on the rename/roadmap page too, under a
    // "Welcome to" lead-in; the summary sits one Next behind it.
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('Welcome to')
    expect(q('rename-lead-line')!.textContent).not.toContain('is now')
    click(q('whatsnew-cta'))
    expect(q('whatsnew-heading')!.textContent).toContain("What you're getting")
    expect(q('whatsnew-heading')!.textContent).not.toContain("What's new")
    const text = container.textContent!
    // One item from the 2.0 set and one from the 2.1 set — both present,
    // because a first-runner missed everything.
    expect(text).toContain('Guided setup.')
    expect(text).toContain('Agent Canvas.')
    // ...but a line that only makes sense against a BEFORE stays out.
    expect(text).not.toContain('New name.')
  })

  it('[host] P4.11 (row 54): no line carries a Beta tag, the 2.0 Codex support line included', () => {
    const all = ALL_SECTIONS.flatMap((s2) => s2.items)
    expect(all.some((it2: any) => it2.title === 'Codex support.')).toBe(true)
    for (const it2 of all) expect('beta' in it2, it2.title).toBe(false)
  })

  it('a See-it line and its page share a cohort, so the fresh page count cannot desync', () => {
    // The sub-line says "N of them have a page of their own"; an upgrade-only
    // line linking a page the fresh cohort sees (or the reverse) would make
    // that true for one cohort and false for the other, silently.
    const pages = new Map(SHOWCASES.map((p) => [p.id, p]))
    for (const s2 of ALL_SECTIONS) {
      for (const it2 of s2.items) {
        if (!it2.seeIt) continue
        expect(!!it2.upgradeOnly, `${it2.title}: line and page cohorts differ`).toBe(!!(pages.get(it2.seeIt) as any)?.upgradeOnly)
      }
    }
  })

  it('the upgrader still sees the upgrade-only lines', () => {
    render({ anchor: FROM_20 })
    click(q('whatsnew-cta')) // rename -> summary
    expect(container.textContent).toContain('New name.')
  })

  it('an upgrader keeps the diff heading — fresh framing never leaks', () => {
    render()
    expect(q('whatsnew-heading')!.textContent).toBe("What's new since 2.1.0")
  })

  it('the Feature Guide does not claim its history is the notes shown after an update', () => {
    // FeatureGuidePage.tsx's What's New blurb said "the same notes you're
    // shown after an update"; the update page is a curated summary.
    const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/FeatureGuidePage.tsx'), 'utf8')
    const blurb = /eyebrow="What's New" title="Release history" blurb="([^"]*)"/.exec(src)?.[1] ?? ''
    expect(blurb).not.toBe('')
    expect(blurb).not.toMatch(/same notes/i)
    expect(blurb.includes(EM_DASH)).toBe(false)
  })
})

// ── #525: the rename/roadmap prelude ──────────────────────────────────
describe('#525 — the rename/roadmap page', () => {
  // A 2.0 stable user: knew the app as Claude Command Center.
  const fromCCC = () => render({ anchor: FROM_20 })
  const forCCC = () => visiblePages(FROM_20)

  it('a 2.0 upgrader opens on the rename page; Next reaches the summary without leaving the run', () => {
    fromCCC()
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('is now')
    expect(q('rename-heading')!.textContent).toContain('AI Code Conductor')
    expect(q('whatsnew-heading')).toBeNull()
    // Derived denominator: rename + summary + one page per page new since 2.0.
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${2 + forCCC().length}`)
    click(q('whatsnew-cta'))
    expect(nexts).toBe(0)
    expect(q('rename-page')).toBeNull()
    expect(q('whatsnew-heading')).not.toBeNull()
  })

  it('the roadmap band names every 2.2 agent, badges the cohorts, and confines 2.2 to itself', () => {
    fromCCC()
    for (const id of ['tile-claude', 'tile-codex', 'tile-copilot', 'tile-antigravity', 'tile-qwen', 'tile-opencode', 'tile-ollama']) {
      expect(q(id), id).not.toBeNull()
    }
    expect(q('tile-claude')!.textContent).toContain('NOW')
    // P4.11 (row 54): Codex is live like Claude Code, so its tile reads NOW.
    expect(q('tile-codex')!.textContent).toContain('NOW')
    expect(q('tile-codex')!.textContent).not.toContain('BETA')
    expect(q('tile-copilot')!.textContent).toContain('2.2')
    expect(q('roadmap-pill')!.textContent).toContain('2.2 IN DEVELOPMENT')
    // Owner call R5: this is a 2.1 install — the tagline speaks to today,
    // and "2.2" appears only inside the labelled roadmap band.
    expect(q('rename-tagline')!.textContent).not.toContain('2.2')
    // Owner calls R7/R8 (canvas v8): the approved one-liner, the deep strip
    // cut, and exactly one reassurance bullet for upgraders.
    expect(q('rename-tagline')!.textContent).toContain('Same application, exciting new roadmap (tentative preview below).')
    expect(q('rm-deep')).toBeNull()
    expect(q('rename-pt-why')).toBeNull()
    expect(q('rename-where')).toBeNull()
  })

  it('O3 C12: the carry-over bullet does not promise the Codex setting carries over', () => {
    // "Nothing changes ... accounts all carry over" was followed by the
    // one-time Codex question saying the earlier Codex setting does not.
    fromCCC()
    const pt = q('rename-pt-nothing')!.textContent!
    expect(pt).not.toContain('Nothing changes')
    expect(pt).not.toMatch(/accounts all carry over/)
    expect(pt).toContain('Same install, same path.')
    expect(pt).toContain('Claude accounts carry over')
    expect(pt).toContain('Codex asks you once')
    expect(pt.includes(EM_DASH)).toBe(false)
  })

  it('post-rename upgraders never see it; fresh installs DO, under a Welcome lead-in', () => {
    render() // 2.1.0: lived through the rename
    expect(q('rename-page')).toBeNull()
    expect(q('whatsnew-dot-rename')).toBeNull()
    remount()
    // Owner call R1: the roadmap is the introduction — fresh installs get
    // the page too, without the "is now" diff framing.
    render({ fresh: true })
    expect(q('rename-page')).not.toBeNull()
    expect(q('rename-lead-line')!.textContent).toContain('Welcome to')
    expect(q('rename-lead-line')!.textContent).not.toContain('is now')
    // Spec-review F1/F2: no "Same application" without a before, and no
    // carry-over bullet for someone with nothing to carry over.
    expect(q('rename-tagline')!.textContent).toBe('Exciting new roadmap (tentative preview below).')
    expect(q('rename-tagline')!.textContent).not.toContain('Same application')
    expect(q('rename-points')).toBeNull()
  })

  it('a See-it chip still lands on its page with the prelude in front', () => {
    fromCCC()
    click(q('whatsnew-cta')) // -> summary
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
    const ix = forCCC().findIndex((pg) => pg.id === 'watchdog')
    expect(q('showcase-eyebrow')!.textContent).toContain(`${ix + 1} of ${forCCC().length}`)
  })

  it('the dots gain a rename dot that jumps home, and the walk ends on the harness CTA', () => {
    fromCCC()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-page-oneRow')).not.toBeNull()
    click(q('whatsnew-dot-rename'))
    expect(q('rename-page')).not.toBeNull()
    const cta = () => q('whatsnew-cta')!
    for (let i = 0; i < 1 + forCCC().length; i++) click(cta()) // rename -> summary -> ... -> last page
    expect(cta().textContent).toBe('Continue')
    expect(nexts).toBe(0)
    click(cta())
    expect(nexts).toBe(1)
  })

  it('the 2.0 line never shows the page for either cohort', () => {
    ;(globalThis as any).__APP_VERSION__ = '2.0.5'
    render({ fresh: true })
    expect(q('rename-page')).toBeNull()
  })

  it('showRenamePageFor — the upgrader gate in one place, on the anchor', () => {
    expect(showRenamePageFor(undefined, '2.1.0')).toBe(false) // fresh installs are gated by `fresh`
    expect(showRenamePageFor('2.0.5', '2.1.0')).toBe(true)
    expect(showRenamePageFor('1.9.0', '2.1.0')).toBe(true)
    expect(showRenamePageFor('2.1.0-beta.5', '2.1.0')).toBe(true) // pre-rename beta tester
    expect(showRenamePageFor('2.1.0-beta.6', '2.1.0')).toBe(false) // the rename build itself
    expect(showRenamePageFor('2.1.0-beta.17', '2.1.0')).toBe(false)
    expect(showRenamePageFor('2.0.1', '2.0.5')).toBe(false) // a 2.0-line build predates the rename
    expect(showRenamePageFor('2.0.5', '2.2.0')).toBe(true) // straight 2.0 -> 2.2 is still owed the why
    // A 2.1.1 tester's anchor is 2.1.0 (whatsNewAnchorFor): no rename page.
    expect(showRenamePageFor('2.1.0', CURRENT)).toBe(false)
  })

  it('the beta-channel tester arm is gone: a prerelease build on the beta channel shows it only by the anchor', () => {
    // Owner call R2 (2026-08-27) showed it on EVERY prerelease for testers,
    // "until we hit stable"; 2.1 is stable, and it replayed on every beta.
    settingsState.settings = { updateChannel: 'beta' }
    render({ anchor: FROM_210 })
    expect(q('rename-page')).toBeNull()
    expect(q('whatsnew-heading')).not.toBeNull()
  })
})
