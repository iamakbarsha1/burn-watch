'use server'

import { inviteUser } from '@/lib/api'
import { getUserRole } from '@/lib/session'

export async function inviteAction(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const role = await getUserRole()
  if (role !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const email = formData.get('email') as string
  const name = formData.get('name') as string

  if (!email?.includes('@')) {
    return { ok: false, message: 'Valid email required' }
  }
  if (!name?.trim()) {
    return { ok: false, message: 'Name required' }
  }

  try {
    await inviteUser(email.trim(), name.trim())
    return { ok: true, message: `Invited ${email}. They can now run "burnwatch register".` }
  } catch (err: any) {
    return { ok: false, message: err.message ?? 'Failed to invite user' }
  }
}
