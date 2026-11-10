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
  // Explicit null, never absent. The unique index over the six-field key must
  // see it so two org-sourced rows with no device still collide.
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
