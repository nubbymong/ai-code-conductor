import React, { useLayoutEffect, useMemo, useState } from 'react'
import type { TkProvider, TkTokenTotals } from '../../../shared/types'
import { TK_PROVIDER_LABEL, TK_PROVIDER_COLOR, tkTokens } from './tk-labels'
import type { TkChartMetric } from './tk-labels'

interface DataPoint {
  day: string
  costUsd: number
  /** Usage track MP11/MP12: the day's cost per provider. */
  byProvider?: Partial<Record<TkProvider, number>>
  /** 2.1.3-beta.4: the day's tokens, and their total per provider. */
  tokens?: TkTokenTotals
  tokensByProvider?: Partial<Record<TkProvider, number>>
}

interface Props {
  data: DataPoint[]
  /** MP12 (Q1.4): the providers drawn as their own series of cost, when
   *  both have cost in these figures. */
  series?: TkProvider[]
  /** 2.1.3-beta.4: the same for tokens, when both have tokens here. */
  tokenSeries?: TkProvider[]
}

/** The chart's two-way switch, in the order it shows them. */
const METRICS: ReadonlyArray<{ value: TkChartMetric; label: string }> = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
]

function formatCostShort(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

/** The width the chart is laid out at until it is measured (and where
 *  there is no layout to measure). */
const DEFAULT_W = 460
/** The plot's height grows with its width, as the chart always has, within
 *  these bounds; the date labels sit in a strip below it. */
const MIN_PLOT_H = 110
const MAX_PLOT_H = 176
const LABEL_H = 18
/** Keeps the first and last dots inside the plot rather than half cut off. */
const PAD_X = 3
const AXIS_FONT_PX = 9
/** A generous width per character of an axis label (digits and '-'), so a
 *  label's estimated width is never narrower than the text drawn. */
const AXIS_CHAR_PX = AXIS_FONT_PX * 0.62
/** Clear space kept between two neighbouring axis labels. */
const AXIS_LABEL_GAP_PX = 12

/** A day's axis label: 'MM-DD', or the full 'YYYY-MM-DD' when the range
 *  crosses a year, so the labels read unambiguously. */
function formatDayLabel(day: string, withYear: boolean): string {
  return withYear ? day : day.slice(5)
}

/** The plot's height for a chart `width` px wide. */
function plotHeight(width: number): number {
  return Math.round(Math.min(MAX_PLOT_H, Math.max(MIN_PLOT_H, (width * MIN_PLOT_H) / DEFAULT_W)))
}

/** The x of point `i` of `n` on a plot `width` px wide. */
function pointX(i: number, n: number, width: number): number {
  return n === 1 ? width / 2 : PAD_X + (i / (n - 1)) * (width - 2 * PAD_X)
}

/** The y of a value `v` on a plot `plotH` px high whose top is `max`. */
function valueY(v: number, max: number, plotH: number): number {
  return plotH - (v / max) * plotH * 0.88 - 4
}

/**
 * Which points carry a date label, and where each label is centred, on a
 * plot `width` px wide whose labels are `labelPx` wide. Labels are evenly
 * spaced by index, centred on their point but kept inside the chart, and
 * never closer than a label width plus a gap to the one before; the last
 * point is labelled only when that fits.
 */
function axisLabelLayout(n: number, width: number, labelPx: number): Array<{ index: number; x: number }> {
  if (n <= 0) return []
  const half = labelPx / 2
  const centre = (i: number) => Math.min(Math.max(pointX(i, n, width), half), Math.max(half, width - half))
  if (n === 1) return [{ index: 0, x: centre(0) }]
  const spacing = labelPx + AXIS_LABEL_GAP_PX
  const perIndex = Math.max((width - 2 * PAD_X) / (n - 1), Number.EPSILON)
  // The first label is moved inward by up to half its width to stay in the
  // chart, so the stride leaves room for that too.
  const stride = Math.max(1, Math.ceil((spacing + half) / perIndex))
  const candidates: number[] = []
  for (let i = 0; i < n; i += stride) candidates.push(i)
  if (candidates[candidates.length - 1] !== n - 1) candidates.push(n - 1)
  const out: Array<{ index: number; x: number }> = []
  for (const index of candidates) {
    const x = centre(index)
    if (out.length === 0 || x - out[out.length - 1].x >= spacing) out.push({ index, x })
  }
  return out
}

/** What a point plots: its cost, or its tokens. */
function valueOf(d: DataPoint, metric: TkChartMetric): number {
  return (metric === 'tokens' ? d.tokens?.total : d.costUsd) ?? 0
}
/** A point's part for one provider, of what the chart plots. */
function partOf(d: DataPoint, p: TkProvider, metric: TkChartMetric): number {
  return (metric === 'tokens' ? d.tokensByProvider?.[p] : d.byProvider?.[p]) ?? 0
}
/** A value as the tooltips read it. */
function formatValue(v: number, metric: TkChartMetric): string {
  return metric === 'tokens' ? `${tkTokens(v)} tokens` : formatCostShort(v)
}

/**
 * Area + line chart of daily cost over time, built with inline SVG (no
 * external charting library). The SVG is drawn at the width it is given, one
 * unit to a pixel, so its text and dots are never stretched, and the date
 * labels are chosen to fit that width. A switch (2.1.3-beta.4) plots each
 * day's tokens instead, split by provider the same way; it starts on Cost
 * and is kept while the page stays open.
 */
export function CostOverTimeChart({ data, series, tokenSeries }: Props) {
  const [metric, setMetric] = useState<TkChartMetric>('cost')
  const chosen = metric === 'tokens' ? tokenSeries : series
  const split = chosen && chosen.length > 1 ? chosen : null

  // The width the chart is drawn at: measured, and re-measured on resize.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(DEFAULT_W)
  useLayoutEffect(() => {
    if (!frame) return
    const measure = () => {
      const w = frame.clientWidth
      if (w > 0) setWidth(w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(frame)
    return () => ro.disconnect()
  }, [frame])
  const plotH = plotHeight(width)
  const svgH = plotH + LABEL_H

  const { points, maxValue, peak } = useMemo(() => {
    if (!data || data.length === 0) return { points: [], maxValue: 0, peak: 0 }
    // The largest value in range, and the top of the scale drawn: the floor
    // keeps a range of zeros drawable (a tenth of a cent, or one token), and
    // is never read as a figure.
    const most = Math.max(0, ...data.map((d) => valueOf(d, metric)))
    const max = Math.max(most, metric === 'tokens' ? 1 : 0.001)
    const pts = data.map((d, i) => ({
      ...d,
      value: valueOf(d, metric),
      x: pointX(i, data.length, width),
      y: valueY(valueOf(d, metric), max, plotH),
    }))
    return { points: pts, maxValue: max, peak: most }
  }, [data, width, plotH, metric])

  // The date labels: the year when the range crosses one, spaced to fit.
  const { labelAt, withYear } = useMemo(() => {
    if (!data || data.length === 0) return { labelAt: new Map<number, number>(), withYear: false }
    const year = (d: { day: string }) => d.day.slice(0, 4)
    const crossesYear = year(data[0]) !== year(data[data.length - 1])
    const labelPx = (crossesYear ? 10 : 5) * AXIS_CHAR_PX
    const layout = axisLabelLayout(data.length, width, labelPx)
    return { labelAt: new Map(layout.map((l) => [l.index, l.x])), withYear: crossesYear }
  }, [data, width])

  // MP12: one line per provider, on the same scale as the total.
  const seriesPaths = useMemo(() => {
    if (!split || points.length === 0) return []
    return split.map((p) => ({
      provider: p,
      d: points
        .map((pt, i) => {
          const y = valueY(partOf(pt, p, metric), maxValue, plotH)
          return `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${y.toFixed(1)}`
        })
        .join(' '),
    }))
  }, [split, points, maxValue, plotH, metric])

  if (!data || data.length === 0) {
    return (
      <div
        className="rounded-xl p-4 flex items-center justify-center"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          minHeight: 160,
        }}
      >
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No data in range</div>
      </div>
    )
  }

  // Build SVG path for the line
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  // Build SVG path for the filled area (close to bottom)
  const firstX = points[0].x.toFixed(1)
  const lastX = points[points.length - 1].x.toFixed(1)
  const areaPath = `${linePath} L ${lastX} ${plotH} L ${firstX} ${plotH} Z`

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[11px] text-overlay0 uppercase tracking-wider" data-testid="tk-chart-title">
          {metric === 'tokens' ? 'Tokens over time' : 'Cost over time'}
        </div>
        {split && (
          <div className="flex items-center gap-2 ml-auto" data-testid="tk-cost-series-legend">
            {split.map((p) => (
              <span key={p} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span className="rounded-sm" style={{ width: 8, height: 2, background: TK_PROVIDER_COLOR[p] }} />
                {TK_PROVIDER_LABEL[p]}
              </span>
            ))}
          </div>
        )}
        {/* 2.1.3-beta.4: Cost or Tokens, styled as the filter bar's switches. */}
        <div
          role="group"
          aria-label="Chart shows"
          className={`flex rounded overflow-hidden${split ? '' : ' ml-auto'}`}
          style={{ border: '1px solid var(--border-subtle)' }}
          data-testid="tk-chart-metric"
        >
          {METRICS.map(({ value, label }) => {
            const active = metric === value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setMetric(value)}
                className="px-2.5 py-0.5 text-xs transition-colors"
                style={{
                  background: active ? 'var(--accent)' : 'var(--surface-stage)',
                  color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="overflow-x-auto" ref={setFrame}>
        <svg
          width="100%"
          height={svgH}
          viewBox={`0 0 ${width} ${svgH}`}
          style={{ display: 'block' }}
        >
          <defs>
            <linearGradient id="tk-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* Area fill */}
          <path d={areaPath} fill="url(#tk-area-grad)" />
          {/* Line (the total), or one line per provider (MP12) */}
          {split ? seriesPaths.map((s) => (
            <path
              key={s.provider}
              d={s.d}
              fill="none"
              stroke={TK_PROVIDER_COLOR[s.provider]}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              data-testid={`tk-cost-series-${s.provider}`}
            />
          )) : (
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {/* Data point dots + tooltips */}
          {points.map((p, i) => {
            const labelX = labelAt.get(i)
            return (
              <g key={p.day}>
                {p.value > 0 && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={2.5}
                    fill="var(--accent)"
                    opacity={0.85}
                  />
                )}
                <title>{split
                  ? `${p.day}: ${split.map((s) => `${TK_PROVIDER_LABEL[s]} ${formatValue(partOf(p, s, metric), metric)}`).join(', ')}`
                  : `${p.day}: ${formatValue(p.value, metric)}`}</title>
                {labelX !== undefined && (
                  <text
                    x={labelX}
                    y={plotH + 13}
                    textAnchor="middle"
                    fontSize={AXIS_FONT_PX}
                    fill="var(--text-muted)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatDayLabel(p.day, withYear)}
                  </text>
                )}
              </g>
            )
          })}
          {/* The top of the scale, only when something in range is above
              zero: a range of zeros has no top figure to give. */}
          {peak > 0 && (
            <text x={2} y={10} fontSize={AXIS_FONT_PX} fill="var(--text-muted)" data-testid="tk-chart-max">
              {metric === 'tokens' ? tkTokens(maxValue) : formatCostShort(maxValue)}
            </text>
          )}
        </svg>
      </div>
    </div>
  )
}
