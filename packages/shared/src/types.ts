// Raw row from `npx ccusage@latest daily --json`
export interface CcusageRow {
  date: string
  agent: 'Claude' | 'Qwen' | 'Gemini CLI' | 'Codex' | 'All'
  models: string[]
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUsd: number
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

export interface OrgProjectSummary {
  path: string
  totalCost: number
  totalSessions: number
  avgCostPerSession: number
  userCount: number
}
