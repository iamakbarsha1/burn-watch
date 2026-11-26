import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type { UserId } from '@burn-watch/db'
import { callsTo } from './mongo-store.fake.js'

const state = vi.hoisted(() => ({
  docs: {} as Record<string, Record<string, unknown>[]>,
  aggregates: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { op: string; collection: string; args: unknown[] }[],
  failOn: null as string | null,
  bulk: { upsertedCount: 1, matchedCount: 0 },
}))

vi.mock('@burn-watch/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@burn-watch/db')>()
  const { fakeStore } = await import('./mongo-store.fake.js')
  const store = fakeStore(state, Object.keys(real.COLLECTIONS))
  return { ...real, getStore: () => store }
})

const { audit, auditView } = await import('./audit.js')

const ORG = '11111111-1111-4111-8111-111111111111'
const ME = '33333333-3333-4333-8333-333333333333' as UserId
const OTHER = '77777777-7777-4777-8777-777777777777' as UserId
const TEAM = '88888888-8888-4888-8888-888888888888'

function req(role: 'admin' | 'manager' | 'developer' = 'admin') {
  const error = vi.fn()
  const request = { user: { userId: ME, orgId: ORG, role }, log: { error } } as unknown as FastifyRequest
  return { request, error }
}

beforeEach(() => {
  state.docs = {}
  state.calls = []
  state.failOn = null
})

describe('audit', () => {
  it('inserts one action with the actor from the JWT', async () => {
    const { request } = req()
    await audit(request, { action: 'team.create', target: { type: 'team', id: TEAM, label: 'Platform' }, detail: { name: 'Platform' } })

    const [[doc]] = callsTo(state, 'auditEvents', 'insertOne') as [[Record<string, unknown>]]
    expect(doc).toMatchObject({
      orgId: ORG,
      kind: 'action',
      action: 'team.create',
      actorId: ME,
      actorRole: 'admin',
      target: { type: 'team', id: TEAM, label: 'Platform' },
      detail: { name: 'Platform' },
      lastAt: null,
      count: 1,
      expiresAt: null,
    })
    expect(doc.at).toBeInstanceOf(Date)
  })

  it('labels an org target with the org name, and still writes when that read fails', async () => {
    state.docs.organizations = [{ _id: ORG, name: 'Acme' }]
    const { request } = req()
    await audit(request, { action: 'org.min_claude_version', target: { type: 'org', id: ORG, label: null } })
    state.failOn = 'organizations.findOne'
    await audit(request, { action: 'seat.assign_all', target: { type: 'org', id: ORG, label: null } })

    const inserts = callsTo(state, 'auditEvents', 'insertOne') as [Record<string, unknown>][]
    expect(inserts.map(([doc]) => doc.target)).toEqual([
      { type: 'org', id: ORG, label: 'Acme' },
      { type: 'org', id: ORG, label: null },
    ])
  })

  it('swallows a failed insert and logs audit_write_failed with the full event', async () => {
    state.failOn = 'auditEvents.insertOne'
    const { request, error } = req()
    await expect(
      audit(request, { action: 'seat.remove', target: { type: 'seat', id: 'x', label: null }, detail: { agent: 'claude' } }),
    ).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledTimes(1)
    const [obj, msg] = error.mock.calls[0]
    expect(msg).toBe('audit_write_failed')
    expect(obj.err).toBeInstanceOf(Error)
    expect(obj.event).toMatchObject({ action: 'seat.remove', actorId: ME, orgId: ORG, detail: { agent: 'claude' } })
  })
})

describe('auditView', () => {
  it('writes nothing for a scope of only the viewer', async () => {
    const { request } = req('developer')
    await auditView(request, 'usage_distribution', [ME])
    expect(state.calls).toEqual([])
  })

  it('upserts one doc per viewer, surface, scope and UTC day', async () => {
    const { request } = req('manager')
    await auditView(request, 'governance', [ME, OTHER])

    const [[filter, update, opts]] = callsTo(state, 'auditEvents', 'updateOne') as [[{ _id: string }, Record<string, Record<string, unknown>>, unknown]]
    const day = new Date().toISOString().slice(0, 10)
    expect(filter).toEqual({ _id: `view:${ORG}:${ME}:governance:all:${day}` })
    expect(opts).toEqual({ upsert: true })
    expect(update.$inc).toEqual({ count: 1 })
    expect(update.$set.lastAt).toBeInstanceOf(Date)
    expect(update.$setOnInsert).toMatchObject({
      kind: 'view',
      action: 'view.governance',
      actorId: ME,
      actorRole: 'manager',
      target: { type: 'scope', id: null, label: 'managed teams' },
      detail: { people: 2 },
    })
    // Not in $setOnInsert: the filter sets _id, and the other two change every view.
    expect(update.$setOnInsert).not.toHaveProperty('_id')
    expect(update.$setOnInsert).not.toHaveProperty('count')
    expect(update.$setOnInsert).not.toHaveProperty('lastAt')
    const expires = (update.$setOnInsert.expiresAt as Date).getTime() - (update.$setOnInsert.at as Date).getTime()
    expect(expires).toBe(365 * 24 * 60 * 60 * 1000)
  })

  it('keys a team read by team id and labels it with the team name', async () => {
    state.docs.teams = [{ _id: TEAM, name: 'Platform' }]
    const { request } = req('admin')
    await auditView(request, 'overview', [OTHER], TEAM)

    const [[filter, update]] = callsTo(state, 'auditEvents', 'updateOne') as [[{ _id: string }, Record<string, Record<string, unknown>>]]
    expect(filter._id).toContain(`:overview:${TEAM}:`)
    expect(update.$setOnInsert.target).toEqual({ type: 'team', id: TEAM, label: 'Platform' })
  })

  it('labels an admin whole-org read "org" with no people count', async () => {
    const { request } = req('admin')
    await auditView(request, 'people', undefined)
    const [[, update]] = callsTo(state, 'auditEvents', 'updateOne') as [[unknown, Record<string, Record<string, unknown>>]]
    expect(update.$setOnInsert.target).toEqual({ type: 'scope', id: null, label: 'org' })
    expect(update.$setOnInsert.detail).toBeNull()
  })

  it('swallows a failed upsert and logs audit_write_failed', async () => {
    state.failOn = 'auditEvents.updateOne'
    const { request, error } = req('admin')
    await expect(auditView(request, 'usage_distribution', undefined)).resolves.toBeUndefined()
    expect(error.mock.calls[0][1]).toBe('audit_write_failed')
    expect(error.mock.calls[0][0].event).toMatchObject({ action: 'view.usage_distribution' })
  })
})
