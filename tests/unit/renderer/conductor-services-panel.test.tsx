// @vitest-environment jsdom
/**
 * ConductorServicesPanel unit tests (Conductor D1b, Task 10).
 *
 * Verifies (spec §3.7 / §6):
 *   - renders the per-service metrics (port, pid, in-flight, events, drops,
 *     throughput, jank, restarts, lastError) + a level-coloured log tail
 *   - "Copy diagnostics" writes the full DiagnosticsSnapshot JSON to the clipboard
 *   - "Restart" calls serviceHealth.restart('hooks') in utility mode
 *   - "Restart" is disabled when host is in-process-fallback
 *   - the MCP server is a row from the snapshot like any other (no fixed text),
 *     with no restart of its own
 *   - a card shows only the counters its row keeps
 *   - a row's measured cost is shown when it has one
 *   - click-outside calls onClose
 *
 * jsdom logs a benign "Not implemented: HTMLCanvasElement.getContext" — unrelated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DiagnosticsSnapshot, ServiceState, ServiceHost } from '../../../src/shared/service-health'
import { createInitialHealth } from '../../../src/shared/service-health'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function mkSnap(state: ServiceState, host: ServiceHost = 'utility-process'): DiagnosticsSnapshot {
  const h = { ...createInitialHealth('hooks', 'Hooks gateway', host), state }
  return { capturedAt: 1, services: [h], log: [] }
}

/** The card of one service row, found by the row id the panel puts on it. */
function card(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-service-id="${id}"]`) as HTMLElement
}

const restartMock = vi.fn().mockResolvedValue({ ok: true })

function mockApi(snap: DiagnosticsSnapshot): void {
  ;(globalThis as any).window.electronAPI = {
    serviceHealth: {
      get: vi.fn().mockResolvedValue(snap),
      restart: restartMock,
      onUpdate: vi.fn().mockReturnValue(() => {}),
    },
  }
}

const { default: ConductorServicesPanel } = await import(
  '../../../src/renderer/components/ConductorServicesPanel'
)

async function renderPanel(props: { onClose: () => void }): Promise<{
  container: HTMLElement
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConductorServicesPanel, props))
  })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function findButton(container: HTMLElement, re: RegExp): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    re.test(b.textContent ?? '')
  ) as HTMLButtonElement
}

describe('ConductorServicesPanel', () => {
  let unmount: () => void

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders metrics + log and Copy writes DiagnosticsSnapshot JSON', async () => {
    const snap = mkSnap('listening')
    snap.services[0].port = 19431
    snap.services[0].pid = 8421
    snap.services[0].inFlight = 3
    snap.services[0].eventsTotal = 42
    snap.log = [
      { ts: 1, serviceId: 'hooks', level: 'info', code: 'bound', message: 'bound :19431 pid=8421' },
    ]
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).clipboard = { writeText }
    mockApi(snap)

    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount

    expect(r.container.textContent).toContain('19431')
    expect(r.container.textContent).toContain('8421')
    expect(r.container.textContent).toContain('bound :19431')

    const copyBtn = findButton(r.container, /Copy/i)
    expect(copyBtn).toBeTruthy()
    await act(async () => { copyBtn.click() })
    expect(writeText).toHaveBeenCalledOnce()
    const arg = writeText.mock.calls[0][0] as string
    expect(arg).toContain('"services"')
    // Round-trips to the exact snapshot.
    expect(JSON.parse(arg)).toEqual(snap)
  })

  it('shows "Copied" feedback after Copy diagnostics is clicked (BUG-2)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).clipboard = { writeText }
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const copyBtn = findButton(r.container, /Copy/i)
    await act(async () => { copyBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(findButton(r.container, /Copied/i)).toBeTruthy()
  })

  it('styles Restart with a destructive (danger) tone (BUG-3)', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    // Since #360 the panel paints from the E5 semantic tokens, so the
    // destructive read lives in --status-danger rather than in a `red`
    // palette class name. Assert the tone, not the old class.
    const style = restartBtn.getAttribute('style') || ''
    expect(style).toMatch(/--status-danger/)
    expect(style).not.toMatch(/--status-(success|info)\b/)
  })

  it('Restart calls serviceHealth.restart("hooks") in utility mode', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    expect(restartBtn.hasAttribute('disabled')).toBe(false)
    await act(async () => { restartBtn.click() })
    expect(restartMock).toHaveBeenCalledWith('hooks')
  })

  it('Restart is disabled in fallback', async () => {
    mockApi(mkSnap('degraded', 'in-process-fallback'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    expect(restartBtn.hasAttribute('disabled')).toBe(true)
  })

  it('per-card Restart passes that card\'s own id (watchdog)', async () => {
    const hooks = { ...createInitialHealth('hooks', 'Hooks gateway', 'utility-process'), state: 'listening' as ServiceState }
    const wd = { ...createInitialHealth('watchdog', 'Watchdog', 'in-process'), state: 'listening' as ServiceState }
    mockApi({ capturedAt: 1, services: [hooks, wd], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restarts = Array.from(r.container.querySelectorAll('button')).filter((b) => /Restart/i.test(b.textContent ?? ''))
    expect(restarts).toHaveLength(2) // one per card, no footer restart
    await act(async () => { restarts[1].click() })
    expect(restartMock).toHaveBeenCalledWith('watchdog')
  })

  it('watchdog Restart is enabled, and its card says it runs in-process', async () => {
    // The watchdog lives in the main process. That is where it always runs,
    // not a fallback from a crashed child, so it does not disable restart.
    const wd = { ...createInitialHealth('watchdog', 'Watchdog', 'in-process'), state: 'listening' as ServiceState }
    mockApi({ capturedAt: 1, services: [wd], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(card(r.container, 'watchdog').textContent).toContain('in-process')
    expect(card(r.container, 'watchdog').textContent).not.toContain('fallback')
    const btn = findButton(r.container, /Restart/i)
    expect(btn.hasAttribute('disabled')).toBe(false)
    await act(async () => { btn.click() })
    expect(restartMock).toHaveBeenCalledWith('watchdog')
  })

  // --- The MCP server is a row from the snapshot, not fixed text ---

  it('shows nothing about an MCP server that the snapshot does not hold', async () => {
    // The panel used to end with the fixed text "MCP server in-process :19333
    // (next phase)" whatever the server was doing, and on whatever port.
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(r.container.textContent).not.toMatch(/next phase/i)
    expect(r.container.textContent).not.toContain('MCP server')
    expect(r.container.textContent).not.toContain('19333')
  })

  it('renders the MCP server row from the snapshot: its state, host and real port', async () => {
    const mcp = { ...createInitialHealth('mcp', 'MCP server', 'in-process'), state: 'listening' as ServiceState, port: 19433 }
    mockApi({ capturedAt: 1, services: [{ ...mkSnap('listening').services[0] }, mcp], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const text = card(r.container, 'mcp').textContent ?? ''
    expect(text).toContain('MCP server')
    expect(text).toContain('in-process :19433')
    expect(text).not.toContain('19333')
    expect(r.container.textContent).not.toMatch(/next phase/i)
    // Nothing is counted for this row, so no counter is shown as a zero.
    expect(text).not.toMatch(/Events|In-flight|Thrput|Uptime|PID/)
    // The other cards keep theirs.
    expect(card(r.container, 'hooks').textContent).toMatch(/Events/)
  })

  it('the MCP server row follows the server: starting, crashed with its error, stopped', async () => {
    const base = createInitialHealth('mcp', 'MCP server', 'in-process')
    mockApi({ capturedAt: 1, services: [{ ...base, state: 'crashed', lastError: { message: 'listen EADDRINUSE', ts: 1 } }], log: [] })
    let r = await renderPanel({ onClose: () => {} })
    expect(card(r.container, 'mcp').textContent).toContain('in-process (crashed)')
    expect(card(r.container, 'mcp').textContent).toContain('last error: listen EADDRINUSE')
    r.unmount()
    mockApi({ capturedAt: 1, services: [{ ...base, state: 'starting' }], log: [] })
    r = await renderPanel({ onClose: () => {} })
    expect(card(r.container, 'mcp').textContent).toContain('in-process (starting)')
    r.unmount()
    mockApi({ capturedAt: 1, services: [{ ...base, state: 'stopped' }], log: [] })
    r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(card(r.container, 'mcp').textContent).toContain('stopped')
  })

  it('MCP Restart is disabled and says why: the row has no restart of its own', async () => {
    const mcp = { ...createInitialHealth('mcp', 'MCP server', 'in-process'), state: 'listening' as ServiceState, port: 19333 }
    mockApi({ capturedAt: 1, services: [mcp], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const btn = findButton(card(r.container, 'mcp'), /Restart/i)
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.getAttribute('title')).toMatch(/Relaunch the app/)
    await act(async () => { btn.click() })
    expect(restartMock).not.toHaveBeenCalled()
  })

  it('the Session helper card (2.1.3-beta.6) shows how many terminals it holds, and its Restart is disabled with the reason', async () => {
    const helper = { ...createInitialHealth('helper', 'Session helper', 'helper'), state: 'listening' as ServiceState, heldSessions: 2 }
    mockApi({ capturedAt: 1, services: [helper], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(counterLabels(r.container, 'helper')).toEqual(['Held', 'Jank m'])
    expect(card(r.container, 'helper').querySelector('[data-counters]')?.textContent).toContain('2')
    const btn = findButton(card(r.container, 'helper'), /Restart/i)
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.getAttribute('title')).toMatch(/holder of its own/)
    await act(async () => { btn.click() })
    expect(restartMock).not.toHaveBeenCalled()
  })

  // --- Stopped rows, and the rows the registry added ---

  it('a stopped hooks row reads disabled; any other stopped row reads stopped', async () => {
    const hooks = { ...createInitialHealth('hooks', 'Hooks gateway', 'utility-process'), state: 'stopped' as ServiceState }
    const tk = { ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'), state: 'stopped' as ServiceState }
    mockApi({ capturedAt: 1, services: [hooks, tk], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(card(r.container, 'hooks').textContent).toContain('disabled')
    expect(card(r.container, 'tokenomics').textContent).toContain('stopped')
    expect(card(r.container, 'tokenomics').textContent).not.toContain('disabled')
    // Neither can be restarted while stopped.
    for (const id of ['hooks', 'tokenomics']) {
      expect(findButton(card(r.container, id), /Restart/i).hasAttribute('disabled')).toBe(true)
    }
    expect(findButton(card(r.container, 'tokenomics'), /Restart/i).getAttribute('title')).toBe('Tokenomics is stopped')
  })

  it('a running Tokenomics row can be restarted, by its own id', async () => {
    const tk = { ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'), state: 'degraded' as ServiceState }
    mockApi({ capturedAt: 1, services: [tk], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const btn = findButton(card(r.container, 'tokenomics'), /Restart/i)
    expect(btn.hasAttribute('disabled')).toBe(false)
    await act(async () => { btn.click() })
    expect(restartMock).toHaveBeenCalledWith('tokenomics')
  })

  // --- A card shows only the counters its row keeps ---

  /** The labels of the counters a card shows, in order (none: the card has no counter grid). */
  function counterLabels(container: HTMLElement, id: string): string[] | null {
    const grid = card(container, id).querySelector('[data-counters]')
    return grid ? Array.from(grid.children).map((cell) => cell.firstElementChild?.textContent ?? '') : null
  }
  function counterValue(container: HTMLElement, id: string, label: string): string | undefined {
    const grid = card(container, id).querySelector('[data-counters]')
    const cell = Array.from(grid?.children ?? []).find((c) => c.firstElementChild?.textContent === label)
    return cell?.lastElementChild?.textContent ?? undefined
  }

  it('each card shows only the counters its row keeps, so none reads as a real zero', async () => {
    const up = (id: string, label: string, host: ServiceHost) => ({ ...createInitialHealth(id, label, host), state: 'listening' as ServiceState })
    mockApi({
      capturedAt: 1,
      services: [
        up('hooks', 'Hooks gateway', 'utility-process'),
        up('logging', 'Session logging', 'utility-process'),
        up('tokenomics', 'Tokenomics', 'utility-process'),
        up('watchdog', 'Watchdog', 'in-process'),
        { ...up('mcp', 'MCP server', 'in-process'), port: 19333 },
      ],
      log: [],
    })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    // The hooks gateway reports every counter, its own event-loop stalls included.
    expect(counterLabels(r.container, 'hooks')).toEqual(['PID', 'Uptime', 'In-flight', 'Restarts', 'Events', 'Trimmed', 'Thrput/s', 'Jank m/c'])
    // The logging worker reports no event-loop stalls of its own.
    expect(counterLabels(r.container, 'logging')).toEqual(['PID', 'Uptime', 'In-flight', 'Restarts', 'Events', 'Trimmed', 'Thrput/s', 'Jank m'])
    // The usage index keeps its worker's process id (2.1.3-beta.4), and no
    // trim count, no rate and no stalls of its own.
    expect(counterLabels(r.container, 'tokenomics')).toEqual(['PID', 'Uptime', 'In-flight', 'Restarts', 'Events', 'Jank m'])
    // The Watchdog has no process of its own and counts no restarts.
    expect(counterLabels(r.container, 'watchdog')).toEqual(['Uptime', 'In-flight', 'Events', 'Jank m'])
    expect(counterLabels(r.container, 'mcp')).toBeNull()
  })

  it('the Tokenomics card shows what its row keeps, and the main loop\'s stalls alone', async () => {
    const tk = {
      ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'),
      state: 'listening' as ServiceState,
      pid: 7001, inFlight: 2, eventsTotal: 4200, restartCount: 1, mainLoopStallsLastMin: 3,
    }
    mockApi({ capturedAt: 1, services: [tk], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(counterValue(r.container, 'tokenomics', 'PID')).toBe('7001')
    expect(counterValue(r.container, 'tokenomics', 'In-flight')).toBe('2')
    expect(counterValue(r.container, 'tokenomics', 'Events')).toBe('4200')
    expect(counterValue(r.container, 'tokenomics', 'Restarts')).toBe('1')
    expect(counterValue(r.container, 'tokenomics', 'Jank m')).toBe('3')
    expect(card(r.container, 'tokenomics').textContent).not.toMatch(/Trimmed|Thrput|Jank m\/c|3\/0/)
  })

  it('a hooks row that fell back to the main process shows no PID and no child stalls, as an in-process row does', async () => {
    const hooks = {
      ...createInitialHealth('hooks', 'Hooks gateway', 'in-process-fallback'),
      state: 'degraded' as ServiceState,
      pid: 4242, mainLoopStallsLastMin: 2, childLoopStallsLastMin: 3,
    }
    mockApi({ capturedAt: 1, services: [hooks], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(counterLabels(r.container, 'hooks')).toEqual(['Uptime', 'In-flight', 'Restarts', 'Events', 'Trimmed', 'Thrput/s', 'Jank m'])
    expect(counterValue(r.container, 'hooks', 'Jank m')).toBe('2')
    expect(card(r.container, 'hooks').textContent).not.toMatch(/PID|4242|Jank m\/c/)
  })

  it('a row with no child up shows a dash for its PID and Uptime, never a zero or NaN', async () => {
    const down = (id: string, label: string, state: ServiceState) => ({ ...createInitialHealth(id, label, 'utility-process'), state })
    mockApi({
      capturedAt: 1,
      services: [down('hooks', 'Hooks gateway', 'crashed'), down('logging', 'Session logging', 'restarting'), down('tokenomics', 'Tokenomics', 'starting')],
      log: [],
    })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    for (const id of ['hooks', 'logging', 'tokenomics']) {
      expect(counterValue(r.container, id, 'PID')).toBe('-')
      expect(counterValue(r.container, id, 'Uptime')).toBe('-')
    }
    for (const id of ['hooks', 'logging', 'tokenomics']) {
      expect(card(r.container, id).textContent).not.toMatch(/NaN|\b0s\b|undefined/)
    }
  })

  it('a row the panel does not know shows every counter, as a supervised child does', async () => {
    const other = { ...createInitialHealth('something-new', 'Something new', 'utility-process'), state: 'listening' as ServiceState, mainLoopStallsLastMin: 1, childLoopStallsLastMin: 2 }
    mockApi({ capturedAt: 1, services: [other], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(counterLabels(r.container, 'something-new')).toEqual(['PID', 'Uptime', 'In-flight', 'Restarts', 'Events', 'Trimmed', 'Thrput/s', 'Jank m/c'])
    expect(counterValue(r.container, 'something-new', 'Jank m/c')).toBe('1/2')
  })

  // --- measured: optional, shown on the row when present ---

  it('renders a row\'s measured cost when it has one', async () => {
    const tk = {
      ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'),
      state: 'listening' as ServiceState,
      measured: { cpuPercent: 1.25, filesTouchedLastScan: 340, sampledAt: Date.now() - 12_000 },
    }
    mockApi({ capturedAt: 1, services: [tk], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const m = card(r.container, 'tokenomics').querySelector('[data-measured]') as HTMLElement
    expect(m).toBeTruthy()
    expect(m.textContent).toContain('CPU')
    expect(m.textContent).toContain('1.3%')
    expect(m.textContent).toContain('Files/scan')
    expect(m.textContent).toContain('340')
    expect(m.textContent).toMatch(/Measured1[2-4]s ago/)
  })

  it('shows only the measured figures the row was given', async () => {
    const tk = {
      ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'),
      state: 'listening' as ServiceState,
      measured: { filesTouchedLastScan: 0, sampledAt: Date.now() },
    }
    mockApi({ capturedAt: 1, services: [tk], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const m = card(r.container, 'tokenomics').querySelector('[data-measured]') as HTMLElement
    expect(m.textContent).toContain('Files/scan')
    expect(m.textContent).not.toContain('CPU')
  })

  it('shows no measured block on a row without one, or with no figures in it', async () => {
    const hooks = { ...createInitialHealth('hooks', 'Hooks gateway', 'utility-process'), state: 'listening' as ServiceState }
    const tk = {
      ...createInitialHealth('tokenomics', 'Tokenomics', 'utility-process'),
      state: 'listening' as ServiceState,
      measured: { sampledAt: Date.now() },
    }
    // Not numbers: a figure that cannot be shown is left out, and the panel still renders.
    const logging = {
      ...createInitialHealth('logging', 'Session logging', 'utility-process'),
      state: 'listening' as ServiceState,
      measured: { cpuPercent: 'lots', filesTouchedLastScan: null, sampledAt: 'now' } as never,
    }
    mockApi({ capturedAt: 1, services: [hooks, tk, logging], log: [] })
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(r.container.querySelector('[data-measured]')).toBeNull()
    expect(r.container.textContent).not.toMatch(/Measured|Files\/scan|CPU/)
    expect(card(r.container, 'logging').textContent).toContain('Session logging')
  })

  it('scrolls inside the window rather than running off it as rows are added', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const panel = r.container.querySelector('[role="dialog"]') as HTMLElement
    expect(panel.className).toContain('overflow-y-auto')
    expect(panel.className).toMatch(/max-h-\[calc\(100vh-/)
  })

  it('calls onClose on outside mousedown', async () => {
    const onClose = vi.fn()
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose })
    unmount = r.unmount
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
