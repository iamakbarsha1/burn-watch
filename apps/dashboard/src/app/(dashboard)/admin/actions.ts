'use server'

import { revalidatePath } from 'next/cache'
import {
  createInvite,
  createInvites,
  createBudgetAlert,
  updateBudgetAlert,
  deleteBudgetAlert,
  connectCopilot,
  disconnectCopilot,
  syncCopilot,
  fetchCopilotSeats,
  createTeam,
  renameTeam,
  deleteTeam,
  setTeamMember,
  removeTeamMember,
  setSeat,
  removeSeat,
  assignSeatToAll,
} from '@/lib/api'
import { getUserRole } from '@/lib/session'
import { parseInviteCsv } from '@/lib/csv'
import type { AgentName, CopilotSeatsResponse, CopilotSyncResult } from '@burn-watch/shared'

export interface InviteState {
  ok: boolean
  message: string
  // Only set on success. The path, not a full URL: the browser knows which
  // origin it is on, and a server-rendered host header does not.
  path?: string
  email?: string
}

const ROLES = ['admin', 'manager', 'developer']

export async function inviteAction(
  _prev: InviteState | null,
  formData: FormData,
): Promise<InviteState> {
  const role = await getUserRole()
  if (role !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const email = (formData.get('email') as string | null)?.trim() ?? ''
  const inviteRole = (formData.get('role') as string | null) ?? 'developer'

  if (!email.includes('@')) {
    return { ok: false, message: 'Valid email required' }
  }
  if (!ROLES.includes(inviteRole)) {
    return { ok: false, message: 'Unknown role' }
  }

  try {
    const invite = await createInvite(email, inviteRole)
    revalidatePath('/admin')
    return {
      ok: true,
      message: `Invite for ${invite.email} expires ${invite.expiresAt.slice(0, 10)}.`,
      path: `/invite/${invite.token}`,
      email: invite.email,
    }
  } catch (err: any) {
    return { ok: false, message: err.message ?? 'Failed to create invite' }
  }
}

export interface BulkInviteState {
  ok: boolean
  message: string
  // Paths, not URLs, for the same reason as InviteState.
  results?: ({ email: string; ok: true; path: string } | { email: string; ok: false; error: string })[]
}

export async function bulkInviteAction(
  _prev: BulkInviteState | null,
  formData: FormData,
): Promise<BulkInviteState> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }

  const rows = parseInviteCsv((formData.get('csv') as string | null) ?? '')
  if (rows.length === 0) return { ok: false, message: 'Paste or choose a CSV with at least one email' }
  if (rows.length > 200) return { ok: false, message: `${rows.length} rows. The limit is 200 per upload` }

  try {
    const { results } = await createInvites(rows)
    revalidatePath('/admin')
    const made = results.filter((r) => r.ok).length
    return {
      ok: made > 0,
      message: `${made} of ${results.length} invites created.`,
      results: results.map((r) =>
        r.ok ? { email: r.email, ok: true, path: `/invite/${r.token}` } : { email: r.email, ok: false, error: r.error },
      ),
    }
  } catch (err: any) {
    return { ok: false, message: err.message ?? 'Failed to create invites' }
  }
}

export interface BudgetAlertActionState {
  ok: boolean
  message: string
}

const AGENTS: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']

function isAgentName(value: string): value is AgentName {
  return (AGENTS as string[]).includes(value)
}

const ALERT_TYPES = ['api-spend', 'idle-seat', 'limit-hit'] as const
type AlertType = (typeof ALERT_TYPES)[number]

function wholeNumber(formData: FormData, name: string, min: number, max: number, message: string): number {
  const n = Number(formData.get(name))
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(message)
  return n
}

/**
 * Shared by create and update: a threshold typed as a whole percent (the UI
 * never shows a bare fraction) parsed down to what the API stores, and the
 * optional scoping fields collapsed from "" to null rather than left as an
 * empty string the API would reject. Only the fields of the chosen type are
 * sent; the API stores the others as null.
 */
