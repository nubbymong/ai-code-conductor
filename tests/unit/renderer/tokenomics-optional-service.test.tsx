// @vitest-environment jsdom
/**
 * 2.1.3-beta.4: Tokenomics as an optional service, as the user meets it.
 *
 * The Tokenomics page: switched off in Settings it says "Tokenomics is off",
 * offers Turn on, and asks main for nothing. Turned on, here or in Settings
 * while the page tab is open, it starts and shows what was recorded before
 * as soon as the worker says what the index holds. Rescan asks first, then
 * reads everything again while the figures stay up. A change to the accounts
 * left out asks for the figures again. Main's own word that it is off shows
 * the off panel too, whatever the settings here say. The GitHub Copilot
 * billing card stays while Tokenomics is off. A start that is let go before
 * main has answered leaves no listener behind.
 *
 * Settings, General, Tokenomics: the switch (on by default) and the accounts
 * the figures leave out, with the plain statement that leaving one out saves
 * no disk work.
 *
 * Review fixes: a saved list of accounts left out that is not a list of
 * account keys is read as main reads it, so neither the page nor Settings
 * breaks on it. An Account filter on an account left out while the page was
 * closed, or while Tokenomics was off, is let go before the page asks for
 * anything. A session detail cached from before is not shown again, and an
 * open one is asked for again when the accounts left out change. Settings
 * asks for the list of accounts again when a pass completes.
 *
 * Host-safe: jsdom and the real stores; the preload API is faked and the
 * dashboard's parts are stand-ins.
 */
import { createElement, type ReactNode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot } from '../../../src/shared/providers'
import type { TkAccountPresent, TkIndexStatus, TkSessionDetail, TkSummary } from '../../../src/shared/types'
import { tkExcludedAccounts } from '../../../src/main/tokenomics/tk-types'

// A stand-in for one part of the dashboard. Hoisted, as the mocks below are;
// it draws only when the page renders, by which time React is loaded.
const part = vi.hoisted(() => (name: string) => () => createElement('div', { 'data-part': name }))
vi.mock('../../../src/renderer/components/tokenomics/KpiRow', () => ({ KpiRow: part('kpi') }))
vi.mock('../../../src/renderer/components/tokenomics/CostOverTimeChart', () => ({ CostOverTimeChart: part('chart') }))
vi.mock('../../../src/renderer/components/tokenomics/ModelCacheDonut', () => ({ ModelCacheDonut: part('donut') }))
vi.mock('../../../src/renderer/components/tokenomics/CostByConfig', () => ({ CostByConfig: part('by-config') }))
vi.mock('../../../src/renderer/components/tokenomics/SessionsTable', () => ({ SessionsTable: part('sessions') }))
vi.mock('../../../src/renderer/components/tokenomics/SessionDetailDrawer', () => ({ SessionDetailDrawer: part('drawer') }))
vi.mock('../../../src/renderer/components/tokenomics/ActivityHeatmap', () => ({ ActivityHeatmap: part('heatmap') }))
vi.mock('../../../src/renderer/components/tokenomics/FilterBar', () => ({ FilterBar: part('filters') }))
vi.mock('../../../src/renderer/components/tokenomics/GitHubCopilotCard', () => ({ GitHubCopilotCard: part('copilot') }))
vi.mock('../../../src/renderer/components/tokenomics/IndexingState', () => ({ IndexingState: part('indexing') }))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../src/renderer/components/sentinel/CompatBadge', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/SettingsPage', () => ({
  Section: ({ children, testId, title }: { children: ReactNode; testId?: string; title: string }) =>
    createElement('section', { 'data-testid': testId, 'data-title': title }, children),
}))

