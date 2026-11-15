// @vitest-environment jsdom
//
// Release-note warnings on the page a user meets after an update.
//
// The full-screen What's New summary ("What's new since ...") is curated: it
// shows a few lines, not the release notes. A release's warnings are the one
// thing from the notes it must not leave out, so the summary shows them first,
// ahead of its sections: those of the release now running, and those of every
// release the user passed over on the way to it, each under its version.
//
// "Passed over" is told from the version whose notes the user last saw (the
// harness hands it over as `seenVersion`), not from the What's New anchor: a
// tester's anchor is the last final release, and would bring an earlier beta's
// warnings back on every later beta.
//
// The history here is the test's own. The real changelog carries a warning
// only when a release adds one, so a test against it would pass either way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as fs from 'fs'
import * as path from 'path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RUNNING = '2.1.3-beta.9'
const EARLIER_BETA = '2.1.3-beta.8'
const QUIET_BETA = '2.1.3-beta.7'
const LAST_FINAL = '2.1.2'
const BEFORE_RENAME = '2.0.5'
;(globalThis as any).__APP_VERSION__ = RUNNING

const FIRST_WARNING = 'Sessions restart once after this update.'
const SECOND_WARNING = 'To go back, install the build before this one; your settings are kept.'
const EARLIER_WARNING = 'A warning that belonged to an earlier build.'

const HISTORY = [
  { version: RUNNING, date: '2026-11-20', warnings: [FIRST_WARNING, `  ${SECOND_WARNING}\n`, ' '], changes: [{ type: 'fix' as const, description: 'A fixed thing.' }] },
  { version: EARLIER_BETA, date: '2026-11-19', warnings: [EARLIER_WARNING], changes: [{ type: 'fix' as const, description: 'An earlier fix.' }] },
  { version: QUIET_BETA, date: '2026-11-18', changes: [{ type: 'fix' as const, description: 'A quiet fix.' }] },
  { version: LAST_FINAL, date: '2026-10-17', changes: [{ type: 'fix' as const, description: 'An old fix.' }] },
]

const RUNNING_GROUP = { version: RUNNING, warnings: [FIRST_WARNING, SECOND_WARNING] }
const EARLIER_GROUP = { version: EARLIER_BETA, warnings: [EARLIER_WARNING] }

vi.mock('../../../src/renderer/changelog', () => ({ changelog: HISTORY }))

const metaState: any = { meta: { lastSeenVersion: LAST_FINAL } }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const settingsState: any = { settings: { updateChannel: 'beta' } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { WhatsNewV2Step, summaryWarnings } = await import('../../../src/renderer/onboarding/WhatsNewV2Step')

let container: HTMLDivElement
let root: Root
let nexts: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  nexts = 0
  ;(globalThis as any).__APP_VERSION__ = RUNNING
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ;(globalThis as any).__APP_VERSION__ = RUNNING
})

const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)
const click = (el: Element | null) => act(() => { (el as HTMLElement).click() })
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const items = (el: Element) => Array.from(el.querySelectorAll('li')).map((li) => li.textContent)
/** The releases the block lists, in order: [version label, its warnings]. */
const shownGroups = () =>
  Array.from(container.querySelectorAll('[data-ux-id^="whatsnew-summary-warnings-"]')).map((g) => [g.querySelector('h4')?.textContent, items(g)])

