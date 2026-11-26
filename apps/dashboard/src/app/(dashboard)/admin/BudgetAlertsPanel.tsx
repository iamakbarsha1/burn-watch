'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
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

type AlertType = BudgetAlert['type']

const TYPE_LABELS: Record<AlertType, string> = {
  'api-spend': 'API spend',
  'idle-seat': 'Unused seat',
  'limit-hit': 'Limit hits',
}

export function CreateBudgetAlertForm() {
  const [state, dispatch, pending] = useActionState<BudgetAlertActionState | null, FormData>(
    createBudgetAlertAction,
    null,
  )
  const [type, setType] = useState<AlertType>('api-spend')

  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-36">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-type">
            Type
          </label>
          <select
            id="alert-type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as AlertType)}
            className={`${inputClass} w-full`}
          >
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
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
        {type === 'api-spend' && (
          <>
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
          </>
        )}
        {type === 'idle-seat' && (
          <div className="w-28">
            <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-idle-days">
              Unused days
            </label>
            <input
              id="alert-idle-days"
              name="idleDays"
              type="number"
              min="1"
              max="365"
              defaultValue={14}
              required
              className={`${inputClass} w-full`}
            />
          </div>
        )}
        {type === 'limit-hit' && (
          <div className="w-40">
            <label className="mb-1 block text-xs text-ink-2" htmlFor="alert-limit-hits">
              Limit hits per month
            </label>
            <input
              id="alert-limit-hits"
              name="limitHits"
              type="number"
              min="1"
              defaultValue={3}
              required
              className={`${inputClass} w-full`}
            />
          </div>
        )}
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

function BudgetAlertRow({ alert }: { alert: BudgetAlert }) {
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

  return (
    <Tr>
      <Td className="text-ink-2">{TYPE_LABELS[alert.type]}</Td>
      <Td className="text-ink-2">{alert.agent ?? 'All agents'}</Td>
      <Td>
        <form action={updateDispatch} className="flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="id" value={alert.id} />
          <input type="hidden" name="type" value={alert.type} />
          <input type="hidden" name="agent" value={alert.agent ?? ''} />
          {alert.type === 'api-spend' && (
            <>
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
            </>
          )}
          {alert.type === 'idle-seat' && (
            <>
              <input
                name="idleDays"
                type="number"
                min="1"
                max="365"
                defaultValue={alert.idleDays ?? 14}
                aria-label="Unused days"
                className={`${inputClass} w-16`}
              />
              <span className="text-xs text-ink-3">unused days</span>
            </>
          )}
          {alert.type === 'limit-hit' && (
            <>
              <input
                name="limitHits"
                type="number"
                min="1"
                defaultValue={alert.limitHits ?? 1}
                aria-label="Limit hits per month"
                className={`${inputClass} w-16`}
              />
              <span className="text-xs text-ink-3">hits / month</span>
            </>
          )}
          <button type="submit" disabled={updatePending} className={secondaryButtonClass}>
            {updatePending ? 'Saving…' : 'Save'}
          </button>
        </form>
        {updateState && !updateState.ok && <p className="mt-1 text-xs text-bad">{updateState.message}</p>}
      </Td>
      <Td numeric className="text-ink">
        {alert.type === 'api-spend'
          ? formatCost(alert.monthToDateSpendUsd)
          : alert.type === 'idle-seat'
            ? `${alert.idleSeatCount ?? 0} unused`
            : `${alert.people ?? 0} ${alert.people === 1 ? 'person' : 'people'}`}
      </Td>
      <Td>
        {alert.tripped ? <Badge tone="bad">Tripped</Badge> : <Badge tone="good">OK</Badge>}
        {alert.tripped && alert.type === 'idle-seat' && (
          <p className="mt-1 text-xs">
            <Link href={`/adoption?idleDays=${alert.idleDays ?? 14}`} className="text-brand underline-offset-4 hover:underline">
              See unused seats
            </Link>
          </p>
        )}
      </Td>
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

export function BudgetAlertsTable({ alerts }: { alerts: BudgetAlert[] }) {
  return (
    <TableFrame>
      <table className="w-full min-w-[820px] border-collapse">
        <thead className="bg-surface-2">
          <tr>
            <Th>Type</Th>
            <Th>Agent</Th>
            <Th>Settings</Th>
            <Th numeric>This month</Th>
            <Th>Status</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 && <EmptyRow colSpan={6}>No budget alerts configured</EmptyRow>}
          {alerts.map((a) => (
            <BudgetAlertRow key={a.id} alert={a} />
          ))}
        </tbody>
      </table>
    </TableFrame>
  )
}
