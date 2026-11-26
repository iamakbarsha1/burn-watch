import type { ObjectId } from 'mongodb'
import type {
  ActivityEntry,
  AgentName,
  AuditAction,
  AuditTarget,
  ProjectEntry,
  SessionEntry,
} from '@burn-watch/shared'
import type {
  AgentPolicyKey,
  DayKey,
  DeviceId,
  IntegrationKey,
  IsoDate,
  McpApprovalKey,
  Micros,
  OrgId,
  SeatKey,
  TeamId,
  TeamMemberKey,
  UserId,
} from './ids.js'

export interface OrganizationDoc {
  _id: OrgId
  name: string
  slug: string
  githubOrg: string | null
  createdAt: Date
  /** R2 B5. Absent = no minimum, nothing flagged for Claude Code. */
  minClaudeVersion?: string
  /** R2 B6. Claude org hashes that are the company's. Absent = not set, no outside-org flags. */
  ownClaudeOrgHashes?: string[]
  /** R2 C4. Jira project keys that count as tickets in branch names. Absent = not set. */
  ticketPrefixes?: string[]
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
  /** v2 Phase 2. Set only by the person: listed on Adoption as happy to help. Absent = false. */
  helpVolunteer?: boolean
}

export interface DeviceDoc {
  _id: DeviceId
  userId: UserId
  hostname: string
  platform: string
  /** Set at register, and on every submit from agent 0.4.0. */
  agentVersion: string
  /** Highest Claude Code version in the last submit. Null until a 0.4.0 agent submits. */
  claudeVersion: string | null
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
  /** Team joined on accept. Absent on invites made before R0.5. */
  teamId?: TeamId | null
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

export interface TeamDoc {
  _id: TeamId
  orgId: OrgId
  /** Unique per org. */
  name: string
  createdAt: Date
}

/**
 * One user's place in one team. Many-to-many: a user can sit in several teams
 * and a team can have several managers.
 *
 * `role: 'manager'` widens dashboard scope only for a user whose JWT role is
 * also 'manager'. The JWT role is the gate; this row only says which people.
 */
export interface TeamMemberDoc {
  _id: TeamMemberKey
  teamId: TeamId
  // Denormalised so every scope lookup can filter on org and a row written
  // against another org's user can never widen a viewer's scope.
  orgId: OrgId
  userId: UserId
  role: 'manager' | 'member'
  createdAt: Date
}

/** A paid seat for one user on one agent. Usage on a seated agent is not API spend. */
export interface SeatDoc {
  _id: SeatKey
  orgId: OrgId
  userId: UserId
  agent: AgentName
  monthlyPriceMicros: Micros
  startDate: IsoDate
  createdAt: Date
}

/**
 * An admin's approval of one MCP server key (R1 B3). `server` is the exact key
 * the agent sends, so `Neon` and `claude_ai_Neon` are two approvals. The key is
 * stored as a value, never as a field path, since it comes from developer configs.
 */
export interface McpApprovalDoc {
  _id: McpApprovalKey
  orgId: OrgId
  server: string
  note: string | null
  approvedBy: UserId
  approvedAt: Date
}

/**
 * The org's rule for one agent (R1 B2). No doc means "not set", which the
 * setup-check list flags. `models` holds exact model names, used only when
 * `rule` is 'models'.
 */
export interface AgentPolicyDoc {
  _id: AgentPolicyKey
  orgId: OrgId
  agent: AgentName
  rule: 'allowed' | 'models' | 'blocked'
  models: string[]
  note: string | null
  updatedBy: UserId
  updatedAt: Date
}

export type BudgetAlertType = 'api-spend' | 'idle-seat' | 'limit-hit'

export interface BudgetAlertDoc {
  _id: string
  orgId: OrgId
  type: BudgetAlertType
  /** Always null since v2 (0006 deleted per-person alerts): the alert covers the whole org. */
  userId: UserId | null
  /** Null means the alert covers every agent. */
  agent: AgentName | null
  /** api-spend only; 0 on the other types. */
  monthlyLimitMicros: Micros
  /** A ratio of the limit, not money, so it stays a plain number. api-spend only. */
  threshold: number
  /** idle-seat only. */
  idleDays: number | null
  /** limit-hit only: hits this month that trip the alert. */
  limitHits: number | null
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
  /** Set only when true: the model had no price, so costMicros is 0 for that reason. */
  unpriced?: true
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
  /** Null for days synced by an agent before 0.3.0. */
  limitHitCount: number | null
  /** The fields below are null for days synced by an agent before 0.4.0. */
  claudeVersions: Record<string, number> | null
  entrypointCounts: Record<string, number> | null
  skillCounts: Record<string, number> | null
  sidechainMessages: number | null
  permissionModeCounts: Record<string, number> | null
  accountHashes: string[] | null
  claudeOrgHashes: string[] | null
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

/**
 * One admin action or one day of views (R1 B8). Append-only from the API's
 * side: only apps/api/src/audit.ts writes here, and only the TTL deletes.
 * Actions use newId(); views use `view:org:viewer:surface:scope:day` so a
 * day's repeat views fold into one doc with a count.
 */
export interface AuditEventDoc {
  _id: string
  orgId: OrgId
  kind: 'action' | 'view'
  action: AuditAction
  actorId: UserId
  actorRole: 'device' | 'admin' | 'manager' | 'developer'
  target: AuditTarget
  /** Small, never secrets (tokens, invite or device codes, JWTs). */
  detail: Record<string, unknown> | null
  /** Views: first view that day. */
  at: Date
  /** Views only. */
  lastAt: Date | null
  /** 1 for actions; views per day. */
  count: number
  /** TTL. Null = kept: actions until B9 picks a period; views at + 365 days. */
  expiresAt: Date | null
  /**
   * Views only (v2.1): everyone the view covered when it happened, unioned over
   * the day. "Who viewed my data" matches on this, so a later team change does
   * not rewrite the past. Absent on views written before v2.1.
   */
  coveredUserIds?: UserId[]
}
