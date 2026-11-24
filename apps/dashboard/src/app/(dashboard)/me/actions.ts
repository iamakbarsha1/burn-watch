'use server'

import { revalidatePath } from 'next/cache'
import { setHelpVolunteer } from '@/lib/api'

export interface HelpVolunteerState {
  ok: boolean
  message: string
}

/** v2 Phase 2. Any role; the API writes only the caller's own flag. */
export async function helpVolunteerAction(
  _prev: HelpVolunteerState | null,
  formData: FormData,
): Promise<HelpVolunteerState> {
  // An unchecked checkbox is not sent at all.
  const on = formData.get('helpVolunteer') === 'on'
  try {
    await setHelpVolunteer(on)
    revalidatePath('/me')
    revalidatePath('/adoption')
    return { ok: true, message: on ? 'Your name now shows on the Adoption page.' : 'Your name no longer shows.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}
