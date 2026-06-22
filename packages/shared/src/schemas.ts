import { z } from 'zod'

export const AgentNameSchema = z.enum(['claude', 'qwen', 'gemini', 'codex', 'copilot'])

const dateRegex = /^\d{4}-\d{2}-\d{2}$/

export const UsageEventSchema = z.object({
  agent: AgentNameSchema,
  date: z.string().regex(dateRegex, 'Must be YYYY-MM-DD'),
  modelName: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreateTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  isFreeTier: z.boolean(),
})

export const ActivityEntrySchema = z.object({
  type: z.string().min(1),
  cost: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  oneShotRate: z.number().min(0).max(100),
})

export const ProjectEntrySchema = z.object({
  path: z.string().min(1),
  cost: z.number().nonnegative(),
  avgPerSession: z.number().nonnegative(),
  sessions: z.number().int().nonnegative(),
  overheadK: z.number().nonnegative(),
})

export const SessionEntrySchema = z.object({
  date: z.string(),
  project: z.string(),
  cost: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
})

export const ClaudeEnrichmentSchema = z.object({
  date: z.string().regex(dateRegex),
  sessionCount: z.number().int().nonnegative(),
  callCount: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(100),
  writtenTokens: z.number().int().nonnegative(),
  activityBreakdown: z.array(ActivityEntrySchema),
  projectBreakdown: z.array(ProjectEntrySchema),
  topSessions: z.array(SessionEntrySchema),
  toolUsage: z.record(z.string(), z.number().int().nonnegative()),
  shellUsage: z.record(z.string(), z.number().int().nonnegative()),
  mcpUsage: z.record(z.string(), z.number().int().nonnegative()),
})

export const UsagePayloadSchema = z.object({
  deviceId: z.string().uuid(),
  date: z.string().regex(dateRegex),
  events: z.array(UsageEventSchema).max(500),
  enrichment: ClaudeEnrichmentSchema.nullable(),
})

export const RegisterDeviceSchema = z.object({
  email: z.string().email(),
  hostname: z.string().min(1).max(255),
  platform: z.string().min(1).max(50),
  agentVersion: z.string().min(1).max(50),
})

export const VerifyDeviceSchema = z.object({
  pendingId: z.string().uuid(),
  code: z.string().length(6).regex(/^[A-Z0-9]{6}$/),
})

export type UsageEventInput = z.infer<typeof UsageEventSchema>
export type ClaudeEnrichmentInput = z.infer<typeof ClaudeEnrichmentSchema>
export type UsagePayloadInput = z.infer<typeof UsagePayloadSchema>
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>
export type VerifyDeviceInput = z.infer<typeof VerifyDeviceSchema>
