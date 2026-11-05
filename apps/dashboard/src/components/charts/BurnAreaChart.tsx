'use client'

import { useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TrendPoint } from '@burn-watch/shared'
import { AGENTS, fillDateGaps, totalsByAgent } from '@/lib/agents'
import { formatCost } from '@/lib/format'
import { SeriesDot } from '@/components/ui'

/** The card the chart sits on. Stacked bands are separated by a gap in this
 *  colour, which is what keeps one band from bleeding into the next. */
const SURFACE = '#0f0f0f'
const GRID = '#242424'
const AXIS_INK = '#6f6f6f'

interface Props {
  data: TrendPoint[]
}

function shortDate(iso: string): string {
  return iso.slice(5)
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number }[]
  label?: string
}) {
  if (!active || !payload?.length) return null

  const rows = AGENTS.map((a) => ({
    agent: a,
    value: payload.find((p) => p.dataKey === a.costKey)?.value ?? 0,
  }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const total = rows.reduce((s, r) => s + r.value, 0)

  return (
    <div className="min-w-44 rounded-lg border border-line bg-surface-2/95 p-3 text-xs shadow-xl backdrop-blur">
      <p className="mb-2 font-medium text-ink">{label}</p>
      {rows.length === 0 ? (
        <p className="text-ink-3">No spend</p>
      ) : (
        <>
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={r.agent.id} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-ink-2">
                  <SeriesDot color={r.agent.color} />
                  {r.agent.label}
                </span>
                <span className="tabular-nums text-ink">{formatCost(r.value)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-line pt-2">
            <span className="text-ink-2">Total</span>
            <span className="font-semibold tabular-nums text-ink">{formatCost(total)}</span>
          </div>
        </>
      )}
    </div>
  )
}

export function BurnAreaChart({ data }: Props) {
  const rows = useMemo(() => fillDateGaps(data), [data])
  const totals = useMemo(() => totalsByAgent(rows), [rows])

  // Only agents that actually spent in this range get a band, so the legend
  // does not list four agents that are flat at zero.
  const active = AGENTS.filter((a) => totals[a.id] > 0)

  if (active.length === 0) {
    return <p className="py-16 text-center text-sm text-ink-2">No spend in this range</p>
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={340}>
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          {/* Solid hairline, horizontal only. A dashed grid reads as a
              threshold line when it is just a grid. */}
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            stroke={GRID}
            tick={{ fontSize: 11, fill: AXIS_INK }}
            tickLine={false}
            minTickGap={44}
          />
          <YAxis
            stroke={GRID}
            tick={{ fontSize: 11, fill: AXIS_INK }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
          />
          <Tooltip
            content={<TrendTooltip />}
            cursor={{ stroke: AXIS_INK, strokeWidth: 1 }}
          />
          {/*
            Identity lives in the fill, not in a stroke.
            Every band used to carry a 2px stroke in its own colour, and because
            the areas are stacked, a series with almost no spend still drew that
            stroke at the *cumulative* top of the stack. Gemini — 64 cents, all
            time — was painted last and so traced Claude's curve in blue, which
            is why the Claude line looked missing. The stroke here is the card
            colour: it is the 2px gap between bands, and no series can wear
            another one's shape.
          */}
          {active.map((a) => (
            <Area
              key={a.id}
              type="monotone"
              dataKey={a.costKey}
              name={a.id}
              stackId="spend"
              fill={a.color}
              fillOpacity={0.9}
              stroke={SURFACE}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>

      <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        {active.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-xs">
            <SeriesDot color={a.color} />
            <span className="text-ink-2">{a.label}</span>
            <span className="tabular-nums text-ink">{formatCost(totals[a.id])}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The stacked chart answers "what did the team spend"; at this data's scale it
 * cannot also answer "what did Copilot do", because Copilot's $32 is a band one
 * pixel tall next to Claude's $2,983. Each agent gets its own panel on its own
 * y-scale, where its shape is legible, with the total underneath to keep the
 * scales from being mistaken for each other.
 */
export function AgentSparklines({ data }: Props) {
  const rows = useMemo(() => fillDateGaps(data), [data])
  const totals = useMemo(() => totalsByAgent(rows), [rows])
  const active = AGENTS.filter((a) => totals[a.id] > 0)

  if (active.length === 0) return null

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {active.map((a) => (
        <div
          key={a.id}
          className="rounded-[var(--radius-card)] border border-line bg-surface-1 p-4 transition-colors hover:border-line-strong"
        >
          <div className="flex items-center gap-2">
            <SeriesDot color={a.color} />
            <span className="text-xs text-ink-2">{a.label}</span>
          </div>
          <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {formatCost(totals[a.id])}
          </p>
          <div className="mt-3">
            <ResponsiveContainer width="100%" height={56}>
              <AreaChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                <Tooltip
                  content={<TrendTooltip />}
                  cursor={{ stroke: AXIS_INK, strokeWidth: 1 }}
                />
                <YAxis hide domain={[0, 'dataMax']} />
                <Area
                  type="monotone"
                  dataKey={a.costKey}
                  name={a.id}
                  stroke={a.color}
                  strokeWidth={1.5}
                  fill={a.color}
                  fillOpacity={0.18}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">own scale · peak {formatCost(
            Math.max(...rows.map((r) => r[a.costKey] as number)),
          )}</p>
        </div>
      ))}
    </div>
  )
}
