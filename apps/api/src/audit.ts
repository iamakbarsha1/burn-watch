import type { FastifyRequest } from 'fastify'
import type { AuditAction, AuditSurface, AuditTarget } from '@burn-watch/shared'
import { getStore, newId, type AuditEventDoc, type OrgId, type TeamId, type UserId } from '@burn-watch/db'
import type { JwtPayload } from './plugins/jwt.js'
import { orgPeople } from './plugins/org-people.js'

/** Views expire after a year (Decision 4). Actions keep expiresAt null until B9 picks a period. */
const VIEW_RETENTION_MS = 365 * 24 * 60 * 60 * 1000

/**
 * The only writer to auditEvents (R1 B8). Route handlers call audit() or
 * auditView() on the success path, after any transaction has returned.
 *
 * Every write is awaited before the handler answers and never throws: no work
 * is left running after the response, which a serverless runtime may freeze
 * and a container may kill. A failed write logs `audit_write_failed` with the
 * whole event so it can be found and re-inserted by hand; the action it
 * describes already succeeded and still answers normally.
 *
 * shortcut: failed audit writes are only in logs, move to outbox/queue if any loss is unacceptable
 */
async function write(request: FastifyRequest, event: AuditEventDoc, op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
  } catch (err) {
    request.log.error({ err, event }, 'audit_write_failed')
  }
}

/** Who did it. From the verified JWT, never the body; `actor` only for the two unauthenticated routes that create one. */
type Actor = Pick<JwtPayload, 'userId' | 'orgId' | 'role'>

export async function audit(
  request: FastifyRequest,
  e: { action: AuditAction; target: AuditTarget; detail?: Record<string, unknown> | null; actor?: Actor },
): Promise<void> {
  const actor = e.actor ?? request.user
  let target = e.target
  if (target.type === 'org' && !target.label) {
    // Callers holding only the org id: label it with the name, so /audit never shows a bare UUID.
    try {
      const org = await getStore().organizations.findOne({ _id: actor.orgId as OrgId }, { projection: { name: 1 } })
      target = { ...target, label: org?.name ?? null }
    } catch {
      // The label is cosmetic; a failed read must not cost the event.
    }
  }
  const event: AuditEventDoc = {
    _id: newId(),
    orgId: actor.orgId as OrgId,
    kind: 'action',
    action: e.action,
    actorId: actor.userId as UserId,
    actorRole: actor.role,
    target,
    detail: e.detail ?? null,
    at: new Date(),
    lastAt: null,
    count: 1,
    expiresAt: null,
  }
  await write(request, event, () => getStore().auditEvents.insertOne(event))
}

/**
 * One view of other people's data: one doc per viewer, surface, scope and UTC
 * day, counted. Skips a scope that reaches nobody but the viewer, so callers
 * need not repeat the rule. `scope` is what readScope / viewerScope returned
 * (undefined = the whole org).
 */
export async function auditView(
  request: FastifyRequest,
  surface: AuditSurface,
  scope: UserId[] | undefined,
  teamId?: string,
): Promise<void> {
  const viewer = request.user
  if (scope && scope.every((id) => id === viewer.userId)) return

  const orgId = viewer.orgId as OrgId
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  let target: AuditTarget
  try {
    const team = teamId ? await getStore().teams.findOne({ _id: teamId as TeamId, orgId }, { projection: { name: 1 } }) : null
    target = teamId
      ? { type: 'team', id: teamId, label: team?.name ?? null }
      : { type: 'scope', id: null, label: !scope ? 'org' : viewer.role === 'manager' ? 'managed teams' : 'org' }
  } catch {
    // The label is cosmetic; a failed read must not cost the event.
    target = { type: teamId ? 'team' : 'scope', id: teamId ?? null, label: null }
  }

  let covered: UserId[] | undefined
  try {
    covered = scope ?? (await orgPeople(orgId))
  } catch {
    // Without it the row reads as a pre-v2.1 view: matched by current teams.
    covered = undefined
  }

  const _id = `view:${orgId}:${viewer.userId}:${surface}:${teamId ?? 'all'}:${day}`
  const event: AuditEventDoc = {
    _id,
    orgId,
    kind: 'view',
    action: `view.${surface}`,
    actorId: viewer.userId as UserId,
    actorRole: viewer.role,
    target,
    detail: scope ? { people: scope.length } : null,
    at: now,
    lastAt: now,
    count: 1,
    expiresAt: new Date(now.getTime() + VIEW_RETENTION_MS),
    ...(covered && { coveredUserIds: covered }),
  }
  // _id comes from the filter; lastAt, count and coverage change on every view.
  const { _id: _key, lastAt, count: _count, coveredUserIds: _covered, ...onInsert } = event
  await write(request, event, () =>
    getStore().auditEvents.updateOne(
      { _id },
      {
        $setOnInsert: onInsert,
        $inc: { count: 1 },
        $set: { lastAt },
        ...(covered && { $addToSet: { coveredUserIds: { $each: covered } } }),
      },
      { upsert: true },
    ),
  )
}
