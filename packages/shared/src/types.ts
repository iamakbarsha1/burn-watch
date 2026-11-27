import type { z } from 'zod'
import type { BranchEntrySchema, ClaudeEnrichmentSchema, ProjectEntrySchema, SessionEntrySchema } from './schemas.js'

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
  unpriced?: boolean     // the model has no known price; costUsd is 0 for that reason
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
  repoAccessWarning?: string | null   // last sync's macOS privacy block, for `burnwatch status`
  // First UTC day sent by agent 0.6.0+ on a device that synced before it; null on a new device.
  // Earlier days were sent by the previous collector and are never re-sent.
  ownCollectorFrom?: string | null
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

/** R1 A8. Runs of consecutive active days, weekends never break one. See apps/api consecutive-days.ts. */
export interface ConsecutiveDays {
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

// GET /v1/dashboard/me/usage (v2 Phase 1). The caller's own numbers, never anyone else's.
export interface MyUsageResponse {
  from: string
  to: string
  /** Days in range, for "12 of 30". */
  rangeDays: number
  /** Days with any tokens, in range. */
  activeDays: number
  /** All time. Shown only to the person. */
  consecutiveDays: ConsecutiveDays
  totalTokens: number
  sessions: number
  totalCostUsd: number
  /** Agents with tokens in range only. */
  agents: { agent: AgentName; tokens: number; costUsd: number }[]
  features: FeaturesTried
  /** Null before the first sync. */
  onboarding: MyOnboarding | null
  /** The person listed themselves as happy to help with Claude Code. */
  helpVolunteer: boolean
  /** v2 Phase 3: the person's own status, the same facts an admin sees about them. */
  seats: MySeat[]
  /** Own free-tier or unpriced use in range. */
  freeTier: FreeTierModelRow[]
  /** Own use outside the org's agent rules in range. */
  setupChecks: MySetupCheck[]
  /** Own Claude account flags in range. */
  accountFlags: ClaudeAccountFlag[]
}

/** One of the person's own seats. */
export interface MySeat {
  agent: AgentName
  /** Days since last use, today included; 0 when used today. */
  daysUnused: number
}

/** One (agent, model) of the person's own use outside the agent rules. */
export interface MySetupCheck {
  agent: AgentName
  modelName: string
  reason: SetupCheckReason
  days: number
  tokens: number
}

/** Average active days per week over the range. */
export const USAGE_BANDS = ['none', '1-2', '3-4', '5+'] as const
export type UsageBand = (typeof USAGE_BANDS)[number]

// GET /v1/dashboard/usage-distribution (v2 Phase 1). Counts per band, no names.
export interface UsageDistributionResponse {
  from: string
  to: string
  /** Active people in scope, MIN_GROUP_SIZE or more. */
  people: number
  bands: Record<UsageBand, number>
}

// One row of the admin team view. It covers every user in the org, so the fields that depend on usage are all nullable or zero
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
  /** An agent of theirs submitted in the last 7 days. No usage or dates per person (v2 rules 1 and 3). */
  reporting: boolean
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
  /** R2 B5. From sign-in, then from every submit from agent 0.4.0. */
  agentVersion: string
  /** R2 B5. Highest Claude Code version in the last submit; null before a 0.4.0 submit or with no Claude Code use. */
  claudeVersion: string | null
}

