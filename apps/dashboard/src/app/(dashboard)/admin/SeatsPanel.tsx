'use client'

import { useActionState } from 'react'
import type { AgentName, Seat } from '@burn-watch/shared'
import { setSeatAction, removeSeatAction, assignSeatToAllAction, type SeatActionState } from './actions'
import {
  inputClass,
  buttonClass,
  secondaryButtonClass,
  TableFrame,
  Th,
  Td,
  Tr,
  EmptyRow,
} from '@/components/ui'
import { formatCost } from '@/lib/format'

const AGENTS: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']

interface Person {
  id: string
  name: string
}

function useSeatAction(action: (prev: SeatActionState | null, formData: FormData) => Promise<SeatActionState>) {
  return useActionState<SeatActionState | null, FormData>(action, null)
}

function Status({ state, compact }: { state: SeatActionState | null; compact?: boolean }) {
  if (!state || (compact && state.ok)) return null
  return (
    <p role="status" className={`mt-1 ${compact ? 'text-xs' : 'text-sm'} ${state.ok ? 'text-good' : 'text-bad'}`}>
      {state.message}
    </p>
  )
}

/** Agent, price and start date, shared by the add-seat and assign-to-everyone forms. */
function SeatFields({ idPrefix, defaultStart }: { idPrefix: string; defaultStart: string }) {
  return (
    <>
      <div className="w-36">
        <label className="mb-1 block text-xs text-ink-2" htmlFor={`${idPrefix}-agent`}>
          Agent
        </label>
        <select id={`${idPrefix}-agent`} name="agent" defaultValue="claude" className={`${inputClass} w-full`}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="w-32">
        <label className="mb-1 block text-xs text-ink-2" htmlFor={`${idPrefix}-price`}>
          Monthly price ($)
        </label>
        <input
          id={`${idPrefix}-price`}
          name="monthlyPriceUsd"
          type="number"
          min="0"
          step="0.01"
          required
          className={`${inputClass} w-full`}
        />
      </div>
      <div className="w-40">
        <label className="mb-1 block text-xs text-ink-2" htmlFor={`${idPrefix}-start`}>
          Start date
        </label>
        <input
          id={`${idPrefix}-start`}
          name="startDate"
          type="date"
          defaultValue={defaultStart}
          required
          className={`${inputClass} w-full`}
        />
      </div>
    </>
  )
}

export function AddSeatForm({ users, defaultStart }: { users: Person[]; defaultStart: string }) {
  const [state, dispatch, pending] = useSeatAction(setSeatAction)
  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-48">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="seat-user">
            Person
          </label>
          <select id="seat-user" name="userId" required defaultValue="" className={`${inputClass} w-full`}>
            <option value="" disabled>
              Pick someone
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <SeatFields idPrefix="seat" defaultStart={defaultStart} />
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Saving…' : 'Save seat'}
        </button>
      </div>
      <Status state={state} />
    </form>
  )
}

export function AssignAllSeatsForm({ defaultStart }: { defaultStart: string }) {
  const [state, dispatch, pending] = useSeatAction(assignSeatToAllAction)
  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-end gap-2">
        <SeatFields idPrefix="assign-all" defaultStart={defaultStart} />
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? 'Assigning…' : 'Assign to everyone'}
        </button>
      </div>
      <Status state={state} />
    </form>
  )
}

function SeatRow({ seat }: { seat: Seat }) {
  const [state, dispatch, pending] = useSeatAction(removeSeatAction)
  return (
    <Tr>
      <Td>
        <div className="font-medium text-ink">{seat.userName ?? <span className="text-ink-3">Removed user</span>}</div>
        {seat.userEmail && <div className="text-xs text-ink-3">{seat.userEmail}</div>}
      </Td>
      <Td className="text-ink-2">{seat.agent}</Td>
      <Td numeric className="text-ink">
        {formatCost(seat.monthlyPriceUsd)}
      </Td>
      <Td className="text-ink-2">{seat.startDate}</Td>
      <Td>
        <form
          action={dispatch}
          onSubmit={(e) => {
            if (!window.confirm(`Remove the ${seat.agent} seat for ${seat.userName ?? 'this user'}?`)) e.preventDefault()
          }}
        >
          <input type="hidden" name="userId" value={seat.userId} />
          <input type="hidden" name="agent" value={seat.agent} />
          <button type="submit" disabled={pending} className={secondaryButtonClass}>
            {pending ? 'Removing…' : 'Remove'}
          </button>
        </form>
        <Status state={state} compact />
      </Td>
    </Tr>
  )
}

export function SeatsTable({ seats }: { seats: Seat[] }) {
  return (
    <TableFrame>
      <table className="w-full min-w-[640px] border-collapse">
        <thead className="bg-surface-2">
          <tr>
            <Th>Person</Th>
            <Th>Agent</Th>
            <Th numeric>Monthly price</Th>
            <Th>Start date</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {seats.length === 0 && <EmptyRow colSpan={5}>No seats yet</EmptyRow>}
          {seats.map((s) => (
            <SeatRow key={`${s.userId}:${s.agent}`} seat={s} />
          ))}
        </tbody>
      </table>
    </TableFrame>
  )
}
