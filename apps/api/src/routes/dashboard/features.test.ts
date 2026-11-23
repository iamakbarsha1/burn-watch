import { describe, it, expect } from 'vitest'
import { countFeatures, featureDays, featureFlags } from './features.js'

describe('featureFlags', () => {
  it('reads nothing as nothing, and SDK as unknown on a pre-0.4.0 day', () => {
    expect(featureFlags({})).toEqual({ mcp: false, skills: false, subagents: false, plan: false, sdk: null })
    expect(featureFlags({ toolUsage: null, mcpUsage: null, entrypointCounts: null }).sdk).toBeNull()
  })

  it('finds each feature from the tool calls every agent sends', () => {
    expect(featureFlags({ mcpUsage: { github: 3 } }).mcp).toBe(true)
    expect(featureFlags({ toolUsage: { skill: 1 } }).skills).toBe(true)
    expect(featureFlags({ toolUsage: { agent: 2 } }).subagents).toBe(true)
    expect(featureFlags({ toolUsage: { task: 1 } }).subagents).toBe(true)
    expect(featureFlags({ toolUsage: { exitplanmode: 1 } }).plan).toBe(true)
    expect(featureFlags({ toolUsage: { enterplanmode: 1 } }).plan).toBe(true)
  })

  it('finds each feature from the 0.4.0 fields alone', () => {
    expect(featureFlags({ skillCounts: { 'pr-review': 4 } }).skills).toBe(true)
    expect(featureFlags({ sidechainMessages: 7 }).subagents).toBe(true)
    expect(featureFlags({ permissionModeCounts: { plan: 1, default: 9 } }).plan).toBe(true)
  })

  it('ignores zero counts and unrelated tools', () => {
    const flags = featureFlags({
      toolUsage: { read: 40, skill: 0, Skill: 3 },
      mcpUsage: { github: 0 },
      sidechainMessages: 0,
      permissionModeCounts: { bypassPermissions: 5 },
    })
    expect(flags).toEqual({ mcp: false, skills: false, subagents: false, plan: false, sdk: null })
  })

  it('counts SDK only for an entry point other than the CLI', () => {
    expect(featureFlags({ entrypointCounts: { cli: 10 } }).sdk).toBe(false)
    expect(featureFlags({ entrypointCounts: { cli: 10, 'sdk-ts': 1 } }).sdk).toBe(true)
    expect(featureFlags({ entrypointCounts: {} }).sdk).toBe(false)
  })
})

describe('featureDays', () => {
  it('counts days per feature and keeps SDK null with no 0.4.0 day', () => {
    expect(featureDays([{ toolUsage: { skill: 2 } }, { toolUsage: { skill: 1 }, mcpUsage: { x: 1 } }, {}])).toEqual({
      mcp: 1,
      skills: 2,
      subagents: 0,
      plan: 0,
      sdk: null,
    })
  })

  it('counts SDK days only over days that know the entry point', () => {
    const days = featureDays([{}, { entrypointCounts: { cli: 1 } }, { entrypointCounts: { 'sdk-py': 1 } }])
    expect(days.sdk).toBe(1)
    expect(featureDays([{}, { entrypointCounts: { cli: 1 } }]).sdk).toBe(0)
  })
})

describe('countFeatures', () => {
  const p = (days: Partial<Record<string, number | null>>) => ({
    days: { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: null, ...days },
  })

  it('counts a person once per feature used on at least one day, and SDK-known people', () => {
    expect(countFeatures([p({ mcp: 3, sdk: 0 }), p({ mcp: 1, skills: 2, sdk: 1 }), p({})])).toEqual({
      users: 3,
      used: { mcp: 2, skills: 1, subagents: 0, plan: 0, sdk: 1 },
      sdkKnown: 2,
    })
  })

  it('handles nobody', () => {
    expect(countFeatures([])).toEqual({
      users: 0,
      used: { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: 0 },
      sdkKnown: 0,
    })
  })
})
