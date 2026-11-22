import { z } from 'zod'

export const AgentNameSchema = z.enum(['claude', 'qwen', 'gemini', 'codex', 'copilot'])

/**
 * Agents whose only tier is free. Mirrors FREE_TIER_AGENTS in
 * apps/agent/src/collectors/reference.ts, which sets isFreeTier; the API uses
 * this copy to say why a row was flagged. Change both together.
 */
export const FREE_TIER_AGENTS: ReadonlySet<z.infer<typeof AgentNameSchema>> = new Set(['qwen'])

const dateRegex = /^\d{4}-\d{2}-\d{2}$/

// `.describe()` text on every field the agent sends is what the R0.4
// transparency page shows; its test fails when a field has none.
export const UsageEventSchema = z.object({
  agent: AgentNameSchema.describe('Which coding agent (claude, qwen, gemini, codex, copilot)'),
  date: z.string().regex(dateRegex, 'Must be YYYY-MM-DD').describe('Day the usage happened'),
  modelName: z.string().min(1).describe('Model name, e.g. claude-sonnet-4'),
  inputTokens: z.number().int().nonnegative().describe('Input tokens'),
  outputTokens: z.number().int().nonnegative().describe('Output tokens'),
  cacheCreateTokens: z.number().int().nonnegative().describe('Tokens written to the prompt cache'),
  cacheReadTokens: z.number().int().nonnegative().describe('Tokens read from the prompt cache'),
  totalTokens: z.number().int().nonnegative().describe('Sum of the four token counts'),
  costUsd: z.number().nonnegative().describe('API-equivalent cost, USD'),
  isFreeTier: z.boolean().describe('Whether the usage was on a free tier'),
})

export const ActivityEntrySchema = z.object({
  type: z.string().min(1),
  cost: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  oneShotRate: z.number().min(0).max(100),
})

const count = z.number().int().nonnegative()
const countMap = z.record(z.string(), count)

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
  deviceId: z.string().uuid().describe('BurnWatch ID for this laptop'),
  date: z.string().regex(dateRegex).describe('Day the sync covers'),
  events: z.array(UsageEventSchema).max(500).describe('Token and cost totals per agent and model'),
  enrichment: ClaudeEnrichmentSchema.nullable().describe('Claude Code activity detail, read from local transcripts'),
  agentVersion: z.string().min(1).max(50).optional().describe('BurnWatch agent version. Agent 0.4.0+'),
})

export const RegisterDeviceSchema = z.object({
  email: z.string().email().describe('Your work email, to link the laptop to your account'),
  hostname: z.string().min(1).max(255).describe("The laptop's network name"),
  platform: z.string().min(1).max(50).describe('Operating system (darwin, linux, win32)'),
  agentVersion: z.string().min(1).max(50).describe('BurnWatch agent version at sign-in'),
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

// R1 B2. Model names are exact strings from agent output, stored as values.
export const AgentPolicyInputSchema = z
  .object({
    rule: z.enum(['allowed', 'models', 'blocked']),
    models: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((p) => p.rule !== 'models' || p.models.length > 0, {
    message: 'List at least one model, or choose blocked',
    path: ['models'],
  })

// R1 B3. A key comes from a developer's MCP config, so it is bounded and only
// ever stored as a value.
export const McpServerKeySchema = z.string().min(1).max(200)
export const McpApprovalInputSchema = z.object({
  server: McpServerKeySchema,
  note: z.string().trim().max(500).nullable().optional(),
})

// R1 A1. Query strings arrive as text, so coerce; nothing is stored.
export const IdleSeatsQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  idleDays: z.coerce.number().int().min(1).max(365).default(14),
})

// R1 A8. Admin writes all three at once; a person sets only their own flag.
export const LeaderboardSettingsSchema = z.object({
  developerView: z.enum(['own', 'rank', 'full']),
  showNames: z.boolean(),
  showOthersCost: z.boolean(),
})
// R2 B5. Plain X.Y.Z only; null clears the minimum.
export const DeviceSettingsSchema = z.object({
  minClaudeVersion: z.string().max(20).regex(/^\d+\.\d+\.\d+$/).nullable(),
})
export const HideOnLeaderboardSchema = z.object({ hideOnLeaderboard: z.boolean() })

// R1 B8. The audit log's `action` filter is a prefix from this closed list.
export const AUDIT_ACTION_PREFIXES = [
  'device.', 'user.', 'invite.', 'team.', 'seat.', 'alert.', 'policy.', 'mcp.', 'org.', 'copilot.', 'view.',
] as const
export const AuditQuerySchema = z.object({
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
  kind: z.enum(['action', 'view', 'all']).default('all'),
  actorId: z.string().uuid().optional(),
  action: z.enum(AUDIT_ACTION_PREFIXES).optional(),
  targetId: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

// Price table (own-collector design, Part 1 "Pricing"). USD per token. A model
// with no known price is absent, never 0, so a lookup miss means "unpriced".
const usdPerToken = z.number().positive()

export const ModelPriceSchema = z.object({
  input: usdPerToken,
  output: usdPerToken,
  cacheWrite5m: usdPerToken.optional(),
  cacheWrite1h: usdPerToken.optional(),
  cacheRead: usdPerToken.optional(),
  // Applies per request once its prompt is over 200k tokens.
  above200k: z.object({
    input: usdPerToken,
    output: usdPerToken,
    cacheWrite5m: usdPerToken.optional(),
    cacheWrite1h: usdPerToken.optional(),
    cacheRead: usdPerToken.optional(),
  }).strict().optional(),
}).strict()

export const PriceTableSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1),
  models: z.record(z.string(), ModelPriceSchema),
  // Dated or provider-prefixed name -> key in `models`.
  aliases: z.record(z.string(), z.string()),
}).strict()

export type ModelPrice = z.infer<typeof ModelPriceSchema>
export type PriceTable = z.infer<typeof PriceTableSchema>

// z.input: what a client sends, so a field with a default stays optional.
export type BudgetAlertInput = z.input<typeof BudgetAlertInputSchema>
export type BudgetAlertPatch = z.input<typeof BudgetAlertPatchSchema>
export type SeatInput = z.infer<typeof SeatInputSchema>
export type SeatAssignAll = z.infer<typeof SeatAssignAllSchema>
export type AgentPolicyInput = z.input<typeof AgentPolicyInputSchema>
export type McpApprovalInput = z.input<typeof McpApprovalInputSchema>
export type AuditQuery = z.input<typeof AuditQuerySchema>

export type UsageEventInput = z.infer<typeof UsageEventSchema>
export type ClaudeEnrichmentInput = z.infer<typeof ClaudeEnrichmentSchema>
export type UsagePayloadInput = z.infer<typeof UsagePayloadSchema>
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>
export type VerifyDeviceInput = z.infer<typeof VerifyDeviceSchema>
export type ApproveDeviceInput = z.infer<typeof ApproveDeviceSchema>
