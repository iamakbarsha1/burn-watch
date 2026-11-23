import { describe, it, expect } from 'vitest'
import type { AuditAction, AuditRow } from '@burn-watch/shared'
import { auditSentence } from './audit'

const row = (action: AuditAction, over: Partial<AuditRow> = {}): AuditRow => ({
  id: 'e1',
  at: '2026-11-05T09:12:00.000Z',
  lastAt: null,
  count: 1,
  kind: action.startsWith('view.') ? 'view' : 'action',
  action,
  actor: { id: 'u1', name: 'Asha', role: 'admin' },
  target: { type: 'org', id: null, label: null },
  detail: null,
  ...over,
})
const names = new Map([['u2', 'Priya']])

describe('auditSentence', () => {
  it.each<[AuditAction, Partial<AuditRow>, string]>([
    ['device.approve', { detail: { hostname: 'mac.local', platform: 'darwin', pendingId: 'p' } }, 'Approved their device mac.local'],
    ['device.revoke', { target: { type: 'device', id: 'd', label: 'mac.local' }, detail: { ownerId: 'u2', hostname: 'mac.local' } }, "Revoked Priya's device mac.local"],
    ['device.self_revoke', {}, 'Uninstalled the agent on a device'],
    ['org.bootstrap', { detail: { orgName: 'Acme' } }, 'Set up the organization Acme'],
    ['user.create', { detail: { email: 'x@acme.dev', role: 'developer' } }, 'Added x@acme.dev as a developer'],
    ['invite.create', { target: { type: 'invite', id: 'i', label: 'x@acme.dev' }, detail: { role: 'manager' } }, 'Invited x@acme.dev as manager'],
    ['invite.bulk', { detail: { created: [{}, {}], failed: 1 } }, 'Invited 2 people from a CSV, 1 rows failed'],
    ['invite.accept', { detail: { role: 'developer', teamId: null } }, 'Accepted an invite as developer'],
    ['team.create', { detail: { name: 'Platform' } }, 'Created team Platform'],
    ['team.rename', { detail: { name: 'Core' } }, 'Renamed a team to Core'],
    ['team.delete', { target: { type: 'team', id: 't', label: 'Platform' } }, 'Deleted team Platform'],
    ['team.member_set', { target: { type: 'team', id: 't', label: 'Platform' }, detail: { userId: 'u2', userName: 'Priya', role: 'manager' } }, 'Made Priya a manager of Platform'],
    ['team.member_remove', { target: { type: 'team', id: 't', label: null }, detail: { userId: 'u2' } }, 'Removed Priya from a team'],
    ['seat.set', { target: { type: 'seat', id: 's', label: 'p@acme.dev' }, detail: { userId: 'u2', agent: 'claude', monthlyPriceUsd: 20, startDate: '2026-11-01' } }, "Set p@acme.dev's Claude seat to $20.00/month from 2026-11-01"],
    ['seat.remove', { detail: { userId: 'u2', agent: 'claude' } }, "Removed Priya's Claude seat"],
    ['seat.assign_all', { detail: { agent: 'claude', monthlyPriceUsd: 20, created: 3 } }, 'Gave 3 people a Claude seat at $20.00/month'],
    ['alert.create', { target: { type: 'alert', id: 'a', label: 'api-spend' } }, 'Created an API spend alert'],
    ['alert.update', { target: { type: 'alert', id: 'a', label: 'idle-seat' } }, 'Changed an idle seat alert'],
    ['alert.delete', {}, 'Deleted a budget alert'],
    ['policy.set', { detail: { agent: 'claude', rule: 'models', models: ['opus', 'sonnet'], note: null } }, 'Allowed only opus, sonnet on Claude'],
    ['policy.set', { detail: { agent: 'qwen', rule: 'blocked', models: [], note: null } }, 'Set Qwen to blocked'],
    ['policy.unset', { detail: { agent: 'qwen' } }, 'Cleared the Qwen policy'],
    ['mcp.approve', { detail: { server: 'Neon', note: null } }, 'Approved MCP server Neon'],
    ['mcp.unapprove', { detail: { server: 'Neon' } }, 'Removed the approval for MCP server Neon'],
    ['org.leaderboard_settings', { detail: { developerView: 'full', showNames: false, showOthersCost: true } }, "Changed leaderboard settings: developers see the whole list, names off, others' cost on"],
    ['org.min_claude_version', { detail: { minClaudeVersion: '2.1.0' } }, 'Set the minimum Claude Code version to 2.1.0'],
    ['org.min_claude_version', { detail: { minClaudeVersion: null } }, 'Cleared the minimum Claude Code version'],
    ['org.claude_orgs', { detail: { count: 2 } }, "Marked 2 Claude orgs as the company's"],
    ['org.claude_orgs', { detail: { count: 0 } }, "Cleared the company's Claude org"],
    ['copilot.connect', { detail: { org: 'acme' } }, 'Connected Copilot for GitHub org acme'],
    ['copilot.disconnect', {}, 'Disconnected Copilot'],
    ['copilot.sync', { detail: { day: '2026-11-09', reportPublished: true, written: 4 } }, 'Ran a Copilot sync for 2026-11-09: 4 rows written'],
    ['view.governance', { target: { type: 'team', id: 't', label: 'Platform' }, detail: { people: 6 } }, 'Viewed Governance for Platform (6 people)'],
    ['view.leaderboard', { target: { type: 'scope', id: null, label: 'org' } }, 'Viewed Leaderboard for the whole org'],
    ['view.adoption', { target: { type: 'scope', id: null, label: 'managed teams' }, detail: { people: 1 } }, 'Viewed Adoption for their teams (1 person)'],
    ['view.audit', { target: { type: 'scope', id: null, label: 'org' } }, 'Viewed the audit log for the whole org'],
  ])('%s reads as a sentence', (action, over, expected) => {
    expect(auditSentence(row(action, over), names)).toBe(expected)
  })
})
