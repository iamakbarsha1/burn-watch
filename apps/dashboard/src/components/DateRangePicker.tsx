'use client'

import { useSearchParams, usePathname, useRouter } from 'next/navigation'

const PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Yesterday', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
] as const

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return formatDate(d)
}

export function DateRangePicker() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()

  const today = formatDate(new Date())
  const from = searchParams.get('from') ?? today
  const to = searchParams.get('to') ?? today

  function navigate(newFrom: string, newTo: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('from', newFrom)
    params.set('to', newTo)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {PRESETS.map((p) => {
          const pFrom = p.days === 0 ? today : p.days === 1 ? daysAgo(1) : daysAgo(p.days - 1)
          const pTo = p.days === 1 ? daysAgo(1) : today
          const isActive = from === pFrom && to === pTo
          return (
            <button
              key={p.label}
              onClick={() => navigate(pFrom, pTo)}
              style={{
                padding: '0.375rem 0.75rem',
                fontSize: '0.8rem',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                background: isActive ? 'var(--foreground)' : 'var(--card)',
                color: isActive ? 'var(--background)' : 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => navigate(e.target.value, to)}
          style={{
            padding: '0.375rem 0.5rem',
            fontSize: '0.8rem',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            background: 'var(--card)',
            color: 'var(--foreground)',
          }}
        />
        <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>to</span>
        <input
          type="date"
          value={to}
          min={from}
          max={today}
          onChange={(e) => navigate(from, e.target.value)}
          style={{
            padding: '0.375rem 0.5rem',
            fontSize: '0.8rem',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            background: 'var(--card)',
            color: 'var(--foreground)',
          }}
        />
      </div>
    </div>
  )
}
