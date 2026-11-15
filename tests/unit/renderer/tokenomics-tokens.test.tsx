// @vitest-environment jsdom
/**
 * 2.1.3-beta.4: token counts on the Tokenomics page. The headline row shows
 * the tokens beside the life-to-date and last-seven-days costs, compactly,
 * with their parts in a tooltip; a summary without them shows none, never a
 * zero. The chart over time has a Cost or Tokens switch, on Cost at first:
 * Tokens plots each day's tokens with the same split by provider, its own
 * series (a provider whose usage has no price has tokens and no cost), its
 * own title, tooltips and top label (none for a range of zeros). Host-safe:
 * jsdom only.
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { TkKpis, TkSummary, TkTokenTotals } from '../../../src/shared/types'
import { KpiRow } from '../../../src/renderer/components/tokenomics/KpiRow'
import { CostOverTimeChart } from '../../../src/renderer/components/tokenomics/CostOverTimeChart'
import { tkSeriesInRange, tkTokenBreakdown } from '../../../src/renderer/components/tokenomics/tk-labels'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const T = (input: number, output: number, cacheRead: number, cacheWrite: number): TkTokenTotals =>
  ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite })
const K = (cost: number, life: TkTokenTotals, week: TkTokenTotals): TkKpis => ({
  lifeToDateCostUsd: cost, last7dCostUsd: cost / 10, prev7dCostUsd: cost / 20, cacheEfficiencyPct: 50, cacheSavingsUsd: 1,
  lifeToDateTokens: life, last7dTokens: week,
})
const DAILY: TkSummary['dailySeries'] = [
  { day: '2026-09-25', costUsd: 10, byProvider: { claude: 10, codex: 0 }, tokens: T(1_000_000, 200_000, 0, 0), tokensByProvider: { claude: 700_000, codex: 500_000 } },
  { day: '2026-09-26', costUsd: 12, byProvider: { claude: 12, codex: 0 }, tokens: T(2_000_000, 400_000, 1_000_000, 0), tokensByProvider: { claude: 3_000_000, codex: 400_000 } },
]

describe('token counts on the page (2.1.3-beta.4)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  const render = (el: ReturnType<typeof createElement>) => act(() => { root.render(el) })
  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

  it('the headline row shows the tokens beside the life-to-date and last-seven-days costs, compactly, with their parts in the tooltip', () => {
    render(createElement(KpiRow, { kpis: K(1284.4, T(10_000_000, 2_000_000, 300_000_000, 4_000_000), T(1_200_000, 30_000, 0, 999)) }))
    const life = byTestId('tk-kpi-tokens-life')!
    const week = byTestId('tk-kpi-tokens-7d')!
    expect(life.textContent).toBe('316.0M tokens')
    expect(week.textContent).toBe('1.2M tokens')
    expect(life.getAttribute('title')).toBe('Input 10.0M, output 2.0M, cache read 300.0M, cache write 4.0M')
    expect(week.getAttribute('title')).toBe('Input 1.2M, output 30.0k, cache read 0, cache write 999')
    // Beside its cost: in the same card, after the figure.
    const lifeCard = life.closest('.rounded-xl') as HTMLElement
    expect(lifeCard.textContent).toContain('Life-to-date')
    expect(lifeCard.textContent!.indexOf('$1.3k')).toBeLessThan(lifeCard.textContent!.indexOf('316.0M tokens'))
    expect((week.closest('.rounded-xl') as HTMLElement).textContent).toContain('Last 7 days')
    // The cache card has no token figure of its own.
    expect(container.querySelectorAll('[data-testid^="tk-kpi-tokens-"]')).toHaveLength(2)
  })

  it('a summary without the token figures shows none, never a zero', () => {
    const { lifeToDateTokens: _l, last7dTokens: _w, ...costsOnly } = K(5, T(1, 1, 1, 1), T(1, 1, 1, 1))
    render(createElement(KpiRow, { kpis: costsOnly as TkKpis }))
    expect(container.querySelectorAll('[data-testid^="tk-kpi-tokens-"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('tokens')
    // None counted is a real zero, and says so.
    render(createElement(KpiRow, { kpis: K(0, T(0, 0, 0, 0), T(0, 0, 0, 0)) }))
    expect(byTestId('tk-kpi-tokens-life')?.textContent).toBe('0 tokens')
  })

  it('the chart starts on Cost, and the switch plots tokens instead: its title, tooltips, top label and dots', () => {
    render(createElement(CostOverTimeChart, { data: DAILY }))
    const group = byTestId('tk-chart-metric')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Chart shows')
    const buttons = () => [...group.querySelectorAll('button')]
    expect(buttons().map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Cost', 'true'], ['Tokens', 'false']])
    expect(byTestId('tk-chart-title')?.textContent).toBe('Cost over time')
    expect(byTestId('tk-chart-max')?.textContent).toBe('$12.0')
    expect([...container.querySelectorAll('title')].map((t) => t.textContent)).toEqual(['2026-09-25: $10.0', '2026-09-26: $12.0'])

    act(() => { buttons()[1].click() })
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(byTestId('tk-chart-title')?.textContent).toBe('Tokens over time')
    expect(byTestId('tk-chart-max')?.textContent).toBe('3.4M')
    expect([...container.querySelectorAll('title')].map((t) => t.textContent)).toEqual(['2026-09-25: 1.2M tokens', '2026-09-26: 3.4M tokens'])
    expect(container.querySelectorAll('circle')).toHaveLength(2)

    // And back.
    act(() => { buttons()[0].click() })
    expect(byTestId('tk-chart-title')?.textContent).toBe('Cost over time')
    expect(byTestId('tk-chart-max')?.textContent).toBe('$12.0')
  })

  it('the switch looks like the filter bar\'s: the accent on the one chosen, the page\'s own colour tokens', () => {
    render(createElement(CostOverTimeChart, { data: DAILY }))
    const [cost, tokens] = [...byTestId('tk-chart-metric')!.querySelectorAll('button')] as HTMLElement[]
    expect(cost.getAttribute('style')).toContain('var(--accent)')
    expect(cost.getAttribute('style')).toContain('var(--surface-base)')
    expect(tokens.getAttribute('style')).toContain('var(--surface-stage)')
    expect(tokens.getAttribute('style')).toContain('var(--text-secondary)')
    expect(cost.className).toBe('px-2.5 py-0.5 text-xs transition-colors')
  })

  it('on Tokens, the split is the token series: a provider with tokens and no cost is drawn', () => {
    // Codex has no cost here (no price), so the cost chart draws one line;
    // its tokens are drawn as their own series.
    const series = tkSeriesInRange(['claude', 'codex'], DAILY)
    const tokenSeries = tkSeriesInRange(['claude', 'codex'], DAILY, 'tokens')
    expect(series).toBeUndefined()
    expect(tokenSeries).toEqual(['claude', 'codex'])
    render(createElement(CostOverTimeChart, { data: DAILY, series, tokenSeries }))
    expect(byTestId('tk-cost-series-legend')).toBeNull()
    act(() => { (byTestId('tk-chart-metric')!.querySelectorAll('button')[1] as HTMLElement).click() })
    expect(byTestId('tk-cost-series-legend')?.textContent).toBe('Claude CodeCodex')
    expect(byTestId('tk-cost-series-claude')).not.toBeNull()
    expect(byTestId('tk-cost-series-codex')).not.toBeNull()
    expect([...container.querySelectorAll('title')].map((t) => t.textContent)).toEqual([
      '2026-09-25: Claude Code 700.0k tokens, Codex 500.0k tokens',
      '2026-09-26: Claude Code 3.0M tokens, Codex 400.0k tokens',
    ])
  })

  it('a range of zeros has no top figure on either view: the drawing floor is never read as one', () => {
    const none = { claude: 0, codex: 0 }
    const zeros: TkSummary['dailySeries'] = DAILY.map((d) => ({ ...d, costUsd: 0, byProvider: none, tokens: T(0, 0, 0, 0), tokensByProvider: none }))
    render(createElement(CostOverTimeChart, { data: zeros }))
    const tokensButton = () => byTestId('tk-chart-metric')!.querySelectorAll('button')[1] as HTMLElement
    expect(byTestId('tk-chart-max')).toBeNull()
    act(() => { tokensButton().click() })
    expect(byTestId('tk-chart-max')).toBeNull()
    // Tokens with no cost: the Tokens view has its top figure, the Cost view none.
    render(createElement(CostOverTimeChart, { data: DAILY.map((d) => ({ ...d, costUsd: 0, byProvider: none })) }))
    expect(byTestId('tk-chart-max')?.textContent).toBe('3.4M')
    act(() => { (byTestId('tk-chart-metric')!.querySelectorAll('button')[0] as HTMLElement).click() })
    expect(byTestId('tk-chart-max')).toBeNull()
  })

  it('the token series follows the tokens in range, as the cost series follows the cost', () => {
    const claudeOnly: TkSummary['dailySeries'] = [{ ...DAILY[0], tokensByProvider: { claude: 5, codex: 0 } }]
    expect(tkSeriesInRange(['claude', 'codex'], claudeOnly, 'tokens')).toBeUndefined()
    expect(tkSeriesInRange(['claude', 'codex'], DAILY, 'cost')).toBeUndefined()
    expect(tkSeriesInRange(undefined, DAILY, 'tokens')).toBeUndefined()
    expect(tkTokenBreakdown(T(1, 2, 3, 4))).toBe('Input 1, output 2, cache read 3, cache write 4')
  })
})

// That the page hands the chart both series, and the headline row its token
// figures, is rendered on the page itself in tokenomics-page-renders.test.tsx.
