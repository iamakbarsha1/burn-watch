'use client'

import { useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { inputClass } from '@/components/ui'

/**
 * Writes `teamId` to the URL, next to `from`/`to`, so the sidebar carries it
 * from page to page and a refresh keeps it. Only Overview and Trends read it.
 */
export function TeamFilter({ teams, value }: { teams: { id: string; name: string }[]; value?: string }) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function select(teamId: string) {
    const q = new URLSearchParams(searchParams.toString())
    if (teamId) q.set('teamId', teamId)
    else q.delete('teamId')
    const query = q.toString()
    startTransition(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }

  return (
    <div className="mb-6 flex items-center gap-2">
      <label htmlFor="team-filter" className="text-xs text-ink-2">
        Team
      </label>
      <select
        id="team-filter"
        value={value ?? ''}
        onChange={(e) => select(e.target.value)}
        disabled={pending}
        className={`${inputClass} w-56`}
      >
        <option value="">Everyone I can see</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  )
}
