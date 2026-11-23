'use server'

import { revalidatePath } from 'next/cache'
import { setTicketPrefixes } from '@/lib/api'
import { getUserRole } from '@/lib/session'

export interface TicketActionState {
  ok: boolean
  message: string
}

const KEY = /^[A-Z][A-Z0-9]{1,9}$/

/** R2 C4. Save the org's Jira project keys from a comma or space separated list; empty clears. Admin only; the API checks again. */
export async function ticketPrefixesAction(_prev: TicketActionState | null, formData: FormData): Promise<TicketActionState> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }
  const prefixes = [
    ...new Set(
      String(formData.get('prefixes') ?? '')
        .split(/[\s,]+/)
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
  const bad = prefixes.filter((p) => !KEY.test(p))
  if (bad.length) return { ok: false, message: `Not a project key: ${bad.join(', ')}. Use 2 to 10 letters or digits, starting with a letter.` }
  if (prefixes.length > 50) return { ok: false, message: 'At most 50 keys' }
  try {
    await setTicketPrefixes(prefixes)
    revalidatePath('/tickets')
    return { ok: true, message: prefixes.length ? 'Project keys saved.' : 'Project keys cleared.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}
