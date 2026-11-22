import type { z } from 'zod'
import type { BranchEntrySchema, ClaudeEnrichmentSchema, ProjectEntrySchema, SessionEntrySchema } from './schemas.js'

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

// Wire shapes come from the Zod schemas so there is one list of fields.
export type BranchEntry = z.infer<typeof BranchEntrySchema>
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>
export type SessionEntry = z.infer<typeof SessionEntrySchema>
export type ClaudeEnrichment = z.infer<typeof ClaudeEnrichmentSchema>

// Payload sent by agent to POST /v1/usage
export interface UsagePayload {
  deviceId: string
  date: string
  events: UsageEvent[]
  enrichment: ClaudeEnrichment | null
  agentVersion?: string
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
  /** API-list-price value of the usage. Same number as totalCostUsd, which stays one release. */
  valueUsd: number
  /** What the org paid: prorated seat cost plus usage on unseated agents. */
  actualCost: {
    seatUsd: number
    apiUsd: number
    totalUsd: number
    /** Seat rows in scope; Claude + Copilot for one person is two. */
    seatCount: number
    /** Sum of the monthly prices of those seats. */
    monthlySeatUsd: number
  }
}

// GET /v1/dashboard/seats (admin only).
export interface Seat {
  userId: string
  /** Null when the user row is gone, so the seat can still be removed. */
  userName: string | null
  userEmail: string | null
  agent: AgentName
  monthlyPriceUsd: number
  startDate: string
  createdAt: string
}

// GET /v1/dashboard/teams. Teams the viewer can pick in the team filter:
// every team for an admin, managed teams for a manager, none for a developer.
export interface TeamMember {
  userId: string
  /** Null when the user row is gone, so a stale member still renders. */
  name: string | null
  role: 'manager' | 'member'
}

export interface Team {
  id: string
  name: string
  members: TeamMember[]
}

// GET /v1/dashboard/teams/compare (C5). A user in two teams counts in both,
// so team totals can add up to more than the org total.
export interface TeamComparison {
  teamId: string
  name: string
  memberCount: number
  /** Members with any usage in the range. */
  activeUsers: number
  totalCostUsd: number
  totalTokens: number
  byAgent: AgentSummary[]
  /** Days with no usage are absent, as on /trends. */
  daily: { date: string; totalCost: number }[]
}

/** R1 A8. Runs of active days, weekends never break one. See apps/api streaks.ts. */
export interface Streak {
  /** Active days in the live run, 0 if broken. */
  current: number
  /** Longest run, all time. */
  longest: number
  lastActive: string | null
}

/** R1 A8. Names, so the page can list them and R2 can add skills without a shape change. */
export interface FeaturesTried {
  /** byAgent keys with tokens > 0, in range. */
  agents: AgentName[]
  /** mcpUsage keys, in range, sorted. */
  mcpServers: string[]
}

export type LeaderboardSort = 'activeDays' | 'score' | 'streak' | 'tokens' | 'cost'

/** Org leaderboard settings. Absent on the org = own, true, false. */
export interface LeaderboardSettings {
  /** What a developer sees: own row, own row with rank, or the whole list. */
  developerView: 'own' | 'rank' | 'full'
  /** Off shows people as "Person N" to managers and developers. */
  showNames: boolean
  /** On lets developers see cost on other people's rows. */
  showOthersCost: boolean
}

/** GET /leaderboard/settings: the org settings plus the caller's own choice. */
export interface LeaderboardSettingsResponse extends LeaderboardSettings {
  hideOnLeaderboard: boolean
}

/**
 * One leaderboard row. Every cost field is null on a row the viewer may not
 * see cost on, and a masked row carries no real name, email or user id.
 */
