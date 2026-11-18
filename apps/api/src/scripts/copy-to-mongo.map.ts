/**
 * Postgres row to Mongo document, one function per table. Pure, so the money
 * and id conversions are tested without either database. See copy-to-mongo.ts.
 */
import {
  dayKey,
  integrationKey,
  microsFromUsd,

  type BudgetAlertDoc,
  type ClaudeEnrichmentDoc,
  type DailySnapshotDoc,
  type DeviceDoc,
  type DeviceId,
  type DeviceTokenDoc,
  type InviteDoc,
  type IsoDate,
  type Micros,
  type OrgId,
  type OrgIntegrationDoc,
  type OrganizationDoc,
  type PendingDeviceDoc,
  type UsageEventDoc,
  type UsageSource,
  type UserDoc,
  type UserId,
} from '@burn-watch/db'
import type { AgentName } from '@burn-watch/shared'
import type * as pg from '../../drizzle/schema.js'

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect']

/** numeric(12,6) arrives as a string. Six decimals, so micros are exact. */
const micros = (usd: string): Micros => microsFromUsd(Number(usd))
const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v))

export const orgDoc = (r: Row<typeof pg.organizations>): OrganizationDoc => ({
  _id: r.id as OrgId,
  name: r.name,
  slug: r.slug,
  githubOrg: r.githubOrg,
  createdAt: r.createdAt,
})

// passwordHash is left behind: dashboard login lives in better-auth's own
// `account` table, and no code reads this column.
export const userDoc = (r: Row<typeof pg.users>): UserDoc => ({
  _id: r.id as UserId,
  orgId: r.orgId as OrgId,
  // The API matches emails lowercased; Postgres compared with lower() on both sides.
  email: r.email.toLowerCase(),
  name: r.name,
  githubUsername: r.githubUsername,
  role: r.role,
  isActive: r.isActive,
  createdAt: r.createdAt,
})

export const deviceDoc = (r: Row<typeof pg.devices>): DeviceDoc => ({
  _id: r.id as DeviceId,
  userId: r.userId as UserId,
  hostname: r.hostname,
  platform: r.platform,
  agentVersion: r.agentVersion,
  lastSeenAt: r.lastSeenAt,
  createdAt: r.createdAt,
})

export const deviceTokenDoc = (r: Row<typeof pg.deviceTokens>): DeviceTokenDoc => ({
  _id: r.id,
  deviceId: r.deviceId as DeviceId,
  tokenHash: r.tokenHash,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
})

export const pendingDeviceDoc = (r: Row<typeof pg.pendingDevices>): PendingDeviceDoc => ({
  _id: r.id,
  code: r.code,
  email: r.email.toLowerCase(),
  hostname: r.hostname,
  platform: r.platform,
  agentVersion: r.agentVersion,
  expiresAt: r.expiresAt,
  approvedAt: r.approvedAt,
  verifiedAt: r.verifiedAt,
  deviceId: r.deviceId as DeviceId | null,
  createdAt: r.createdAt,
})

export const inviteDoc = (r: Row<typeof pg.invites>): InviteDoc => ({
  _id: r.id,
  orgId: r.orgId as OrgId,
  email: r.email.toLowerCase(),
  role: r.role,
  code: r.code,
  expiresAt: r.expiresAt,
  usedAt: r.usedAt,
  createdAt: r.createdAt,
})

export const orgIntegrationDoc = (r: Row<typeof pg.orgIntegrations>): OrgIntegrationDoc => ({
  _id: integrationKey(r.orgId as OrgId, r.provider),
  orgId: r.orgId as OrgId,
  provider: r.provider as 'copilot',
  encryptedToken: r.encryptedToken,
  lastSyncAt: r.lastSyncAt,
  createdAt: r.createdAt,
})

export const budgetAlertDoc = (r: Row<typeof pg.budgetAlerts>): BudgetAlertDoc => ({
  _id: r.id,
  orgId: r.orgId as OrgId,
  userId: r.userId as UserId | null,
  agent: r.agent as AgentName | null,
  monthlyLimitMicros: micros(r.monthlyLimitUsd),
  threshold: Number(r.threshold),
  trippedAt: r.trippedAt,
  createdAt: r.createdAt,
})

/** No _id: the copy upserts on the unique key, so a rerun keeps the first ObjectId. */
export const usageEventDoc = (
  r: Row<typeof pg.usageEvents>,
  orgId: OrgId,
): Omit<UsageEventDoc, '_id'> => ({
  userId: r.userId as UserId,
  orgId,
  deviceId: r.deviceId as DeviceId | null,
  source: r.source as UsageSource,
  agent: r.agent as AgentName,
  date: r.date as IsoDate,
  modelName: r.modelName,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  cacheCreateTokens: r.cacheCreateTokens,
  cacheReadTokens: r.cacheReadTokens,
  totalTokens: r.totalTokens,
  costMicros: micros(r.costUsd),
  isFreeTier: r.isFreeTier,
  submittedAt: r.submittedAt,
})

// sessionCount, callCount and cacheHitRate are not copied: DailySnapshotDoc
// owns them in Mongo (see the ClaudeEnrichmentDoc comment).
export const enrichmentDoc = (
  r: Row<typeof pg.claudeEnrichment>,
  orgId: OrgId,
): ClaudeEnrichmentDoc => ({
  _id: dayKey(r.userId as UserId, r.date as IsoDate),
  userId: r.userId as UserId,
  orgId,
  date: r.date as IsoDate,
  writtenTokens: r.writtenTokens,
  activityBreakdown: r.activityBreakdown,
  projectBreakdown: r.projectBreakdown,
  topSessions: r.topSessions,
  toolUsage: r.toolUsage,
  shellUsage: r.shellUsage,
  mcpUsage: r.mcpUsage,
  submittedAt: r.submittedAt,
})

const SNAPSHOT_AGENTS = ['claude', 'qwen', 'gemini', 'codex', 'copilot'] as const

export const snapshotDoc = (r: Row<typeof pg.dailySnapshots>): DailySnapshotDoc => {
  const byAgent: DailySnapshotDoc['byAgent'] = {}
  for (const a of SNAPSHOT_AGENTS) {
    const tokens = r[`${a}Tokens`]
    const costMicros = micros(r[`${a}CostUsd`])
    // Absent agent means zero, so a zero column is left out.
    if (tokens !== 0 || costMicros !== 0) byAgent[a] = { tokens, costMicros }
  }
  return {
    _id: dayKey(r.userId as UserId, r.date as IsoDate),
    userId: r.userId as UserId,
    orgId: r.orgId as OrgId,
    date: r.date as IsoDate,
    byAgent,
    totalTokens: r.totalTokens,
    totalCostMicros: micros(r.totalCostUsd),
    callCount: r.callCount,
    sessionCount: r.sessionCount,
    cacheHitRate: numOrNull(r.cacheHitRate),
    modelsUsed: r.modelsUsed ?? [],
    updatedAt: r.updatedAt,
  }
}
