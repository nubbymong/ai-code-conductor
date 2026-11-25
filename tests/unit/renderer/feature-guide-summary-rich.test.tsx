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
import type { TrainingSection, TrainingStep } from '../../../src/renderer/training-steps'

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

  it('every card the guide shows has no mark left as text in its summary or its highlights', async () => {
    const bad: string[] = []
    for (const section of SECTIONS) {
      await openGuideAt(section)
      bad.push(...sweepGuideCards(section, cardsOf(section)))
    }
    expect(bad).toEqual([])
  })
})

// The guide's cards are swept from the data, not from what happens to be on the
// page (#426, the same shape as the tip sweep's): the sweep used to take every
// summary and highlights element it found and check those, so a section that
// drew no cards, or a card that drew no summary or list, passed it. Now each
// card the data puts in the section must be on the page, with the summary the
// data gives it and every highlight in the list, each with text and none with a
// mark left as text. One line per problem, naming the section and the element.
const SECTIONS: readonly TrainingSection[] = ['getting-started', 'productivity', 'integrations', 'admin', 'tips']
/** The cards of a section: all of them, as both assistants are in use here. */
const cardsOf = (section: TrainingSection): TrainingStep[] => trainingSteps.filter((s) => s.section === section)

function sweepGuideCards(section: TrainingSection, cards: readonly TrainingStep[]): string[] {
  const bad: string[] = []
  if (cards.length === 0) bad.push(`${section}: the data has no card for this section`)
  for (const step of cards) {
    const card = container.querySelector(`[data-ux-id="card-${step.id}"]`)
    if (!card) { bad.push(`${section}: card-${step.id} is not on the page`); continue }
    const read = (what: 'summary' | 'highlights', el: Element | null, text: string | null) => {
      const at = `${section}: card-${step.id}-${what}`
      if (!el) bad.push(`${at} is not on the page`)
      else if (!(text ?? '').trim()) bad.push(`${at} shows no text`)
      else if (/\*\*|`/.test(text!)) bad.push(`${at} shows a mark as text: ${text!.match(/.{0,30}(\*\*|`).{0,30}/)?.[0]}`)
    }
    if (step.summary) {
      const p = card.querySelector(`[data-ux-id="card-${step.id}-summary"]`)
      read('summary', p, p?.textContent ?? null)
    }
    const list = card.querySelector(`[data-ux-id="card-${step.id}-highlights"]`)
    read('highlights', list, list?.textContent ?? null)
    // The list holds every highlight the card has, each with text in it.
    const want = (step.highlights ?? step.bullets ?? []).length
    const items = list ? Array.from(list.querySelectorAll('li')) : []
    if (list && items.length !== want) bad.push(`${section}: card-${step.id}-highlights shows ${items.length} of ${want} items`)
    items.forEach((li, i) => {
      if (!(li.textContent ?? '').trim()) bad.push(`${section}: card-${step.id}-highlights item ${i + 1} shows no text`)
    })
  }
  return bad
}

describe('the guide sweep fails a card that did not render', () => {
  it('a card the data holds and the section does not show is named', async () => {
    await openGuideAt('tips')
    expect(sweepGuideCards('tips', cardsOf('tips'))).toEqual([])
    const standIn: TrainingStep = { ...cardsOf('tips')[0], id: 'stand-in-card', summary: 'A stand-in.', highlights: ['One.'] }
    // It sits beside a card that did render: the old sweep checked what was
    // there and passed.
    expect(sweepGuideCards('tips', [...cardsOf('tips'), standIn])).toEqual(['tips: card-stand-in-card is not on the page'])
  })

  it('a section the page is not showing is every one of its cards missing, not clean', async () => {
    await openGuideAt('productivity')
    const want = cardsOf('tips')
    expect(want.length).toBeGreaterThan(0)
    expect(sweepGuideCards('tips', want)).toEqual(want.map((s) => `tips: card-${s.id} is not on the page`))
  })

  it('a section with no cards in the data is a finding, not a pass', async () => {
    await openGuideAt('tips')
    expect(sweepGuideCards('tips', [])).toEqual(['tips: the data has no card for this section'])
  })

  it('a card whose list is shorter than its data, or whose summary the page does not draw, is named', async () => {
    await openGuideAt('tips')
    const real = cardsOf('tips')[0]
    const shown = real.highlights ?? real.bullets
    expect(sweepGuideCards('tips', [{ ...real, highlights: [...shown, 'A highlight the card does not draw.'] }]))
      .toEqual([`tips: card-${real.id}-highlights shows ${shown.length} of ${shown.length + 1} items`])
    // The summary element is drawn only when the card has a summary: take it
    // out of the card on the page, and the sweep must say so.
    container.querySelector(`[data-ux-id="card-${real.id}-summary"]`)!.remove()
    expect(sweepGuideCards('tips', [real])).toEqual([`tips: card-${real.id}-summary is not on the page`])
  })

  it('an item with no text in it, and a mark left as text, are named', async () => {
    await openGuideAt('tips')
    const real = cardsOf('tips')[0]
    const items = Array.from(container.querySelectorAll(`[data-ux-id="card-${real.id}-highlights"] li`))
    expect(items.length).toBeGreaterThan(0)
    items[0].textContent = ''
    expect(sweepGuideCards('tips', [real])).toEqual([`tips: card-${real.id}-highlights item 1 shows no text`])
    items[0].textContent = 'A highlight with **bold** left as text'
    const marked = sweepGuideCards('tips', [real])
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain(`tips: card-${real.id}-highlights shows a mark as text: `)
    expect(marked[0]).toContain('**bold**')
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