function parseBudgetAlertForm(formData: FormData) {
  const rawType = String(formData.get('type') ?? '').trim() || 'api-spend'
  const userId = String(formData.get('userId') ?? '').trim() || null
  const rawAgent = String(formData.get('agent') ?? '').trim()

  if (!(ALERT_TYPES as readonly string[]).includes(rawType)) {
    throw new Error('Unknown alert type')
  }
  const type = rawType as AlertType
  if (rawAgent && !isAgentName(rawAgent)) {
    throw new Error('Unknown agent')
  }
  const agent: AgentName | null = rawAgent && isAgentName(rawAgent) ? rawAgent : null

  if (type === 'idle-seat') {
    const idleDays = wholeNumber(formData, 'idleDays', 1, 365, 'Enter idle days between 1 and 365')
    return { type, idleDays, userId, agent }
  }
  if (type === 'limit-hit') {
    const limitHits = wholeNumber(formData, 'limitHits', 1, 100000, 'Enter limit hits of 1 or more')
    return { type, limitHits, userId, agent }
  }

  const monthlyLimitUsd = Number(formData.get('monthlyLimitUsd'))
  const thresholdPct = Number(formData.get('thresholdPct'))
  if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0) {
    throw new Error('Enter a monthly limit greater than 0')
  }
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct > 100) {
    throw new Error('Enter a threshold between 1 and 100')
  }
  return { type, monthlyLimitUsd, threshold: thresholdPct / 100, userId, agent }
}

export async function createBudgetAlertAction(
  _prev: BudgetAlertActionState | null,
  formData: FormData,
): Promise<BudgetAlertActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  try {
    const input = parseBudgetAlertForm(formData)
    await createBudgetAlert(input)
    revalidatePath('/admin')
    return { ok: true, message: 'Budget alert created.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to create budget alert' }
  }
}

export async function updateBudgetAlertAction(
  _prev: BudgetAlertActionState | null,
  formData: FormData,
): Promise<BudgetAlertActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const id = String(formData.get('id') ?? '')
  if (!id) {
    return { ok: false, message: 'No budget alert selected' }
  }

  try {
    await updateBudgetAlert(id, parseBudgetAlertForm(formData))
    revalidatePath('/admin')
    return { ok: true, message: 'Budget alert updated.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to update budget alert' }
  }
}

export async function deleteBudgetAlertAction(
  _prev: BudgetAlertActionState | null,
  formData: FormData,
): Promise<BudgetAlertActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const id = String(formData.get('id') ?? '')
  if (!id) {
    return { ok: false, message: 'No budget alert selected' }
  }

  try {
    await deleteBudgetAlert(id)
    revalidatePath('/admin')
    return { ok: true, message: 'Budget alert deleted.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to delete budget alert' }
  }
}

/* ---------- GitHub Copilot integration ---------- */

export interface CopilotActionState {
  ok: boolean
  message: string
}

/**
 * The sync result travels back so the panel can render it.
 *
 * Only the counts, never anything derived from the credential. A sync that
 * failed carries a message and no result, which is what tells the panel to
 * render the error instead of a table of zeroes.
 */
export interface CopilotSyncState extends CopilotActionState {
  result?: CopilotSyncResult
}

export async function connectCopilotAction(
  _prev: CopilotActionState | null,
  formData: FormData,
): Promise<CopilotActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const org = String(formData.get('org') ?? '').trim()
  // Read, passed straight to the API, and never put anywhere else. It is not
  // logged, not echoed into the returned message, and not written back into
  // the form.
  const token = String(formData.get('token') ?? '').trim()

  if (!org) {
    return { ok: false, message: 'Enter the GitHub organization slug' }
  }
  if (!token) {
    return { ok: false, message: 'Enter a GitHub token' }
  }

  try {
    const connection = await connectCopilot(org, token)
    revalidatePath('/admin')
    return { ok: true, message: `Connected to ${connection.org}.` }
  } catch (err) {
    // The API's own words. A 503 says encryption is not configured and a 400
    // says GitHub refused the token, and those send an operator to two
    // different places.
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to connect Copilot' }
  }
}

