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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: SidebarNav } = await import('../../../src/renderer/components/sidebar/SidebarNav')
const { PAGE_TAB_META } = await import('../../../src/renderer/page-tab-meta')
const { VIEW_FEATURE_IDS, knownFeatureIds } = await import('../../../src/renderer/stores/tipsStore')
const { TIPS_LIBRARY } = await import('../../../src/renderer/tips-library')
const { APP_KNOWLEDGE_SECTIONS } = await import('../../../src/shared/app-knowledge')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')

const props = { currentView: 'sessions' as any, insightsStatus: null, insightsMessage: null, cloudAgentRunning: 0 }

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAccountProfilesStore.setState({ profiles: [] })
})

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

  it('the app renders the page for the machines view and tells it when its tab is the one showing', () => {
    // jsdom cannot mount the whole app; pin the one line that wires the page in. Without
    // the page the tab is empty; without `active` (it defaults to true) the page would
    // stop reading again when its tab comes back to the front.
    const app = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toMatch(/if \(v === 'machines'\) return <MachinesPage active=\{view === 'machines'\} \/>/)
    expect(app).toMatch(/import MachinesPage from '\.\/components\/MachinesPage'/)
  })
})

describe('the expanded rail fits the sidebar (Machines made it one button longer)', () => {
  // jsdom does no layout, so this pins the class that lets the row fit; the width
  // itself is checked by eye on the VM UI check at the default (256) and narrowest
  // (200) sidebar width, with two accounts so the Account button shows.
  // The expanded buttons are flex-1. Without min-w-0 each is at least its 20px
  // icon wide: ten of them with their gaps and the divider need about 257px
  // against the 239px a 256px sidebar leaves, and the Feature Guide and Account
  // buttons spill past the sidebar edge. With min-w-0 they share the row and shrink.
  const profile = (id: string) => ({ id, name: id, accountEmail: `${id}@example.com`, createdAt: 0 })
  const railButtons = () => Array.from(container.querySelector('[data-tour="nav-rail"]')!.children).filter((c) => c.tagName === 'BUTTON')

  it('every expanded rail button, the Account and Feature Guide ones included, may shrink with the row', () => {
    useAccountProfilesStore.setState({ profiles: [profile('one'), profile('two')] as any })
    act(() => root.render(React.createElement(SidebarNav, { ...props, onViewChange: () => {}, onShowAccountUsage: () => {} } as any)))
    const buttons = railButtons()
    // Four first-group pages, four more, the Account button and the Feature Guide: ten.
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Cloud Agents', 'Insights', 'Tokenomics', 'Machines', 'Conductor MCP', 'Memory', 'Logs', 'Settings', 'Account usage', 'Feature Guide',
    ])
    for (const b of buttons) {
      expect(b.className, b.getAttribute('aria-label') ?? '').toMatch(/(^|\s)flex-1(\s|$)/)
      expect(b.className, b.getAttribute('aria-label') ?? '').toMatch(/(^|\s)min-w-0(\s|$)/)
    }
  })

  it('the collapsed rail keeps its fixed square buttons', () => {
    useAccountProfilesStore.setState({ profiles: [profile('one'), profile('two')] as any })
    act(() => root.render(React.createElement(SidebarNav, { ...props, onViewChange: () => {}, onShowAccountUsage: () => {}, collapsed: true } as any)))
    const buttons = railButtons()
    expect(buttons.length).toBe(10)
    for (const b of buttons) expect(b.className).toContain('w-10 h-10')
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
    // Every state the page can show, and every time it reads.
    for (const word of ['off, not installed, starting, ready or failed', 'when you open it', 'when you switch back to its tab', 'press **Refresh**', 'after each action']) expect(body).toContain(word)
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
    // When it reads, and what an empty list means.
    expect(section.body).toContain('when you open it, when you switch back to its tab, when you press Refresh and after each action')
    expect(section.body).toContain('an empty list there does not mean none are held')
    // The helper is switched on by the setting; it is not the setting.
    expect(section.body).toContain('switches the session helper on')
    expect(section.body).not.toContain('The session helper is the setting')
    expect(section.body).not.toMatch(/—/)
  })

  it('the list of rail pages, which Ask Conductor answers from, names Machines', () => {
    const pages = APP_KNOWLEDGE_SECTIONS.find((s) => s.id !== 'machines' && s.title === 'The pages on the left rail')!
    expect(pages).toBeTruthy()
    expect(pages.body).toContain('Machines shows This computer, its session helper (off by default) and the terminals the helper holds')
    expect(pages.body).toContain('The Machines page')
  })
})
