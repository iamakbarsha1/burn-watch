import { RegisterDeviceSchema, UsagePayloadSchema } from '@burn-watch/shared'
import type { ZodTypeAny } from 'zod'

/**
 * The field list for the "What BurnWatch knows about me" page, read from the
 * same Zod schemas the API validates the agent against, so the page cannot
 * list less than the agent is allowed to send.
 */

/** `group`: an object or array whose own fields follow as separate rows. */
export type SchemaField = { path: string; description: string; depth: number; group: boolean }

// typeName, not instanceof: the shared package may resolve its own zod copy.
const WRAPPERS = new Set(['ZodOptional', 'ZodNullable', 'ZodDefault'])

function unwrap(t: ZodTypeAny): ZodTypeAny {
  while (WRAPPERS.has(t._def.typeName)) t = t._def.innerType
  return t
}

function shapeOf(t: ZodTypeAny): Record<string, ZodTypeAny> | null {
  return t._def.typeName === 'ZodObject' ? t._def.shape() : null
}

export function schemaFields(schema: ZodTypeAny, prefix = '', depth = 0): SchemaField[] {
  const shape = shapeOf(unwrap(schema)) ?? {}
  return Object.entries(shape).flatMap(([key, field]) => {
    const path = prefix + key
    const row = { path, description: field.description ?? '', depth, group: false }
    const t = unwrap(field)
    const isArray = t._def.typeName === 'ZodArray'
    const inner = isArray ? unwrap(t._def.type) : t
    const innerShape = shapeOf(inner)
    // Only descend into described objects: activity and top-session entries are
    // never filled by the agent, and their parent row already says so.
    if (!innerShape || !Object.values(innerShape).some((f) => f.description)) return [row]
    return [{ ...row, group: true }, ...schemaFields(inner, `${path}${isArray ? '[]' : ''}.`, depth + 1)]
  })
}

/**
 * Who can read a field in the dashboard or through its API.
 * scoped: you, a manager of a team you are in, and admins (viewerScope).
 * self: only you, on My usage.
 * selfAdmin: you on My usage, and admins (v2 Phase 3: you see what an admin sees about you).
 * admin: admins only. none: stored, but no page or route shows it yet.
 */
export type Audience = 'scoped' | 'self' | 'selfAdmin' | 'admin' | 'none'

/**
 * Exact path, or the array's entry for a field inside an array element. The test fails on a
 * field that resolves to nothing and on an entry no field uses, so a new
 * schema field needs a decision here before it ships.
 */
export const AUDIENCE: Record<string, Audience> = {
  // Sign-in (RegisterDeviceSchema)
  email: 'admin', // Governance setup-check rows, Admin seats; managers see counts only
  hostname: 'admin', // Admin users list, Devices
  platform: 'admin', // Devices
  agentVersion: 'none',
  // Nightly sync (UsagePayloadSchema)
  deviceId: 'none',
  date: 'scoped',
  events: 'scoped', // Overview, Trends, My usage; free-tier and setup-check use as counts for managers, named for admins, yours on My usage
  'enrichment.date': 'scoped',
  'enrichment.sessionCount': 'self', // My usage
  'enrichment.callCount': 'none',
  'enrichment.cacheHitRate': 'none', // Adoption works its cache rate out from token counts, not this
  'enrichment.writtenTokens': 'none',
  'enrichment.activityBreakdown': 'none',
  'enrichment.projectBreakdown': 'scoped', // Projects
  'enrichment.projectBreakdown[].branches': 'scoped', // Tickets, as keys; branch names are never shown
  'enrichment.projectBreakdown[].overheadK': 'none',
  'enrichment.topSessions': 'none',
  'enrichment.toolUsage': 'scoped', // Activity, Adoption
  'enrichment.shellUsage': 'scoped', // Activity
  'enrichment.mcpUsage': 'scoped', // Activity, Adoption, My usage; Governance MCP shows people counts, no names
  'enrichment.limitHitCount': 'admin', // limit-hit alerts, as a count of people
  'enrichment.claudeVersions': 'none',
  'enrichment.entrypointCounts': 'scoped', // Adoption
  'enrichment.skillCounts': 'scoped', // Adoption
  'enrichment.sidechainMessages': 'scoped', // Adoption
  'enrichment.permissionModeCounts': 'scoped', // Adoption
  'enrichment.accountHashes': 'selfAdmin', // Governance as labels and counts per note; your own notes on My usage; the hash is never shown
  'enrichment.claudeOrgHashes': 'selfAdmin', // Governance as labels and counts per note; your own notes on My usage; the hash is never shown
  // Set on My usage (MY_CHOICES)
  helpVolunteer: 'scoped', // My usage; your name on Adoption under your teams, only when on
}

export function audienceOf(path: string): Audience | undefined {
  if (path in AUDIENCE) return AUDIENCE[path]
  // Only array elements inherit: a new top-level or enrichment field must get
  // its own entry, never a quiet 'none' from its container.
  const parent = path.replace(/\[\]\.[^.]+$/, '')
  return parent === path ? undefined : AUDIENCE[parent]
}

/** Saved from the dashboard by the person, not sent by the agent. Keys match HelpVolunteerSchema. */
const MY_CHOICES: SchemaField[] = [
  {
    path: 'helpVolunteer',
    description: 'Whether you are happy to help with Claude Code. Off unless you turn it on.',
    depth: 0,
    group: false,
  },
]

export const FIELD_GROUPS = [
  {
    title: 'When you sign in a laptop',
    description: 'Sent once, by burnwatch register.',
    fields: schemaFields(RegisterDeviceSchema),
  },
  {
    title: 'Every evening sync',
    description: "Sent once a day with yesterday's totals.",
    fields: schemaFields(UsagePayloadSchema),
  },
  {
    title: 'What you choose on My usage',
    description: 'Saved when you change it. Only you can change it.',
    fields: MY_CHOICES,
  },
]
