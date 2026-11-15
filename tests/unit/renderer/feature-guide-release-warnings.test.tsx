// @vitest-environment jsdom
//
// Release-note warnings in the Feature Guide's release history.
//
// The Feature Guide page is mounted for real and its What's New section is
// opened from the rail, with a release history of the test's own, so the test
// reads what a user of that page sees: every release's warnings, first in its
// release. Reading the page's source for the name of the renderer would pass
// even if the page dropped the warnings before it drew anything.
//
// The shared renderer itself is covered in whats-new-warnings.test.tsx.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const NEWEST_WARNING = 'Sessions restart once after this update.'
const SECOND_WARNING = 'To go back, install 9.9.8 again; your settings are kept.'
const OLDEST_WARNING = 'This release moved the settings file.'

const HISTORY = [
  {
    version: '9.9.9',
    date: '2026-01-03',
    highlights: 'A bigger release.',
    warnings: [NEWEST_WARNING, SECOND_WARNING],
    changes: [{ type: 'improvement' as const, description: 'A changed thing.' }],
  },
  {
    version: '9.9.8',
    date: '2026-01-02',
    highlights: 'A small release.',
    changes: [{ type: 'fix' as const, description: 'A fixed thing.' }],
  },
  {
    version: '9.9.7',
    date: '2026-01-01',
    highlights: 'An older release.',
    warnings: [OLDEST_WARNING],
    changes: [{ type: 'feature' as const, description: 'An added thing.' }],
  },
]

vi.mock('../../../src/renderer/changelog', () => ({ changelog: HISTORY }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
;(window as any).electronPlatform = 'win32'

const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { default: FeatureGuidePage } = await import('../../../src/renderer/components/FeatureGuidePage')
const { snapshot } = await import('./accounts-snapshot-harness')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

/** The Feature Guide with its What's New section open, as the rail opens it. */
async function openReleaseHistory(): Promise<HTMLElement> {
  await act(async () => { root.render(<FeatureGuidePage onNavigateToSessions={() => {}} onStartTour={() => {}} />) })
  const rail = container.querySelector('[data-ux-id="rail-whatsnew"]') as HTMLButtonElement
  expect(rail, "the rail has no What's New item").not.toBeNull()
  await act(async () => { rail.click() })
  const section = container.querySelector('[data-ux-id="whatsnew-section"]') as HTMLElement
  expect(section, "the What's New section did not open").not.toBeNull()
  return section
}

const warningBlocks = (section: HTMLElement) => Array.from(section.querySelectorAll('[data-ux-id^="whatsnew-warnings-"]'))

describe("the Feature Guide's release history", () => {
  it('shows the warnings of every release that has them, and of no other', async () => {
    const section = await openReleaseHistory()
    const blocks = warningBlocks(section)
    expect(blocks.map((b) => b.getAttribute('data-ux-id'))).toEqual(['whatsnew-warnings-9.9.9', 'whatsnew-warnings-9.9.7'])
    expect(Array.from(blocks[0].querySelectorAll('li')).map((li) => li.textContent)).toEqual([NEWEST_WARNING, SECOND_WARNING])
    expect(Array.from(blocks[1].querySelectorAll('li')).map((li) => li.textContent)).toEqual([OLDEST_WARNING])
    // The release between them has none, and is still listed.
    expect(section.textContent).toContain('A small release.')
  })

  it('puts them first in their release: under its version line, ahead of its highlights and changes', async () => {
    const text = (await openReleaseHistory()).textContent ?? ''
    const at = (s: string) => {
      expect(text, `"${s}" is not shown`).toContain(s)
      return text.indexOf(s)
    }
    expect(at('v9.9.9')).toBeLessThan(at(NEWEST_WARNING))
    expect(at(SECOND_WARNING)).toBeLessThan(at('A bigger release.'))
    expect(at(SECOND_WARNING)).toBeLessThan(at('A changed thing.'))
    expect(at('v9.9.7')).toBeLessThan(at(OLDEST_WARNING))
    expect(at(OLDEST_WARNING)).toBeLessThan(at('An older release.'))
  })

  it('no two elements of the section share an id', async () => {
    // Several releases carry warnings here, as a real history will.
    const section = await openReleaseHistory()
    const uxIds = Array.from(section.querySelectorAll('[data-ux-id]')).map((e) => e.getAttribute('data-ux-id'))
    expect(uxIds.filter((id, i) => uxIds.indexOf(id) !== i)).toEqual([])
    const ids = Array.from(section.querySelectorAll('[id]')).map((e) => e.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})
