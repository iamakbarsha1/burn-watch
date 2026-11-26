import { z } from 'zod'
import type { FastifyReply } from 'fastify'
import { MIN_GROUP_SIZE } from '@burn-watch/shared'
import type { ScopeRefusal } from '../../plugins/jwt.js'

export const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const dateString = () => z.string().regex(dateRegex)

/** `from`/`to`, shared by every dashboard route that accepts a date range. */
export const dateRangeFields = {
  from: dateString().optional(),
  to: dateString().optional(),
}

/**
 * Raw (pre-refine) `date`/`from`/`to` shape. Spread this into a route's own
 * `z.object({...})` when it needs extra fields, before applying its own
 * `.refine`.
 */
export const dateQueryShape = {
  date: dateString().optional(),
  ...dateRangeFields,
}

/** Narrows a read to one team. Overview and trends take it. */
export const teamIdField = { teamId: z.string().uuid().optional() }

export const isRefusal = (scope: unknown): scope is ScopeRefusal => scope === 403 || scope === 404 || scope === 'too_small'

/** Answers a readScope refusal. `group_too_small` is the code the dashboard looks for. */
export const refuse = (reply: FastifyReply, scope: ScopeRefusal) =>
  scope === 'too_small'
    ? reply.status(403).send({ error: 'group_too_small', minGroupSize: MIN_GROUP_SIZE })
    : reply.status(scope).send({ error: scope === 404 ? 'Team not found' : 'Not allowed to read this team' })

/**
 * `date`/`from`/`to`, refined so a request carries either a single date or a
 * complete range. Overview, activity, and projects take exactly this shape;
 * trends composes `dateQueryShape` / `dateRangeFields` instead
 * because it adds its own fields and its own refine message.
 */
export const dateQuerySchema = z
  .object(dateQueryShape)
  .refine((d) => d.date || (d.from && d.to), { message: 'Provide date or from+to' })
