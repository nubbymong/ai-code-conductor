// @vitest-environment jsdom
/**
 * Each rate-limit window on the status strip is decided from its own field
 * (2.1.3-beta.19 fix round 5). Claude Code can report a weekly window and no
 * 5-hour one: seen on every reading of a helper tab on the owner's Raspberry
 * Pi 5 (arm64) signed in by a setup token, whose status gave
 * rateLimitWeekly 68 with its reset, no rateLimitCurrent and no buckets. The
 * strip drew both windows as waiting ("--%", "waiting for the status line"),
 * because one branch on rateLimitCurrent decided both. Now the weekly bar
 * shows its figure and reset, and the 5-hour one says not reported; the
 * waiting meters show only while neither field has arrived. The same strip
 * serves local, SSH and helper tabs. The harness is
 * session-status-strip-remote-usage.test.tsx's.
 *
 * The clock is pinned (PR 763 fix round 7). The strip draws a window's bar
 * only while its reset is still ahead of Date.now() (a passed one is drawn
 * as no reading), and these readings name fixed resets. With the real
 * clock, "both fields" went red once 2026-11-26T20:00Z had passed (CI at
 * 20:22Z), and every weekly case would have gone red after 2026-11-30T03:00Z.
 * Only Date is faked: the strip's timers run as they do in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [] }
const settingsState: any = { settings: {} }
const profilesState: any = { profiles: [] }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: vi.fn() }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')
const { composeRendererProviders } = await import('../../../src/renderer/providers')

let container: HTMLDivElement
let root: Root

/** The time these readings were taken at: before every reset they name. */
const READ_AT = new Date('2026-11-26T15:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(READ_AT)
  composeRendererProviders()
  ;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11, showRateLimits: true, showResetTime: true }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  profilesState.profiles = []
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

/** The Pi helper tab's reading: a weekly figure and its reset, nothing else. */
const WEEKLY_ONLY = { rateLimitWeekly: 68, rateLimitWeeklyResets: '2026-11-30T03:00:00.000Z', usageBuckets: [] }
const helperTab = (extra: Record<string, unknown>) => {
  sessionState.sessions = [{ id: 's1', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u' }, contextPercent: 10, status: 'working', ...extra }]
}
const localTab = (extra: Record<string, unknown>) => {
  sessionState.sessions = [{ id: 's1', provider: 'claude', sessionType: 'local', contextPercent: 10, status: 'working', ...extra }]
}
const draw = () => act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
const pending = () => container.querySelectorAll('[data-testid="rate-limit-pending"]')
const notReported = () => container.querySelector('[data-testid="rate-limit-not-reported"]') as HTMLElement | null
const bar = (label: string) => container.querySelector(`[aria-label="${label} rate limit utilisation"]`) as HTMLElement | null
/** Every title on the strip: none may say a window is still on its way. */
const titles = () => [...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title') ?? '')

describe('the status strip decides each rate-limit window from its own field', () => {
  it('weekly only (a helper tab): the weekly bar shows 68% and its reset; the 5-hour one says not reported, never waiting', () => {
    helperTab(WEEKLY_ONLY)
    draw()
    expect(bar('Weekly')?.getAttribute('aria-valuenow')).toBe('68')
    const weekly = bar('Weekly')!.parentElement!
    expect(weekly.textContent).toContain('68%')
    expect(weekly.textContent).toMatch(/resets /)
    expect(weekly.getAttribute('title')).toMatch(/^Weekly window .*resets /)
    expect(notReported()?.textContent).toBe('5h:not reported')
    expect(notReported()?.getAttribute('title')).toBe('Claude Code reported no 5-hour window for this account')
    expect(bar('5h')).toBeNull()
    expect(pending().length).toBe(0)
    expect(container.querySelector('[data-testid="statusline-pending"]')).toBeNull()
    expect(titles().some((t) => /waiting/i.test(t))).toBe(false)
    expect(container.textContent).not.toContain('--%')
  })

  it('weekly only with no provider set: the title names Claude Code, as the strip treats an unset provider as Claude', () => {
    localTab(WEEKLY_ONLY)
    delete sessionState.sessions[0].provider
    draw()
    expect(notReported()?.getAttribute('title')).toBe('Claude Code reported no 5-hour window for this account')
  })

  it('weekly only on a local tab reads the same (the strip is one for every kind of tab)', () => {
    localTab(WEEKLY_ONLY)
    draw()
    expect(bar('Weekly')?.getAttribute('aria-valuenow')).toBe('68')
    expect(notReported()).not.toBeNull()
    expect(pending().length).toBe(0)
  })

  it('neither field yet: both windows wait, as before', () => {
    helperTab({ usageBuckets: [] })
    draw()
    expect([...pending()].map((p) => p.getAttribute('title'))).toEqual([
      `5h window ${String.fromCharCode(0x2014)} waiting for the status line`,
      `Weekly window ${String.fromCharCode(0x2014)} waiting for the status line`,
    ])
    expect(notReported()).toBeNull()
  })

  it('both fields: both figures, as before', () => {
    helperTab({ rateLimitCurrent: 23, rateLimitCurrentResets: '2026-11-26T20:00:00.000Z', ...WEEKLY_ONLY })
    draw()
    expect(bar('5h')?.getAttribute('aria-valuenow')).toBe('23')
    expect(bar('Weekly')?.getAttribute('aria-valuenow')).toBe('68')
    expect(notReported()).toBeNull()
    expect(pending().length).toBe(0)
  })

  it('a hidden 5-hour window stays hidden when it is not reported', () => {
    helperTab(WEEKLY_ONLY)
    settingsState.settings.hiddenUsageBuckets = ['5h']
    draw()
    expect(notReported()).toBeNull()
    expect(bar('Weekly')?.getAttribute('aria-valuenow')).toBe('68')
  })
})
