'use server'

import { revalidatePath } from 'next/cache'
import {
  createInvite,
  createBudgetAlert,
  updateBudgetAlert,
  deleteBudgetAlert,
  connectCopilot,
  disconnectCopilot,
  syncCopilot,
} from '@/lib/api'
import { getUserRole } from '@/lib/session'
import type { AgentName, CopilotSyncResult } from '@burn-watch/shared'

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

export interface BudgetAlertActionState {
  ok: boolean
  message: string
}

const AGENTS: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']

function isAgentName(value: string): value is AgentName {
  return (AGENTS as string[]).includes(value)
}

/**
 * Shared by create and update: a threshold typed as a whole percent (the UI
 * never shows a bare fraction) parsed down to what the API stores, and the
 * optional scoping fields collapsed from "" to null rather than left as an
 * empty string the API would reject.
 */
function parseBudgetAlertForm(formData: FormData) {
  const monthlyLimitUsd = Number(formData.get('monthlyLimitUsd'))
  const thresholdPct = Number(formData.get('thresholdPct'))
  const userId = String(formData.get('userId') ?? '').trim() || null
  const rawAgent = String(formData.get('agent') ?? '').trim()

  if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0) {
    throw new Error('Enter a monthly limit greater than 0')
  }
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct > 100) {
    throw new Error('Enter a threshold between 1 and 100')
  }
  if (rawAgent && !isAgentName(rawAgent)) {
    throw new Error('Unknown agent')
  }
  const agent: AgentName | null = rawAgent && isAgentName(rawAgent) ? rawAgent : null

  return { monthlyLimitUsd, threshold: thresholdPct / 100, userId, agent }
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
    const { userId, agent, ...patch } = parseBudgetAlertForm(formData)
    await updateBudgetAlert(id, { ...patch, userId, agent })
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
