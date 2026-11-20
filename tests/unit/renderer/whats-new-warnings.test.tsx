// @vitest-environment jsdom
//
// Release-note warnings in What's New.
//
// A changelog entry may carry `warnings`: plain sentences a user should read
// before relying on that release. The shared renderer (WhatsNewEntries) shows
// them FIRST in the release, in a marked block, so both of its surfaces do:
// the What's New dialog and the Feature Guide's release history (the Feature
// Guide page itself is mounted in feature-guide-release-warnings.test.tsx).
//
// The entries here are the test's own. The real changelog carries a warning
// only when a release adds one, so a test against it would pass either way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BUILD_TIME__ = '2026-11-15T00:00:00.000Z'

const FIRST_WARNING = 'Sessions restart once after this update.'
const SECOND_WARNING = 'To go back, install 9.9.8 again; your settings are kept.'

const WARNED = {
  version: '9.9.9',
  date: '2026-01-03',
  highlights: 'A bigger release.',
  warnings: [FIRST_WARNING, SECOND_WARNING],
  changes: [{ type: 'improvement' as const, description: 'A changed thing.' }],
}
const PLAIN = {
  version: '9.9.8',
  date: '2026-01-02',
  highlights: 'A small release.',
  changes: [{ type: 'fix' as const, description: 'A fixed thing.' }],
}

// The dialog reads the real changelog; give it a history of the test's own.
vi.mock('../../../src/renderer/changelog', () => ({ changelog: [WARNED, PLAIN] }))

const metaState: any = { meta: { lastSeenVersion: '9.9.7' } }
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

const { WhatsNewEntries, formatChangelogDate } = await import('../../../src/renderer/components/WhatsNewEntries')
const { default: WhatsNewModal } = await import('../../../src/renderer/components/WhatsNewModal')
const { releaseWarnings } = await import('../../../src/renderer/onboarding/upgrade-flow')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// One block per release that has warnings, each with an id of its own.
const blocks = () => Array.from(container.querySelectorAll('[data-ux-id^="whatsnew-warnings-"]'))
const uxIds = () => blocks().map((b) => b.getAttribute('data-ux-id'))
/** The element a block names as its label (aria-labelledby). */
const labelOf = (block: Element) => document.getElementById(block.getAttribute('aria-labelledby') ?? '')

function renderEntries(entries: unknown[]) {
  act(() => {
    root.render(createElement(WhatsNewEntries, { entries: entries as any }))
  })
}

describe('releaseWarnings: the warnings of one release, ready to show', () => {
  it('is empty for a release that has none', () => {
    expect(releaseWarnings({})).toEqual([])
    expect(releaseWarnings({ warnings: [] })).toEqual([])
  })

  it('keeps the sentences in the order they were written', () => {
    expect(releaseWarnings(WARNED)).toEqual([FIRST_WARNING, SECOND_WARNING])
  })

  it('drops blank ones, and folds line breaks and runs of spaces as the generator does', () => {
    expect(releaseWarnings({ warnings: ['', '  The first\n  line.  ', '   ', 'The\tsecond.'] })).toEqual([
      'The first line.',
      'The second.',
    ])
  })
})

