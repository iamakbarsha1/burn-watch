import type { UsagePayload, RegisterDeviceRequest, VerifyDeviceResponse } from '@burn-watch/shared'

export class ApiClient {
  constructor(private apiUrl: string, private accessToken: string) {}

  async postUsage(payload: UsagePayload): Promise<{ accepted: number; skipped: number; date: string }> {
    const res = await fetch(`${this.apiUrl}/v1/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async refreshToken(refreshToken: string): Promise<{ accessToken: string }> {
    const res = await fetch(`${this.apiUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshToken}` },
    })
    if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
    return res.json()
  }

  static async registerDevice(
    apiUrl: string,
    data: RegisterDeviceRequest,
  ): Promise<VerifyDeviceResponse> {
    const res = await fetch(`${apiUrl}/v1/auth/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`Registration failed: ${res.status} ${await res.text()}`)
    return res.json()
  }
}
