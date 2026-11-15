// @vitest-environment jsdom
/**
 * ConductorHealthPill unit tests (Conductor D1b, Task 9).
 *
 * Verifies the aggregate-colour mapping + label rules from spec §2:
 *   - green + no state word when the hooks service is `listening`
 *   - amber + "Fallback" when host is `in-process-fallback`
 *   - amber + "Degraded" for a degraded row on its own host
 *   - amber + "Starting" / "Restarting" for a row that is coming up
 *   - red + "Down" when crashed
 *   - grey + no state word only when every row is stopped; a row that is
 *     switched off beside a running one is not an alarm and decides nothing
 *   - the label always renders "<diamond> Services"
 *   - clicking the pill invokes onOpen
 *
 * jsdom logs a benign "Not implemented: HTMLCanvasElement.getContext" — unrelated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type {
  DiagnosticsSnapshot,
  ServiceState,
  ServiceHost,
} from '../../../src/shared/service-health'
import { createInitialHealth } from '../../../src/shared/service-health'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function mkSnap(state: ServiceState, host: ServiceHost = 'utility-process'): DiagnosticsSnapshot {
  const h = { ...createInitialHealth('hooks', 'Hooks gateway', host), state, host, port: 19431 }
  return { capturedAt: 1, services: [h], log: [] }
}

/** A snapshot of several rows, each given as [id, state] on a utility process. */
function mkRows(...rows: Array<[id: string, state: ServiceState]>): DiagnosticsSnapshot {
  return {
    capturedAt: 1,
    services: rows.map(([id, state]) => ({ ...createInitialHealth(id, `${id} service`, 'utility-process'), state })),
    log: [],
  }
}

function mockApi(snap: DiagnosticsSnapshot): void {
  ;(globalThis as any).window.electronAPI = {
    serviceHealth: {
      get: vi.fn().mockResolvedValue(snap),
      restart: vi.fn(),
      onUpdate: vi.fn().mockReturnValue(() => {}),
    },
  }
}

const { default: ConductorHealthPill } = await import(
  '../../../src/renderer/components/ConductorHealthPill'
)

async function renderPill(props: { open: boolean; onOpen: () => void }): Promise<{
  container: HTMLElement
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConductorHealthPill, props))
  })
  // Let the seeding get().then() resolve and re-render.
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

