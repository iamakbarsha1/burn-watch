import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { getStore, type IsoDate, type OrgId, type UserId } from '@burn-watch/db'
import { TicketPrefixesSchema, type TicketRow, type TicketUsageResponse } from '@burn-watch/shared'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
import { dateQuerySchema as QuerySchema } from './query-schema.js'
import { requireAdmin, viewerScope } from '../../plugins/jwt.js'
import { audit } from '../../audit.js'

// Jira key: letter, then 1-9 letters or digits, a dash, a number from 1. No `_`,
// so `foo_PROJ-1` still finds PROJ-1 (design, "Extraction rule").
const TICKET = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d{0,6})(?!\d)/g

/**
 * R2 C4: the first key in a branch name whose prefix is allowed, upper-cased,
 * or null. Case-insensitive (Decision 3); the allowlist drops UTF-8 and the like
 * (Decision 1). An empty allowlist always gives null.
 */
export function ticketKey(branch: string, prefixes: ReadonlySet<string>): string | null {
  for (const m of branch.matchAll(TICKET)) {
    const prefix = m[1].toUpperCase()
    if (prefixes.has(prefix)) return `${prefix}-${m[2]}`
  }
  return null
}

/** Upper-case key prefixes in a branch name, the stricter rule used for admin suggestions. */
export function upperPrefixes(branch: string): string[] {
  return [...branch.matchAll(TICKET)].map((m) => m[1]).filter((p) => p === p.toUpperCase())
}

/** One branch in one repo over the range. */
export interface BranchGroup {
  _id: { branch: string; repo: string }
  cost: number
  sessions: number
  users: UserId[]
  days: string[]
}

/** Branch rows per (branch, repo). Days from agents before 0.4.0 have no `branches` and drop out at the unwind. */
export function ticketTotals(range: EnrichmentRange): Document[] {
  return [
    enrichmentMatch(range),
    { $unwind: '$projectBreakdown' },
    { $unwind: '$projectBreakdown.branches' },
    {
      $group: {
        _id: {
          branch: '$projectBreakdown.branches.name',
          repo: { $ifNull: ['$projectBreakdown.remote', '$projectBreakdown.path'] },
        },
        cost: { $sum: '$projectBreakdown.branches.cost' },
        sessions: { $sum: '$projectBreakdown.branches.sessions' },
        users: { $addToSet: '$userId' },
        days: { $addToSet: '$date' },
      },
    },
  ]
}

/** Fold branch rows into tickets, project keys and "No ticket". Raw branch names stay in here. */
export function foldTickets(
  groups: BranchGroup[],
  allowed: string[],
  withSuggestions: boolean,
): Pick<TicketUsageResponse, 'tickets' | 'projectKeys' | 'noTicket' | 'suggestions'> {
  const prefixes = new Set(allowed)
  const tickets = new Map<string, { cost: number; sessions: number; users: Set<string>; repos: Set<string>; days: Set<string> }>()
  const noTicket = { cost: 0, sessions: 0 }
  const suggest = new Map<string, Set<string>>()

  for (const g of groups) {
    const key = ticketKey(g._id.branch, prefixes)
    if (key) {
      const t = tickets.get(key) ?? { cost: 0, sessions: 0, users: new Set(), repos: new Set(), days: new Set() }
      t.cost += g.cost
      t.sessions += g.sessions
      g.users.forEach((u) => t.users.add(u))
      t.repos.add(g._id.repo)
      g.days.forEach((d) => t.days.add(d))
      tickets.set(key, t)
    } else {
      noTicket.cost += g.cost
      noTicket.sessions += g.sessions
    }
    if (withSuggestions) {
      for (const p of upperPrefixes(g._id.branch)) {
        if (!prefixes.has(p)) suggest.set(p, (suggest.get(p) ?? new Set()).add(g._id.branch))
      }
    }
  }

  const rows = [...tickets].map<TicketRow & { users: Set<string> }>(([key, t]) => ({
    key,
    cost: t.cost,
    sessions: t.sessions,
    userCount: t.users.size,
    repoCount: t.repos.size,
    days: t.days.size,
    users: t.users,
  }))
  rows.sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))

  const byPrefix = new Map<string, { tickets: number; cost: number; sessions: number; users: Set<string> }>()
  for (const r of rows) {
    const prefix = r.key.slice(0, r.key.lastIndexOf('-'))
    const p = byPrefix.get(prefix) ?? { tickets: 0, cost: 0, sessions: 0, users: new Set() }
    p.tickets++
    p.cost += r.cost
    p.sessions += r.sessions
    r.users.forEach((u) => p.users.add(u))
    byPrefix.set(prefix, p)
  }

  return {
    tickets: rows.map(({ users: _users, ...r }) => r),
    projectKeys: [...byPrefix]
      .map(([prefix, p]) => ({ prefix, tickets: p.tickets, cost: p.cost, sessions: p.sessions, userCount: p.users.size }))
      .sort((a, b) => b.cost - a.cost || a.prefix.localeCompare(b.prefix)),
    noTicket,
    suggestions: withSuggestions
      ? [...suggest]
          .map(([prefix, b]) => ({ prefix, branches: b.size }))
          .sort((a, b) => b.branches - a.branches || a.prefix.localeCompare(b.prefix))
      : null,
  }
}

export async function ticketsRoutes(fastify: FastifyInstance) {
  // GET /tickets — R2 C4. Same roles and scope as /projects; no person is named, so no auditView.
  fastify.get('/tickets', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = (parsed.data.date ?? parsed.data.from!) as IsoDate
    const to = (parsed.data.date ?? parsed.data.to!) as IsoDate
    const orgId = request.user.orgId as OrgId
    const store = getStore()
    const [org, groups] = await Promise.all([
      store.organizations.findOne({ _id: orgId }, { projection: { ticketPrefixes: 1 } }),
      store.claudeEnrichment.aggregate<BranchGroup>(
        ticketTotals({ orgId, userIds: await viewerScope(request.user), from, to }),
      ),
    ])
    const prefixes = org?.ticketPrefixes?.length ? org.ticketPrefixes : null
    return {
      from,
      to,
      prefixes,
      ...foldTickets(groups, prefixes ?? [], request.user.role === 'admin'),
    } satisfies TicketUsageResponse
  })

  // PUT /tickets/settings { prefixes } — admin only; [] clears.
  fastify.put('/tickets/settings', { preHandler: requireAdmin(fastify) }, async (request) => {
    const prefixes = [...new Set(TicketPrefixesSchema.parse(request.body).prefixes)]
    const orgId = request.user.orgId as OrgId
    await getStore().organizations.updateOne(
      { _id: orgId },
      prefixes.length ? { $set: { ticketPrefixes: prefixes } } : { $unset: { ticketPrefixes: '' } },
    )
    await audit(request, {
      action: 'org.ticket_prefixes',
      target: { type: 'org', id: orgId, label: null },
      detail: { prefixes },
    })
    return { prefixes }
  })
}
