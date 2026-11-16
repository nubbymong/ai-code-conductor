// @vitest-environment jsdom
//
// The Machines page's place in the app (2.1.3-beta.6, plan section C.1): a
// button in the nav rail's first group (beside Cloud Agents, Insights and
// Tokenomics), a page tab with its own label and icon, a tips usage id so the
// tip stops once the page has been opened, and the surface sweep that ships with
// the page (the Feature Guide reference text and the tip).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: SidebarNav } = await import('../../../src/renderer/components/sidebar/SidebarNav')
const { PAGE_TAB_META } = await import('../../../src/renderer/page-tab-meta')
const { VIEW_FEATURE_IDS, knownFeatureIds } = await import('../../../src/renderer/stores/tipsStore')
const { TIPS_LIBRARY } = await import('../../../src/renderer/tips-library')
const { APP_KNOWLEDGE_SECTIONS } = await import('../../../src/shared/app-knowledge')

const props = { currentView: 'sessions' as any, insightsStatus: null, insightsMessage: null, cloudAgentRunning: 0 }

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

function railOrder(collapsed: boolean): string[] {
  act(() => root.render(React.createElement(SidebarNav, { ...props, onViewChange: () => {}, collapsed } as any)))
  const rail = container.querySelector('[data-tour="nav-rail"]')!
  return Array.from(rail.children).map((c) => c.getAttribute('data-tour') ?? (c.getAttribute('aria-hidden') ? 'divider' : c.getAttribute('aria-label') ?? '?'))
}

describe('Machines in the nav rail', () => {
  it('sits in the first group, right after Tokenomics and before the divider', () => {
    const order = railOrder(false)
    expect(order.slice(0, 5)).toEqual(['nav-cloud-agents', 'nav-insights', 'nav-tokenomics', 'nav-machines', 'divider'])
    expect(order.indexOf('nav-machines')).toBeLessThan(order.indexOf('nav-vision'))
  })

  it('sits in the same place when the rail is collapsed', () => {
    const order = railOrder(true)
    expect(order.slice(0, 5)).toEqual(['nav-cloud-agents', 'nav-insights', 'nav-tokenomics', 'nav-machines', 'divider'])
  })

  it('is named Machines, and opens the machines view when pressed', () => {
    const onViewChange = vi.fn()
    act(() => root.render(React.createElement(SidebarNav, { ...props, onViewChange } as any)))
    const button = container.querySelector('[data-tour="nav-machines"]') as HTMLButtonElement
    expect(button.getAttribute('aria-label')).toBe('Machines')
    act(() => { button.click() })
    expect(onViewChange).toHaveBeenCalledWith('machines')
  })

  it('has a page tab with its own label and icon', () => {
    expect(PAGE_TAB_META.machines?.label).toBe('Machines')
    expect(PAGE_TAB_META.machines?.icon).toBeTruthy()
  })
})

describe('the surface sweep for the Machines page', () => {
  it('opening the page is recorded as a feature the prune knows', () => {
    expect(VIEW_FEATURE_IDS.machines).toBe('machines.machines-page')
    expect(knownFeatureIds().has('machines.machines-page')).toBe(true)
  })

  it('the tip opens the page, and goes once the page has been opened', () => {
    const tip = TIPS_LIBRARY.find((t) => t.id === 'tip.machines-page')!
    expect(tip).toBeTruthy()
    expect(tip.variants.primary.actionTarget).toBe('machines')
    expect(tip.excludes).toEqual(['machines.machines-page'])
    expect(tip.variants.postUse).toBeUndefined()
    expect(tip.variants.primary.shortText.length).toBeLessThan(60)
    const body = tip.variants.primary.body
    expect(body).toContain('off by default')
    expect(body).toContain('Settings, General, Plain terminals through the session helper')
    expect(`${tip.variants.primary.title} ${body}`).not.toMatch(/—/)
  })

  it('the Feature Guide reference says what the page is, that it holds only This computer, and that the helper is off by default', () => {
    const section = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'machines')!
    expect(section).toBeTruthy()
    expect(section.title).toBe('The Machines page')
    expect(section.body).toContain('one machine, This computer')
    expect(section.body).toContain('off by default')
    expect(section.body).toContain('Plain terminals through the session helper, in Settings, General')
    for (const word of ['Re-attach', 'End', 'Run self-test', 'Refresh']) expect(section.body).toContain(word)
  })
})
