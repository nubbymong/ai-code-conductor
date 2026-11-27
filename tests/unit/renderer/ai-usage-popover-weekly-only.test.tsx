// @vitest-environment jsdom
/**
 * The AI usage popover's rate windows decide each window from its own field
 * (2.1.3-beta.19 fix round 5, the status strip's fault in a second place). A
 * session whose status line gave the weekly window and no 5-hour one read
 * "no session telemetry this run", and its weekly figure was not shown. Now
 * the weekly row shows its figure and reset, the 5-hour row says not
 * reported, and the no-telemetry line is only for a session with neither.
 * The harness is ai-usage-popover-provider-off.test.tsx's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: AiUsagePopover } = await import('../../../src/renderer/components/AiUsagePopover')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: false } })
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending', aiUsageCycle: null })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useSessionStore.setState({ sessions: [], activeSessionId: null } as never)
})

async function render(session: Record<string, unknown>) {
  useSessionStore.setState({ sessions: [{ id: 'claude-1', status: 'idle', createdAt: 1, provider: 'claude', ...session }], activeSessionId: 'claude-1' } as never)
  await act(async () => {
    root.render(React.createElement(AiUsagePopover, { open: true, onClose: () => {} }))
  })
}

const text = () => container.textContent ?? ''

describe('AI usage popover: each rate window from its own field', () => {
  it('weekly only: the weekly row shows 68% and its reset, the 5-hour row says not reported', async () => {
    await render({ rateLimitWeekly: 68, rateLimitWeeklyResets: '2026-11-30T03:00:00.000Z' })
    expect(text()).not.toContain('no session telemetry this run')
    expect(text()).toContain('7d window 68%')
    expect(text()).toMatch(/7d window 68%resets /)
    expect(text()).toContain('5h window not reported')
  })

  it('neither: the no-telemetry line, as before', async () => {
    await render({})
    expect(text()).toContain('no session telemetry this run')
    expect(text()).not.toContain('not reported')
  })

  it('both: both figures, as before', async () => {
    await render({ rateLimitCurrent: 23, rateLimitWeekly: 68 })
    expect(text()).toContain('5h window 23%')
    expect(text()).toContain('7d window 68%')
    expect(text()).not.toContain('not reported')
  })
})
