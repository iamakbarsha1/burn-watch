import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MongoClient } from 'mongodb'

const fake = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: (async () => null) as () => Promise<unknown>,
}))

vi.mock('@burn-watch/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@burn-watch/db')>()
  const rateLimits = {
    findOneAndUpdate: (...args: unknown[]) => (fake.calls.push(args), fake.answer()),
  }
  return { ...real, getStore: () => ({ rateLimits }) }
})

const { mongoRateLimitStore, hitPipeline } = await import('./rate-limit-store.js')
const { storeFor } = await import('@burn-watch/db')

const incr = (store: { incr: InstanceType<ReturnType<typeof mongoRateLimitStore>>['incr'] }, key: string, timeWindow: number) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), timeWindow)
  })

beforeEach(() => {
  fake.calls = []
  fake.answer = async () => null
})

describe('mongoRateLimitStore', () => {
  it('issues one upsert on the prefixed key and reports count and remaining window', async () => {
    fake.answer = async () => ({ _id: '1.2.3.4', count: 4, expiresAt: new Date(Date.now() + 1_800_000) })
    const Store = mongoRateLimitStore()

    const result = await incr(new Store(), '1.2.3.4', 3_600_000)

    expect(fake.calls).toHaveLength(1)
    const [filter, update, opts] = fake.calls[0]
    expect(filter).toEqual({ _id: '1.2.3.4' })
    expect(update).toEqual(hitPipeline(3_600_000))
    expect(opts).toEqual({ upsert: true })
    expect(result.current).toBe(4)
    // Remaining window in ms, rounded up. A few ms pass between building the
    // answer and reading the clock.
    expect(result.ttl).toBeGreaterThan(1_799_000)
    expect(result.ttl).toBeLessThanOrEqual(1_800_000)
  })

  it('resets on a closed window and keeps the end of an open one', () => {
    const [stage] = hitPipeline(900_000) as [{ $set: Record<string, unknown> }]
    const closed = { $lte: ['$expiresAt', '$$NOW'] }
    expect(stage.$set.count).toEqual({ $cond: [closed, 1, { $add: ['$count', 1] }] })
    expect(stage.$set.expiresAt).toEqual({
      $cond: [closed, { $add: ['$$NOW', 900_000] }, '$expiresAt'],
    })
  })

  it('counts each route separately', async () => {
    fake.answer = async () => ({ count: 1, expiresAt: new Date(Date.now() + 900_000) })
    const Store = mongoRateLimitStore()

    const child = new Store().child({
      routeInfo: { method: 'POST', url: '/v1/auth/register-device' },
    })
    await incr(child, '1.2.3.4', 900_000)

    expect(fake.calls[0][0]).toEqual({ _id: 'POST/v1/auth/register-device-1.2.3.4' })
  })

  it('fails the request when the counter cannot be written', async () => {
    fake.answer = () => Promise.reject(new Error('connection terminated'))
    await expect(incr(new (mongoRateLimitStore())(), '1.2.3.4', 1000)).rejects.toThrow(
      'connection terminated',
    )
  })

  it('fails the request when the upsert hands back no document', async () => {
    await expect(incr(new (mongoRateLimitStore())(), '1.2.3.4', 1000)).rejects.toThrow('no document')
  })
})

describe('Bound.findOneAndUpdate', () => {
  // The store above reads count and expiresAt off the returned document. The
  // driver returns the document as it was before the update unless told
  // otherwise, which would report every first hit as no document at all.
  it('asks the driver for the document after the update', async () => {
    const seen: unknown[][] = []
    const collection = {
      findOneAndUpdate: async (...args: unknown[]) => (seen.push(args), { count: 1 }),
    }
    const client = { db: () => ({ collection: () => collection }) } as unknown as MongoClient

    const doc = await storeFor(client).rateLimits.findOneAndUpdate({ _id: 'k' }, hitPipeline(1000), {
      upsert: true,
    })

    expect(doc).toEqual({ count: 1 })
    expect(seen[0][2]).toMatchObject({ upsert: true, returnDocument: 'after' })
  })
})