/** R2 B5. GET/PUT /v1/auth/admin/device-settings. Null = no minimum. */
export interface DeviceSettings {
  minClaudeVersion: string | null
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

// GET /v1/dashboard/tickets (R2 C4). Ticket keys come from Claude Code branch
// names; raw branch names never leave the API.
export interface TicketRow {
  /** PROJ-123 */
  key: string
  cost: number
  sessions: number
  userCount: number
  repoCount: number
  days: number
}

export interface TicketUsageResponse {
  from: string
  to: string
  /** Null when the admin has not set any project keys. */
  prefixes: string[] | null
  /** Sorted by cost, then key. */
  tickets: TicketRow[]
  projectKeys: { prefix: string; tickets: number; cost: number; sessions: number; userCount: number }[]
  /** Branch cost with no allowed key. */
  noTicket: { cost: number; sessions: number }
  /** Upper-case prefixes seen in range that are not allowed yet, with distinct branch counts. Admins only, else null. */
  suggestions: { prefix: string; branches: number }[] | null
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
  /** idle-seat only: unused seats right now. Names are on the Unused seats card. Null for the other types. */
  idleSeatCount: number | null
  /** limit-hit only: people who hit a usage limit this month. Null for the other types. */
  people: number | null
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

// GET /v1/dashboard/governance/free-tier (B1). Counts only (v2 Phase 3): admins
// see the org, managers their own teams. `reason` says why the agent flagged the
// row: an agent with only a free tier, or a model the collector has no price for.
export type FreeTierReason = 'free-tier-agent' | 'unpriced-model'

/** One (agent, model) over the scope. For `/me/usage` the counts are the person's own. */
export interface FreeTierModelRow {
  agent: AgentName
  modelName: string
  reason: FreeTierReason
  /** People with use of this model in range. 1 on `/me/usage`. */
  people: number
  /** Distinct days with use in the range. */
  days: number
  tokens: number
}

export interface FreeTierResponse {
  /** Distinct people with any free-tier use in range. */
  people: number
  rows: FreeTierModelRow[]
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

export type SetupCheckReason = 'agent-blocked' | 'agent-not-set' | 'model-not-listed'

/** One (user, agent, model) group of use outside the agent rules. Admins only (v2 decision 2). */
export interface SetupCheckRow {
  userId: string
  /** Null when the user row is gone. */
  userName: string | null
  userEmail: string | null
  /** Names of the teams this user is in. */
  teams: string[]
  agent: AgentName
  modelName: string
  reason: SetupCheckReason
  days: number
  tokens: number
  firstDate: string
  lastDate: string
}

// GET /v1/dashboard/governance/setup-checks (R1 B2, renamed in v2 Phase 3).
export interface SetupChecksResponse {
  /** All five agents, in AGENTS order. */
  policies: AgentPolicy[]
  /** Distinct people in scope with use outside the rules. */
  people: number
  /** Named rows, admins only; [] for managers. */
  rows: SetupCheckRow[]
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
  /** Distinct people who called it in range. No names (v2 Phase 3). */
  people: number
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

// GET /v1/dashboard/governance/accounts (R2 B6). Admins only. Hashes are never
// shown: accounts and orgs are labelled by first seen in the range.
export type ClaudeAccountFlag = 'shared' | 'outside-org' | 'several' | 'seat-no-use' | 'use-no-seat'

export interface ClaudeOrgRow {
  /** The org hash, for the save call only. The page never renders it. */
  id: string
  /** "Claude org 1", stable only within one range. */
  label: string
  users: number
  days: number
  ours: boolean
  /** The viewer's own days carry this org. */
  includesYou: boolean
}

export interface ClaudeAccountsResponse {
  from: string
  to: string
  /** Claude Code users in scope with a day in range, and how many of those have a hashed day. */
  coverage: { users: number; hashed: number }
  companyOrgSet: boolean
  /** Claude seats held by people in scope. */
  seatsEntered: number
  /** People with a day on a company org. Null when the company org is not set. */
  companyOrgUsers: number | null
  orgs: ClaudeOrgRow[]
  accounts: { label: string; users: number; days: number; shared: boolean }[]
  /** People per flag. No names (v2 Phase 3); each person sees their own flags on My usage. */
  flagCounts: Record<ClaudeAccountFlag, number>
}

// GET /v1/dashboard/adoption/unused-seats (R1 A1, renamed in v2 Phase 3). Admins
// only, named (v2 decision 2): seats with no tokens on their own agent for
// `idleDays`+ days. Each person sees their own seats on My usage.
export interface UnusedSeatRow {
  userId: string
  /** Null when the user row is gone. */
  userName: string | null
  agent: AgentName
  /** Days since last use, or since the seat started when never used, today included. */
  daysUnused: number
}

export interface UnusedSeatsResponse {
  idleDays: number
  /** Longest unused first. */
  rows: UnusedSeatRow[]
  byAgent: { agent: AgentName; seats: number; monthlyUsd: number }[]
  totalMonthlyUsd: number
  /** Seats the org has at all, so the page can tell "none entered" from "none unused". */
  orgSeats: number
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

export interface FunnelResponse {
  from: string
  to: string
  rangeDays: number
  /** Thresholds in use: active days for "active" and for "power user". */
  activeDays: number
  powerDays: number
  /** Each person once, even when in two teams. */
  total: FunnelCounts
  /** Visible teams of MIN_GROUP_SIZE or more members. A person in two teams counts in both. */
  teams: ({ teamId: string; teamName: string } & FunnelCounts)[]
  /** People in no visible team. Admins only, with no team filter, and MIN_GROUP_SIZE or more people; null otherwise. */
  noTeam: FunnelCounts | null
}

/**
 * v2 rule 2: a dashboard read over fewer than this many people answers 403
 * `group_too_small` instead of numbers, so no total can point at one person.
 * A person reading only their own data is never refused.
 */
export const MIN_GROUP_SIZE = 5

// R2 A5 feature matrix. Claude Code only.
export const FEATURE_KEYS = ['mcp', 'skills', 'subagents', 'plan', 'sdk'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export interface FeatureCounts {
  /** People with at least one Claude Code day in range. */
  users: number
  /** People who used each feature on at least one day. */
  used: Record<FeatureKey, number>
  /** People with a day from agent 0.4.0+, the only ones whose SDK use is known. */
  sdkKnown: number
}

export interface FeatureMatrixResponse {
  from: string
  to: string
  /** Each person once, even when in two teams. */
  total: FeatureCounts
  /** Visible teams of MIN_GROUP_SIZE or more members. A person in two teams counts in both. */
  teams: ({ teamId: string; teamName: string } & FeatureCounts)[]
  /** People in no visible team. Admins only, with no team filter, and MIN_GROUP_SIZE or more people; null otherwise. */
  noTeam: FeatureCounts | null
}

// GET /v1/dashboard/adoption/onboarding (R2 D6). New people in the range and
// whether they got going in their first 14 days. Admins see the org, managers their teams.
/** R2 D6 Decision 1: tokens on 2+ days in week 1 and 2+ days in week 2. */
export const ACTIVE_DAYS_PER_WEEK = 2
/** Decision 2: any 2 of A5's five features, each on 1+ day. */
export const MIN_FEATURES = 2

export type OnboardingState = 'onboarded' | 'windowEnded' | 'inProgress' | 'noFeatureData'

export interface OnboardingResult {
  state: OnboardingState
  /** Days with tokens in days 1 to 7 and 8 to 14 of the window, any agent. */
  activeWeek1: number
  activeWeek2: number
  /** A5 features used at least once in the window. */
  features: FeatureKey[]
  /** 1 to 14: how far into the window the last synced day is. */
  dayOfWindow: number
}

export interface OnboardingCounts {
  /** People whose first sync is in range. */
  cohort: number
  onboarded: number
  windowEnded: number
  inProgress: number
  noFeatureData: number
}

/** v2 Phase 2: the person's own first 14 days, on My usage only. */
export interface MyOnboarding extends OnboardingResult {
  firstSync: string
}

export interface OnboardingResponse {
  from: string
  to: string
  /** Rules, so the page can say them. */
  activeDaysPerWeek: number
  minFeatures: number
  /** Below this many finished windows the page shows counts, not a percentage. */
  minForPercent: number
  /** v2 rule 2: null when fewer than MIN_GROUP_SIZE people first synced in range. */
  total: OnboardingCounts | null
  /** Visible teams whose cohort is MIN_GROUP_SIZE or more. */
  teams: ({ teamId: string; teamName: string } & OnboardingCounts)[]
  /** Admins only, with no team filter, and a cohort of MIN_GROUP_SIZE or more; null otherwise. */
  noTeam: OnboardingCounts | null
}

// GET /v1/dashboard/adoption/practices (R2 A6). The top quartile of Claude Code
// users against everyone else. Aggregates only: no names or user ids.
/** What ranks people into the top quartile: active days or Claude tokens. */
export const PRACTICE_RANKS = ['days', 'tokens'] as const
export type PracticeRank = (typeof PRACTICE_RANKS)[number]
/** The A5 features A6 compares. SDK is left out: few days report it. */
export const PRACTICE_FEATURES = ['mcp', 'skills', 'subagents', 'plan'] as const
export type PracticeFeature = (typeof PRACTICE_FEATURES)[number]
export type TipId = PracticeFeature | 'cache'

export interface PracticeGroup {
  users: number
  /** Share of people who used each feature on at least one day, 0..1. */
  uses: Record<PracticeFeature, number>
  /** Median share of a person's active days with the feature, 0..1. */
  dayShare: Record<PracticeFeature, number>
  /** Median distinct MCP servers per person. */
  mcpServers: number
  /** Median token-weighted cache hit rate, percent. Null when no one has Claude tokens. */
  cacheHitRate: number | null
}

export interface PracticeTip {
  id: TipId
  /** Top minus rest, as a share 0..1 (cache: percentage points / 100). */
  gap: number
}

// v2 Phase 2. People who set "happy to help with Claude Code" themselves. Nobody else is named.
export interface HelpVolunteer {
  userId: string
  name: string
  /** Features they used in range that fewer than half of the team used. */
  canHelpWith: PracticeFeature[]
}

export interface TeamVolunteers {
  /** Null for "No team", admins only. */
  teamId: string | null
  teamName: string
  volunteers: HelpVolunteer[]
}

// R2 D5. Counts only: no names or user ids.
export interface SetupItem {
  /** The MCP server key as the agent reports it. */
  key: string
  /** local: add to .mcp.json. plugin: install the plugin. claude.ai: connect in claude.ai settings. */
  source: Exclude<McpServerSource, 'unnamed'>
  /** People in the reference group who used it, and in the whole group the card covers. */
  topUsers: number
  teamUsers: number
  /** Admins only, when the org has any approval; null otherwise. */
  approved: boolean | null
}

export interface TeamSetup {
  /** Null for the card that covers the whole scope. */
  teamId: string | null
  teamName: string
  /** Top-quartile members plus volunteers. */
  groupSize: number
  reason: 'ok' | 'smallGroup'
  items: SetupItem[]
}

export interface PracticesResponse {
  from: string
  to: string
  rankBy: PracticeRank
  /** Claude Code users in scope with a day in range. */
  population: number
  /** Below this the groups are null. */
  minPopulation: number
  top: PracticeGroup | null
  rest: PracticeGroup | null
  /** At most 3, largest gap first. */
  tips: PracticeTip[]
  /** Per visible team with at least one volunteer. */
  volunteers: TeamVolunteers[]
  /** R2 D5: shared MCP setup per card. The scope card comes first. */
  setup: TeamSetup[]
}

// R1 B8 audit log. A closed list, so a typo in a call site is a compile error.
export type AuditAction =
  | 'device.approve'
  | 'device.revoke'
  | 'device.self_revoke'
  | 'org.bootstrap'
  | 'user.create'
  | 'user.delete'
  | 'invite.create'
  | 'invite.bulk'
  | 'invite.accept'
  | 'team.create'
  | 'team.rename'
  | 'team.delete'
  | 'team.member_set'
  | 'team.member_remove'
  | 'seat.set'
  | 'seat.remove'
  | 'seat.assign_all'
  | 'alert.create'
  | 'alert.update'
  | 'alert.delete'
  | 'policy.set'
  | 'policy.unset'
  | 'mcp.approve'
  | 'mcp.unapprove'
  /** Removed in v2. Kept so audit rows written before then still read. */
  | 'org.leaderboard_settings'
  | 'org.min_claude_version'
  | 'org.claude_orgs'
  | 'org.ticket_prefixes'
  | 'copilot.connect'
  | 'copilot.disconnect'
  | 'copilot.sync'
  | `view.${AuditSurface}`

/** Reads that show other people's data, logged once per viewer, surface, scope and UTC day. */
export type AuditSurface =
  /** Removed in v2. Kept so audit rows written before then still read. */
  | 'leaderboard'
  | 'usage_distribution'
  | 'governance'
  | 'adoption'
  | 'people'
  | 'team_compare'
  | 'overview'
  | 'trends'
  | 'audit'

export type AuditTargetType =
  | 'user' | 'device' | 'invite' | 'team' | 'seat' | 'alert'
  | 'agent' | 'mcp' | 'org' | 'integration' | 'scope'

/** `label` is a snapshot at write time (email, team name, hostname), so a later rename or delete still reads. */
export interface AuditTarget {
  type: AuditTargetType
  id: string | null
  label: string | null
}

// GET /v1/dashboard/audit/me (v2 Phase 4). Views whose scope covered the
// caller: a whole-org view, a view of a team they are in, or a manager's view
// of their managed teams when the caller is in one. Team membership is read as
// it is today, not as it was on the day of the view.
export interface AuditMeRow {
  /** First view that UTC day. */
  at: string
  /** Last view that day. */
  lastAt: string | null
  /** Views that day. */
  count: number
  surface: AuditSurface
  /** Name resolved at read time; null when the user row is gone. */
  viewer: { name: string | null; role: string }
  /** What was viewed: the whole org, managed teams, or one team by name. */
  scope: string | null
}

export interface AuditMeResponse {
  from: string
  to: string
  /** Newest first, at most 1000. */
  rows: AuditMeRow[]
}

// GET /v1/dashboard/audit. Admin only, newest first.
export interface AuditRow {
  id: string
  /** Views: the first view that UTC day. */
  at: string
  /** Views: the last view that day. Null for actions. */
  lastAt: string | null
  /** 1 for actions; views per day. */
  count: number
  kind: 'action' | 'view'
  action: AuditAction
  /** Name resolved at read time; null when the user row is gone. */
  actor: { id: string; name: string | null; role: string }
  target: AuditTarget
  detail: Record<string, unknown> | null
}
