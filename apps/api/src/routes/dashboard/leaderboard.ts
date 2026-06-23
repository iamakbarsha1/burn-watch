import type { FastifyInstance } from 'fastify'
import { eq, and, desc, sql, gte, lte, sum } from 'drizzle-orm'
import { z } from 'zod'
import { dailySnapshots, users } from '../../../drizzle/schema.js'
import type { LeaderboardEntry } from '@burn-watch/shared'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  date: z.string().regex(dateRegex).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/leaderboard',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { limit, offset } = parsed.data
      const fromDate = parsed.data.date ?? parsed.data.from!
      const toDate = parsed.data.date ?? parsed.data.to!

      const cacheKey = `bw:leaderboard:${orgId}:${fromDate}:${toDate}:${limit}:${offset}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          userId: dailySnapshots.userId,
          name: users.name,
          email: users.email,
          claudeTokens: sum(dailySnapshots.claudeTokens).mapWith(Number),
          claudeCostUsd: sum(dailySnapshots.claudeCostUsd).mapWith(Number),
          qwenTokens: sum(dailySnapshots.qwenTokens).mapWith(Number),
          qwenCostUsd: sum(dailySnapshots.qwenCostUsd).mapWith(Number),
          geminiTokens: sum(dailySnapshots.geminiTokens).mapWith(Number),
          geminiCostUsd: sum(dailySnapshots.geminiCostUsd).mapWith(Number),
          codexTokens: sum(dailySnapshots.codexTokens).mapWith(Number),
          codexCostUsd: sum(dailySnapshots.codexCostUsd).mapWith(Number),
          copilotTokens: sum(dailySnapshots.copilotTokens).mapWith(Number),
          copilotCostUsd: sum(dailySnapshots.copilotCostUsd).mapWith(Number),
          totalCostUsd: sum(dailySnapshots.totalCostUsd).mapWith(Number),
          totalTokens: sum(dailySnapshots.totalTokens).mapWith(Number),
          sessionCount: sum(dailySnapshots.sessionCount).mapWith(Number),
          cacheHitRate: sql<number | null>`null`,
        })
        .from(dailySnapshots)
        .innerJoin(users, eq(dailySnapshots.userId, users.id))
        .where(
          and(eq(dailySnapshots.orgId, orgId), gte(dailySnapshots.date, fromDate), lte(dailySnapshots.date, toDate)),
        )
        .groupBy(dailySnapshots.userId, users.name, users.email)
        .orderBy(desc(sum(dailySnapshots.totalCostUsd)))
        .limit(limit)
        .offset(offset)

      const result: LeaderboardEntry[] = rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        claude: { tokens: r.claudeTokens ?? 0, costUsd: r.claudeCostUsd ?? 0 },
        qwen: { tokens: r.qwenTokens ?? 0, costUsd: r.qwenCostUsd ?? 0 },
        gemini: { tokens: r.geminiTokens ?? 0, costUsd: r.geminiCostUsd ?? 0 },
        codex: { tokens: r.codexTokens ?? 0, costUsd: r.codexCostUsd ?? 0 },
        copilot: { tokens: r.copilotTokens ?? 0, costUsd: r.copilotCostUsd ?? 0 },
        totalCostUsd: r.totalCostUsd ?? 0,
        totalTokens: r.totalTokens ?? 0,
        sessions: r.sessionCount ?? 0,
        cacheHitRate: r.cacheHitRate,
      }))

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
