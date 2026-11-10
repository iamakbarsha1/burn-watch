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

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  // Every authenticated device request looks this table up by device_id, so
  // the lookup is on the hot path for all usage submission.
  (t) => [index('device_tokens_device_id_idx').on(t.deviceId)],
)

// Pending device registration (before user verifies in dashboard)
export const pendingDevices = pgTable('pending_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),       // 6-char alphanumeric
  email: text('email').notNull(),
  hostname: text('hostname').notNull(),
  platform: text('platform').notNull(),
  agentVersion: text('agent_version').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  // Set when a signed-in user enters the code in the dashboard. Until then the
  // row cannot be exchanged for tokens: a work email is the only thing
  // register-device asks for, and work emails are not secrets.
  approvedAt: timestamp('approved_at'),
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
    // Nullable because a row pulled from a GitHub org has no developer machine
    // behind it. The FK stays so an agent-submitted row still has to name a
    // device that exists.
    deviceId: uuid('device_id').references(() => devices.id),
    // Who reported the row, not what it is about. ccusage on a developer's
    // machine already reports Copilot usage per developer, so an org-level pull
    // would otherwise land a second row for the same person, agent and day and
    // double their spend. Plain text rather than an enum so a third source does
    // not need a type migration. Defaulted so every existing row reads 'agent',
    // which is what they are. See `rebuildDailySnapshot` for how a day with both
    // sources is resolved.
    source: text('source').notNull().default('agent'), // 'agent' | 'copilot-org'
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
    // NULLS NOT DISTINCT is the whole point of this constraint. `device_id` is
    // null on every org-sourced row, and under postgres' default NULLS
    // DISTINCT two such rows never collide, so `onConflictDoNothing` would
    // insert a duplicate on every re-pull instead of ignoring it. Needs
    // postgres 15 or newer; the database is 18.
    unique('usage_events_unique_user_agent_date_model_device_source')
      .on(t.userId, t.agent, t.date, t.modelName, t.deviceId, t.source)
      .nullsNotDistinct(),
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
  // When this alert last crossed its trip point, or null if it has not. The
  // month of this timestamp is the month the trip belongs to, which is what
  // makes the banner self-clearing: an alert tripped in October reads as
  // untripped on 1 November with nothing scheduled to go and reset it.
  //
  // Both directions are maintained by the same evaluation, so raising a limit
  // above current spend clears the latch rather than leaving a banner up until
  // the month turns over. A stored column only belongs in a predicate if every
  // path that changes the answer writes it.
  trippedAt: timestamp('tripped_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Rate-limit counters, one row per route+caller. Lives in the database because
// an in-memory counter counts per serverless instance, which multiplies every
// per-route cap by the number of live instances. `expires_at` is timestamptz so
// the window still closes at the right moment if two connections disagree about
// the session time zone.
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('rate_limits_expires_at_idx').on(t.expiresAt)],
)

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
