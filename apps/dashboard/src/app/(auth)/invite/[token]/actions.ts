'use server'

import { acceptInvite } from '@/lib/api'

export async function acceptInviteAction(
  token: string,
  name: string,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  try {
    const { email } = await acceptInvite(token, name)
    return { ok: true, email }
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Could not accept this invite' }
  }
}
