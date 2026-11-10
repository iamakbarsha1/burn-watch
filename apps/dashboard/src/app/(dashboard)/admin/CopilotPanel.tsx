'use client'

import { useActionState } from 'react'
import type {
  CopilotSeatRow,
  CopilotSeatsResponse,
  CopilotStatus,
  CopilotSyncResult,
} from '@burn-watch/shared'
import {
  connectCopilotAction,
  disconnectCopilotAction,
  loadCopilotSeatsAction,
  syncCopilotAction,
  type CopilotActionState,
  type CopilotSeatsState,
  type CopilotSyncState,
} from './actions'
import {
  inputClass,
  buttonClass,
  secondaryButtonClass,
  TableFrame,
  Th,
  Td,
  Tr,
  Badge,
} from '@/components/ui'
import { copilotView, describeIdleSeats, unpricedIdleNote, ENCRYPTION_FAULTS } from '@/lib/copilot'
import { formatAgo, formatCost } from '@/lib/format'

/**
 * The panel the admin page renders in place of the old "Not yet available"
 * badge. `status` is fetched on the server and is null when that fetch failed,
 * which is a state of its own rather than a reason to render nothing.
 */
export function CopilotPanel({ status }: { status: CopilotStatus | null }) {
  const view = copilotView(status)

  switch (view.kind) {
    case 'unreachable':
      return (
        <div className="rounded-lg border border-bad/35 bg-bad/10 px-4 py-3 text-sm text-bad">
          <p className="font-medium">Could not read the Copilot integration status.</p>
          <p className="mt-1 text-ink-2">
            The API did not answer. Nothing has changed, and the rest of this page is still
            accurate. Reload once the API is reachable.
          </p>
        </div>
      )

    case 'blocked':
      return <EncryptionFault reason={view.reason} org={view.org} />

    case 'disconnected':
      return <ConnectForm />

    case 'connected':
      return <Connected org={view.org} lastSyncAt={view.lastSyncAt} />
  }
}

/**
 * Both encryption faults, told apart.
 *
 * The distinction is the whole value of this block. An operator who reads
 * "unavailable" goes looking for a key they already set; one who reads
 * "set but unusable" goes and replaces it.
 */
function EncryptionFault({
  reason,
  org,
}: {
  reason: 'missing-key' | 'malformed-key'
  org: string | null
}) {
  const fault = ENCRYPTION_FAULTS[reason]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="bad">Cannot be configured</Badge>
        <span className="text-sm font-medium text-ink">{fault.title}</span>
      </div>
      <p className="max-w-2xl text-sm text-ink-2">{fault.detail}</p>
      {org && (
        <p className="max-w-2xl text-sm text-warn">
          A connection to <span className="font-medium">{org}</span> is still stored. It is not
          lost, but no sync can run until the key is fixed.
        </p>
      )}
    </div>
  )
}

function ConnectForm() {
  const [state, dispatch, pending] = useActionState<CopilotActionState | null, FormData>(
    connectCopilotAction,
    null,
  )

  return (
    <div className="space-y-3">
      <Badge tone="neutral">Not connected</Badge>

      <form action={dispatch}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <label className="mb-1 block text-xs text-ink-2" htmlFor="copilot-org">
              GitHub organization slug
            </label>
            <input
              id="copilot-org"
              name="org"
              required
              autoComplete="off"
              placeholder="acme-inc"
              className={`${inputClass} w-full`}
            />
          </div>
          <div className="w-72">
            <label className="mb-1 block text-xs text-ink-2" htmlFor="copilot-token">
              GitHub token
            </label>
            {/* Never rendered back: no value, no defaultValue, and the action
                returns nothing derived from it. The browser is told not to
                keep it either. */}
            <input
              id="copilot-token"
              name="token"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} w-full`}
            />
          </div>
          <button type="submit" disabled={pending} className={buttonClass}>
            {pending ? 'Checking with GitHub…' : 'Connect'}
          </button>
        </div>

        <p className="mt-2 max-w-2xl text-xs text-ink-3">
          Needs a token with the manage_billing:copilot scope on a Copilot Business or Enterprise
          organization. It is checked against GitHub before it is stored, and it is encrypted at
          rest.
        </p>

        {state && (
          <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-good' : 'text-bad'}`}>
            {state.message}
          </p>
        )}
      </form>
    </div>
  )
}

