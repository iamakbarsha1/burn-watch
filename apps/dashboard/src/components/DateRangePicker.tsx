'use client'

import { useTransition } from 'react'
import { useSearchParams, usePathname, useRouter } from 'next/navigation'
import { ALL_TIME_FROM, rangePresets, today as todayStr } from '@/lib/format'
import { inputClass } from '@/components/ui'

export function DateRangePicker() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  // Without a transition the click is silent until the server is done, which is
  // exactly how "the timeline selection is laggy" feels. The transition lets the
  // pressed button report itself immediately and holds the existing numbers on
  // screen at reduced opacity instead of flashing a skeleton over them.
  const [pending, startTransition] = useTransition()

  const today = todayStr()
  const from = searchParams.get('from') ?? ALL_TIME_FROM
  const to = searchParams.get('to') ?? today
  const presets = rangePresets({
    from: searchParams.get('from'),
    to: searchParams.get('to'),
  })

  /** A `null` end drops `to` from the URL, which is how a range stays open. */
  function navigate(newFrom: string, newTo: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('from', newFrom)
    if (newTo === null) params.delete('to')
    else params.set('to', newTo)
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-pending={pending ? '' : undefined}
    >
      <div
        role="group"
        aria-label="Date range presets"
        className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-1 p-1"
      >
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => navigate(p.from, p.to)}
            aria-pressed={p.active}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
              p.active
                ? 'bg-ink text-surface-0'
                : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor="range-from">
          From date
        </label>
        <input
          id="range-from"
          type="date"
          value={from}
          max={to}
          onChange={(e) => e.target.value && navigate(e.target.value, to)}
          className={`${inputClass} h-9 text-xs [color-scheme:dark]`}
        />
        <span className="text-xs text-ink-3">to</span>
        <label className="sr-only" htmlFor="range-to">
          To date
        </label>
        <input
          id="range-to"
          type="date"
          value={to}
          min={from}
          max={today}
          onChange={(e) => e.target.value && navigate(from, e.target.value)}
          className={`${inputClass} h-9 text-xs [color-scheme:dark]`}
        />
      </div>

      <span
        role="status"
        aria-live="polite"
        className={`size-3.5 shrink-0 rounded-full border-2 border-ink-3 border-t-transparent transition-opacity ${
          pending ? 'animate-spin opacity-100' : 'opacity-0'
        }`}
      >
        <span className="sr-only">{pending ? 'Updating range' : ''}</span>
      </span>
    </div>
  )
}
