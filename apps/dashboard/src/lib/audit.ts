import type { AuditRow, AuditSurface } from '@burn-watch/shared'
import { agentById } from './agents'
import { formatCost } from './format'

export const SURFACES: Record<AuditSurface, string> = {
  // Removed in v2; kept so audit rows written before then still read.
  leaderboard: 'Leaderboard',
  usage_distribution: 'Usage distribution',
  governance: 'Governance',
  adoption: 'Adoption',
  people: 'the people list',
  team_compare: 'Team comparison',
  overview: 'Overview',
  trends: 'Trends',
  audit: 'the audit log',
}

const ALERTS: Record<string, string> = { 'api-spend': 'an API spend', 'idle-seat': 'an unused seat', 'limit-hit': 'a limit-hit' }

const agent = (id: unknown) => agentById(String(id))?.label ?? String(id)

/**
 * One plain sentence per event, so the table stays dumb. `names` maps user ids
 * to names, for events whose detail names a person by id.
 */
export function auditSentence(row: AuditRow, names: ReadonlyMap<string, string> = new Map()): string {
  const d = (row.detail ?? {}) as Record<string, unknown>
  const label = row.target.label
  const person = (id: unknown) => names.get(String(id)) ?? 'someone'

  if (row.kind === 'view') {
    const surface = SURFACES[row.action.slice('view.'.length) as AuditSurface] ?? row.action
    const scope =
      row.target.type === 'team'
        ? (label ?? 'a deleted team')
        : label === 'managed teams'
          ? 'their teams'
          : 'the whole org'
    const people = typeof d.people === 'number' ? ` (${d.people} ${d.people === 1 ? 'person' : 'people'})` : ''
    return `Viewed ${surface} for ${scope}${people}`
  }

  switch (row.action) {
    case 'device.approve':
      return `Approved their device ${d.hostname ?? ''}`.trim()
    case 'device.revoke':
      return `Revoked ${person(d.ownerId)}'s device ${label ?? ''}`.trim()
    case 'device.self_revoke':
      return 'Uninstalled the agent on a device'
    case 'org.bootstrap':
      return `Set up the organization ${d.orgName ?? ''}`.trim()
    case 'user.create':
      return `Added ${d.email} as a developer`
    case 'invite.create':
      return `Invited ${label} as ${d.role}`
    case 'invite.bulk': {
      const n = Array.isArray(d.created) ? d.created.length : 0
      const failed = typeof d.failed === 'number' && d.failed > 0 ? `, ${d.failed} rows failed` : ''
      return `Invited ${n} ${n === 1 ? 'person' : 'people'} from a CSV${failed}`
    }
    case 'invite.accept':
      return `Accepted an invite as ${d.role}`
    case 'team.create':
      return `Created team ${d.name}`
    case 'team.rename':
      return `Renamed a team to ${d.name}`
    case 'team.delete':
      return `Deleted team ${label ?? ''}`.trim()
    case 'team.member_set':
      return `Made ${d.userName ?? person(d.userId)} a ${d.role} of ${label ?? 'a team'}`
    case 'team.member_remove':
      return `Removed ${person(d.userId)} from ${label ?? 'a team'}`
    case 'seat.set':
      return `Set ${label ?? person(d.userId)}'s ${agent(d.agent)} seat to ${formatCost(Number(d.monthlyPriceUsd))}/month from ${d.startDate}`
    case 'seat.remove':
      return `Removed ${person(d.userId)}'s ${agent(d.agent)} seat`
    case 'seat.assign_all':
      return `Gave ${d.created} ${d.created === 1 ? 'person' : 'people'} a ${agent(d.agent)} seat at ${formatCost(Number(d.monthlyPriceUsd))}/month`
    case 'alert.create':
      return `Created ${ALERTS[label ?? ''] ?? 'a budget'} alert`
    case 'alert.update':
      return `Changed ${ALERTS[label ?? ''] ?? 'a budget'} alert`
    case 'alert.delete':
      return 'Deleted a budget alert'
    case 'policy.set':
      return d.rule === 'models'
        ? `Allowed only ${(d.models as string[]).join(', ')} on ${agent(d.agent)}`
        : `Set ${agent(d.agent)} to ${d.rule}`
    case 'policy.unset':
      return `Cleared the ${agent(d.agent)} policy`
    case 'mcp.approve':
      return `Approved MCP server ${d.server}`
    case 'mcp.unapprove':
      return `Removed the approval for MCP server ${d.server}`
    // Removed in v2; kept so audit rows written before then still read.
    case 'org.leaderboard_settings': {
      const view = { own: 'their own row', rank: 'their own row and rank', full: 'the whole list' }[String(d.developerView)]
      return `Changed leaderboard settings: developers see ${view ?? d.developerView}, names ${d.showNames ? 'on' : 'off'}, others' cost ${d.showOthersCost ? 'on' : 'off'}`
    }
    case 'org.min_claude_version':
      return d.minClaudeVersion
        ? `Set the minimum Claude Code version to ${d.minClaudeVersion}`
        : 'Cleared the minimum Claude Code version'
    case 'org.claude_orgs':
      return d.count ? `Marked ${d.count} Claude ${d.count === 1 ? 'org' : 'orgs'} as the company's` : "Cleared the company's Claude org"
    case 'org.ticket_prefixes':
      return (d.prefixes as string[] | undefined)?.length
        ? `Set ticket project keys to ${(d.prefixes as string[]).join(', ')}`
        : 'Cleared the ticket project keys'
    case 'copilot.connect':
      return `Connected Copilot for GitHub org ${d.org}`
    case 'copilot.disconnect':
      return 'Disconnected Copilot'
    case 'copilot.sync':
      return `Ran a Copilot sync for ${d.day}: ${d.written ?? 0} rows written${d.reportPublished === false ? ', no report from GitHub yet' : ''}`
    default:
      return row.action
  }
}
