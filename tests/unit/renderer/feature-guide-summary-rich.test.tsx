// @vitest-environment jsdom
//
// A card's summary in the Feature Guide and the Feature tour shows its bold
// and code marks as formatting, as its highlights do (the beta.17 release
// smoke: the Machines card's first paragraph read "One card for **This
// computer** and its **session helper**, ..." with the marks as text, on
// beta.16 too). Three summaries hold marks today: Session Configuration and
// Machines (bold) and Dynamic Workflows (code). The page and the tour are
// mounted for real, so the test reads what a user sees.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
;(window as any).electronPlatform = 'win32'

const { trainingSteps } = await import('../../../src/renderer/training-steps')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')
const { default: FeatureGuidePage } = await import('../../../src/renderer/components/FeatureGuidePage')
const { default: TrainingWalkthrough } = await import('../../../src/renderer/components/TrainingWalkthrough')
const { snapshot } = await import('./accounts-snapshot-harness')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('both') }, isLoaded: true })
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const summaryOf = (id: string): string => trainingSteps.find((s) => s.id === id)!.summary!
/** A summary as it reads with its marks taken as formatting. */
const shownAs = (summary: string): string => summary.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1')

async function openGuideAt(section: string): Promise<void> {
  await act(async () => { root.render(<FeatureGuidePage onNavigateToSessions={() => {}} onStartTour={() => {}} />) })
  const rail = container.querySelector(`[data-ux-id="rail-${section}"]`) as HTMLButtonElement
  expect(rail, `the rail has no ${section} item`).not.toBeNull()
  await act(async () => { rail.click() })
}

describe("a Feature Guide card's summary", () => {
  it('Machines: the bold names are bold, and no mark shows as text', async () => {
    expect(summaryOf('machines')).toContain('**This computer**')
    await openGuideAt('admin')
    const p = container.querySelector('[data-ux-id="card-machines-summary"]') as HTMLElement
    expect(p, 'the Machines card shows no summary').not.toBeNull()
    expect(p.textContent).toBe(shownAs(summaryOf('machines')))
    expect(p.textContent).not.toContain('**')
    expect(Array.from(p.querySelectorAll('strong')).map((s) => s.textContent)).toEqual([
      'This computer', 'session helper', 'Plain terminals through the session helper', 'Claude Code and Codex sessions through the session helper',
    ])
  })

  it('Dynamic Workflows: a command in backticks is shown as code', async () => {
    await openGuideAt('productivity')
    const p = container.querySelector('[data-ux-id="card-dynamic-workflows-summary"]') as HTMLElement
    expect(p).not.toBeNull()
    expect(p.textContent).toBe(shownAs(summaryOf('dynamic-workflows')))
    expect(Array.from(p.querySelectorAll('code')).map((c) => c.textContent)).toContain('/effort ultracode')
  })

  it('every card the guide shows has no mark left as text in its summary', async () => {
    for (const section of ['getting-started', 'productivity', 'integrations', 'admin', 'tips']) {
      await openGuideAt(section)
      for (const p of Array.from(container.querySelectorAll('[data-ux-id$="-summary"]'))) {
        expect(p.textContent, `${section}: ${p.getAttribute('data-ux-id')}`).not.toMatch(/\*\*|`/)
      }
    }
  })
})

describe("the Feature tour's summary", () => {
  it('its first card (Session Configuration) shows its bold names as bold', async () => {
    expect(summaryOf('session-options')).toContain('**SSH Persistent**')
    await act(async () => { root.render(<TrainingWalkthrough onClose={() => {}} showAll mode="help" />) })
    const p = document.body.querySelector('[data-ux-id="tour-summary"]') as HTMLElement
    expect(p, 'the tour shows no summary').not.toBeNull()
    expect(p.textContent).toBe(shownAs(summaryOf('session-options')))
    expect(p.textContent).not.toContain('**')
  })

  // The beta.17 final-head re-check: the tour's renderBullet took only bold,
  // so this card read "Run `workflow` in your prompt, ..." with its marks.
  it('Dynamic Workflows: a command in backticks is shown as code, with no mark left as text', async () => {
    expect(summaryOf('dynamic-workflows')).toContain('`/effort ultracode`')
    const p = await openTourAt('dynamic-workflows')
    expect(p.textContent).not.toContain('`')
    expect(Array.from(p.querySelectorAll('code')).map((c) => c.textContent)).toContain('/effort ultracode')
  }, 20_000)
})

/** The tour, mounted (showAll, help mode) and walked to card `id`: its summary. */
async function openTourAt(id: string): Promise<HTMLElement> {
  await act(async () => { root.render(<TrainingWalkthrough onClose={() => {}} showAll mode="help" />) })
  const want = shownAs(summaryOf(id))
  const summary = () => document.body.querySelector('[data-ux-id="tour-summary"]') as HTMLElement
  const dots = Array.from(document.body.querySelectorAll('[aria-label^="Go to step"]')) as HTMLButtonElement[]
  expect(dots.length).toBeGreaterThan(1)
  // The cards these tests read are near the end: from the last dot back, each
  // past the body's fade (TRANSITION_MS, 160 ms), until the summary is the card's.
  for (const dot of dots.reverse()) {
    await act(async () => { dot.click(); await new Promise((r) => setTimeout(r, 220)) })
    if (summary().textContent?.replace(/`/g, '') === want) break
  }
  expect(summary().textContent?.replace(/`/g, ''), `the tour never showed the ${id} card`).toBe(want)
  return summary()
}

// The VM re-check on 11817681: the Dynamic Workflows card's highlights wrote
// their commands as bold code (**`/workflows`**), and both pages' bold
// printed the inner text as it is, so the backticks showed.
describe("the Dynamic Workflows card's highlights", () => {
  const CODES = ['/effort ultracode', '/deep-research <question>', '/workflows', 's']
  const check = (list: HTMLElement) => {
    expect(list.textContent).not.toMatch(/\*\*|`/)
    const codes = Array.from(list.querySelectorAll('code')).map((c) => c.textContent)
    for (const c of CODES) expect(codes, c).toContain(c)
  }

  it('in the Feature Guide show each command as code, with no mark left as text', async () => {
    await openGuideAt('productivity')
    const list = container.querySelector('[data-ux-id="card-dynamic-workflows-highlights"]') as HTMLElement
    expect(list, 'the card shows no highlights').not.toBeNull()
    check(list)
  })

  it('in the Feature tour show each command as code, with no mark left as text', async () => {
    const p = await openTourAt('dynamic-workflows')
    const list = p.parentElement!.querySelector('ul') as HTMLElement
    expect(list, 'the tour card shows no highlights').not.toBeNull()
    check(list)
  }, 20_000)
})
