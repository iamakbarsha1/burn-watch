import type { Document } from 'mongodb'
import type {
  BudgetAlertDoc,
  ClaudeEnrichmentDoc,
  DailySnapshotDoc,
  DeviceDoc,
  DeviceTokenDoc,
  InviteDoc,
  OrgIntegrationDoc,
  OrganizationDoc,
  PendingDeviceDoc,
  RateLimitDoc,
  UsageEventDoc,
  UserDoc,
} from './documents.js'

export interface IndexSpec<T extends Document = Document> {
  readonly name: string
  /**
   * Field order is load-bearing and the object literal preserves it. Typed
   * against the document so a renamed field is a compile error rather than an
   * index MongoDB accepts and never uses.
   */
  readonly key: Readonly<Partial<Record<Extract<keyof T, string>, 1 | -1>>>
  readonly unique?: true
  readonly expireAfterSeconds?: number
}

export interface CollectionSpec<T extends Document = Document> {
  readonly indexes: readonly IndexSpec<T>[]
  /** Phantom. Carries T so the registry can type the Store. Never set, never read. */
  readonly __doc?: T
}

const spec = <T extends Document>(indexes: readonly IndexSpec<T>[]): CollectionSpec<T> => ({ indexes })

/**
 * Every collection this package knows about and every index it expects to
 * find. One object with three consumers: the Store's members and their
 * document types, what syncSchema creates, and what the health check verifies.
 * Adding a collection is one entry here and no second edit anywhere.
 *
 * The object key is the collection name. There is no separate name field,
 * because a key and a string that have to agree are a pair that can disagree.
 *
 * Only indexes with a reader are declared. Each one below ports a Postgres
 * index that encoded a measured hot path or a real incident. An index invented
 * for a query nobody writes costs every write and proves nothing, so a new
 * entry waits for the route that reads it.
 *
 * Four Postgres indexes have no entry because an _id carries them:
 * daily_snapshots and claude_enrichment are keyed by DayKey, org_integrations
 * by IntegrationKey, and rate_limits was already keyed by its text column.
 * usage_events_user_date_idx is gone outright: usageEvents_key leads with
 * userId then date, so it is a usable prefix.
 */
export const COLLECTIONS = {
  organizations: spec<OrganizationDoc>([{ name: 'organizations_slug', key: { slug: 1 }, unique: true }]),

  users: spec<UserDoc>([{ name: 'users_email', key: { email: 1 }, unique: true }]),

  devices: spec<DeviceDoc>([]),

  deviceTokens: spec<DeviceTokenDoc>([
    // Every authenticated device request reads this row before the route's own
    // queries, so the lookup is on the hot path for all usage submission.
    { name: 'deviceTokens_deviceId', key: { deviceId: 1 } },
  ]),

  pendingDevices: spec<PendingDeviceDoc>([
    { name: 'pendingDevices_code', key: { code: 1 }, unique: true },
  ]),

  invites: spec<InviteDoc>([{ name: 'invites_code', key: { code: 1 }, unique: true }]),

  usageEvents: spec<UsageEventDoc>([
    // Carried verbatim from src/scripts/snapshot-race.ts:262-265, down to the
    // field order, which is the index the two-tier upsert was proved against on
    // a live replica set. MongoDB treats a missing or null field as a value in
    // a unique index, so two null-deviceId org-pull rows collide without
    // Postgres' NULLS NOT DISTINCT ceremony.
    {
      name: 'usageEvents_key',
      key: { userId: 1, date: 1, agent: 1, modelName: 1, deviceId: 1, source: 1 },
      unique: true,
    },
    { name: 'usageEvents_date_totalTokens', key: { date: 1, totalTokens: 1 } },
    { name: 'usageEvents_agent_date', key: { agent: 1, date: 1 } },
  ]),

  claudeEnrichment: spec<ClaudeEnrichmentDoc>([
    { name: 'claudeEnrichment_org_date', key: { orgId: 1, date: 1 } },
  ]),

  dailySnapshots: spec<DailySnapshotDoc>([
    { name: 'dailySnapshots_org_date', key: { orgId: 1, date: 1 } },
    { name: 'dailySnapshots_date_cost', key: { date: 1, totalCostMicros: 1 } },
    { name: 'dailySnapshots_date_tokens', key: { date: 1, totalTokens: 1 } },
  ]),

  // No index: _id is the org and provider, which is the only uniqueness the
  // Postgres table declared and the only way anything reads the row.
  orgIntegrations: spec<OrgIntegrationDoc>([]),

  budgetAlerts: spec<BudgetAlertDoc>([]),

  rateLimits: spec<RateLimitDoc>([
    // Replaces the SWEEP_EVERY counter and its delete in plugins/rate-limit-store.ts.
    { name: 'rateLimits_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]),
} satisfies Record<string, CollectionSpec<Document>>

export type CollectionName = keyof typeof COLLECTIONS
