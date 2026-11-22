'use server'

import { revalidatePath } from 'next/cache'
import { setHideOnLeaderboard } from '@/lib/api'

/** The caller's own "Hide my name on the leaderboard". Any role; the API writes only the caller's flag. */
export async function hideNameAction(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const hide = formData.get('hide') === 'on'
  try {
    await setHideOnLeaderboard(hide)
    revalidatePath('/users')
    return { ok: true, message: hide ? 'Your name is hidden.' : 'Your name is shown.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}