import TokenomicsPage from '../../../src/renderer/components/TokenomicsPage'
import { TokenomicsSettings } from '../../../src/renderer/components/settings/TokenomicsSettings'
import { TK_RESCAN_CONFIRM, TK_RESCAN_NOTICE } from '../../../src/renderer/components/tokenomics/tk-labels'
import { useTokenomicsStore } from '../../../src/renderer/stores/tokenomicsStore'
import { useSettingsStore, DEFAULT_SETTINGS, tokenomicsExcludedAccountsOf } from '../../../src/renderer/stores/settingsStore'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const A_WORK = 'acct-' + 'a'.repeat(32)
const A_HOME = 'acct-' + 'b'.repeat(32)
const KEY_WORK = `claude:${A_WORK}`
const KEY_HOME = `claude:${A_HOME}`
const SNAPSHOT = {
  revision: 1,
  providers: [],
  identities: [
    { id: 'id-work', friendlyName: 'Work', colourKey: 'slate-blue' },
    { id: 'id-home', friendlyName: 'Home', colourKey: 'pink' },
  ],
  accounts: [
    { id: A_WORK, providerId: 'claude', identityId: 'id-work', lifecycle: 'active', authMethod: 'browser', external: false },
    { id: A_HOME, providerId: 'claude', identityId: 'id-home', lifecycle: 'active', authMethod: 'browser', external: false },
  ],
} as unknown as AccountsSnapshot
const PRESENT: TkAccountPresent[] = [
  { provider: 'claude', accountKey: '' },
  { provider: 'claude', accountKey: KEY_WORK },
  { provider: 'claude', accountKey: KEY_HOME },
]
// The token figures (2.1.3-beta.4) are not what these cases test, so none.
const T0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
const K = (v: number) => ({ lifeToDateCostUsd: v, last7dCostUsd: v / 10, prev7dCostUsd: v / 20, cacheEfficiencyPct: 50, cacheSavingsUsd: 1, lifeToDateTokens: T0, last7dTokens: T0 })
const SUMMARY: TkSummary = {
  kpis: K(20),
  // One provider has usage here, so the split by provider is never read.
  kpisByProvider: {} as TkSummary['kpisByProvider'],
  dailySeries: [],
  modelSplit: [],
  unpriced: [],
  cacheSplit: { inputUsd: 1, outputUsd: 1, cacheReadUsd: 1, cacheCreateUsd: 1 },
  costByConfig: [],
  heatmap: [],
}
const COMPLETE: TkIndexStatus = { firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 1, lastIndexAt: 1 }
/** As main answers while a worker just forked has not said it is ready. */
const NOT_READY: TkIndexStatus = { firstIndexComplete: false, indexing: true, filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null }
/** As main answers while Tokenomics is off there. */
const MAIN_OFF: TkIndexStatus = { firstIndexComplete: false, indexing: false, filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null, off: true }
/** A GitHub Copilot billing report, as far as the page looks at it: there is one. */
const COPILOT_REPORT = { fetchedAt: 1 }
/** One session's detail, as main answers it. */
const DETAIL: TkSessionDetail = {
  sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', provider: 'claude', configId: null, configLabel: 'External / no config',
  model: 'claude-opus-4-8', costUsd: 15, unpricedTokens: 0, inTok: 3_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0,
  msgCount: 3, lastTs: 2, accountKey: KEY_WORK, firstTs: 1, projectDir: '/proj', byModel: [],
}

type StatusCb = (s: TkIndexStatus) => void
type CompleteCb = (c: { firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }) => void
let pushStatus: StatusCb = () => {}
let pushComplete: CompleteCb = () => {}
const unsubs = { status: vi.fn(), progress: vi.fn(), complete: vi.fn() }
const api = {
  indexStatus: vi.fn(async (): Promise<TkIndexStatus> => COMPLETE),
  onIndexStatus: vi.fn((cb: StatusCb) => { pushStatus = cb; return unsubs.status }),
  onIndexProgress: vi.fn(() => unsubs.progress),
  onIndexComplete: vi.fn((cb: CompleteCb) => { pushComplete = cb; return unsubs.complete }),
  // The filter the page asks with, typed so a case can read it back.
  summary: vi.fn(async (_filter?: unknown) => SUMMARY),
  sessions: vi.fn(async () => ({ rows: [], nextCursor: null })),
  accounts: vi.fn(async (_opts?: { includeExcluded?: boolean }) => PRESENT),
  sessionDetail: vi.fn(async (_sessionId: string): Promise<TkSessionDetail | null> => null),
  rescan: vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: 'off' | 'not-running' }> => ({ ok: true })),
}
const config = { save: vi.fn(async (_key: string, _data: unknown) => true) }
const github = { getAiUsage: vi.fn(async (_force?: boolean) => ({ report: COPILOT_REPORT, status: 'ok', cycle: null })) }
/** The settings object the last save carried. */
const lastSaved = (): Record<string, unknown> => config.save.mock.calls.at(-1)![1] as Record<string, unknown>

