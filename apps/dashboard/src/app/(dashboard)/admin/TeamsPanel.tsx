'use client'

import { useActionState } from 'react'
import type { Team, TeamMember } from '@burn-watch/shared'
import {
  createTeamAction,
  renameTeamAction,
  deleteTeamAction,
  setTeamMemberAction,
  removeTeamMemberAction,
  type TeamActionState,
} from './actions'
import {
  cardClass,
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

interface Person {
  id: string
  name: string
}

type Action = (prev: TeamActionState | null, formData: FormData) => Promise<TeamActionState>

/** Every write here renders its own outcome, so a failure never looks like a no-op. */
function useTeamAction(action: Action) {
  return useActionState<TeamActionState | null, FormData>(action, null)
}

function Status({ state, compact }: { state: TeamActionState | null; compact?: boolean }) {
  if (!state || (compact && state.ok)) return null
  return (
    <p role="status" className={`mt-1 ${compact ? 'text-xs' : 'text-sm'} ${state.ok ? 'text-good' : 'text-bad'}`}>
      {state.message}
    </p>
  )
}

export function CreateTeamForm() {
  const [state, dispatch, pending] = useTeamAction(createTeamAction)
  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="team-name">
            Team name
          </label>
          <input id="team-name" name="name" required maxLength={100} className={`${inputClass} w-full`} />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Creating…' : 'Create team'}
        </button>
      </div>
      <Status state={state} />
    </form>
  )
}

function MemberRow({ teamId, member }: { teamId: string; member: TeamMember }) {
  const [roleState, roleDispatch, rolePending] = useTeamAction(setTeamMemberAction)
  const [removeState, removeDispatch, removePending] = useTeamAction(removeTeamMemberAction)
  const isManager = member.role === 'manager'

  return (
    <Tr>
      <Td className="text-ink">{member.name ?? <span className="text-ink-3">Removed user</span>}</Td>
      <Td>{isManager ? <Badge tone="good">Manager</Badge> : <Badge tone="neutral">Member</Badge>}</Td>
      <Td>
        <div className="flex flex-wrap gap-2">
          <form action={roleDispatch}>
            <input type="hidden" name="teamId" value={teamId} />
            <input type="hidden" name="userId" value={member.userId} />
            <input type="hidden" name="role" value={isManager ? 'member' : 'manager'} />
            <button type="submit" disabled={rolePending} className={secondaryButtonClass}>
              {rolePending ? 'Saving…' : isManager ? 'Make member' : 'Make manager'}
            </button>
          </form>
          <form action={removeDispatch}>
            <input type="hidden" name="teamId" value={teamId} />
            <input type="hidden" name="userId" value={member.userId} />
            <button type="submit" disabled={removePending} className={secondaryButtonClass}>
              {removePending ? 'Removing…' : 'Remove'}
            </button>
          </form>
        </div>
        <Status state={roleState} compact />
        <Status state={removeState} compact />
      </Td>
    </Tr>
  )
}

function TeamCard({ team, users }: { team: Team; users: Person[] }) {
  const [renameState, renameDispatch, renamePending] = useTeamAction(renameTeamAction)
  const [deleteState, deleteDispatch, deletePending] = useTeamAction(deleteTeamAction)
  const [addState, addDispatch, addPending] = useTeamAction(setTeamMemberAction)

  const inTeam = new Set(team.members.map((m) => m.userId))
  const candidates = users.filter((u) => !inTeam.has(u.id))
  // Managers first, then by name, so who runs the team is the first thing read.
  const members = [...team.members].sort(
    (a, b) => (a.role === b.role ? (a.name ?? '').localeCompare(b.name ?? '') : a.role === 'manager' ? -1 : 1),
  )

  return (
    <div className={`${cardClass} space-y-4 p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <form action={renameDispatch} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="teamId" value={team.id} />
          <input
            name="name"
            defaultValue={team.name}
            required
            maxLength={100}
            aria-label={`Name of team ${team.name}`}
            className={`${inputClass} w-56`}
          />
          <button type="submit" disabled={renamePending} className={secondaryButtonClass}>
            {renamePending ? 'Saving…' : 'Rename'}
          </button>
        </form>
        <form
          action={deleteDispatch}
          onSubmit={(e) => {
            if (!window.confirm(`Delete team ${team.name}? Its members stay in the org.`)) e.preventDefault()
          }}
        >
          <input type="hidden" name="teamId" value={team.id} />
          <button type="submit" disabled={deletePending} className={secondaryButtonClass}>
            {deletePending ? 'Deleting…' : 'Delete team'}
          </button>
        </form>
      </div>
      <Status state={renameState} compact />
      <Status state={deleteState} compact />

      <TableFrame>
        <table className="w-full min-w-[520px] border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>Member</Th>
              <Th>Team role</Th>
              <Th>{''}</Th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && <EmptyRow colSpan={3}>No members yet</EmptyRow>}
            {members.map((m) => (
              <MemberRow key={m.userId} teamId={team.id} member={m} />
            ))}
          </tbody>
        </table>
      </TableFrame>

      {candidates.length > 0 && (
        <form action={addDispatch}>
          <input type="hidden" name="teamId" value={team.id} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <label className="mb-1 block text-xs text-ink-2" htmlFor={`add-user-${team.id}`}>
                Add person
              </label>
              <select id={`add-user-${team.id}`} name="userId" required defaultValue="" className={`${inputClass} w-full`}>
                <option value="" disabled>
                  Pick someone
                </option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-36">
              <label className="mb-1 block text-xs text-ink-2" htmlFor={`add-role-${team.id}`}>
                Team role
              </label>
              <select id={`add-role-${team.id}`} name="role" defaultValue="member" className={`${inputClass} w-full`}>
                <option value="member">Member</option>
                <option value="manager">Manager</option>
              </select>
            </div>
            <button type="submit" disabled={addPending} className={buttonClass}>
              {addPending ? 'Adding…' : 'Add'}
            </button>
          </div>
          <Status state={addState} />
        </form>
      )}
    </div>
  )
}

export function TeamsList({ teams, users }: { teams: Team[]; users: Person[] }) {
  if (teams.length === 0) {
    return <p className="text-sm text-ink-3">No teams yet. Team filters appear on Overview and Trends once one exists.</p>
  }
  return (
    <div className="space-y-4">
      {teams.map((t) => (
        <TeamCard key={t.id} team={t} users={users} />
      ))}
    </div>
  )
}
