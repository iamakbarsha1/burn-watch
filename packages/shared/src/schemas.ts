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

const count = z.number().int().nonnegative()
const countMap = z.record(z.string(), count)

// `.describe()` text is what the R0.4 transparency page shows for each field
// the agent sends, so every enrichment field carries one.
export const BranchEntrySchema = z.object({
  name: z.string().max(200).describe('Git branch name, as Claude Code recorded it'),
  cost: z.number().nonnegative().describe("Share of the day's Claude cost spent on this branch, USD"),
  sessions: count.describe('Claude Code sessions on this branch'),
})

export const ProjectEntrySchema = z.object({
  // Wire name kept so 0.2/0.3 agents still validate; it no longer holds a path.
  path: z.string().min(1).describe('Repository name (last segment of the remote, or the folder name), not a path'),
  remote: z
    .string()
    .max(300)
    .nullable()
    .optional()
    .describe('Git origin as host/owner/repo, credentials removed; null when there is none. Agent 0.4.0+'),
  branches: z
    .array(BranchEntrySchema)
    .max(50)
    .optional()
    .describe('Cost and sessions per Git branch in this repository. Agent 0.4.0+'),
  cost: z.number().nonnegative().describe("Share of the day's Claude cost spent in this repository, USD"),
  avgPerSession: z.number().nonnegative().describe('cost divided by sessions'),
  sessions: count.describe('Claude Code sessions in this repository'),
  overheadK: z.number().nonnegative().describe('Cached context read back, in thousands of tokens'),
})

export const SessionEntrySchema = z.object({
  date: z.string(),
  project: z.string(),
  cost: z.number().nonnegative(),
  calls: count,
})

export const ClaudeEnrichmentSchema = z.object({
  date: z.string().regex(dateRegex).describe('Day the figures cover, UTC'),
  sessionCount: count.describe('Distinct Claude Code sessions that day'),
  callCount: count.describe('Assistant messages that day'),
  cacheHitRate: z.number().min(0).max(100).describe('Share of input tokens served from cache, percent'),
  writtenTokens: count.describe('Output tokens'),
  activityBreakdown: z.array(ActivityEntrySchema).describe('Not filled by the agent today'),
  projectBreakdown: z.array(ProjectEntrySchema).describe('Cost and sessions per repository'),
  topSessions: z.array(SessionEntrySchema).describe('Not filled by the agent today'),
  toolUsage: countMap.describe('Tool calls per built-in tool name'),
  shellUsage: countMap.describe('Shell commands per first word of the command, no arguments'),
  mcpUsage: countMap.describe('Tool calls per MCP server name'),
  // Optional fields: older agents do not send them.
  limitHitCount: count.optional().describe('Distinct Claude usage-limit notices. Agent 0.3.0+'),
  claudeVersions: countMap.optional().describe('Assistant messages per Claude Code version. Agent 0.4.0+'),
  entrypointCounts: countMap
    .optional()
    .describe('Assistant messages per entry point (cli, sdk-ts, ...). Agent 0.4.0+'),
  skillCounts: countMap.optional().describe('Assistant messages per skill name that produced them. Agent 0.4.0+'),
  sidechainMessages: count.optional().describe('Assistant messages written by subagents. Agent 0.4.0+'),
  permissionModeCounts: countMap
    .optional()
    .describe('User prompts per permission mode (plan, bypassPermissions, ...). Agent 0.4.0+'),
  accountHashes: z
    .array(z.string().length(64))
    .max(20)
    .optional()
    .describe('Claude account IDs, HMAC-SHA256 keyed on the BurnWatch org ID; the raw ID is never sent. Agent 0.4.0+'),
  claudeOrgHashes: z
    .array(z.string().length(64))
    .max(20)
    .optional()
    .describe('Claude organization IDs, hashed the same way. Agent 0.4.0+'),
})

export const UsagePayloadSchema = z.object({
  deviceId: z.string().uuid(),
  date: z.string().regex(dateRegex),
  events: z.array(UsageEventSchema).max(500),
  enrichment: ClaudeEnrichmentSchema.nullable(),
  agentVersion: z.string().min(1).max(50).optional().describe('BurnWatch agent version. Agent 0.4.0+'),
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
//
// `type` defaults to api-spend so a dashboard that predates it keeps working.
// Which fields each type needs is checked by the API on the merged alert, so
// the same rule covers create and patch: api-spend needs monthlyLimitUsd,
// idle-seat needs idleDays, limit-hit needs limitHits.
export const BudgetAlertTypeSchema = z.enum(['api-spend', 'idle-seat', 'limit-hit'])

export const BudgetAlertInputSchema = z.object({
  type: BudgetAlertTypeSchema.default('api-spend'),
  userId: z.string().uuid().nullable().default(null),
  agent: AgentNameSchema.nullable().default(null),
  monthlyLimitUsd: z.number().positive().max(99999999.99).optional(),
  threshold: z.number().positive().max(1).default(0.8),
  idleDays: z.number().int().min(1).max(365).nullable().default(null),
  limitHits: z.number().int().min(1).max(100000).nullable().default(null),
})

// Every field optional, but at least one present. A PATCH with an empty body
// would otherwise be a successful no-op that looks like a saved change.
export const BudgetAlertPatchSchema = BudgetAlertInputSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Provide at least one field to update' },
)

// PUT /v1/dashboard/seats/:userId/:agent. A day-prorated price, so cents are fine.
export const SeatInputSchema = z.object({
  monthlyPriceUsd: z.number().nonnegative().max(99999.99),
  startDate: z.string().regex(dateRegex),
})

export const SeatAssignAllSchema = SeatInputSchema.extend({ agent: AgentNameSchema })

// z.input: what a client sends, so a field with a default stays optional.
export type BudgetAlertInput = z.input<typeof BudgetAlertInputSchema>
export type BudgetAlertPatch = z.input<typeof BudgetAlertPatchSchema>
export type SeatInput = z.infer<typeof SeatInputSchema>
export type SeatAssignAll = z.infer<typeof SeatAssignAllSchema>

export type UsageEventInput = z.infer<typeof UsageEventSchema>
export type ClaudeEnrichmentInput = z.infer<typeof ClaudeEnrichmentSchema>
export type UsagePayloadInput = z.infer<typeof UsagePayloadSchema>
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>
export type VerifyDeviceInput = z.infer<typeof VerifyDeviceSchema>
export type ApproveDeviceInput = z.infer<typeof ApproveDeviceSchema>
