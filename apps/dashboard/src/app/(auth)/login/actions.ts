'use server'

import { createApiTokenForEmail, setApiTokenCookie, clearApiTokenCookie } from '@/lib/session'

export async function mintApiToken(email: string): Promise<{ success: boolean; error?: string }> {
  const result = await createApiTokenForEmail(email)
  if (!result) {
    return { success: false, error: 'User not found in BurnWatch. Ask your admin to invite you.' }
  }
  await setApiTokenCookie(result.token)
  return { success: true }
}

export async function signOutAction() {
  await clearApiTokenCookie()
}