describe('ConductorHealthPill', () => {
  let unmount: () => void

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('always renders the "Services" label', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    expect(r.container.textContent).toContain('Services')
  })

  it('does not render a leading diamond glyph (BUG-5: pill parity with Code/Claude.ai/Sentinel)', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    expect(r.container.textContent).not.toContain(String.fromCodePoint(0x25c6))
  })

  it('renders green and no state word when listening', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-green')
    expect(r.container.textContent).not.toMatch(/Degraded|Down|Fallback/)
  })

  it('shows amber + "Fallback" when in in-process fallback', async () => {
    mockApi(mkSnap('degraded', 'in-process-fallback'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-yellow')
    expect(r.container.textContent).toContain('Fallback')
  })

  it('shows amber + "Degraded" for a degraded row on its own host', async () => {
    mockApi(mkSnap('degraded'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-yellow')
    expect(r.container.textContent).toContain('Degraded')
    expect(r.container.textContent).not.toMatch(/Fallback|Starting|Down/)
  })

  it('a row that is starting reads "Starting", not "Degraded"', async () => {
    mockApi(mkSnap('starting'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-yellow')
    expect(r.container.textContent).toContain('Starting')
    expect(r.container.textContent).not.toMatch(/Degraded|Fallback|Down/)
  })

  it('a row that is restarting reads "Restarting", not "Degraded"', async () => {
    mockApi(mkSnap('restarting'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-yellow')
    expect(r.container.textContent).toContain('Restarting')
    expect(r.container.textContent).not.toMatch(/Degraded|Fallback|Down/)
  })

  it('shows red + "Down" when crashed', async () => {
    mockApi(mkSnap('crashed'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-red')
    expect(r.container.textContent).toContain('Down')
  })

  // --- a row that is switched off is not an alarm ---

  it('stays green, with no state word, when a row is switched off beside running ones', async () => {
    mockApi(mkRows(['hooks', 'listening'], ['logging', 'stopped'], ['tokenomics', 'stopped'], ['mcp', 'listening']))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-green')
    expect(r.container.textContent).toBe('Services')
    // The tooltip is the running row's, not "off".
    expect(r.container.querySelector('button')?.getAttribute('title')).toMatch(/^hooks service: utility-process listening/)
  })

  it('a switched-off row listed first does not hide one that is starting, degraded or down', async () => {
    mockApi(mkRows(['hooks', 'stopped'], ['tokenomics', 'starting']))
    let r = await renderPill({ open: false, onOpen: () => {} })
    expect((r.container.querySelector('span.rounded-full') as HTMLElement).className).toContain('bg-yellow')
    expect(r.container.textContent).toContain('Starting')
    r.unmount()
    mockApi(mkRows(['hooks', 'stopped'], ['logging', 'degraded'], ['tokenomics', 'starting']))
    r = await renderPill({ open: false, onOpen: () => {} })
    expect(r.container.textContent).toContain('Degraded')
    r.unmount()
    mockApi(mkRows(['hooks', 'stopped'], ['logging', 'degraded'], ['mcp', 'crashed']))
    r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    expect((r.container.querySelector('span.rounded-full') as HTMLElement).className).toContain('bg-red')
    expect(r.container.textContent).toContain('Down')
  })

  it('is grey and says the first row is off only when every row is stopped', async () => {
    mockApi(mkRows(['hooks', 'stopped'], ['logging', 'stopped']))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-overlay0')
    expect(r.container.textContent).toBe('Services')
    expect(r.container.querySelector('button')?.getAttribute('title')).toBe('hooks service: off')
  })

  it('shows neutral grey and no state word when stopped (hooks off)', async () => {
    mockApi(mkSnap('stopped'))
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-overlay0')
    expect(r.container.textContent).not.toMatch(/Degraded|Down|Fallback/)
  })

  it('calls onOpen when clicked', async () => {
    const onOpen = vi.fn()
    mockApi(mkSnap('listening'))
    const r = await renderPill({ open: false, onOpen })
    unmount = r.unmount
    const btn = r.container.querySelector('button') as HTMLButtonElement
    await act(async () => { btn.click() })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  // --- worst-of-all-services: hooks listening + logging crashed -> red ---
  it('picks the worst state when multiple services are present (hooks ok + logging crashed -> red)', async () => {
    const hooks = { ...createInitialHealth('hooks', 'Hooks gateway', 'utility-process'), state: 'listening' as const, host: 'utility-process' as const }
    const logging = { ...createInitialHealth('logging', 'Session logging', 'utility-process'), state: 'crashed' as const, host: 'utility-process' as const }
    const snap: DiagnosticsSnapshot = { capturedAt: 1, services: [hooks, logging], log: [] }
    ;(globalThis as any).window.electronAPI = {
      serviceHealth: {
        get: vi.fn().mockResolvedValue(snap),
        restart: vi.fn(),
        onUpdate: vi.fn().mockReturnValue(() => {}),
      },
    }
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-red')
    expect(r.container.textContent).toContain('Down')
  })

  // --- worst-of-all-services: both listening -> green ---
  it('stays green when all services are listening (hooks + logging both ok)', async () => {
    const hooks = { ...createInitialHealth('hooks', 'Hooks gateway', 'utility-process'), state: 'listening' as const, host: 'utility-process' as const }
    const logging = { ...createInitialHealth('logging', 'Session logging', 'utility-process'), state: 'listening' as const, host: 'utility-process' as const }
    const snap: DiagnosticsSnapshot = { capturedAt: 1, services: [hooks, logging], log: [] }
    ;(globalThis as any).window.electronAPI = {
      serviceHealth: {
        get: vi.fn().mockResolvedValue(snap),
        restart: vi.fn(),
        onUpdate: vi.fn().mockReturnValue(() => {}),
      },
    }
    const r = await renderPill({ open: false, onOpen: () => {} })
    unmount = r.unmount
    const dot = r.container.querySelector('span.rounded-full') as HTMLElement
    expect(dot.className).toContain('bg-green')
    expect(r.container.textContent).not.toMatch(/Degraded|Down|Fallback/)
  })
})
