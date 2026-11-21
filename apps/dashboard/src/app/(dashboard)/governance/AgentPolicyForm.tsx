'use client'

import { useActionState } from 'react'
import type { AgentPolicy } from '@burn-watch/shared'
import { buttonClass, inputClass, secondaryButtonClass } from '@/components/ui'
import { agentPolicyAction, type McpActionState } from './actions'

/** Edit one agent's rule. Rendered for admins only. */
export function AgentPolicyForm({ policy, seen }: { policy: AgentPolicy; seen: string[] }) {
  const [state, dispatch, pending] = useActionState<McpActionState | null, FormData>(agentPolicyAction, null)
  const [cleared, clear, clearing] = useActionState<McpActionState | null, FormData>(agentPolicyAction, null)
  const shown = cleared ?? state
  const id = `policy-${policy.agent}`
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-ink-2 hover:text-ink">Edit</summary>
      <form action={dispatch} className="mt-2 space-y-2">
        <input type="hidden" name="agent" value={policy.agent} />
        <label className="block">
          <span className="text-xs text-ink-2">Rule</span>
          <select
            name="rule"
            defaultValue={policy.rule === 'unset' ? 'allowed' : policy.rule}
            className={`${inputClass} w-full`}
            aria-label={`Rule for ${policy.agent}`}
          >
            <option value="allowed">Allowed, any model</option>
            <option value="models">Allowed, listed models only</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-2">Models, one per line, exact names (only for listed models)</span>
          <textarea
            id={`${id}-models`}
            name="models"
            rows={3}
            defaultValue={policy.models.join('\n')}
            className={`${inputClass} h-auto w-full py-2 font-mono`}
          />
        </label>
        {seen.length > 0 && <p className="text-xs text-ink-2">Seen in this range: {seen.join(', ')}</p>}
        <label className="block">
          <span className="text-xs text-ink-2">Note</span>
          <input name="note" defaultValue={policy.note ?? ''} maxLength={500} className={`${inputClass} w-full`} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Saving…' : 'Save rule'}
        </button>
      </form>
      {policy.rule !== 'unset' && (
        <form action={clear} className="mt-2">
          <input type="hidden" name="agent" value={policy.agent} />
          <input type="hidden" name="intent" value="clear" />
          <button type="submit" disabled={clearing} className={secondaryButtonClass}>
            {clearing ? 'Clearing…' : 'Clear rule'}
          </button>
        </form>
      )}
      {shown && (
        <p role="status" className={`mt-1 text-xs ${shown.ok ? 'text-good' : 'text-bad'}`}>
          {shown.message}
        </p>
      )}
    </details>
  )
}