describe('WhatsNewEntries: a release with warnings', () => {
  it('shows them in one marked block, each as its own item', () => {
    renderEntries([WARNED])
    expect(blocks()).toHaveLength(1)
    const block = blocks()[0]
    // Marked for a reader and for a screen reader alike.
    expect(block.getAttribute('role')).toBe('note')
    expect(block.textContent).toContain('Warnings')
    expect(Array.from(block.querySelectorAll('li')).map((li) => li.textContent)).toEqual([FIRST_WARNING, SECOND_WARNING])
  })

  it('is named by its own visible label, so a screen reader says "Warnings" once', () => {
    renderEntries([WARNED])
    const block = blocks()[0]
    // The label the eye reads is the label the block is named by. A second
    // copy of the word in aria-label would be read out again.
    expect(block.hasAttribute('aria-label')).toBe(false)
    const label = labelOf(block)
    expect(label, 'aria-labelledby points at nothing').not.toBeNull()
    expect(block.contains(label)).toBe(true)
    expect(label!.textContent).toBe('Warnings')
  })

  it('gives the block of each release an id of its own', () => {
    // The release history lists every release, and more than one can carry
    // warnings: one id on all of them would make each a duplicate.
    renderEntries([WARNED, { ...PLAIN, warnings: ['An older warning.'] }])
    expect(uxIds()).toEqual(['whatsnew-warnings-9.9.9', 'whatsnew-warnings-9.9.8'])
    const labelIds = blocks().map((b) => b.getAttribute('aria-labelledby'))
    expect(new Set(labelIds).size).toBe(2)
    expect(labelOf(blocks()[1])!.textContent).toBe('Warnings')
    expect(blocks()[1].contains(labelOf(blocks()[1]))).toBe(true)
  })

  it('puts the block first in the release: after its version line, ahead of the highlights and the changes', () => {
    renderEntries([WARNED])
    const text = container.textContent ?? ''
    const at = (s: string) => {
      expect(text, `"${s}" is not shown`).toContain(s)
      return text.indexOf(s)
    }
    expect(at('v9.9.9')).toBeLessThan(at(FIRST_WARNING))
    expect(at(SECOND_WARNING)).toBeLessThan(at('A bigger release.'))
    expect(at(SECOND_WARNING)).toBeLessThan(at('A changed thing.'))
  })

  it('marks only the release that carries them', () => {
    renderEntries([WARNED, PLAIN])
    expect(blocks()).toHaveLength(1)
    // The block sits inside the 9.9.9 section, not the 9.9.8 one.
    expect(blocks()[0].parentElement?.textContent).toContain('v9.9.9')
    expect(blocks()[0].parentElement?.textContent).not.toContain('v9.9.8')
  })
})

describe('WhatsNewEntries: a release without warnings', () => {
  it.each([
    ['no warnings field', PLAIN],
    ['an empty list', { ...PLAIN, warnings: [] }],
    ['only blank strings', { ...PLAIN, warnings: ['', '   '] }],
  ])('%s: no block, and the release reads as before', (_name, entry) => {
    renderEntries([entry])
    expect(blocks()).toHaveLength(0)
    expect(container.textContent).not.toContain('Warnings')
    expect(container.textContent).toContain('A small release.')
    expect(container.textContent).toContain('A fixed thing.')
  })
})

describe("the What's New dialog", () => {
  it("shows a release's warnings first", () => {
    act(() => {
      root.render(createElement(WhatsNewModal, { onClose: () => {}, showAllVersions: true }))
    })
    expect(blocks()).toHaveLength(1)
    const text = container.textContent ?? ''
    expect(text.indexOf(FIRST_WARNING)).toBeGreaterThan(text.indexOf('v9.9.9'))
    expect(text.indexOf(SECOND_WARNING)).toBeLessThan(text.indexOf('A bigger release.'))
    // The older release, which has none, is still listed below it.
    expect(text.indexOf('A small release.')).toBeGreaterThan(text.indexOf('A bigger release.'))
  })
})

// aicc_planning#366: a changelog date names a calendar day. Read as an
// instant (new Date('2026-11-20') is midnight UTC), it showed the day before
// on a computer west of UTC: the 2.1.3-beta.10 pre-publish VM, on Pacific
// time, showed beta.10 (2026-11-20) as 19 Nov 2026.
describe("What's New dates: the day the changelog names, in every time zone", () => {
  let tz: string | undefined
  beforeEach(() => { tz = process.env.TZ })
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it('west of UTC (Pacific time): 2026-11-20 reads 20 Nov 2026', () => {
    process.env.TZ = 'America/Los_Angeles'
    // The zone is in effect: read as an instant, that string is the 19th here.
    expect(new Date('2026-11-20').getDate(), 'the test zone did not take effect').toBe(19)
    expect(formatChangelogDate('2026-11-20')).toBe('20 Nov 2026')
    expect(formatChangelogDate('2026-01-01')).toBe('1 Jan 2026')
  })

  it("west of UTC: the release line What's New and the Feature Guide show reads 20 Nov 2026", () => {
    process.env.TZ = 'America/Los_Angeles'
    renderEntries([{ ...PLAIN, date: '2026-11-20' }])
    expect(container.textContent).toContain('20 Nov 2026')
    expect(container.textContent).not.toContain('19 Nov 2026')
  })

  it('east of UTC the same day; a string of another shape is shown as it is', () => {
    process.env.TZ = 'Pacific/Kiritimati'
    expect(new Date('2026-11-20').getHours(), 'the test zone did not take effect').toBe(14)
    expect(formatChangelogDate('2026-11-20')).toBe('20 Nov 2026')
    expect(formatChangelogDate('soon')).toBe('soon')
  })
})
