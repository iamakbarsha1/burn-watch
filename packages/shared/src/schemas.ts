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

const DeviceCode = z.string().length(6).regex(/^[A-Z0-9]{6}$/)

export const VerifyDeviceSchema = z.object({
  pendingId: z.string().uuid(),
  code: DeviceCode,
})

// The dashboard approval step. No pendingId: the person typing the code read it
// off a terminal and has no reason to know the id.
export const ApproveDeviceSchema = z.object({
  code: DeviceCode,
})

// A budget alert's stored configuration. `orgId` is deliberately absent: it
// comes from the caller's token, never from the body, which is the same rule
// the dashboard routes follow after an org-scoping bug was fixed there.
//
// `monthlyLimitUsd` is capped at what numeric(10, 2) holds, so an over-large
// figure is a 400 rather than a database error. `threshold` is the fraction of
// the limit that trips the alert, so 0.8 warns at 80%; 1 is allowed and means
// "tell me when I reach the limit itself", and anything above 1 would describe
// an alert that fires after the budget is already blown, which nobody wants.
export const BudgetAlertInputSchema = z.object({
  userId: z.string().uuid().nullable().default(null),
  agent: AgentNameSchema.nullable().default(null),
  monthlyLimitUsd: z.number().positive().max(99999999.99),
  threshold: z.number().positive().max(1).default(0.8),
})

// Every field optional, but at least one present. A PATCH with an empty body
// would otherwise be a successful no-op that looks like a saved change.
export const BudgetAlertPatchSchema = BudgetAlertInputSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Provide at least one field to update' },
)

export type BudgetAlertInput = z.infer<typeof BudgetAlertInputSchema>
export type BudgetAlertPatch = z.infer<typeof BudgetAlertPatchSchema>

export type UsageEventInput = z.infer<typeof UsageEventSchema>
export type ClaudeEnrichmentInput = z.infer<typeof ClaudeEnrichmentSchema>
export type UsagePayloadInput = z.infer<typeof UsagePayloadSchema>
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>
export type VerifyDeviceInput = z.infer<typeof VerifyDeviceSchema>
export type ApproveDeviceInput = z.infer<typeof ApproveDeviceSchema>
