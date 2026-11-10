// Raw output from `npx ccusage@latest daily --json`
export interface CcusageOutput {
  daily: CcusageDailyEntry[]
  totals: Record<string, unknown>
}

export interface CcusageModelBreakdown {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
}

export interface CcusageDailyEntry {
  agent: string              // 'all' | agent name (lowercase)
  period: string             // 'YYYY-MM-DD'
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: CcusageModelBreakdown[]
  metadata?: { agents?: string[] }
}

export type AgentName = 'claude' | 'qwen' | 'gemini' | 'codex' | 'copilot'

// Normalized event for DB insertion
export interface UsageEvent {
  agent: AgentName
  date: string           // YYYY-MM-DD
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUsd: number
  isFreeTier: boolean    // true when costUsd=0 due to missing pricing (e.g. Qwen)
}

// Rich enrichment from codeburn (Claude only)
export interface ActivityEntry {
  type: string           // 'Debugging' | 'Exploration' | 'Coding' | 'Feature Dev' | ...
  cost: number
  turns: number
  oneShotRate: number    // percentage 0-100
}

export interface ProjectEntry {
  path: string
  cost: number
  avgPerSession: number
  sessions: number
  overheadK: number      // context overhead in K tokens
}

export interface SessionEntry {
  date: string
  project: string
  cost: number
  calls: number
}

export interface ClaudeEnrichment {
  date: string
  sessionCount: number
  callCount: number
  cacheHitRate: number   // percentage 0-100
  writtenTokens: number
  activityBreakdown: ActivityEntry[]
  projectBreakdown: ProjectEntry[]
  topSessions: SessionEntry[]
  toolUsage: Record<string, number>   // {bash: 501, read: 201, edit: 168, ...}
  shellUsage: Record<string, number>  // {git: 238, npx: 57, grep: 57, ...}
  mcpUsage: Record<string, number>    // {playwright: 33, neon: 14, ...}
}

// Payload sent by agent to POST /v1/usage
export interface UsagePayload {
  deviceId: string
  date: string
  events: UsageEvent[]
  enrichment: ClaudeEnrichment | null
}

// Device registration
export interface RegisterDeviceRequest {
  email: string
  hostname: string
  platform: string
  agentVersion: string
}

export interface RegisterDeviceResponse {
  pendingId: string
  code: string   // 6-char code displayed in terminal; user enters on dashboard
  expiresAt: string
}

export interface VerifyDeviceRequest {
  pendingId: string
  code: string
}

export interface VerifyDeviceResponse {
  accessToken: string
  refreshToken: string
  deviceId: string
  userId: string
  orgId: string
}

// Local agent config stored at ~/.burnwatch/config.json (chmod 600)
export interface DeviceConfig {
  deviceId: string
  userId: string
  orgId: string
  apiUrl: string
  accessToken: string
  refreshToken: string
  registeredAt: string
  lastSyncAt: string | null
  npxPath: string | null   // full path to npx binary resolved at registration time
}

// Dashboard API response types
export interface AgentSummary {
  agent: AgentName
  tokens: number
  costUsd: number
  isFreeTier: boolean
}

export interface OverviewResponse {
  date: string
  totalCostUsd: number
  totalTokens: number
  activeUsers: number
  vsYesterday: {
    costDelta: number
    costPct: number
    tokensDelta: number
  }
  byAgent: AgentSummary[]
}

export interface LeaderboardEntry {
  userId: string
  name: string
  email: string
  claude: { tokens: number; costUsd: number }
  qwen: { tokens: number; costUsd: number }
  gemini: { tokens: number; costUsd: number }
  codex: { tokens: number; costUsd: number }
  copilot: { tokens: number; costUsd: number }
  totalCostUsd: number
  totalTokens: number
  sessions: number
  cacheHitRate: number | null
}

// One row of the admin team view. Unlike LeaderboardEntry this covers every
// user in the org, so the fields that depend on usage are all nullable or zero
// for someone who has been invited but never run the agent.
export interface AdminUserRow {
  id: string
  name: string
  email: string
  role: string
  isActive: boolean
  createdAt: string
  deviceCount: number
  hostnames: string[]
  lastSeenAt: string | null
  lastSyncDate: string | null
  totalCostUsd: number
  totalTokens: number
  activeDays: number
}

// One row of the admin device view. `revoked` is derived, not stored: it is
// true when the device holds no unrevoked `device_tokens` row, which is the
// same condition the auth guard checks.
export interface AdminDeviceRow {
  id: string
  hostname: string
  platform: string
  lastSeenAt: string | null
  userName: string
  userEmail: string
  revoked: boolean
}

