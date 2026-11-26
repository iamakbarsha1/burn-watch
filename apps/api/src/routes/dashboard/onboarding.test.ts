import { describe, it, expect } from 'vitest'
import { addDays, type IsoDate } from '@burn-watch/db'
import { countOnboarding, onboardingOf } from './onboarding.js'

const START = '2026-11-01' as IsoDate
const day = (n: number) => addDays(START, n - 1)
const DONE = day(20)
const both = { date: day(1), mcpUsage: { github: 1 }, toolUsage: { skill: 1 } }
const active = (...ns: number[]) => ns.map(day)

describe('onboardingOf', () => {
  it('onboards with 2 days each week and 2 features', () => {
    const r = onboardingOf(START, active(1, 2, 8, 9), [both], DONE)
    expect(r).toEqual({ state: 'onboarded', activeWeek1: 2, activeWeek2: 2, features: ['mcp', 'skills'], dayOfWindow: 14 })
  })

  it('puts day 7 in week 1 and day 8 in week 2', () => {
    expect(onboardingOf(START, active(1, 7, 8), [both], DONE)).toMatchObject({ activeWeek1: 2, activeWeek2: 1, state: 'windowEnded' })
    expect(onboardingOf(START, active(1, 7, 8, 14), [both], DONE).state).toBe('onboarded')
  })

  it('misses with 1 active day in either week', () => {
    expect(onboardingOf(START, active(1, 8, 9), [both], DONE).state).toBe('windowEnded')
    expect(onboardingOf(START, active(1, 2, 9), [both], DONE).state).toBe('windowEnded')
  })

  it('counts day 14 and not day 15 or the day before the first sync', () => {
    expect(onboardingOf(START, active(0, 1, 2, 8, 15), [both], DONE)).toMatchObject({ activeWeek1: 2, activeWeek2: 1 })
    expect(onboardingOf(START, active(1, 2, 8, 14), [both], DONE).state).toBe('onboarded')
  })

  it('needs 2 features, counts SDK when known, and ignores features outside the window', () => {
    const one = { date: day(1), mcpUsage: { github: 1 } }
    expect(onboardingOf(START, active(1, 2, 8, 9), [one], DONE).state).toBe('windowEnded')
    const sdk = { date: day(3), entrypointCounts: { 'sdk-ts': 1 } }
    expect(onboardingOf(START, active(1, 2, 8, 9), [one, sdk], DONE)).toMatchObject({ state: 'onboarded', features: ['mcp', 'sdk'] })
    const late = { date: day(15), toolUsage: { skill: 1 } }
    expect(onboardingOf(START, active(1, 2, 8, 9), [one, late], DONE).features).toEqual(['mcp'])
  })

  it('onboards early, before the window ends', () => {
    expect(onboardingOf(START, active(1, 2, 8, 9), [both], day(9))).toMatchObject({ state: 'onboarded', dayOfWindow: 9 })
  })

  it('is in progress until day 14 is synced, then the window ends', () => {
    expect(onboardingOf(START, active(1), [both], day(13)).state).toBe('inProgress')
    expect(onboardingOf(START, active(1), [both], day(14)).state).toBe('windowEnded')
    // First sync today: the last synced day is before it.
    expect(onboardingOf(START, active(1), [both], day(0))).toMatchObject({ state: 'inProgress', dayOfWindow: 1 })
  })

  it('has no feature data without a Claude Code day in the window, even with tokens', () => {
    expect(onboardingOf(START, active(1, 2, 8, 9), [{ ...both, date: day(15) }], DONE).state).toBe('noFeatureData')
  })
})

describe('countOnboarding', () => {
  it('counts each state', () => {
    const states = ['onboarded', 'windowEnded', 'windowEnded', 'inProgress', 'noFeatureData'] as const
    expect(countOnboarding(states.map((state) => ({ state })))).toEqual({
      cohort: 5, onboarded: 1, windowEnded: 2, inProgress: 1, noFeatureData: 1,
    })
  })
})
