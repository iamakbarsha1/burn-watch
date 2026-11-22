import { AGENT_FIELDS_VERSION, compareVersions, type AdminDeviceRow } from '@burn-watch/shared'

/** A1's default: a device counts as active when it holds a live token and was seen in the last 14 days. */
const ACTIVE_DAYS = 14

export interface DeviceVersionStatus {
  /** below: under the org minimum. unknown: agent too old to report it. none: agent reports, no Claude Code use seen. */
  claude: 'ok' | 'below' | 'unknown' | 'none'
  /** True below AGENT_FIELDS_VERSION, the first agent that sends both versions. */
  agentOld: boolean
}

export function deviceVersionStatus(
  row: Pick<AdminDeviceRow, 'agentVersion' | 'claudeVersion'>,
  min: string | null,
): DeviceVersionStatus {
  const agentOld = compareVersions(row.agentVersion, AGENT_FIELDS_VERSION) < 0
  // Unknown is never counted as below: that would claim a fact we do not have.
  const claude = agentOld
    ? 'unknown'
    : row.claudeVersion === null
      ? 'none'
      : min && compareVersions(row.claudeVersion, min) < 0
        ? 'below'
        : 'ok'
  return { claude, agentOld }
}

export interface VersionSummary {
  active: number
  agentCurrent: number
  below: number
  unknown: number
}

/** Counts over active devices only; revoked and long-unseen rows stay in the table but not here. */
export function versionSummary(rows: AdminDeviceRow[], min: string | null, now: Date = new Date()): VersionSummary {
  const since = now.getTime() - ACTIVE_DAYS * 86_400_000
  const active = rows.filter((r) => !r.revoked && r.lastSeenAt !== null && new Date(r.lastSeenAt).getTime() >= since)
  const statuses = active.map((r) => deviceVersionStatus(r, min))
  return {
    active: active.length,
    agentCurrent: statuses.filter((s) => !s.agentOld).length,
    below: statuses.filter((s) => s.claude === 'below').length,
    unknown: statuses.filter((s) => s.claude === 'unknown').length,
  }
}
