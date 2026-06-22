import type { FastifyInstance } from 'fastify'
import { eq, and, desc, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dailySnapshots, users } from '../../../drizzle/schema.js'
import type { LeaderboardEntry } from '@burn-watch/shared'

const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string; limit?: string; offset?: string } }>(
    '/leaderboard',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { date, limit, offset } = parsed.data

      const cacheKey = `bw:leaderboard:${orgId}:${date}:${limit}:${offset}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          userId: dailySnapshots.userId,
          name: users.name,
          email: users.email,
          claudeTokens: dailySnapshots.claudeTokens,
          claudeCostUsd: sql<number>`${dailySnapshots.claudeCostUsd}::float`,
          qwenTokens: dailySnapshots.qwenTokens,
          qwenCostUsd: sql<number>`${dailySnapshots.qwenCostUsd}::float`,
          geminiTokens: dailySnapshots.geminiTokens,
          geminiCostUsd: sql<number>`${dailySnapshots.geminiCostUsd}::float`,
          codexTokens: dailySnapshots.codexTokens,
          codexCostUsd: sql<number>`${dailySnapshots.codexCostUsd}::float`,
          copilotTokens: dailySnapshots.copilotTokens,
          copilotCostUsd: sql<number>`${dailySnapshots.copilotCostUsd}::float`,
          totalCostUsd: sql<number>`${dailySnapshots.totalCostUsd}::float`,
          totalTokens: dailySnapshots.totalTokens,
          sessionCount: dailySnapshots.sessionCount,
          cacheHitRate: sql<number | null>`${dailySnapshots.cacheHitRate}::float`,
        })
        .from(dailySnapshots)
        .innerJoin(users, eq(dailySnapshots.userId, users.id))
        .where(
          and(eq(dailySnapshots.orgId, orgId), eq(dailySnapshots.date, date)),
        )
        .orderBy(desc(dailySnapshots.totalCostUsd))
        .limit(limit)
        .offset(offset)

      const result: LeaderboardEntry[] = rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        claude: { tokens: r.claudeTokens, costUsd: r.claudeCostUsd ?? 0 },
        qwen: { tokens: r.qwenTokens, costUsd: r.qwenCostUsd ?? 0 },
        gemini: { tokens: r.geminiTokens, costUsd: r.geminiCostUsd ?? 0 },
        codex: { tokens: r.codexTokens, costUsd: r.codexCostUsd ?? 0 },
        copilot: { tokens: r.copilotTokens, costUsd: r.copilotCostUsd ?? 0 },
        totalCostUsd: r.totalCostUsd ?? 0,
        totalTokens: r.totalTokens,
        sessions: r.sessionCount,
        cacheHitRate: r.cacheHitRate,
      }))

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
