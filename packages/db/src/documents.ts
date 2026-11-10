import type { ObjectId } from 'mongodb'
import type { ActivityEntry, AgentName, ProjectEntry, SessionEntry } from '@burn-watch/shared'
import type {
  DayKey,
  DeviceId,
  IntegrationKey,
  IsoDate,
  Micros,
  OrgId,
  UserId,
} from './ids.js'

export interface OrganizationDoc {
  _id: OrgId
  name: string
  slug: string
  githubOrg: string | null
  createdAt: Date
}

export interface UserDoc {
  _id: UserId
  orgId: OrgId
  email: string
  name: string
  githubUsername: string | null
  role: 'admin' | 'manager' | 'developer'
  isActive: boolean
  createdAt: Date
}

export interface DeviceDoc {
  _id: DeviceId
  userId: UserId
  hostname: string
  platform: string
  agentVersion: string
  lastSeenAt: Date
  createdAt: Date
}

export interface DeviceTokenDoc {
  _id: string
  deviceId: DeviceId
  tokenHash: string
  expiresAt: Date
  /** Null until the token is revoked. Every device request filters on it. */
  revokedAt: Date | null
  createdAt: Date
}

export interface PendingDeviceDoc {
  _id: string
  code: string
  email: string
  hostname: string
  platform: string
  agentVersion: string
  expiresAt: Date
  approvedAt: Date | null
  verifiedAt: Date | null
  /** Set when the code is exchanged for a device. */
  deviceId: DeviceId | null
  createdAt: Date
}

export interface InviteDoc {
  _id: string
  orgId: OrgId
  email: string
  role: 'admin' | 'manager' | 'developer'
  code: string
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export interface OrgIntegrationDoc {
  _id: IntegrationKey
  orgId: OrgId
  provider: 'copilot'
  encryptedToken: string
  lastSyncAt: Date | null
  createdAt: Date
}

export interface BudgetAlertDoc {
  _id: string
  orgId: OrgId
  /** Null means the alert covers the whole org. */
  userId: UserId | null
  /** Null means the alert covers every agent. */
  agent: AgentName | null
  monthlyLimitMicros: Micros
  /** A ratio of the limit, not money, so it stays a plain number. */
  threshold: number
  trippedAt: Date | null
  createdAt: Date
}

export interface RateLimitDoc {
  /** Route prefix plus caller address, as in Postgres where it was the primary key. */
  _id: string
  count: number
  /** The TTL index drops the row; the window is still decided by comparing this. */
  expiresAt: Date
}

/** Who reported a usage row: the developer's machine, or the GitHub org-level Copilot pull. */
export type UsageSource = 'agent' | 'copilot-org'

export interface UsageEventDoc {
  _id: ObjectId
  userId: UserId
  // orgId denormalised: a user never changes org (no route does it), and it lets
  // every org-scoped read $match without a $lookup through users.
  orgId: OrgId
  // Explicit null, never absent, and always named in an upsert filter. A filter
  // that omits deviceId is unconstrained on it, so one device's row would match
  // another device's upsert and suppress its write. The unique index itself
  // already treats a missing field as null.
  deviceId: DeviceId | null
  source: UsageSource
  agent: AgentName
  date: IsoDate
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalTokens: number
  costMicros: Micros
  isFreeTier: boolean
  submittedAt: Date
}

/**
 * The heavy Claude-only blobs, one document per user-day.
 *
 * callCount, sessionCount and cacheHitRate are deliberately not here.
 * DailySnapshotDoc already carries them, and rebuildDailySnapshot's
 * $set/$setOnInsert split exists to keep a recompute from clobbering exactly
 * those three. Same _id as the snapshot, so pairing the two is a key lookup.
 *
 * orgId is denormalised for the reason UsageEventDoc denormalises it: the
 * org-scoped range reads in routes/dashboard/enrichment.ts join through users
 * today purely to reach it, and Postgres had no org_id column to read.
 *
 * Every blob is nullable because every jsonb column behind it is.
 */
export interface ClaudeEnrichmentDoc {
  _id: DayKey
  userId: UserId
  orgId: OrgId
  date: IsoDate
  writtenTokens: number
  activityBreakdown: ActivityEntry[] | null
  projectBreakdown: ProjectEntry[] | null
  topSessions: SessionEntry[] | null
  toolUsage: Record<string, number> | null
  shellUsage: Record<string, number> | null
  mcpUsage: Record<string, number> | null
  submittedAt: Date
}

export interface DailySnapshotDoc {
  _id: DayKey
  userId: UserId
  orgId: OrgId
  date: IsoDate
  /** The ten per-agent columns were SQL's way of spelling a map. Absent agent = 0. */
  byAgent: Partial<Record<AgentName, { tokens: number; costMicros: Micros }>>
  totalTokens: number
  totalCostMicros: Micros
  callCount: number
  sessionCount: number
  cacheHitRate: number | null
  modelsUsed: string[]
  updatedAt: Date
}