function Connected({ org, lastSyncAt }: { org: string; lastSyncAt: string | null }) {
  const [syncState, syncDispatch, syncPending] = useActionState<CopilotSyncState | null, FormData>(
    syncCopilotAction,
    null,
  )
  const [disconnectState, disconnectDispatch, disconnectPending] = useActionState<
    CopilotActionState | null,
    FormData
  >(disconnectCopilotAction, null)

  const ago = formatAgo(lastSyncAt)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone="good">Connected</Badge>
        <span className="text-sm font-medium text-ink">{org}</span>
        <span className="text-sm text-ink-2">
          {lastSyncAt ? (
            <>
              last synced {lastSyncAt.slice(0, 10)}
              {ago && <span className="text-ink-3"> ({ago})</span>}
            </>
          ) : (
            <span className="text-ink-3">never synced</span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <form action={syncDispatch} className="flex flex-wrap items-end gap-2">
          <div className="w-44">
            <label className="mb-1 block text-xs text-ink-2" htmlFor="copilot-day">
              Day (optional)
            </label>
            <input
              id="copilot-day"
              name="day"
              type="date"
              className={`${inputClass} w-full`}
            />
          </div>
          <button type="submit" disabled={syncPending} className={buttonClass}>
            {syncPending ? 'Syncing…' : 'Sync now'}
          </button>
        </form>

        <form
          action={disconnectDispatch}
          onSubmit={(e) => {
            // Destructive, and the token cannot be recovered afterwards.
            if (
              !window.confirm(
                `Disconnect Copilot from ${org}? The stored token is deleted and syncing stops. Usage already recorded is kept.`,
              )
            ) {
              e.preventDefault()
            }
          }}
        >
          <button type="submit" disabled={disconnectPending} className={secondaryButtonClass}>
            {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </form>
      </div>

      <p className="max-w-2xl text-xs text-ink-3">
        Leave the day empty to pull yesterday in UTC. GitHub publishes no schedule for when a
        day&rsquo;s report is ready, and today&rsquo;s is usually not, so a sync of today writes
        nothing.
      </p>

      {syncPending && (
        <p role="status" className="text-sm text-ink-2">
          Reading seats and usage from GitHub. This takes a while on a large organization.
        </p>
      )}

      {syncState && !syncState.ok && (
        <p role="status" className="text-sm text-bad">
          {syncState.message}
        </p>
      )}

      {syncState?.ok && syncState.result && <SyncResult result={syncState.result} />}

      {disconnectState && !disconnectState.ok && (
        <p role="status" className="text-sm text-bad">
          {disconnectState.message}
        </p>
      )}

      <SeatRoster />
    </div>
  )
}

/**
 * Who holds a paid seat, and which of those seats is idle.
 *
 * Behind a button rather than on page load. Every read walks the whole Copilot
 * seat roster at GitHub, and putting that on the render path would make the
 * slowest call in the app the price of opening the admin page.
 */
function SeatRoster() {
  const [state, dispatch, pending] = useActionState<CopilotSeatsState | null, FormData>(
    loadCopilotSeatsAction,
    null,
  )

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <form action={dispatch} className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <label className="mb-1 block text-xs text-ink-2" htmlFor="copilot-idle-days">
            Idle after (days)
          </label>
          <input
            id="copilot-idle-days"
            name="idleAfterDays"
            type="number"
            min={1}
            max={365}
            defaultValue={30}
            className={`${inputClass} w-full`}
          />
        </div>
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? 'Reading seats…' : 'Show seats'}
        </button>
      </form>

      <p className="max-w-2xl text-xs text-ink-3">
        Read from GitHub each time you ask, and stored nowhere. A large organization takes a
        moment.
      </p>

      {pending && (
        <p role="status" className="text-sm text-ink-2">
          Walking the Copilot seat roster at GitHub.
        </p>
      )}

      {state && !state.ok && (
        <p role="status" className="text-sm text-bad">
          {state.message}
        </p>
      )}

      {state?.ok && state.seats && <SeatRosterResult roster={state.seats} />}
    </div>
  )
}

