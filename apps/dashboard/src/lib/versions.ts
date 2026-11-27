import { AGENT_FIELDS_VERSION, UPDATE_AGENT_VERSION, compareVersions, type AdminDeviceRow } from '@burn-watch/shared'

export interface DeviceVersionStatus {
  /** below: under the org minimum. unknown: agent too old to report it. none: agent reports, no Claude Code use seen. */
  claude: 'ok' | 'below' | 'unknown' | 'none'
  /** True below AGENT_FIELDS_VERSION, the first agent that sends both versions. */
  agentOld: boolean
  /** True below UPDATE_AGENT_VERSION: the "Update agent" badge. */
  updateAgent: boolean
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
  return { claude, agentOld, updateAgent: compareVersions(row.agentVersion, UPDATE_AGENT_VERSION) < 0 }
}

export interface VersionSummary {
  active: number
  agentCurrent: number
  below: number
  unknown: number
}

/** Counts over active devices only: a live token and reporting in the last 7 days. Others stay in the table but not here. */
export function versionSummary(rows: AdminDeviceRow[], min: string | null): VersionSummary {
  const active = rows.filter((r) => !r.revoked && r.reporting)
  const statuses = active.map((r) => deviceVersionStatus(r, min))
  return {
    active: active.length,
    agentCurrent: statuses.filter((s) => !s.updateAgent).length,
    below: statuses.filter((s) => s.claude === 'below').length,
    unknown: statuses.filter((s) => s.claude === 'unknown').length,
  }
}
