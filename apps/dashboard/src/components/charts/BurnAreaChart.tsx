'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import type { TrendPoint } from '@burn-watch/shared'

const AGENT_COLORS: Record<string, string> = {
  claudeCost: '#d97706',
  copilotCost: '#6366f1',
  codexCost: '#10b981',
  geminiCost: '#3b82f6',
  qwenCost: '#06b6d4',
}

const AGENT_LABELS: Record<string, string> = {
  claudeCost: 'Claude',
  copilotCost: 'Copilot',
  codexCost: 'Codex',
  geminiCost: 'Gemini',
  qwenCost: 'Qwen',
}

interface Props {
  data: TrendPoint[]
}

export function BurnAreaChart({ data }: Props) {
  const formatted = data.map((d) => ({
    ...d,
    date: d.date.slice(5), // MM-DD
  }))

  return (
    <ResponsiveContainer width="100%" height={360}>
      <AreaChart data={formatted} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <defs>
          {Object.entries(AGENT_COLORS).map(([key, color]) => (
            <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#222222" />
        <XAxis dataKey="date" stroke="#888888" tick={{ fontSize: 12 }} />
        <YAxis stroke="#888888" tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
        <Tooltip
          contentStyle={{ background: '#111111', border: '1px solid #222222', borderRadius: '6px' }}
          formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, AGENT_LABELS[name] ?? name]}
        />
        <Legend formatter={(value: string) => AGENT_LABELS[value] ?? value} />
        {Object.entries(AGENT_COLORS).map(([key, color]) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="1"
            stroke={color}
            fill={`url(#grad-${key})`}
            strokeWidth={2}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