export async function disconnectCopilotAction(
  _prev: CopilotActionState | null,
  _formData: FormData,
): Promise<CopilotActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  try {
    await disconnectCopilot()
    revalidatePath('/admin')
    return { ok: true, message: 'Copilot disconnected. Usage already recorded is kept.' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Failed to disconnect Copilot',
    }
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export async function syncCopilotAction(
  _prev: CopilotSyncState | null,
  formData: FormData,
): Promise<CopilotSyncState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  // Empty means yesterday UTC, which the API chooses. Checked here anyway so a
  // typo comes back as a sentence instead of a Zod 400.
  const day = String(formData.get('day') ?? '').trim()
  if (day && !DAY.test(day)) {
    return { ok: false, message: 'Enter a date as YYYY-MM-DD, or leave it empty for yesterday' }
  }

  try {
    const result = await syncCopilot(day || undefined)
    revalidatePath('/admin')
    return { ok: true, message: `Synced ${result.day}.`, result }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Copilot sync failed' }
  }
}

/** The roster travels back so the panel can render it. Nothing is stored. */
export interface CopilotSeatsState extends CopilotActionState {
  seats?: CopilotSeatsResponse
}

export async function loadCopilotSeatsAction(
  _prev: CopilotSeatsState | null,
  formData: FormData,
): Promise<CopilotSeatsState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  // Empty leaves the window to the API. Checked here anyway so a typo comes
  // back as a sentence instead of a Zod 400.
  const raw = String(formData.get('idleAfterDays') ?? '').trim()
  const idleAfterDays = raw ? Number(raw) : undefined
  if (
    idleAfterDays !== undefined &&
    (!Number.isInteger(idleAfterDays) || idleAfterDays < 1 || idleAfterDays > 365)
  ) {
    return { ok: false, message: 'Enter a whole number of days between 1 and 365' }
  }

  try {
    const seats = await fetchCopilotSeats(idleAfterDays)
    // No revalidatePath. This reads and writes nothing, and revalidating would
    // re-run every other fetch the admin page makes for no new information.
    return { ok: true, message: `Read ${seats.seats.length} seats from ${seats.org}.`, seats }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Failed to read the Copilot seats',
    }
  }
}

/* ---------- Teams (R0.2) ---------- */

export interface TeamActionState {
  ok: boolean
  message: string
}

const failed = (err: unknown, fallback: string): TeamActionState => ({
  ok: false,
  message: err instanceof Error ? err.message : fallback,
})

/**
 * Every team and seat write goes through here: admin gate, then the call, then
 * a revalidate of every page that shows teams or seat cost. The API also
 * refuses non-admins; this gate only saves the round trip and gives a sentence back.
 */
async function adminWrite(
  run: () => Promise<unknown>,
  success: string,
  fallback: string,
): Promise<TeamActionState> {
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }
  try {
    await run()
    // Overview and Trends read the team list and the seat cost too.
    revalidatePath('/', 'layout')
    return { ok: true, message: success }
  } catch (err) {
    return failed(err, fallback)
  }
}

const field = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim()

export async function createTeamAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const name = field(formData, 'name')
  if (!name) return { ok: false, message: 'Enter a team name' }
  return adminWrite(() => createTeam(name), `Team ${name} created.`, 'Failed to create team')
}

export async function renameTeamAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const id = field(formData, 'teamId')
  const name = field(formData, 'name')
  if (!id) return { ok: false, message: 'No team selected' }
  if (!name) return { ok: false, message: 'Enter a team name' }
  return adminWrite(() => renameTeam(id, name), 'Team renamed.', 'Failed to rename team')
}

