import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AdminDeviceRow } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  devices: [] as AdminDeviceRow[],
  min: null as string | null,
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role }))
vi.mock('@/lib/api', () => ({
  fetchAdminDevices: async () => state.devices,
  fetchDeviceSettings: async () => ({ minClaudeVersion: state.min }),
}))
// Client components with server actions; the table is what is under test.
vi.mock('./ApproveDeviceForm', () => ({ ApproveDeviceForm: () => null }))
vi.mock('./RevokeDeviceButton', () => ({ RevokeDeviceButton: () => null }))
vi.mock('./DeviceSettingsForm', () => ({
  DeviceSettingsForm: ({ minClaudeVersion }: { minClaudeVersion: string | null }) => (
    <i data-min={minClaudeVersion ?? 'none'} />
  ),
}))

const { default: DevicesPage } = await import('./page')

const render = async () => renderToStaticMarkup(await DevicesPage())

const row = (over: Partial<AdminDeviceRow>): AdminDeviceRow => ({
  id: 'd',
  hostname: 'box',
  platform: 'darwin',
  reporting: true,
  userName: 'Ada',
  userEmail: 'ada@example.com',
  revoked: false,
  agentVersion: '0.6.0',
  claudeVersion: '2.1.330',
  ...over,
})

/** The text of the table row for one hostname, tags stripped. */
const rowText = (html: string, hostname: string) =>
  html
    .split('<tr')
    .find((r) => r.includes(`>${hostname}<`))!
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')

beforeEach(() => {
  state.role = 'admin'
  state.min = null
  state.devices = [
    row({ id: '1', hostname: 'current', claudeVersion: '2.1.330' }),
    row({ id: '2', hostname: 'behind', claudeVersion: '2.0.9' }),
    row({ id: '3', hostname: 'old', agentVersion: '0.2.4', claudeVersion: null }),
    row({ id: '4', hostname: 'codex-only', claudeVersion: null }),
    row({ id: '5', hostname: 'gone', revoked: true, agentVersion: '0.1.0', claudeVersion: null }),
  ]
})

describe('DevicesPage versions', () => {
  it('flags a Claude Code version below the minimum, and only that one', async () => {
    state.min = '2.1.0'
    const html = await render()
    expect(rowText(html, 'behind')).toContain('2.0.9 Below 2.1.0')
    expect(rowText(html, 'current')).toContain('2.1.330')
    expect(rowText(html, 'current')).not.toContain('Below')
    expect(html).toContain('data-min="2.1.0"')
  })

  it('shows unknown with Update agent for an agent before 0.4.0, never below', async () => {
    state.min = '2.1.0'
    const html = await render()
    const old = rowText(html, 'old')
    expect(old).toContain('Unknown (agent before 0.4.0)')
    expect(old).toContain('0.2.4 Update agent')
    expect(old).not.toContain('Below')
    expect(rowText(html, 'current')).not.toContain('Update agent')
  })

  it('says No Claude Code use for a 0.4 agent with no version', async () => {
    expect(rowText(await render(), 'codex-only')).toContain('No Claude Code use')
  })

  it('flags nothing for Claude Code with no minimum set', async () => {
    const html = await render()
    expect(html).not.toContain('Below')
    expect(html).toContain('No minimum set.')
  })

  it('summarises active devices, leaving revoked rows out', async () => {
    state.min = '2.1.0'
    const text = (await render()).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    expect(text).toContain('Agent 0.6.0+: 3 of 4 active devices. Below the Claude Code minimum: 1. Unknown: 1.')
    expect(text).toContain('gone')
  })

  it('links the setup guide for rebuilding an old agent', async () => {
    expect(await render()).toContain('href="/setup"')
  })

  it('shows a developer no table, minimum or versions', async () => {
    state.role = 'developer'
    const html = await render()
    expect(html).not.toContain('Claude Code')
    expect(html).not.toContain('data-min')
  })
})
