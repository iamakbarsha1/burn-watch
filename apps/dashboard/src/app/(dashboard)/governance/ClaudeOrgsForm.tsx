'use client'

import { useActionState } from 'react'
import type { ClaudeOrgRow } from '@burn-watch/shared'
import { buttonClass, TableFrame, Th, Td, Tr } from '@/components/ui'
import { claudeOrgsAction, type McpActionState } from './actions'

/** R2 B6. Claude orgs seen, with a tick for the company's. The hash is the checkbox value, never shown. */
export function ClaudeOrgsForm({ orgs }: { orgs: ClaudeOrgRow[] }) {
  const [state, dispatch, pending] = useActionState<McpActionState | null, FormData>(claudeOrgsAction, null)
  return (
    <form action={dispatch}>
      <TableFrame>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Claude org</Th>
              <Th numeric>People</Th>
              <Th numeric>Days</Th>
              <Th>Company org</Th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <Tr key={o.id}>
                <Td className="font-medium text-ink">
                  {o.label}
                  {o.includesYou && <span className="ml-2 text-xs text-ink-2">includes you</span>}
                </Td>
                <Td numeric>{o.users}</Td>
                <Td numeric>{o.days}</Td>
                <Td>
                  <input type="checkbox" name="ids" value={o.id} defaultChecked={o.ours} aria-label={`${o.label} is the company's`} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state && (
          <p role="status" className={`text-xs ${state.ok ? 'text-ink-2' : 'text-bad'}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  )
}
