import { describe, it, expect } from 'vitest'
import { snapshotDoc, usageEventDoc, budgetAlertDoc, userDoc } from './copy-to-mongo.map.js'
import type { OrgId } from '@burn-watch/db'

const at = new Date('2026-11-01T00:00:00Z')
const U = '11111111-1111-1111-1111-111111111111'
const O = '22222222-2222-2222-2222-222222222222'

describe('copy-to-mongo mapping', () => {
  it('turns numeric(12,6) dollars into exact micros', () => {
    const doc = usageEventDoc(
      {
        id: 'x', userId: U, deviceId: null, source: 'agent', agent: 'claude', date: '2026-11-01',
        modelName: 'm', inputTokens: 1, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 0,
        totalTokens: 3, costUsd: '123.456789', isFreeTier: false, sourceRaw: null, submittedAt: at,
      },
      O as OrgId,
    )
    expect(doc.costMicros).toBe(123456789)
    expect(doc.deviceId).toBeNull()
    expect(doc).not.toHaveProperty('_id')
  })

  it('folds the per-agent columns into byAgent and drops the zero ones', () => {
    const zero = { Tokens: 0, CostUsd: '0.000000' }
    const col = (a: string, v: { Tokens: number; CostUsd: string }) => ({ [`${a}Tokens`]: v.Tokens, [`${a}CostUsd`]: v.CostUsd })
    const doc = snapshotDoc({
      id: 'x', userId: U, orgId: O, date: '2026-11-01',
      ...col('claude', { Tokens: 10, CostUsd: '0.500000' }),
      ...col('qwen', zero), ...col('gemini', zero), ...col('codex', zero),
      ...col('copilot', { Tokens: 0, CostUsd: '0.000001' }),
      totalTokens: 10, totalCostUsd: '0.500001', callCount: 1, sessionCount: 1,
      cacheHitRate: '42.50', modelsUsed: null, updatedAt: at,
    } as Parameters<typeof snapshotDoc>[0])
    expect(doc._id).toBe(`${U}:2026-11-01`)
    expect(doc.byAgent).toEqual({ claude: { tokens: 10, costMicros: 500000 }, copilot: { tokens: 0, costMicros: 1 } })
    expect(doc.totalCostMicros).toBe(500001)
    expect(doc.cacheHitRate).toBe(42.5)
    expect(doc.modelsUsed).toEqual([])
  })

  it('stores the alert limit in micros and the threshold as a ratio', () => {
    const doc = budgetAlertDoc({
      id: 'a', orgId: O, userId: null, agent: null, monthlyLimitUsd: '250.00', threshold: '0.80',
      trippedAt: null, createdAt: at,
    })
    expect(doc.monthlyLimitMicros).toBe(250_000_000)
    expect(doc.threshold).toBe(0.8)
  })

  it('lowercases user emails so case-insensitive lookups still find them', () => {
    const doc = userDoc({
      id: U, orgId: O, email: 'Admin@Acme.COM', name: 'A', githubUsername: null,
      role: 'admin', isActive: true, createdAt: at,
    } as Parameters<typeof userDoc>[0])
    expect(doc.email).toBe('admin@acme.com')
  })
})
