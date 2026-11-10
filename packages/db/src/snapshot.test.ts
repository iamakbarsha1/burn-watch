import { describe, expect, it } from 'vitest'
import { dayKey, type IsoDate, type Micros, type OrgId, type UserId } from './ids.js'
import { buildSnapshot, pickWinningSource, type AgentSourceTotals } from './snapshot.js'

const row = (
  agent: AgentSourceTotals['agent'],
  source: AgentSourceTotals['source'],
  tokens: number,
  models: string[] = [],
): AgentSourceTotals => ({ agent, source, tokens, costMicros: (tokens * 10) as Micros, models })

describe('pickWinningSource', () => {
  it('prefers the agent source per agent, not globally', () => {
    // claude has only an agent row, copilot has both, codex has only the org
    // pull. A global "any agent rows today" test would drop codex entirely and
    // summing both sources would double copilot.
    const picked = pickWinningSource([
      row('claude', 'agent', 100),
      row('copilot', 'agent', 10),
      row('copilot', 'copilot-org', 999),
      row('codex', 'copilot-org', 5),
    ])
    expect(Object.fromEntries(picked.map((p) => [p.agent, p.tokens]))).toEqual({
      claude: 100,
      copilot: 10,
      codex: 5,
    })
  })

  it('is independent of the order rows arrive in', () => {
    const a = pickWinningSource([row('copilot', 'copilot-org', 999), row('copilot', 'agent', 10)])
    const b = pickWinningSource([row('copilot', 'agent', 10), row('copilot', 'copilot-org', 999)])
    expect(a).toEqual(b)
    expect(a[0].tokens).toBe(10)
  })
})

describe('buildSnapshot', () => {
  it('sums the winning rows and keys the document by user-day', () => {
    const userId = 'u1' as UserId
    const date = '2026-01-15' as IsoDate
    const now = new Date('2026-01-16T00:00:00Z')
    const doc = buildSnapshot(
      userId,
      'o1' as OrgId,
      date,
      [
        { agent: 'claude', tokens: 100, costMicros: 1_000_000 as Micros, models: ['opus', 'sonnet'] },
        { agent: 'codex', tokens: 5, costMicros: 50 as Micros, models: ['sonnet'] },
      ],
      now,
    )
    expect(doc._id).toBe(dayKey(userId, date))
    expect(doc.totalTokens).toBe(105)
    expect(doc.totalCostMicros).toBe(1_000_050)
    expect(doc.byAgent).toEqual({
      claude: { tokens: 100, costMicros: 1_000_000 },
      codex: { tokens: 5, costMicros: 50 },
    })
    expect(doc.modelsUsed).toEqual(['opus', 'sonnet'])
    expect(doc.updatedAt).toBe(now)
  })
})
