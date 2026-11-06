'use client'

import { useActionState } from 'react'
import type { BudgetAlert, AgentName } from '@burn-watch/shared'
import {
  createBudgetAlertAction,
  updateBudgetAlertAction,
  deleteBudgetAlertAction,
  type BudgetAlertActionState,
} from './actions'
import {
  inputClass,
  buttonClass,
  secondaryButtonClass,
  TableFrame,
  Th,
  Td,
  Tr,
  EmptyRow,
  Badge,
} from '@/components/ui'
import { formatCost } from '@/lib/format'

const AGENTS: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']

interface Person {
  id: string
  name: string
}

export function CreateBudgetAlertForm({ users }: { users: Person[] }) {
  const [state, dispatch, pending] = useActionState<BudgetAlertActionState | null, FormData>(
    createBudgetAlertAction,
    null,
  )

  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-user">
            Scope
          </label>
          <select id="alert-user" name="userId" defaultValue="" className={`${inputClass} w-full`}>
            <option value="">Whole org</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-36">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-agent">
            Agent
          </label>
          <select id="alert-agent" name="agent" defaultValue="" className={`${inputClass} w-full`}>
            <option value="">All agents</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-limit">
            Monthly limit ($)
          </label>
          <input
            id="alert-limit"
            name="monthlyLimitUsd"
            type="number"
            min="1"
            step="0.01"
            required
            className={`${inputClass} w-full`}
          />
        </div>
        <div className="w-28">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-threshold">
            Threshold (%)
          </label>
          <input
            id="alert-threshold"
            name="thresholdPct"
            type="number"
            min="1"
            max="100"
            defaultValue={80}
            required
            className={`${inputClass} w-full`}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Adding…' : 'Add alert'}
        </button>
      </div>

      {state && (
        <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </p>
      )}
    </form>
  )
}

function BudgetAlertRow({ alert, users }: { alert: BudgetAlert; users: Person[] }) {
  const [updateState, updateDispatch, updatePending] = useActionState<
    BudgetAlertActionState | null,
    FormData
  >(updateBudgetAlertAction, null)
  // The delete result used to be dropped on the floor, so a failing delete
  // looked exactly like a successful one: the row simply stayed where it was
  // with nothing said. A write whose outcome is never rendered cannot be
  // tested by using the page.
  const [deleteState, deleteDispatch, deletePending] = useActionState<
    BudgetAlertActionState | null,
    FormData
  >(deleteBudgetAlertAction, null)

  const scopeLabel = alert.userId
    ? (users.find((u) => u.id === alert.userId)?.name ?? 'Unknown user')
    : 'Whole org'

  return (
    <Tr>
      <Td>{scopeLabel}</Td>
      <Td className="text-ink-2">{alert.agent ?? 'All agents'}</Td>
      <Td>
        <form action={updateDispatch} className="flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="id" value={alert.id} />
          <input type="hidden" name="userId" value={alert.userId ?? ''} />
          <input type="hidden" name="agent" value={alert.agent ?? ''} />
          <input
            name="monthlyLimitUsd"
            type="number"
            min="1"
            step="0.01"
            defaultValue={alert.monthlyLimitUsd}
            aria-label="Monthly limit"
            className={`${inputClass} w-24`}
          />
          <input
            name="thresholdPct"
            type="number"
            min="1"
            max="100"
            defaultValue={Math.round(alert.threshold * 100)}
            aria-label="Threshold percent"
            className={`${inputClass} w-16`}
          />
          <span className="text-xs text-ink-3">%</span>
          <button type="submit" disabled={updatePending} className={secondaryButtonClass}>
            {updatePending ? 'Saving…' : 'Save'}
          </button>
        </form>
        {updateState && !updateState.ok && <p className="mt-1 text-xs text-bad">{updateState.message}</p>}
      </Td>
      <Td numeric className="text-ink">
        {formatCost(alert.monthToDateSpendUsd)}
      </Td>
      <Td>{alert.tripped ? <Badge tone="bad">Tripped</Badge> : <Badge tone="good">OK</Badge>}</Td>
      <Td>
        <form
          action={deleteDispatch}
          onSubmit={(e) => {
            if (!window.confirm('Delete this budget alert?')) e.preventDefault()
          }}
        >
          <input type="hidden" name="id" value={alert.id} />
          <button type="submit" disabled={deletePending} className={secondaryButtonClass}>
            {deletePending ? 'Deleting…' : 'Delete'}
          </button>
        </form>
        {deleteState && !deleteState.ok && (
          <p className="mt-1 text-xs text-bad">{deleteState.message}</p>
        )}
      </Td>
    </Tr>
  )
}

export function BudgetAlertsTable({ alerts, users }: { alerts: BudgetAlert[]; users: Person[] }) {
  return (
    <TableFrame>
      <table className="w-full min-w-[720px] border-collapse">
        <thead className="bg-surface-2">
          <tr>
            <Th>Scope</Th>
            <Th>Agent</Th>
            <Th>Limit / threshold</Th>
            <Th numeric>This month</Th>
            <Th>Status</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 && <EmptyRow colSpan={6}>No budget alerts configured</EmptyRow>}
          {alerts.map((a) => (
            <BudgetAlertRow key={a.id} alert={a} users={users} />
          ))}
        </tbody>
      </table>
    </TableFrame>
  )
}