function render(props: Partial<React.ComponentProps<typeof WhatsNewV2Step>> = {}) {
  const p = { anchor: props.fresh ? undefined : LAST_FINAL, ...props }
  metaState.meta = p.anchor ? { lastSeenVersion: p.anchor } : {}
  act(() => {
    root.render(<WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." {...p} />)
  })
}

describe('summaryWarnings: which warnings the summary page shows', () => {
  it('the running release, cleaned as everywhere else, for someone who ran the release before it', () => {
    expect(summaryWarnings(HISTORY, RUNNING, false, EARLIER_BETA)).toEqual([RUNNING_GROUP])
  })

  it('every release passed over on the way as well, newest first, each under its version', () => {
    // 2.1.2 straight to beta.9: beta.8 never ran here, so its warning was
    // never shown. beta.7 has none and makes no group.
    expect(summaryWarnings(HISTORY, RUNNING, false, LAST_FINAL)).toEqual([RUNNING_GROUP, EARLIER_GROUP])
    expect(summaryWarnings(HISTORY, RUNNING, false, QUIET_BETA)).toEqual([RUNNING_GROUP, EARLIER_GROUP])
  })

  it('never a release the user has already seen the notes of', () => {
    // A tester's What's New anchor is the last final release. Told from the
    // anchor, beta.8's warning would come back on beta.9 and on every beta
    // after it; told from what they last saw, it does not.
    const told = summaryWarnings(HISTORY, RUNNING, false, EARLIER_BETA).flatMap((g) => g.warnings)
    expect(told).not.toContain(EARLIER_WARNING)
  })

  it('a sentence a newer release repeats is shown once, under the newest release that carries it', () => {
    const repeated = [
      { ...HISTORY[0], warnings: ['Still true in this release.', FIRST_WARNING] },
      { ...HISTORY[1], warnings: ['  Still true in\nthis release. ', EARLIER_WARNING] },
      { ...HISTORY[2], warnings: ['Still true in this release.'] },
      HISTORY[3],
    ]
    expect(summaryWarnings(repeated, RUNNING, false, LAST_FINAL)).toEqual([
      { version: RUNNING, warnings: ['Still true in this release.', FIRST_WARNING] },
      { version: EARLIER_BETA, warnings: [EARLIER_WARNING] },
    ])
  })

  it('the running release only when the last version seen is not known', () => {
    expect(summaryWarnings(HISTORY, RUNNING, false, undefined)).toEqual([RUNNING_GROUP])
    expect(summaryWarnings(HISTORY, RUNNING, false)).toEqual([RUNNING_GROUP])
  })

  it('the running release only on the same build again, or after going back a build', () => {
    expect(summaryWarnings(HISTORY, RUNNING, false, RUNNING)).toEqual([RUNNING_GROUP])
    expect(summaryWarnings(HISTORY, EARLIER_BETA, false, RUNNING)).toEqual([EARLIER_GROUP])
  })

  it('none when no release in range has any, or the running build has no entry and nothing was passed over', () => {
    expect(summaryWarnings(HISTORY, QUIET_BETA, false, LAST_FINAL)).toEqual([])
    expect(summaryWarnings(HISTORY, '2.1.3-beta.10', false, RUNNING)).toEqual([])
    expect(summaryWarnings(HISTORY, '', false, LAST_FINAL)).toEqual([])
  })

  it('none for a fresh install: nothing changed for someone who had no version before', () => {
    expect(summaryWarnings(HISTORY, RUNNING, true, undefined)).toEqual([])
    expect(summaryWarnings(HISTORY, RUNNING, true, LAST_FINAL)).toEqual([])
  })
})

describe("the What's New summary page", () => {
  it('shows the running release warnings in a marked block, under its version', () => {
    render({ seenVersion: EARLIER_BETA })
    const block = q('whatsnew-warnings')
    expect(block, 'no warnings block on the summary').not.toBeNull()
    expect(block!.getAttribute('role')).toBe('note')
    expect(shownGroups()).toEqual([[`Version ${RUNNING}`, [FIRST_WARNING, SECOND_WARNING]]])
    expect(container.textContent).not.toContain(EARLIER_WARNING)
  })

  it('is named by its own visible heading, so a screen reader says "Warnings" once', () => {
    render({ seenVersion: EARLIER_BETA })
    const block = q('whatsnew-warnings')!
    expect(block.hasAttribute('aria-label')).toBe(false)
    const label = document.getElementById(block.getAttribute('aria-labelledby') ?? '')
    expect(label, 'aria-labelledby points at nothing').not.toBeNull()
    expect(block.contains(label)).toBe(true)
    expect(label!.textContent).toBe('Warnings')
  })

  it('shows the warnings of the releases passed over too, newest first, each under its version', () => {
    render({ seenVersion: LAST_FINAL })
    expect(shownGroups()).toEqual([
      [`Version ${RUNNING}`, [FIRST_WARNING, SECOND_WARNING]],
      [`Version ${EARLIER_BETA}`, [EARLIER_WARNING]],
    ])
    // One block holds them all.
    expect(container.querySelectorAll('[data-ux-id="whatsnew-warnings"]')).toHaveLength(1)
    expect(Array.from(q('whatsnew-warnings')!.querySelectorAll('li'))).toHaveLength(3)
  })

  it('shows the running release only when it is not told which version was last seen', () => {
    render()
    expect(shownGroups()).toEqual([[`Version ${RUNNING}`, [FIRST_WARNING, SECOND_WARNING]]])
  })

  it('puts the block first: under the heading, ahead of every section', () => {
    render({ seenVersion: LAST_FINAL })
    const block = q('whatsnew-warnings')!
    const sections = q('whatsnew-sections')!
    expect(sections.children.length).toBeGreaterThan(0)
    expect(before(q('whatsnew-heading')!, block)).toBe(true)
    expect(before(block, sections)).toBe(true)
    // It is a block of its own, not one more line inside a section.
    expect(sections.contains(block)).toBe(false)
  })

  it('shows no block when no release in range has warnings, and the page is otherwise there', () => {
    ;(globalThis as any).__APP_VERSION__ = QUIET_BETA
    render({ seenVersion: LAST_FINAL })
    expect(q('whatsnew-warnings')).toBeNull()
    expect(container.textContent).not.toContain('Warnings')
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(q('whatsnew-sections')!.children.length).toBeGreaterThan(0)
  })

  it('shows no block to a fresh install', () => {
    render({ fresh: true })
    // A fresh install opens on the page before the summary; go to the summary.
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(q('whatsnew-warnings')).toBeNull()
    expect(container.textContent).not.toContain(FIRST_WARNING)
  })
})

describe('the run cannot be left before the warnings were on screen', () => {
  // Someone coming from before the rename opens on the page ahead of the
  // summary, and that page has a Skip of its own.
  const fromBeforeRename = () => render({ anchor: BEFORE_RENAME, seenVersion: BEFORE_RENAME })
  const lastDot = () => {
    const dots = Array.from(q('whatsnew-dots')!.querySelectorAll('button'))
    return dots[dots.length - 1]
  }

  it('Skip on the page before the summary goes to the summary, and leaves from there', () => {
    fromBeforeRename()
    expect(q('rename-page'), 'the run opens on the page before the summary').not.toBeNull()
    expect(q('whatsnew-warnings')).toBeNull()
    click(q('whatsnew-skip'))
    expect(nexts, 'the run was left before the warnings were shown').toBe(0)
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(shownGroups().map((g) => g[0])).toEqual([`Version ${RUNNING}`, `Version ${EARLIER_BETA}`])
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })

  it('jumping past the summary and leaving from the last page comes back to it once', () => {
    fromBeforeRename()
    click(lastDot()) // the last page, never having opened the summary
    expect(q('whatsnew-heading')).toBeNull()
    expect(q('whatsnew-cta')!.textContent).toBe('Continue')
    click(q('whatsnew-cta'))
    expect(nexts, 'the run was left before the warnings were shown').toBe(0)
    expect(q('whatsnew-warnings')).not.toBeNull()
    // Shown now: leaving from the last page leaves.
    click(lastDot())
    click(q('whatsnew-cta'))
    expect(nexts).toBe(1)
  })

  it('with no warnings to show, Skip on the page before the summary leaves at once, as before', () => {
    ;(globalThis as any).__APP_VERSION__ = QUIET_BETA
    fromBeforeRename()
    expect(q('rename-page')).not.toBeNull()
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })

  it('a run that opens on the summary leaves on the first Skip', () => {
    render({ anchor: '2.1.0', seenVersion: '2.1.0' })
    expect(q('whatsnew-warnings'), 'the run opens on the summary, warnings showing').not.toBeNull()
    expect(q('whatsnew-skip'), 'this run has pages behind the summary').not.toBeNull()
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })
})

describe('the redirect to the warnings is announced by moving focus to them', () => {
  // The button that was pressed stays where it is, so without a move a screen
  // reader user hears nothing about the block that appeared above it, and
  // pressing the same button again leaves without meeting it.
  const fromBeforeRename = () => render({ anchor: BEFORE_RENAME, seenVersion: BEFORE_RENAME })
  const dots = () => Array.from(q('whatsnew-dots')!.querySelectorAll('button')) as HTMLElement[]
  const focusOn = (el: Element | null) => { act(() => { (el as HTMLElement).focus() }) }
  /** The heading that names the warnings block. */
  const warningsHeading = () => document.getElementById(q('whatsnew-warnings')!.getAttribute('aria-labelledby') ?? '')

  it('Skip on the page before the summary puts focus on the warnings heading', () => {
    fromBeforeRename()
    focusOn(q('whatsnew-skip'))
    expect(document.activeElement).toBe(q('whatsnew-skip'))
    click(q('whatsnew-skip'))
    expect(nexts, 'the run was left before the warnings were shown').toBe(0)
    const heading = warningsHeading()
    expect(heading, 'no warnings heading on the summary').not.toBeNull()
    expect(heading!.textContent).toBe('Warnings')
    // Reachable by script, never a stop of its own in the Tab order.
    expect(heading!.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement, 'focus stayed on the footer button').toBe(heading)
  })

  it('leaving from the last page after jumping past the summary does the same', () => {
    fromBeforeRename()
    focusOn(dots()[dots().length - 1])
    click(dots()[dots().length - 1])
    expect(q('whatsnew-warnings')).toBeNull()
    focusOn(q('whatsnew-cta'))
    click(q('whatsnew-cta'))
    expect(nexts, 'the run was left before the warnings were shown').toBe(0)
    expect(document.activeElement).toBe(warningsHeading())
    expect(document.activeElement).not.toBe(q('whatsnew-cta'))
  })

  it('a run that opens on the summary, warnings showing, leaves focus where it was', () => {
    render({ anchor: '2.1.0', seenVersion: '2.1.0' })
    expect(q('whatsnew-warnings')).not.toBeNull()
    focusOn(q('whatsnew-cta'))
    expect(document.activeElement).toBe(q('whatsnew-cta'))
    expect(document.activeElement).not.toBe(warningsHeading())
  })

  it('opening the summary by its dot, with no Skip redirect, moves no focus', () => {
    fromBeforeRename()
    focusOn(q('whatsnew-dot-summary'))
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-warnings')).not.toBeNull()
    expect(document.activeElement).toBe(q('whatsnew-dot-summary'))
    expect(document.activeElement).not.toBe(warningsHeading())
  })

  it('opening the summary with Next, with no Skip redirect, moves no focus', () => {
    fromBeforeRename()
    focusOn(q('whatsnew-cta'))
    click(q('whatsnew-cta'))
    expect(q('whatsnew-warnings')).not.toBeNull()
    expect(document.activeElement).toBe(q('whatsnew-cta'))
  })

  it('moves focus once: coming back to the summary later does not pull it to the heading again', () => {
    fromBeforeRename()
    click(q('whatsnew-skip'))
    expect(document.activeElement).toBe(warningsHeading())
    focusOn(dots()[dots().length - 1])
    click(dots()[dots().length - 1])
    expect(q('whatsnew-warnings')).toBeNull()
    focusOn(q('whatsnew-dot-summary'))
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-warnings')).not.toBeNull()
    expect(document.activeElement).toBe(q('whatsnew-dot-summary'))
  })

  it('with no warnings, Skip on the page before the summary moves no focus', () => {
    ;(globalThis as any).__APP_VERSION__ = QUIET_BETA
    fromBeforeRename()
    focusOn(q('whatsnew-skip'))
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
    expect(document.activeElement).toBe(q('whatsnew-skip'))
  })

  it('the focused heading draws no outline, so the page looks as it did', () => {
    // jsdom paints nothing; pin the declaration. A heading is not a control,
    // and a ring around it after a keyboard Skip would be a new look.
    const css = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/onboarding/onboarding.css'), 'utf-8')
    expect(/\.ob-root \.wn-warn-h:focus \{ outline: none; \}/.test(css), 'no outline-off rule for the warnings heading').toBe(true)
  })
})
