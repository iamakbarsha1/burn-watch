'use server'

import { revalidatePath } from 'next/cache'
import { DeviceSettingsSchema } from '@burn-watch/shared'
import { approveDevice, revokeDevice, updateDeviceSettings } from '@/lib/api'
import { getApiToken, getSession, getUserRole } from '@/lib/session'

const CODE = /^[A-Z0-9]{6}$/

export async function approveDeviceAction(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  if (!(await getApiToken())) {
    return { ok: false, message: 'Sign in again to approve a device' }
  }

  // Typed off a terminal, so fix the casing and stray spaces here rather than
  // bouncing the request for them.
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  if (!CODE.test(code)) {
    return { ok: false, message: 'Enter the 6-character code shown by burnwatch register' }
  }

  try {
    const { hostname, platform } = await approveDevice(code)
    return { ok: true, message: `Approved ${hostname} (${platform}). The agent finishes on its own.` }
  } catch (err) {
    // The API answers every failure alike so codes cannot be probed. Naming
    // the signed-in account is safe, and it is the usual cause: approving a
    // colleague's code from your own login.
    const email = (await getSession())?.user?.email
    const hint = email ? ` Signed in as ${email}; a code only works for the same email it was registered with.` : ''
    return { ok: false, message: `${err instanceof Error ? err.message : 'Failed to approve device'}.${hint}` }
  }
}

export async function revokeDeviceAction(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  // The real control is requireAdmin on the API. This only keeps a non-admin
  // from getting a confusing 403 out of a button they should not have seen.
  if ((await getUserRole()) !== 'admin') {
    return { ok: false, message: 'Admin role required' }
  }

  const deviceId = String(formData.get('deviceId') ?? '')
  const hostname = String(formData.get('hostname') ?? 'this device')
  if (!deviceId) {
    return { ok: false, message: 'No device selected' }
  }

  try {
    const { revoked } = await revokeDevice(deviceId)
    revalidatePath('/devices')
    return {
      ok: true,
      message:
        revoked === 0
          ? `${hostname} already had no live token.`
          : `Revoked ${hostname}. It cannot report usage again until it re-registers.`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to revoke device' }
  }
}

/** Set or clear the org's minimum Claude Code version. Admin only; the API checks again. */
export async function deviceSettingsAction(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }

  // Clear is its own button, so an empty Save is a typo, not a request to clear.
  const clear = formData.get('intent') === 'clear'
  const parsed = DeviceSettingsSchema.safeParse({
    minClaudeVersion: clear ? null : String(formData.get('minClaudeVersion') ?? '').trim(),
  })
  if (!parsed.success) return { ok: false, message: 'Enter a version like 2.1.0' }

  try {
    const { minClaudeVersion } = await updateDeviceSettings(parsed.data)
    revalidatePath('/devices')
    return {
      ok: true,
      message: minClaudeVersion ? `Minimum set to ${minClaudeVersion}.` : 'Minimum cleared.',
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save the minimum' }
  }
}
