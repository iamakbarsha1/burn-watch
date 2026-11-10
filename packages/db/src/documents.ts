import type { ObjectId } from 'mongodb'
import type { AgentName } from '@burn-watch/shared'
import type { DayKey, DeviceId, IsoDate, Micros, OrgId, UserId } from './ids.js'

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
