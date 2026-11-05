'use server'

import { approveDevice } from '@/lib/api'
import { getApiToken } from '@/lib/session'

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
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to approve device' }
  }
}
