import type { Document } from 'mongodb'
import type { AgentName } from '@burn-watch/shared'
import type { SeatDoc } from './documents.js'
import { seatKey, type IsoDate, type Micros, type OrgId, type SeatKey, type UserId } from './ids.js'
import type { Store } from './store.js'

const DAY_MS = 86_400_000
const dayNumber = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`) / DAY_MS

export const addDays = (d: IsoDate, n: number): IsoDate =>
  new Date((dayNumber(d) + n) * DAY_MS).toISOString().slice(0, 10) as IsoDate

/**
 * One seat's cost over [from, to], prorated by day. The daily rate is
 * monthly × 12 ÷ 365, so a year of seat costs twelve months of price. Days
 * before the start date or after today cost nothing, so "All time" from 2020
 * does not bill years that never happened.
 */
export function seatCost(
  seat: Pick<SeatDoc, 'monthlyPriceMicros' | 'startDate'>,
  from: IsoDate,
  to: IsoDate,
  today: IsoDate,
): Micros {
  const lo = from > seat.startDate ? from : seat.startDate
  const hi = to < today ? to : today
  const days = hi >= lo ? dayNumber(hi) - dayNumber(lo) + 1 : 0
  // Multiply before dividing so whole-year spans land on whole micros.
  return Math.round((seat.monthlyPriceMicros * 12 * days) / 365) as Micros
}

/** Every seated (user, agent) pair in the org. */
export async function seatedKeys(store: Store, orgId: OrgId): Promise<Set<SeatKey>> {
  const seats = await store.seats.find({ orgId }, { projection: { _id: 1 } })
  return new Set(seats.map((s) => s._id))
}

/** (user, agent) pairs with any tokens in [from, to], as seat keys. */
export function activePairsPipeline(orgId: OrgId, userIds: UserId[], from: IsoDate, to: IsoDate): Document[] {
  return [
    { $match: { orgId, userId: { $in: userIds }, date: { $gte: from, $lte: to } } },
    { $project: { userId: 1, entries: { $objectToArray: { $ifNull: ['$byAgent', {}] } } } },
    { $unwind: '$entries' },
    { $match: { 'entries.v.tokens': { $gt: 0 } } },
    { $group: { _id: { $concat: ['$userId', ':', '$entries.k'] } } },
  ]
}

/**
 * Seats in scope with no tokens on their own agent in the last `idleDays`
 * days, today included. A seat younger than the window is skipped: it has not
 * had the chance to be idle yet.
 */
export async function idleSeats(
  store: Store,
  orgId: OrgId,
  userId: UserId | null,
  agent: AgentName | null,
  idleDays: number,
  date: IsoDate,
): Promise<SeatDoc[]> {
  const from = addDays(date, -(idleDays - 1))
  const seats = await store.seats.find({
    orgId,
    ...(userId && { userId }),
    ...(agent && { agent }),
    startDate: { $lte: from },
  })
  if (seats.length === 0) return []
  const userIds = [...new Set(seats.map((s) => s.userId))]
  const active = await store.dailySnapshots.aggregate<{ _id: SeatKey }>(
    activePairsPipeline(orgId, userIds, from, date),
  )
  const used = new Set(active.map((r) => r._id))
  return seats.filter((s) => !used.has(s._id))
}

/**
 * Last date each (user, agent) pair had tokens, as seat keys. A pair with no
 * tokens ever is absent. Same unwind as `activePairsPipeline`, with no date
 * bound. The group key is a pair, not the joined key, so it cannot pass for
 * an `activePairsPipeline` row.
 */
export async function seatLastUsed(store: Store, orgId: OrgId, userIds: UserId[]): Promise<Map<SeatKey, IsoDate>> {
  if (userIds.length === 0) return new Map()
  const rows = await store.dailySnapshots.aggregate<{ _id: { userId: UserId; agent: string }; lastUsed: IsoDate }>([
    { $match: { orgId, userId: { $in: userIds } } },
    { $project: { userId: 1, date: 1, entries: { $objectToArray: { $ifNull: ['$byAgent', {}] } } } },
    { $unwind: '$entries' },
    { $match: { 'entries.v.tokens': { $gt: 0 } } },
    { $group: { _id: { userId: '$userId', agent: '$entries.k' }, lastUsed: { $max: '$date' } } },
  ])
  return new Map(rows.map((r) => [seatKey(r._id.userId, r._id.agent), r.lastUsed]))
}
