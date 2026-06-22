import {
  pgTable,
  text,
  bigint,
  numeric,
  boolean,
  timestamp,
  jsonb,
  date as pgDate,
  integer,
  unique,
  index,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import type {
  ActivityEntry,
  ProjectEntry,
  SessionEntry,
} from '@burn-watch/shared'

// ─── Identity ────────────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  githubOrg: text('github_org'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  githubUsername: text('github_username'),
  role: text('role', { enum: ['admin', 'manager', 'developer'] })
    .notNull()
    .default('developer'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: text('password_hash'),  // for dashboard login (better-auth)
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  platform: text('platform').notNull(),  // 'darwin' | 'win32' | 'linux'
  agentVersion: text('agent_version').notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Pending device registration (before user verifies in dashboard)
export const pendingDevices = pgTable('pending_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),       // 6-char alphanumeric
  email: text('email').notNull(),
  hostname: text('hostname').notNull(),
  platform: text('platform').notNull(),
  agentVersion: text('agent_version').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  verifiedAt: timestamp('verified_at'),
  deviceId: uuid('device_id').references(() => devices.id),  // set after verify
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Org invites
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'manager', 'developer'] })
    .notNull()
    .default('developer'),
  code: text('code').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// ─── Usage ───────────────────────────────────────────────────────────────────

// Raw per-agent-per-model daily data (from ccusage tier 1)
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    agent: text('agent').notNull(),         // 'claude' | 'qwen' | 'gemini' | 'codex' | 'copilot'
    date: pgDate('date').notNull(),
    modelName: text('model_name').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheCreateTokens: bigint('cache_create_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    isFreeTier: boolean('is_free_tier').notNull().default(false),
    sourceRaw: jsonb('source_raw'),          // original ccusage JSON row
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  },
  (t) => [
    unique('usage_events_unique_user_agent_date_model_device').on(
      t.userId, t.agent, t.date, t.modelName, t.deviceId,
    ),
    index('usage_events_user_date_idx').on(t.userId, t.date),
    index('usage_events_date_total_tokens_idx').on(t.date, t.totalTokens),
    index('usage_events_agent_date_idx').on(t.agent, t.date),
  ],
)

// Rich Claude-only enrichment (from codeburn tier 2)
export const claudeEnrichment = pgTable(
  'claude_enrichment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: pgDate('date').notNull(),
    sessionCount: integer('session_count').notNull().default(0),
    callCount: integer('call_count').notNull().default(0),
    cacheHitRate: numeric('cache_hit_rate', { precision: 5, scale: 2 }),
    writtenTokens: bigint('written_tokens', { mode: 'number' }).notNull().default(0),
    activityBreakdown: jsonb('activity_breakdown').$type<ActivityEntry[]>(),
    projectBreakdown: jsonb('project_breakdown').$type<ProjectEntry[]>(),
    topSessions: jsonb('top_sessions').$type<SessionEntry[]>(),
    toolUsage: jsonb('tool_usage').$type<Record<string, number>>(),
    shellUsage: jsonb('shell_usage').$type<Record<string, number>>(),
    mcpUsage: jsonb('mcp_usage').$type<Record<string, number>>(),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  },
  (t) => [
    unique('claude_enrichment_unique_user_date').on(t.userId, t.date),
    index('claude_enrichment_user_date_idx').on(t.userId, t.date),
  ],
)

// Pre-aggregated snapshot for fast dashboard queries
export const dailySnapshots = pgTable(
  'daily_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    date: pgDate('date').notNull(),

    // Per-agent token + cost totals
    claudeTokens: bigint('claude_tokens', { mode: 'number' }).notNull().default(0),
    claudeCostUsd: numeric('claude_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    qwenTokens: bigint('qwen_tokens', { mode: 'number' }).notNull().default(0),
    qwenCostUsd: numeric('qwen_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    geminiTokens: bigint('gemini_tokens', { mode: 'number' }).notNull().default(0),
    geminiCostUsd: numeric('gemini_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    codexTokens: bigint('codex_tokens', { mode: 'number' }).notNull().default(0),
    codexCostUsd: numeric('codex_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    copilotTokens: bigint('copilot_tokens', { mode: 'number' }).notNull().default(0),
    copilotCostUsd: numeric('copilot_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),

    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
    totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    callCount: integer('call_count').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    cacheHitRate: numeric('cache_hit_rate', { precision: 5, scale: 2 }),
    modelsUsed: text('models_used').array(),

    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('daily_snapshots_unique_user_date').on(t.userId, t.date),
    index('daily_snapshots_org_date_idx').on(t.orgId, t.date),
    index('daily_snapshots_date_cost_idx').on(t.date, t.totalCostUsd),
    index('daily_snapshots_date_tokens_idx').on(t.date, t.totalTokens),
  ],
)

// GitHub Copilot server-side integration (org-level)
export const orgIntegrations = pgTable('org_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),           // 'copilot'
  encryptedToken: text('encrypted_token').notNull(),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Budget alerts per org/user/agent
export const budgetAlerts = pgTable('budget_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),   // null = org-wide
  agent: text('agent'),                                  // null = all agents
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 10, scale: 2 }).notNull(),
  threshold: numeric('threshold', { precision: 5, scale: 2 }).notNull().default('0.8'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// ─── Relations ───────────────────────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  orgIntegrations: many(orgIntegrations),
  budgetAlerts: many(budgetAlerts),
  invites: many(invites),
}))

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
  devices: many(devices),
  usageEvents: many(usageEvents),
  claudeEnrichment: many(claudeEnrichment),
  dailySnapshots: many(dailySnapshots),
}))

export const devicesRelations = relations(devices, ({ one, many }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  deviceTokens: many(deviceTokens),
  usageEvents: many(usageEvents),
}))
