import type { FastifyInstance } from 'fastify'
import { eq, and, desc } from 'drizzle-orm'
import { dailySnapshots, users } from '../../../drizzle/schema.js'
import type { LeaderboardEntry } from '@burn-watch/shared'

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string } }>(
    '/leaderboard',
    async (request, reply) => {
      const orgId = request.user.orgId
      const { date } = request.query
      if (!date) {
        return reply.status(400).send({ error: 'date is required' })
      }

      const cacheKey = `bw:leaderboard:${orgId}:${date}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          userId: dailySnapshots.userId,
          name: users.name,
          email: users.email,
          claudeTokens: dailySnapshots.claudeTokens,
          claudeCostUsd: dailySnapshots.claudeCostUsd,
          qwenTokens: dailySnapshots.qwenTokens,
          qwenCostUsd: dailySnapshots.qwenCostUsd,
          geminiTokens: dailySnapshots.geminiTokens,
          geminiCostUsd: dailySnapshots.geminiCostUsd,
          codexTokens: dailySnapshots.codexTokens,
          codexCostUsd: dailySnapshots.codexCostUsd,
          copilotTokens: dailySnapshots.copilotTokens,
          copilotCostUsd: dailySnapshots.copilotCostUsd,
          totalCostUsd: dailySnapshots.totalCostUsd,
          totalTokens: dailySnapshots.totalTokens,
          sessionCount: dailySnapshots.sessionCount,
          cacheHitRate: dailySnapshots.cacheHitRate,
        })
        .from(dailySnapshots)
        .innerJoin(users, eq(dailySnapshots.userId, users.id))
        .where(
          and(eq(dailySnapshots.orgId, orgId), eq(dailySnapshots.date, date)),
        )
        .orderBy(desc(dailySnapshots.totalCostUsd))

      const result: LeaderboardEntry[] = rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        claude: { tokens: r.claudeTokens, costUsd: Number(r.claudeCostUsd) },
        qwen: { tokens: r.qwenTokens, costUsd: Number(r.qwenCostUsd) },
        gemini: { tokens: r.geminiTokens, costUsd: Number(r.geminiCostUsd) },
        codex: { tokens: r.codexTokens, costUsd: Number(r.codexCostUsd) },
        copilot: { tokens: r.copilotTokens, costUsd: Number(r.copilotCostUsd) },
        totalCostUsd: Number(r.totalCostUsd),
        totalTokens: r.totalTokens,
        sessions: r.sessionCount,
        cacheHitRate: r.cacheHitRate ? Number(r.cacheHitRate) : null,
      }))

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
