import { randomUUID } from 'node:crypto'

export type OrgId = string & { readonly __brand: 'OrgId' }
export type UserId = string & { readonly __brand: 'UserId' }
export type DeviceId = string & { readonly __brand: 'DeviceId' }
/** `${userId}:${date}`, the _id of every one-per-user-day document. */
export type DayKey = string & { readonly __brand: 'DayKey' }
/**
 * `${orgId}:${provider}`, the _id of an org's connection to one provider.
 *
 * Postgres spelled this as a unique index over (org_id, provider), added after
 * two admins connecting at once raced into two rows. As an _id the constraint
 * cannot be dropped, misnamed, or missed by a sync that never ran.
 */
export type IntegrationKey = string & { readonly __brand: 'IntegrationKey' }
/** YYYY-MM-DD. Lexicographic order is date order, so range filters work on the string. */
export type IsoDate = string & { readonly __brand: 'IsoDate' }
/** Integer micro-dollars. numeric(12,6) has six decimals, so this encoding is lossless. */
export type Micros = number & { readonly __brand: 'Micros' }

/** Same shape as the Postgres uuids, so ids embedded in live device tokens stay valid. */
export const newId = <T extends string>(): T => randomUUID() as T

export const dayKey = (userId: UserId, date: IsoDate): DayKey => `${userId}:${date}` as DayKey

export const integrationKey = (orgId: OrgId, provider: string): IntegrationKey =>
  `${orgId}:${provider}` as IntegrationKey

export const microsFromUsd = (usd: number): Micros => Math.round(usd * 1e6) as Micros

/**
 * The inverse, for the HTTP boundary only. Everything below a route handler
 * stays in micros: dividing early reintroduces exactly the binary fractions
 * the integer encoding exists to avoid, and a cost that has been through a
 * float round trip no longer sums to the same total.
 */
export const usdFromMicros = (micros: Micros): number => micros / 1e6