export interface PendingInvite {
  id: string
  email: string
  role: string
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

export interface TrendPoint {
  date: string
  claudeCost: number
  qwenCost: number
  geminiCost: number
  codexCost: number
  copilotCost: number
  totalCost: number
  claudeTokens: number
  qwenTokens: number
  totalTokens: number
}

export interface OrgActivitySummary {
  type: string
  totalCost: number
  totalTurns: number
  avgOneShotRate: number
  userCount: number
}

export interface ToolUsageSummary {
  tool: string
  count: number
  category: 'tool' | 'shell' | 'mcp'
}

export interface OrgProjectSummary {
  path: string
  totalCost: number
  totalSessions: number
  avgCostPerSession: number
  userCount: number
}

// One budget alert as the dashboard sees it.
//
// `userId: null` means the alert watches the whole org, and `agent: null` means
// it watches every agent, so the four combinations of those two nulls are the
// whole scope vocabulary. `monthlyLimitUsd` and `threshold` are the stored
// configuration; everything below them is computed or latched.
//
// `trippedAt` is the latch, written by the evaluation that runs on every
// snapshot rebuild. `tripped` is that latch read for the month the request
// falls in, which is the only question a banner asks. An alert that tripped
// last month is not news today. `monthToDateSpendUsd` is live, so the admin
// table can show the figure climbing between trips.
export interface BudgetAlert {
  id: string
  userId: string | null
  userName: string | null
  agent: AgentName | null
  monthlyLimitUsd: number
  threshold: number
  createdAt: string
  trippedAt: string | null
  tripped: boolean
  monthToDateSpendUsd: number
}

// GET /v1/integrations/copilot/status.
//
// `encryption` keeps all three states rather than collapsing to a boolean.
// This response is the only place an operator learns that COPILOT_ENCRYPTION_KEY
// was mistyped rather than never set, and the two faults need different repairs.
//
// `connected` and `encryption` are independent. A connection stored while the
// key was present survives the key being removed from the environment, so
// `connected: true` with a non-ready `encryption` is reachable and real.
export interface CopilotStatus {
  encryption: 'ready' | 'missing-key' | 'malformed-key'
  connected: boolean
  org: string | null
  lastSyncAt: string | null
}

// POST /v1/integrations/copilot/sync.
//
// `unmatchedLogins` is never optional and never empty by omission. A GitHub
// login with no matching `github_username` on a BurnWatch user contributes
// nothing to the totals and looks exactly like a developer who did no work,
// so the list travels to whatever renders the result.
export interface CopilotSyncResult {
  day: string
  /**
   * Whether GitHub had a report for that day at all.
   *
   * False and "nobody used Copilot" both produce no rows, and only the first
   * is worth retrying. It also covers a third case: GitHub answers 404 rather
   * than 403 for a resource a token cannot see, so a credential that can read
   * seat billing but lacks Copilot metrics looks exactly like a day that has
   * not been generated. Collapsing them would leave such a token looking
   * healthy forever while pulling nothing.
   */
  reportPublished: boolean
  seats: {
    total: number
    skippedNullAssignee: number
  }
  usage: {
    matched: number
    written: number
    skipped: number
  }
  unmatchedLogins: string[]
}

// GET /v1/integrations/copilot/seats.
//
// The org's Copilot seat roster, read live from GitHub and joined against
// BurnWatch users. Nothing here is stored: a roster is current state rather
// than a time series, and a stored copy could only ever disagree with the
// system that issues the licences.
//
// Each seat carries two independent facts. `status` is a tagged value rather
// than an `isIdle` boolean so a reader branches on one field instead of
// reconstructing the state from several, and `userId` is separately nullable
// because a seat matching no BurnWatch user is an ordinary state, not an error.
export type CopilotSeatStatus = 'active' | 'idle'

export interface CopilotSeatRow {
  /**
   * GitHub's own casing, not the lowercased key the match is made on, so an
   * admin can paste it straight into a user record.
   */
  login: string
  /** Null when no `users.github_username` in the org matches this login. */
  userId: string | null
  userName: string | null
  status: CopilotSeatStatus
  lastActivityAt: string | null
  lastActivityEditor: string | null
  planType: string
  /**
   * Null when `planType` carries no price on file. A guessed dollar figure on
   * a spend dashboard is worse than an absent one, so an unrecognised plan
   * reports nothing and is counted in `summary.unpricedIdleSeats` instead.
   */
  monthlyCostUsd: number | null
  pendingCancellationDate: string | null
}

export interface CopilotSeatsResponse {
  org: string
  /** Echoed, so a rendered figure always names the window it was computed over. */
  idleAfterDays: number
  /**
   * GitHub's own `total_seats`, not `seats.length`. The two differ by the
   * seats GitHub reports with no assignee, which `skippedNullAssignee` counts.
   */
  totalSeats: number
  skippedNullAssignee: number
  seats: CopilotSeatRow[]
  summary: {
    active: number
    idle: number
    /**
     * Seats whose `userId` is null: a paid licence whose spend BurnWatch
     * cannot attribute to anyone. The same class of defect `unmatchedLogins`
     * exists to make visible, caught a step earlier. It is the licence that
     * is flagged here, not a day of usage that has already gone unrecorded.
     */
    unlinked: number
    /** Summed over the idle seats with a known price, and only those. */
    idleMonthlyCostUsd: number
    /**
     * Idle seats whose plan carries no price, so whatever renders
     * `idleMonthlyCostUsd` can say what the figure leaves out.
     */
    unpricedIdleSeats: number
  }
  /**
   * GitHub logins that matched more than one user in the org. Nothing stops
   * two users carrying the same `github_username`, and when they do the
   * seat's row above is attributed to the lowest `users.id`, which is a
   * tie-break and not a fact. Never optional and never empty by omission,
   * for the reason `unmatchedLogins` gives on the sync result.
   */
  ambiguousLogins: string[]
}
