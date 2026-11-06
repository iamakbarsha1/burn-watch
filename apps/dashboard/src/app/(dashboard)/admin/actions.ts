'use server'

import { revalidatePath } from 'next/cache'
import { createInvite } from '@/lib/api'
import { getUserRole } from '@/lib/session'

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
