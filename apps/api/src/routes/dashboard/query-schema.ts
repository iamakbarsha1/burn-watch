import { z } from 'zod'

export const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const dateString = () => z.string().regex(dateRegex)

/** `from`/`to`, shared by every dashboard route that accepts a date range. */
export const dateRangeFields = {
  from: dateString().optional(),
  to: dateString().optional(),
}

/**
 * Raw (pre-refine) `date`/`from`/`to` shape. Spread this into a route's own
 * `z.object({...})` when it needs extra fields — leaderboard's `limit`/
 * `offset` — before applying its own `.refine`.
 */
export const dateQueryShape = {
  date: dateString().optional(),
  ...dateRangeFields,
}

/**
 * `date`/`from`/`to`, refined so a request carries either a single date or a
 * complete range. Overview, activity, and projects take exactly this shape;
 * leaderboard and trends compose `dateQueryShape` / `dateRangeFields` instead
 * because each adds its own fields and its own refine message.
 */
export const dateQuerySchema = z
  .object(dateQueryShape)
  .refine((d) => d.date || (d.from && d.to), { message: 'Provide date or from+to' })
