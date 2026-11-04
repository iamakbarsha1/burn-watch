import { describe, it, expect } from 'vitest'
import {
  AgentNameSchema,
  UsageEventSchema,
  ActivityEntrySchema,
  ProjectEntrySchema,
  SessionEntrySchema,
  ClaudeEnrichmentSchema,
  UsagePayloadSchema,
  RegisterDeviceSchema,
  VerifyDeviceSchema,
} from './schemas.js'

const usageEvent = {
  agent: 'claude',
  date: '2026-11-05',
  modelName: 'claude-opus-5',
  inputTokens: 100,
  outputTokens: 50,
  cacheCreateTokens: 10,
  cacheReadTokens: 900,
  totalTokens: 1060,
  costUsd: 0.42,
  isFreeTier: false,
}

const activityEntry = { type: 'coding', cost: 1.5, turns: 12, oneShotRate: 66.7 }

const projectEntry = {
  path: '/Users/dev/burn-watch',
  cost: 3.2,
  avgPerSession: 0.8,
  sessions: 4,
  overheadK: 12.5,
}

const sessionEntry = { date: '2026-11-05', project: 'burn-watch', cost: 0.9, calls: 31 }

const enrichment = {
  date: '2026-11-05',
  sessionCount: 4,
  callCount: 31,
  cacheHitRate: 92.1,
  writtenTokens: 4200,
  activityBreakdown: [activityEntry],
  projectBreakdown: [projectEntry],
  topSessions: [sessionEntry],
  toolUsage: { Read: 10, Edit: 4 },
  shellUsage: { git: 6 },
  mcpUsage: { neon: 2 },
}

const payload = {
  deviceId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  date: '2026-11-05',
  events: [usageEvent],
  enrichment,
}

describe('AgentNameSchema', () => {
  it('accepts every agent the collectors can report', () => {
    for (const agent of ['claude', 'qwen', 'gemini', 'codex', 'copilot']) {
      expect(AgentNameSchema.safeParse(agent).success).toBe(true)
    }
  })

  it('rejects an agent outside the enum', () => {
    expect(AgentNameSchema.safeParse('cursor').success).toBe(false)
  })
})

describe('UsageEventSchema', () => {
  it('accepts a complete event', () => {
    expect(UsageEventSchema.safeParse(usageEvent).success).toBe(true)
  })

  it('rejects a date that is not YYYY-MM-DD', () => {
    // ccusage is fed `--since 20261105`, so a collector leaking that format
    // straight through is the realistic way this field goes wrong.
    expect(UsageEventSchema.safeParse({ ...usageEvent, date: '20261105' }).success).toBe(false)
  })

  it('rejects a negative cost', () => {
    expect(UsageEventSchema.safeParse({ ...usageEvent, costUsd: -1 }).success).toBe(false)
  })

  it('rejects fractional token counts', () => {
    expect(UsageEventSchema.safeParse({ ...usageEvent, totalTokens: 10.5 }).success).toBe(false)
  })

  it('rejects an empty model name', () => {
    expect(UsageEventSchema.safeParse({ ...usageEvent, modelName: '' }).success).toBe(false)
  })
})

describe('ActivityEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(ActivityEntrySchema.safeParse(activityEntry).success).toBe(true)
  })

  it('rejects a one-shot rate above 100', () => {
    expect(ActivityEntrySchema.safeParse({ ...activityEntry, oneShotRate: 101 }).success).toBe(false)
  })
})

describe('ProjectEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(ProjectEntrySchema.safeParse(projectEntry).success).toBe(true)
  })

  it('rejects an empty path', () => {
    expect(ProjectEntrySchema.safeParse({ ...projectEntry, path: '' }).success).toBe(false)
  })
})

describe('SessionEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(SessionEntrySchema.safeParse(sessionEntry).success).toBe(true)
  })

  it('rejects a non-integer call count', () => {
    expect(SessionEntrySchema.safeParse({ ...sessionEntry, calls: 1.5 }).success).toBe(false)
  })
})

describe('ClaudeEnrichmentSchema', () => {
  it('accepts a full enrichment block', () => {
    expect(ClaudeEnrichmentSchema.safeParse(enrichment).success).toBe(true)
  })

  it('rejects a cache hit rate above 100', () => {
    expect(ClaudeEnrichmentSchema.safeParse({ ...enrichment, cacheHitRate: 120 }).success).toBe(false)
  })

  it('rejects non-numeric tool usage counts', () => {
    expect(
      ClaudeEnrichmentSchema.safeParse({ ...enrichment, toolUsage: { Read: 'many' } }).success,
    ).toBe(false)
  })
})

describe('UsagePayloadSchema', () => {
  it('accepts a payload with enrichment', () => {
    expect(UsagePayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('accepts a null enrichment, which is what every non-Claude agent sends', () => {
    expect(UsagePayloadSchema.safeParse({ ...payload, enrichment: null }).success).toBe(true)
  })

  it('rejects a deviceId that is not a uuid', () => {
    expect(UsagePayloadSchema.safeParse({ ...payload, deviceId: 'device-1' }).success).toBe(false)
  })

  it('rejects more than 500 events', () => {
    const events = Array.from({ length: 501 }, () => usageEvent)
    expect(UsagePayloadSchema.safeParse({ ...payload, events }).success).toBe(false)
  })

  it('accepts exactly 500 events', () => {
    const events = Array.from({ length: 500 }, () => usageEvent)
    expect(UsagePayloadSchema.safeParse({ ...payload, events }).success).toBe(true)
  })
})

describe('RegisterDeviceSchema', () => {
  it('accepts a valid registration', () => {
    expect(
      RegisterDeviceSchema.safeParse({
        email: 'dev@example.com',
        hostname: 'laptop.local',
        platform: 'darwin',
        agentVersion: '0.1.0',
      }).success,
    ).toBe(true)
  })

  it('rejects a malformed email', () => {
    expect(
      RegisterDeviceSchema.safeParse({
        email: 'not-an-email',
        hostname: 'laptop.local',
        platform: 'darwin',
        agentVersion: '0.1.0',
      }).success,
    ).toBe(false)
  })
})

describe('VerifyDeviceSchema', () => {
  const valid = { pendingId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', code: 'A1B2C3' }

  it('accepts a six-character uppercase code', () => {
    expect(VerifyDeviceSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a lowercase code', () => {
    expect(VerifyDeviceSchema.safeParse({ ...valid, code: 'a1b2c3' }).success).toBe(false)
  })

  it('rejects a code of the wrong length', () => {
    expect(VerifyDeviceSchema.safeParse({ ...valid, code: 'A1B2C' }).success).toBe(false)
  })
})
