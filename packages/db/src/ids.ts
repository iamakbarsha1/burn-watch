import { randomUUID } from 'node:crypto'

export type OrgId = string & { readonly __brand: 'OrgId' }
export type UserId = string & { readonly __brand: 'UserId' }
export type DeviceId = string & { readonly __brand: 'DeviceId' }
/** `${userId}:${date}`, the _id of every one-per-user-day document. */
export type DayKey = string & { readonly __brand: 'DayKey' }
/** YYYY-MM-DD. Lexicographic order is date order, so range filters work on the string. */
export type IsoDate = string & { readonly __brand: 'IsoDate' }
/** Integer micro-dollars. numeric(12,6) has six decimals, so this encoding is lossless. */
export type Micros = number & { readonly __brand: 'Micros' }

/** Same shape as the Postgres uuids, so ids embedded in live device tokens stay valid. */
export const newId = <T extends string>(): T => randomUUID() as T

export const dayKey = (userId: UserId, date: IsoDate): DayKey => `${userId}:${date}` as DayKey

export const microsFromUsd = (usd: number): Micros => Math.round(usd * 1e6) as Micros