export async function deleteTeamAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const id = field(formData, 'teamId')
  if (!id) return { ok: false, message: 'No team selected' }
  return adminWrite(() => deleteTeam(id), 'Team deleted.', 'Failed to delete team')
}

/** Add a member, or change an existing member's role. Same API call for both. */
export async function setTeamMemberAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const teamId = field(formData, 'teamId')
  const userId = field(formData, 'userId')
  const role = field(formData, 'role')
  if (!teamId) return { ok: false, message: 'No team selected' }
  if (!userId) return { ok: false, message: 'Pick a person' }
  if (role !== 'manager' && role !== 'member') return { ok: false, message: 'Unknown team role' }
  return adminWrite(() => setTeamMember(teamId, userId, role), 'Member saved.', 'Failed to save member')
}

export async function removeTeamMemberAction(
  _prev: TeamActionState | null,
  formData: FormData,
): Promise<TeamActionState> {
  const teamId = field(formData, 'teamId')
  const userId = field(formData, 'userId')
  if (!teamId || !userId) return { ok: false, message: 'No member selected' }
  return adminWrite(() => removeTeamMember(teamId, userId), 'Member removed.', 'Failed to remove member')
}

/* ---------- Seats (R0.1) ---------- */

export type SeatActionState = TeamActionState

/** Agent, price and start date: what one seat and "assign to everyone" both need. */
function parseSeatForm(formData: FormData) {
  const agent = field(formData, 'agent')
  const rawPrice = field(formData, 'monthlyPriceUsd')
  const monthlyPriceUsd = Number(rawPrice)
  const startDate = field(formData, 'startDate')
  if (!isAgentName(agent)) throw new Error('Pick an agent')
  if (!rawPrice || !Number.isFinite(monthlyPriceUsd) || monthlyPriceUsd < 0 || monthlyPriceUsd > 99999.99) {
    throw new Error('Enter a monthly price between 0 and 99,999.99')
  }
  if (!DAY.test(startDate)) throw new Error('Enter a start date as YYYY-MM-DD')
  return { agent, monthlyPriceUsd, startDate }
}

/** Add a seat, or change the price and start date of an existing one. Same API call for both. */
export async function setSeatAction(_prev: SeatActionState | null, formData: FormData): Promise<SeatActionState> {
  const userId = field(formData, 'userId')
  if (!userId) return { ok: false, message: 'Pick a person' }
  let seat: ReturnType<typeof parseSeatForm>
  try {
    seat = parseSeatForm(formData)
  } catch (err) {
    return failed(err, 'Invalid seat')
  }
  const { agent, ...input } = seat
  return adminWrite(() => setSeat(userId, agent, input), 'Seat saved.', 'Failed to save seat')
}

export async function removeSeatAction(_prev: SeatActionState | null, formData: FormData): Promise<SeatActionState> {
  const userId = field(formData, 'userId')
  const agent = field(formData, 'agent')
  if (!userId || !isAgentName(agent)) return { ok: false, message: 'No seat selected' }
  return adminWrite(() => removeSeat(userId, agent), 'Seat removed.', 'Failed to remove seat')
}

export async function assignSeatToAllAction(
  _prev: SeatActionState | null,
  formData: FormData,
): Promise<SeatActionState> {
  let input: ReturnType<typeof parseSeatForm>
  try {
    input = parseSeatForm(formData)
  } catch (err) {
    return failed(err, 'Invalid seat')
  }
  let created = 0
  const state = await adminWrite(
    async () => {
      created = (await assignSeatToAll(input)).created
    },
    '',
    'Failed to assign seats',
  )
  if (!state.ok) return state
  return {
    ok: true,
    message:
      created === 0
        ? `Everyone already has a ${input.agent} seat. Nothing changed.`
        : `Added ${created} ${input.agent} seat${created === 1 ? '' : 's'}. Existing seats were left as they were.`,
  }
}