function SeatRosterResult({ roster }: { roster: CopilotSeatsResponse }) {
  // An empty roster is an answer, not a fault. GitHub has issued no seats.
  if (roster.seats.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        GitHub reports no Copilot seats for {roster.org}. Nobody holds a licence, and nothing is
        wrong.
      </p>
    )
  }

  const caveat = unpricedIdleNote(roster.summary)
  const unlinked = roster.seats.filter((s) => s.userId === null).map((s) => s.login)

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-ink">
        {describeIdleSeats(roster.summary, roster.idleAfterDays)}
      </p>
      {caveat && <p className="max-w-2xl text-sm text-ink-2">{caveat}</p>}

      {unlinked.length > 0 && <UnlinkedSeats logins={unlinked} />}
      {roster.ambiguousLogins.length > 0 && <AmbiguousLogins logins={roster.ambiguousLogins} />}

      <TableFrame>
        <table className="w-full min-w-[760px] border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>Developer</Th>
              <Th>GitHub login</Th>
              <Th>Status</Th>
              <Th>Last activity</Th>
              <Th>Editor</Th>
              <Th>Plan</Th>
              <Th numeric>Monthly cost</Th>
            </tr>
          </thead>
          <tbody>
            {roster.seats.map((seat) => (
              <SeatRosterRow key={seat.login} seat={seat} />
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}

function SeatRosterRow({ seat }: { seat: CopilotSeatRow }) {
  const ago = formatAgo(seat.lastActivityAt)

  return (
    <Tr>
      <Td className="text-ink">
        {seat.userName ?? (
          <span className="text-warn">{seat.login}, not linked</span>
        )}
      </Td>
      <Td className="font-mono text-xs text-ink-2">{seat.login}</Td>
      <Td>
        <Badge tone={seat.status === 'active' ? 'good' : 'warn'}>
          {seat.status === 'active' ? 'Active' : 'Idle'}
        </Badge>
      </Td>
      <Td className="text-ink-2">
        {seat.lastActivityAt ? (
          <>
            {seat.lastActivityAt.slice(0, 10)}
            {ago && <span className="text-ink-3"> ({ago})</span>}
          </>
        ) : (
          <span className="text-ink-3">never</span>
        )}
      </Td>
      <Td className="text-ink-2">
        {seat.lastActivityEditor ?? <span className="text-ink-3">-</span>}
      </Td>
      <Td className="text-ink-2">{seat.planType}</Td>
      <Td numeric className="text-ink-2">
        {seat.monthlyCostUsd === null ? (
          <span className="text-ink-3">-</span>
        ) : (
          formatCost(seat.monthlyCostUsd)
        )}
      </Td>
    </Tr>
  )
}

/**
 * The seats that cost money and attribute to nobody.
 *
 * Deliberately not `UnmatchedLogins`. That block reports a developer whose
 * recorded usage a sync has already dropped; this one reports a licence billed
 * right now whose spend has nowhere to land. Same root gap at two different
 * moments, and one component serving both would have to go vague to manage it.
 */
function UnlinkedSeats({ logins }: { logins: string[] }) {
  return (
    <div className="rounded-lg border border-warn/35 bg-warn/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">
          {logins.length === 1 ? '1 seat not linked' : `${logins.length} seats not linked`}
        </Badge>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        A paid Copilot licence is billed for each of these GitHub logins, and no BurnWatch user
        carries them as a github_username. Nothing they spend can be attributed to a person on this
        dashboard. Set the field on each matching user.
      </p>
      <LoginChips logins={logins} />
    </div>
  )
}

/**
 * The seats whose developer the API had to pick.
 *
 * Two BurnWatch users carry the same github_username, so the row in the table
 * names whichever has the lowest id. It reads like a fact and is a tie-break
 * until the duplicate is cleared.
 */
function AmbiguousLogins({ logins }: { logins: string[] }) {
  return (
    <div className="rounded-lg border border-warn/35 bg-warn/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">
          {logins.length === 1
            ? '1 login on more than one user'
            : `${logins.length} logins on more than one user`}
        </Badge>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        More than one BurnWatch user carries each of these GitHub logins as a github_username. The
        table shows the seat against the user with the lowest id, which may not be the right
        person. Clear the field on every user but one.
      </p>
      <LoginChips logins={logins} />
    </div>
  )
}

/** The pasteable form of a login list, shared by every callout on this panel. */
function LoginChips({ logins }: { logins: string[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {logins.map((login) => (
        <li
          key={login}
          className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
        >
          {login}
        </li>
      ))}
    </ul>
  )
}

function SyncResult({ result }: { result: CopilotSyncResult }) {
  return (
    <div className="space-y-3">
      <TableFrame>
        <table className="w-full min-w-[640px] border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>Day</Th>
              <Th numeric>Seats</Th>
              <Th numeric>Seats with no assignee</Th>
              <Th numeric>Rows written</Th>
              <Th numeric>Rows skipped</Th>
            </tr>
          </thead>
          <tbody>
            <Tr>
              <Td className="text-ink">{result.day}</Td>
              <Td numeric className="text-ink-2">
                {result.seats.total}
              </Td>
              <Td numeric className="text-ink-2">
                {result.seats.skippedNullAssignee}
              </Td>
              <Td numeric className="font-semibold text-ink">
                {result.usage.written}
              </Td>
              <Td numeric className="text-ink-2">
                {result.usage.skipped}
              </Td>
            </Tr>
          </tbody>
        </table>
      </TableFrame>

      {result.usage.written === 0 && result.unmatchedLogins.length === 0 && (
        <p className="text-sm text-ink-2">
          GitHub reported no Copilot usage for {result.day}. Nothing was written, and nothing is
          wrong.
        </p>
      )}

      {result.unmatchedLogins.length > 0 && <UnmatchedLogins logins={result.unmatchedLogins} />}
    </div>
  )
}

/**
 * The part of the result that costs money to miss.
 *
 * These developers used Copilot and their spend was not recorded, because no
 * BurnWatch user carries their GitHub login. It reads as "they did no work",
 * which is why it gets its own block instead of a line in the table above.
 */
function UnmatchedLogins({ logins }: { logins: string[] }) {
  return (
    <div className="rounded-lg border border-warn/35 bg-warn/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">
          {logins.length === 1 ? '1 login not matched' : `${logins.length} logins not matched`}
        </Badge>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        These GitHub logins used Copilot, and no BurnWatch user has them as a github_username.
        Their usage was not recorded and does not appear in any total on this dashboard. Set the
        field on each matching user and run the sync again for the same day to pick it up.
      </p>
      <LoginChips logins={logins} />
    </div>
  )
}