describe('Tokenomics as an optional service, on the page and in Settings (2.1.3-beta.4)', () => {
  let container: HTMLDivElement
  let root: Root
  const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
  /** For a chain of several answers from main, one after the other. */
  const settleAll = async (): Promise<void> => { for (let i = 0; i < 6; i++) await settle() }
  const parts = (name: string): number => container.querySelectorAll(`[data-part="${name}"]`).length
  const text = (): string => container.textContent ?? ''
  const q = (testId: string): HTMLElement | null => container.querySelector(`[data-testid="${testId}"]`)
  const hasPart = (name: string): boolean => container.querySelector(`[data-part="${name}"]`) !== null
  const setSettings = (over: Record<string, unknown>): void => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } as typeof DEFAULT_SETTINGS, isLoaded: true })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), tokenomics: api, config, github }
    for (const f of [api.indexStatus, api.onIndexStatus, api.onIndexProgress, api.onIndexComplete, api.summary, api.sessions, api.accounts, api.sessionDetail, api.rescan, config.save, github.getAiUsage, unsubs.status, unsubs.progress, unsubs.complete]) f.mockClear()
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending', aiUsageCycle: null })
    api.indexStatus.mockImplementation(async () => COMPLETE)
    api.sessionDetail.mockImplementation(async () => null)
    api.rescan.mockImplementation(async () => ({ ok: true }))
    api.accounts.mockImplementation(async () => PRESENT)
    pushStatus = () => {}
    pushComplete = () => {}
    useProviderAccountsStore.setState({ snapshot: SNAPSHOT, loaded: true })
    useTokenomicsStore.setState({ summary: null, accounts: [], indexStatus: null, filter: { range: 'all' }, sessions: [], selected: null, nextCursor: null, error: null, rescanning: false, _unsubs: [] })
    setSettings({})
    ;(window as any).confirm = vi.fn(() => true)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  describe('the Tokenomics page', () => {
    it('switched off, says so, offers Turn on, and asks main for nothing', async () => {
      setSettings({ tokenomicsEnabled: false })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(q('tk-off')).not.toBeNull()
      expect(text()).toContain('Tokenomics is off')
      expect(q('tk-turn-on')!.textContent).toBe('Turn on')
      expect(hasPart('kpi')).toBe(false)
      expect(hasPart('indexing')).toBe(false)
      for (const f of [api.indexStatus, api.onIndexStatus, api.onIndexProgress, api.onIndexComplete, api.summary, api.sessions, api.accounts]) expect(f).not.toHaveBeenCalled()
    })

    it('on by default: the dashboard, with no off panel', async () => {
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(q('tk-off')).toBeNull()
      expect(hasPart('kpi')).toBe(true)
      expect(api.indexStatus).toHaveBeenCalledTimes(1)
    })

    it('Turn on saves the setting, starts the page, and shows what was recorded before as the worker comes up', async () => {
      setSettings({ tokenomicsEnabled: false })
      api.indexStatus.mockImplementation(async () => NOT_READY)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await act(async () => { q('tk-turn-on')!.click() })
      await settle()
      expect(config.save).toHaveBeenCalledTimes(1)
      expect(config.save.mock.calls[0][0]).toBe('settings')
      expect(lastSaved().tokenomicsEnabled).toBe(true)
      // Started: the off panel is gone and the index is asked about.
      expect(q('tk-off')).toBeNull()
      expect(api.indexStatus).toHaveBeenCalledTimes(1)
      expect(hasPart('indexing')).toBe(true)
      expect(api.summary).not.toHaveBeenCalled()
      // The worker says what the index already holds: the figures load.
      await act(async () => { pushStatus(COMPLETE) })
      await settle()
      expect(api.summary).toHaveBeenCalledTimes(1)
      expect(hasPart('indexing')).toBe(false)
      expect(hasPart('kpi')).toBe(true)
    })

    it('switched off in Settings while the page tab is open: the off panel, and its listeners are let go', async () => {
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(hasPart('kpi')).toBe(true)
      await act(async () => { setSettings({ tokenomicsEnabled: false }) })
      expect(q('tk-off')).not.toBeNull()
      expect(hasPart('kpi')).toBe(false)
      for (const u of [unsubs.status, unsubs.progress, unsubs.complete]) expect(u).toHaveBeenCalledTimes(1)
      // And on again in Settings: it starts once more.
      await act(async () => { setSettings({ tokenomicsEnabled: true }) })
      await settle()
      expect(q('tk-off')).toBeNull()
      expect(api.indexStatus).toHaveBeenCalledTimes(2)
    })

    it('Rescan asks first; declined, nothing is read again', async () => {
      ;(window as any).confirm = vi.fn(() => false)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      await act(async () => { q('tk-rescan')!.click() })
      await settle()
      expect((window as any).confirm).toHaveBeenCalledWith(TK_RESCAN_CONFIRM)
      expect(api.rescan).not.toHaveBeenCalled()
      expect(text()).not.toContain(TK_RESCAN_NOTICE)
    })

    it('Rescan, confirmed: asked of main once, the figures stay up with a notice, and a finished pass ends it', async () => {
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      const button = q('tk-rescan') as HTMLButtonElement
      expect(button.textContent).toBe('Rescan')
      await act(async () => { button.click() })
      await settle()
      expect(api.rescan).toHaveBeenCalledTimes(1)
      expect(text()).toContain(TK_RESCAN_NOTICE)
      expect(hasPart('kpi')).toBe(true)
      expect((q('tk-rescan') as HTMLButtonElement).disabled).toBe(true)
      expect(q('tk-rescan')!.textContent).toBe('Rescanning')
      // A pass that left work behind does not end it; one that read every
      // file to its end does.
      await act(async () => { pushComplete({ firstIndex: false, drained: false, filesFailed: 0, eventsTotal: 1 }) })
      await settle()
      expect(text()).toContain(TK_RESCAN_NOTICE)
      await act(async () => { pushComplete({ firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 1 }) })
      await settle()
      expect(text()).not.toContain(TK_RESCAN_NOTICE)
      expect((q('tk-rescan') as HTMLButtonElement).disabled).toBe(false)
    })

    it('a Rescan main could not start leaves the page as it was', async () => {
      api.rescan.mockImplementation(async () => ({ ok: false, reason: 'not-running' }))
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      await act(async () => { q('tk-rescan')!.click() })
      await settle()
      expect(useTokenomicsStore.getState().rescanning).toBe(false)
      expect(text()).not.toContain(TK_RESCAN_NOTICE)
    })

    it('the accounts left out changed while the page is open: the figures are asked for again, and a filter on one now left out is let go', async () => {
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(api.summary).toHaveBeenCalledTimes(1)
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [KEY_HOME] }) })
      await settle()
      expect(api.summary).toHaveBeenCalledTimes(2)
      // A filter on the account that is then left out.
      await act(async () => { useTokenomicsStore.getState().setAccount({ provider: 'claude', key: KEY_WORK }) })
      await settle()
      const before = api.summary.mock.calls.length
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [KEY_HOME, KEY_WORK] }) })
      await settle()
      expect(useTokenomicsStore.getState().filter.account).toBeUndefined()
      expect(api.summary.mock.calls.length).toBe(before + 1)
      expect(api.summary.mock.calls.at(-1)![0]).toEqual({})
      // A filter on usage recorded to no account is not one left out.
      await act(async () => { useTokenomicsStore.getState().setAccount({ provider: 'claude', key: '' }) })
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [] }) })
      await settle()
      expect(useTokenomicsStore.getState().filter.account).toEqual({ provider: 'claude', key: '' })
    })

    // The filter outlives the page (the store is the app's). An account left
    // out while the page was closed used to stay chosen: the page asked for
    // an account left out and showed empty figures for one the Account
    // filter no longer lists.
    it('an Account filter on an account left out while the page was closed is let go before the page asks for anything; one still kept stays', async () => {
      useTokenomicsStore.setState({ filter: { range: 'all', account: { provider: 'claude', key: KEY_WORK } } })
      setSettings({ tokenomicsExcludedAccounts: [KEY_WORK] })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(useTokenomicsStore.getState().filter.account).toBeUndefined()
      expect(api.summary).toHaveBeenCalledTimes(1)
      expect(api.summary.mock.calls[0]).toEqual([{}])

      act(() => { root.render(createElement('div')) })
      api.summary.mockClear()
      useTokenomicsStore.setState({ filter: { range: 'all', account: { provider: 'claude', key: KEY_HOME } } })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(useTokenomicsStore.getState().filter.account).toEqual({ provider: 'claude', key: KEY_HOME })
      expect(api.summary.mock.calls).toEqual([[{ provider: 'claude', accountKey: KEY_HOME }]])
    })

    it('an Account filter on an account left out while Tokenomics was off, with the page tab open, is let go as it is switched on', async () => {
      setSettings({ tokenomicsEnabled: false })
      useTokenomicsStore.setState({ filter: { range: 'all', account: { provider: 'claude', key: KEY_WORK } } })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      await act(async () => { setSettings({ tokenomicsEnabled: false, tokenomicsExcludedAccounts: [KEY_WORK] }) })
      await settle()
      expect(api.summary).not.toHaveBeenCalled()
      await act(async () => { setSettings({ tokenomicsEnabled: true, tokenomicsExcludedAccounts: [KEY_WORK] }) })
      await settleAll()
      expect(useTokenomicsStore.getState().filter.account).toBeUndefined()
      expect(api.summary.mock.calls).toEqual([[{}]])
    })

    it('a session detail cached from an earlier visit is not shown when the page opens again', async () => {
      useTokenomicsStore.setState({ selected: DETAIL })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(useTokenomicsStore.getState().selected).toBeNull()
    })

    it('the accounts left out change with a session open: its detail is asked for again under them, and closed once nothing of it is left', async () => {
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      api.sessionDetail.mockImplementationOnce(async () => DETAIL)
      await act(async () => { await useTokenomicsStore.getState().selectSession(DETAIL.sessionId) })
      expect(useTokenomicsStore.getState().selected).toEqual(DETAIL)
      // Some of it is left out: the detail shows what is kept.
      const KEPT = { ...DETAIL, costUsd: 5, msgCount: 1, inTok: 1_000_000 }
      api.sessionDetail.mockImplementationOnce(async () => KEPT)
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [KEY_HOME] }) })
      await settleAll()
      expect(api.sessionDetail).toHaveBeenCalledTimes(2)
      expect(api.sessionDetail).toHaveBeenLastCalledWith(DETAIL.sessionId)
      expect(useTokenomicsStore.getState().selected).toEqual(KEPT)
      // All of it left out: main has no detail for it, and the drawer closes.
      api.sessionDetail.mockImplementationOnce(async () => null)
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [KEY_HOME, KEY_WORK] }) })
      await settleAll()
      expect(api.sessionDetail).toHaveBeenCalledTimes(3)
      expect(useTokenomicsStore.getState().selected).toBeNull()
      // With nothing open, nothing is asked for.
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [] }) })
      await settleAll()
      expect(api.sessionDetail).toHaveBeenCalledTimes(3)

      // Closed while it is asked for again: the answer does not open it.
      api.sessionDetail.mockImplementationOnce(async () => DETAIL)
      await act(async () => { await useTokenomicsStore.getState().selectSession(DETAIL.sessionId) })
      let answer: (d: TkSessionDetail | null) => void = () => {}
      api.sessionDetail.mockImplementationOnce(() => new Promise<TkSessionDetail | null>((resolve) => { answer = resolve }))
      await act(async () => { setSettings({ tokenomicsExcludedAccounts: [KEY_HOME] }) })
      act(() => { useTokenomicsStore.getState().clearSelected() })
      await act(async () => { answer(KEPT) })
      await settleAll()
      expect(useTokenomicsStore.getState().selected).toBeNull()
    })
  })

  // Main reads the saved list with its own rule and ignores what is not an
  // account key. The window used to keep the value as it was saved, so a
  // saved string made the page throw, and a list holding a number made
  // Settings, General throw.
  describe('a saved list of accounts left out that is not one', () => {
    const boxes = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('[data-testid="settings-tokenomics-exclude"]')]
    const checked = (): Array<[string | null, boolean]> => boxes().map((b) => [b.getAttribute('data-account-key'), b.checked])
    /** As the app hydrates the settings it read, with the one-off
     *  migrations already done so nothing is saved. */
    const hydrate = (over: Record<string, unknown>): void => {
      useSettingsStore.getState().hydrate({ ...DEFAULT_SETTINGS, fontMigratedV2: true, gpuDefaultOnMigrated: true, ...over } as typeof DEFAULT_SETTINGS)
    }

    it('a string: read as no account left out; the page renders, and Settings lists the accounts, not its letters', async () => {
      hydrate({ tokenomicsExcludedAccounts: KEY_HOME })
      expect(useSettingsStore.getState().settings.tokenomicsExcludedAccounts).toEqual([])
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(hasPart('kpi')).toBe(true)
      act(() => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(checked()).toEqual([[KEY_HOME, false], [KEY_WORK, false]])
    })

    it('[5, null]: read as no account left out; Settings renders its list', async () => {
      hydrate({ tokenomicsExcludedAccounts: [5, null] })
      expect(useSettingsStore.getState().settings.tokenomicsExcludedAccounts).toEqual([])
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(checked()).toEqual([[KEY_HOME, false], [KEY_WORK, false]])
    })

    it('a list with some account keys in it: those are kept, once each, and the rest dropped; the page and Settings go by them', async () => {
      hydrate({ tokenomicsExcludedAccounts: [5, KEY_WORK, null, 'bogus', '', KEY_WORK, { key: KEY_HOME }] })
      expect(useSettingsStore.getState().settings.tokenomicsExcludedAccounts).toEqual([KEY_WORK])
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(checked()).toEqual([[KEY_HOME, false], [KEY_WORK, true]])
      act(() => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(hasPart('kpi')).toBe(true)
    })

    it('a saved file without the key: nothing is added to it', () => {
      hydrate({})
      expect(Object.hasOwn(useSettingsStore.getState().settings, 'tokenomicsExcludedAccounts')).toBe(false)
    })

    it('the rule is main\'s: for each value, the same accounts as main reads', () => {
      const many = Array.from({ length: 70 }, (_, i) => `claude:acct-${i}`)
      const values: unknown[] = [
        undefined, null, 5, KEY_WORK, {}, { 0: KEY_WORK }, [], [5, null], [KEY_WORK], ['', KEY_WORK, KEY_WORK, KEY_HOME],
        ['bogus', 'claude:', 'claude:a b', 'claude:a:b', `claude:${'x'.repeat(128)}`, `claude:${'x'.repeat(129)}`, 'gemini:abc', ' claude:abc', 'claude:abc '],
        many,
      ]
      for (const v of values) expect(tokenomicsExcludedAccountsOf(v), JSON.stringify(v)).toEqual(tkExcludedAccounts(v))
      expect(tokenomicsExcludedAccountsOf(many)).toHaveLength(64)
    })
  })

  describe('the page and main disagree, or the page is let go early', () => {
    // The settings in this window say on, main says off: a save that did
    // not reach it, or settings it could not read as it came up. The page
    // used to wait on "Indexing usage data" for an index that was not running.
    it('main says it is off: the off panel, not "Indexing"; Turn on saves the setting again and asks main, and the figures load', async () => {
      api.indexStatus.mockImplementation(async () => MAIN_OFF)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(q('tk-off')).not.toBeNull()
      expect(hasPart('indexing')).toBe(false)
      expect(hasPart('kpi')).toBe(false)
      expect(api.summary).not.toHaveBeenCalled()
      // Started all the same, so what main says when it comes up is heard.
      expect(api.onIndexStatus).toHaveBeenCalledTimes(1)

      api.indexStatus.mockImplementation(async () => COMPLETE)
      await act(async () => { q('tk-turn-on')!.click() })
      await settleAll()
      // Saved again, although it was on here already.
      expect(config.save).toHaveBeenCalledTimes(1)
      expect(lastSaved().tokenomicsEnabled).toBe(true)
      expect(api.indexStatus).toHaveBeenCalledTimes(2)
      expect(q('tk-off')).toBeNull()
      expect(api.summary).toHaveBeenCalledTimes(1)
      expect(hasPart('kpi')).toBe(true)
    })

    it('main still says it is off after Turn on: the off panel stays, and nothing waits', async () => {
      api.indexStatus.mockImplementation(async () => MAIN_OFF)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      await act(async () => { q('tk-turn-on')!.click() })
      await settleAll()
      expect(api.indexStatus).toHaveBeenCalledTimes(2)
      expect(q('tk-off')).not.toBeNull()
      expect(hasPart('indexing')).toBe(false)
      expect(api.summary).not.toHaveBeenCalled()
    })

    it('main says it is off and then comes up: its status ends the off panel and the figures load', async () => {
      api.indexStatus.mockImplementation(async () => MAIN_OFF)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settle()
      expect(q('tk-off')).not.toBeNull()
      await act(async () => { pushStatus(COMPLETE) })
      await settle()
      expect(q('tk-off')).toBeNull()
      expect(api.summary).toHaveBeenCalledTimes(1)
      expect(hasPart('kpi')).toBe(true)
    })

    // GitHub Copilot billing is GitHub's own figure, not the usage index's.
    it('switched off, the GitHub Copilot billing card stays under the off panel; with its meter off there is none', async () => {
      setSettings({ tokenomicsEnabled: false, githubAiUsageEnabled: true })
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(github.getAiUsage).toHaveBeenCalledTimes(1)
      expect(q('tk-off')).not.toBeNull()
      expect(parts('copilot')).toBe(1)
      expect(hasPart('kpi')).toBe(false)
      // Nothing of Tokenomics is asked for it.
      for (const f of [api.indexStatus, api.summary, api.sessions, api.accounts]) expect(f).not.toHaveBeenCalled()
      // The meter off: no card.
      await act(async () => { setSettings({ tokenomicsEnabled: false, githubAiUsageEnabled: false }) })
      await settle()
      expect(q('tk-off')).not.toBeNull()
      expect(parts('copilot')).toBe(0)
    })

    it('main says it is off: the GitHub Copilot billing card stays there too, and on the dashboard it shows once', async () => {
      setSettings({ githubAiUsageEnabled: true })
      api.indexStatus.mockImplementation(async () => MAIN_OFF)
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await settleAll()
      expect(q('tk-off')).not.toBeNull()
      expect(parts('copilot')).toBe(1)
      await act(async () => { pushStatus(COMPLETE) })
      await settleAll()
      expect(q('tk-off')).toBeNull()
      expect(hasPart('kpi')).toBe(true)
      expect(parts('copilot')).toBe(1)
    })

    // Switched on and off again before main has answered the first
    // question. The start used to go on and subscribe after it had been let
    // go: three listeners left on while off, and three more at the next on.
    it('switched on and then off before main has answered: nothing is subscribed, and the next on subscribes once', async () => {
      setSettings({ tokenomicsEnabled: false })
      let answer: (s: TkIndexStatus) => void = () => {}
      api.indexStatus.mockImplementationOnce(() => new Promise<TkIndexStatus>((resolve) => { answer = resolve }))
      await act(async () => { root.render(createElement(TokenomicsPage)) })
      await act(async () => { setSettings({ tokenomicsEnabled: true }) })
      expect(api.indexStatus).toHaveBeenCalledTimes(1)
      await act(async () => { setSettings({ tokenomicsEnabled: false }) })
      // Main answers now, after the page was let go.
      await act(async () => { answer(COMPLETE) })
      await settleAll()
      for (const f of [api.onIndexStatus, api.onIndexProgress, api.onIndexComplete]) expect(f).not.toHaveBeenCalled()
      expect(api.summary).not.toHaveBeenCalled()
      expect(useTokenomicsStore.getState()._unsubs).toHaveLength(0)
      expect(q('tk-off')).not.toBeNull()

      // On again: one set of listeners, and one refresh for a finished pass.
      await act(async () => { setSettings({ tokenomicsEnabled: true }) })
      await settleAll()
      for (const f of [api.onIndexStatus, api.onIndexProgress, api.onIndexComplete]) expect(f).toHaveBeenCalledTimes(1)
      expect(useTokenomicsStore.getState()._unsubs).toHaveLength(3)
      const before = api.summary.mock.calls.length
      await act(async () => { pushComplete({ firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 1 }) })
      await settleAll()
      expect(api.summary.mock.calls.length).toBe(before + 1)
      // Off: each of the three is let go, once.
      await act(async () => { setSettings({ tokenomicsEnabled: false }) })
      for (const u of [unsubs.status, unsubs.progress, unsubs.complete]) expect(u).toHaveBeenCalledTimes(1)
    })
  })

  describe('Settings, General, Tokenomics', () => {
    const boxes = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('[data-testid="settings-tokenomics-exclude"]')]
    const labelOf = (box: HTMLInputElement): string => box.closest('label')!.textContent ?? ''

    it('the switch is on by default; turning it off saves that, and says what off means', async () => {
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      const box = q('settings-tokenomics-enabled') as HTMLInputElement
      expect(box.checked).toBe(true)
      expect(q('settings-tokenomics')!.getAttribute('data-title')).toBe('Tokenomics')
      expect(text()).toContain('what was recorded before is kept')
      expect(text()).toContain('picks up from where it stopped')
      await act(async () => { box.click() })
      await settle()
      expect(config.save).toHaveBeenCalledTimes(1)
      expect(lastSaved().tokenomicsEnabled).toBe(false)
      expect((q('settings-tokenomics-enabled') as HTMLInputElement).checked).toBe(false)
    })

    it('lists the accounts with recorded usage, the ones left out included, by name; usage recorded to no account is not one', async () => {
      setSettings({ tokenomicsExcludedAccounts: [KEY_HOME] })
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(api.accounts).toHaveBeenCalledWith({ includeExcluded: true })
      expect(boxes().map((b) => [labelOf(b), b.checked])).toEqual([['Claude Code: Home', true], ['Claude Code: Work', false]])
      // The statement the plan asks for: it filters the figures only.
      expect(text()).toContain('it saves no disk work')
      // And what can never be left out: usage recorded to no account.
      expect(text()).toContain('Usage that was not recorded to an account stays in the figures')
    })

    it('ticking an account leaves it out, unticking puts it back', async () => {
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      const work = (): HTMLInputElement => boxes().find((b) => b.getAttribute('data-account-key') === KEY_WORK)!
      await act(async () => { work().click() })
      await settle()
      expect(lastSaved().tokenomicsExcludedAccounts).toEqual([KEY_WORK])
      expect(work().checked).toBe(true)
      await act(async () => { work().click() })
      await settle()
      expect(lastSaved().tokenomicsExcludedAccounts).toEqual([])
      expect(work().checked).toBe(false)
    })

    it('switched off, nothing is asked of main, and an account left out can still be put back', async () => {
      setSettings({ tokenomicsEnabled: false, tokenomicsExcludedAccounts: [KEY_WORK] })
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(api.accounts).not.toHaveBeenCalled()
      expect(boxes().map((b) => [labelOf(b), b.checked])).toEqual([['Claude Code: Work', true]])
      await act(async () => { boxes()[0].click() })
      await settle()
      expect(lastSaved().tokenomicsExcludedAccounts).toEqual([])
    })

    it('just switched on, the list is asked for again when the worker says it is up', async () => {
      api.accounts.mockImplementationOnce(async () => { throw new Error('tokenomics worker not ready') })
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(boxes()).toHaveLength(0)
      await act(async () => { pushStatus(COMPLETE) })
      await settle()
      expect(api.accounts).toHaveBeenCalledTimes(2)
      expect(boxes()).toHaveLength(2)
    })

    // On an index that was empty, the worker is ready before any account is
    // recorded, and the pass that records them says so as it completes, not
    // in a status push. The list used to wait for Settings to be opened again.
    it('an index that was empty: the accounts its pass records become choices as the pass completes, and the listeners are let go on leaving', async () => {
      api.accounts.mockImplementationOnce(async () => [])
      await act(async () => { root.render(createElement(TokenomicsSettings)) })
      await settle()
      expect(boxes()).toHaveLength(0)
      expect(text()).toContain('Accounts appear here once usage has been recorded for them.')
      await act(async () => { pushComplete({ firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 3 }) })
      await settle()
      expect(api.accounts).toHaveBeenCalledTimes(2)
      expect(api.accounts).toHaveBeenLastCalledWith({ includeExcluded: true })
      expect(boxes()).toHaveLength(2)
      act(() => { root.render(createElement('div')) })
      expect(unsubs.status).toHaveBeenCalledTimes(1)
      expect(unsubs.complete).toHaveBeenCalledTimes(1)
    })
  })
})