export interface LeaderboardEntry {
  userId: string
  name: string
  email: string
  claude: { tokens: number; costUsd: number | null }
  qwen: { tokens: number; costUsd: number | null }
  gemini: { tokens: number; costUsd: number | null }
  codex: { tokens: number; costUsd: number | null }
  copilot: { tokens: number; costUsd: number | null }
  totalCostUsd: number | null
  totalTokens: number
  sessions: number
  cacheHitRate: number | null
  /** Prorated seat cost over the range plus apiSpendUsd. */
  actualCostUsd: number | null
  /** Value of usage on agents this person has no seat for. */
  apiSpendUsd: number | null
  /** totalCostUsd ÷ actualCostUsd; null when actual cost is 0. */
  valueMultiple: number | null
  /** Position under the chosen sort, shared on ties (1, 2, 2, 4). */
  rank: number
  /** People ranked, so a lone row can read "#3 of 12". */
  outOf: number
  /** Days in range, starting at the first usage day of the ranked people, for "12 of 30". */
  rangeDays: number
  /** 0-100: active days, current streak, tokens, features tried vs the top person, 40/30/20/10. */
  score: number
  /** Days with any tokens, in range. */
  activeDays: number
  streak: Streak
  features: FeaturesTried
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
  remote: string | null
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
  type: 'api-spend' | 'idle-seat' | 'limit-hit'
  userId: string | null
  userName: string | null
  agent: AgentName | null
  monthlyLimitUsd: number
  threshold: number
  createdAt: string
  trippedAt: string | null
  tripped: boolean
  /** API spend only: usage on seated (user, agent) pairs is left out. */
  monthToDateSpendUsd: number
  idleDays: number | null
  limitHits: number | null
  /** idle-seat only; null for the other types. */
  idleSeats: { userId: string; userName: string | null; agent: AgentName }[] | null
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

// GET /v1/dashboard/governance/free-tier (B1). Admins see the org, managers
// their own teams. `reason` says why the agent flagged the row: an agent with
// only a free tier, or a model ccusage has no price for.
export type FreeTierReason = 'free-tier-agent' | 'unpriced-model'

export interface FreeTierRow {
  userId: string
  /** Null when the user row is gone. */
  userName: string | null
  userEmail: string | null
  /** Names of the viewer's visible teams this user is in. */
  teams: string[]
  agent: AgentName
  modelName: string
  reason: FreeTierReason
  /** Distinct days with free-tier use in the range. */
  days: number
  tokens: number
  firstDate: string
  lastDate: string
}

export interface FreeTierTeamTotal {
  /** Null for users in none of the viewer's visible teams. */
  teamId: string | null
  teamName: string | null
  users: number
  tokens: number
}

export interface FreeTierResponse {
  rows: FreeTierRow[]
  byTeam: FreeTierTeamTotal[]
}

/** R1 B2. 'unset' means the org has no rule for the agent yet. */
export type AgentPolicyRule = 'allowed' | 'models' | 'blocked' | 'unset'

export interface AgentPolicy {
  agent: AgentName
  rule: AgentPolicyRule
  /** Exact model names; only used when rule is 'models'. */
  models: string[]
  note: string | null
}

export type ViolationReason = 'agent-blocked' | 'agent-not-set' | 'model-not-listed'

/** One (user, agent, model) group of usage outside the policy. Same shape as a free-tier row. */
export type ViolationRow = Omit<FreeTierRow, 'reason'> & { reason: ViolationReason }

export interface ViolationsResponse {
  /** All five agents, in AGENTS order. */
  policies: AgentPolicy[]
  rows: ViolationRow[]
  byTeam: FreeTierTeamTotal[]
  /** Model names used in the range per agent, for the edit form. Admins only; {} for managers. */
  seenModels: Partial<Record<AgentName, string[]>>
}

/** Where an MCP server key came from, read off its prefix. */
export type McpServerSource = 'plugin' | 'claude.ai' | 'local' | 'unnamed'

export interface McpServerRow {
  /** The exact key the agent sent: the name in the developer's config. */
  server: string
  source: McpServerSource
  approved: boolean
  note: string | null
  users: { userId: string; name: string | null }[]
  calls: number
  /** Distinct days with a call in the range. */
  days: number
  lastDate: string
}

export interface McpInventoryResponse {
  servers: McpServerRow[]
  /** Approved keys nobody called in the range, so an admin can still revoke them. */
  unusedApprovals: { server: string; note: string | null }[]
}

// GET /v1/dashboard/adoption/idle-seats (R1 A1). Seats with no tokens on their
// own agent for `idleDays`+ days. Admins see the org, managers their own teams.
export interface IdleSeatRow {
  userId: string
  /** Null when the user row is gone. */
  userName: string | null
  /** Names of the viewer's visible teams this user is in. */
  teams: string[]
  agent: AgentName
  startDate: string
  /** Last day with tokens on this agent. Null when never used. */
  lastUsed: string | null
  /** Days since the day after `lastUsed`, or since `startDate` when never used, today included. */
  daysIdle: number
  monthlyPriceUsd: number
  /** Seat cost from the first idle day to today. */
  costSinceUsedUsd: number
}

export interface IdleSeatsResponse {
  idleDays: number
  /** Longest idle first. */
  rows: IdleSeatRow[]
  byAgent: { agent: AgentName; seats: number; monthlyUsd: number }[]
  /** A seat holder in two teams counts in both. Holders in no visible team are left out. */
  byTeam: { teamId: string; teamName: string; seats: number; monthlyUsd: number }[]
  totalMonthlyUsd: number
  /** Seats the org has at all, so the page can tell "none entered" from "none idle". Admins only; null for managers. */
  orgSeats: number | null
}

// GET /v1/dashboard/adoption/funnel (R1 A3). How many people reached each step
// in the page's date range. Admins see the org, managers their own teams.
export interface FunnelCounts {
  /** Registered users plus people with an unused invite, so each stage is a subset of the one before. */
  invited: number
  registered: number
  /** Registered users with a device. A sub-line under first sync, not a stage. */
  deviceLinked: number
  firstSync: number
  active: number
  powerUser: number
}

/** The last stage a person reached, when it is not power user. */
export type FunnelStop = 'invited' | 'registered' | 'firstSync' | 'active'

export interface StuckPerson {
  stoppedAt: FunnelStop
  /** Null for an unused invite. */
  userId: string | null
  name: string | null
  /** The invite email when there is no user. */
  email: string | null
  /** Names of the viewer's visible teams this person is in. */
  teams: string[]
  /** Invite sent, account created, or last day with tokens, by stage. */
  lastStepDate: string
}

export interface FunnelResponse {
  from: string
  to: string
  rangeDays: number
  /** Thresholds in use: active days for "active" and for "power user". */
  activeDays: number
  powerDays: number
  /** Each person once, even when in two teams. */
  total: FunnelCounts
  /** Visible teams by name. A person in two teams counts in both. */
  teams: ({ teamId: string; teamName: string } & FunnelCounts)[]
  /** People in no visible team. Admins only, with no team filter; null otherwise. */
  noTeam: FunnelCounts | null
  /** Everyone short of power user, same scope as the counts. */
  stuck: StuckPerson[]
}
