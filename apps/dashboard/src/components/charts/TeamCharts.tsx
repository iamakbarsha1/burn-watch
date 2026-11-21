'use client'

import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { TeamComparison } from '@burn-watch/shared'
import { TEAM_COLORS, teamDailyRows } from '@/lib/teams'
import { formatCost } from '@/lib/format'

const GRID = '#242424'
const AXIS_INK = '#6f6f6f'

/** Daily value, one line per team. Lines, not stacked areas: teams can overlap. */
export function TeamLinesChart({ teams }: { teams: TeamComparison[] }) {
  const rows = useMemo(() => teamDailyRows(teams), [teams])

  if (rows.length === 0) {
    return <p className="py-16 text-center text-sm text-ink-2">No usage in this range</p>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(iso: string) => iso.slice(5)}
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
          formatter={(v: number) => formatCost(v)}
          contentStyle={{ background: '#141414', border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#f5f5f5' }}
          cursor={{ stroke: AXIS_INK, strokeWidth: 1 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {teams.map((t, i) => (
          <Line
            key={t.teamId}
            type="monotone"
            dataKey={t.teamId}
            name={t.name}
            stroke={TEAM_COLORS[i % TEAM_COLORS.length]}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
