import { describe, it, expect } from 'vitest'
import { AUDIENCE, FIELD_GROUPS, audienceOf, schemaFields } from './transparency'
import { HelpVolunteerSchema, UsagePayloadSchema } from '@burn-watch/shared'

const fields = FIELD_GROUPS.flatMap((g) => g.fields)

describe('transparency field list', () => {
  it('walks nested schemas, including R0.3 fields', () => {
    const paths = schemaFields(UsagePayloadSchema).map((f) => f.path)
    expect(paths).toContain('events[].modelName')
    expect(paths).toContain('events[].unpriced')
    expect(paths).toContain('enrichment.projectBreakdown[].remote')
    expect(paths).toContain('enrichment.projectBreakdown[].branches[].name')
    expect(paths).toContain('enrichment.accountHashes')
    expect(paths).toContain('agentVersion')
    // Entries the agent never fills are listed once, not walked.
    expect(paths.some((p) => p.startsWith('enrichment.topSessions[]'))).toBe(false)
  })

  it('has a description for every field', () => {
    for (const f of fields) expect(f.description, f.path).toBeTruthy()
  })

  it('has an audience for every field that is not a group', () => {
    for (const f of fields) if (!f.group) expect(audienceOf(f.path), f.path).toBeDefined()
  })

  it('has no audience entry for a field that no longer exists', () => {
    const paths = new Set(fields.map((f) => f.path))
    for (const key of Object.keys(AUDIENCE)) expect(paths.has(key), key).toBe(true)
  })

  it('inherits only through array elements', () => {
    expect(audienceOf('events[].costUsd')).toBe('scoped')
    expect(audienceOf('enrichment.projectBreakdown[].branches[].cost')).toBe('scoped')
    expect(audienceOf('nope')).toBeUndefined()
    expect(audienceOf('enrichment.newField')).toBeUndefined()
  })

  it('marks the fields Adoption (A5 to A7) reads as visible to the viewer scope', () => {
    for (const f of ['skillCounts', 'sidechainMessages', 'permissionModeCounts', 'entrypointCounts', 'toolUsage', 'mcpUsage']) {
      expect(audienceOf(`enrichment.${f}`), f).toBe('scoped')
    }
  })

  it('marks the fields only My usage shows as visible to you alone', () => {
    expect(audienceOf('enrichment.sessionCount')).toBe('self')
  })

  it('lists the help flag under its schema key, visible to the viewer scope', () => {
    const mine = FIELD_GROUPS.find((g) => g.title === 'What you choose on My usage')!.fields.map((f) => f.path)
    expect(mine).toEqual(Object.keys(HelpVolunteerSchema.shape))
    expect(audienceOf('helpVolunteer')).toBe('scoped')
  })
})
