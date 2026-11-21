'use client'

import { useActionState, useEffect, useState } from 'react'
import { bulkInviteAction } from './actions'
import { Badge, inputClass, buttonClass, secondaryButtonClass } from '@/components/ui'

export function BulkInviteForm() {
  const [state, dispatch, pending] = useActionState(bulkInviteAction, null)
  const [csv, setCsv] = useState('')
  const [origin, setOrigin] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => setOrigin(window.location.origin), [])
  useEffect(() => setCopied(false), [state])

  const links = (state?.results ?? []).flatMap((r) => (r.ok ? [`${r.email},${origin}${r.path}`] : []))

  return (
    <form action={dispatch}>
      <label htmlFor="bulk-csv" className="text-sm text-ink-2">
        One person per line: <code className="text-xs">email,role,team</code>. Role defaults to
        developer, team is optional and must already exist. Up to 200 rows.
      </label>
      <textarea
        id="bulk-csv"
        name="csv"
        rows={6}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder={'email,role,team\nana@company.com,developer,Platform\nraj@company.com,manager,Platform'}
        className={`${inputClass} mt-2 h-auto w-full py-2 font-mono text-xs`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className={`${secondaryButtonClass} cursor-pointer`}>
          Choose CSV file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (file) setCsv(await file.text())
            }}
          />
        </label>
        <button type="submit" disabled={pending || !csv.trim()} className={buttonClass}>
          {pending ? 'Creating…' : 'Create invites'}
        </button>
      </div>

      {state && (
        <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </p>
      )}

      {state?.results && state.results.length > 0 && (
        <div className="mt-3 space-y-2">
          {links.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-ink-2">
                Links are shown once. The server keeps only a hash.
              </p>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={async () => {
                  await navigator.clipboard.writeText(['email,link', ...links].join('\n'))
                  setCopied(true)
                }}
              >
                {copied ? 'Copied' : `Copy ${links.length} links as CSV`}
              </button>
            </div>
          )}
          <ul className="divide-y divide-line rounded border border-line text-sm">
            {state.results.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                {r.ok ? <Badge tone="good">Invited</Badge> : <Badge tone="bad">Skipped</Badge>}
                <span className="text-ink">{r.email || '(blank)'}</span>
                {r.ok ? (
                  <code className="min-w-0 flex-1 truncate text-xs text-ink-3">{`${origin}${r.path}`}</code>
                ) : (
                  <span className="text-ink-2">{r.error}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  )
}
