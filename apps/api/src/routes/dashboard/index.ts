import type { FastifyInstance } from 'fastify'
import { overviewRoutes } from './overview.js'
import { leaderboardRoutes } from './leaderboard.js'
import { trendsRoutes } from './trends.js'
import { activityRoutes } from './activity.js'
import { projectsRoutes } from './projects.js'

export async function dashboardRoutes(fastify: FastifyInstance) {
  await fastify.register(overviewRoutes)
  await fastify.register(leaderboardRoutes)
  await fastify.register(trendsRoutes)
  await fastify.register(activityRoutes)
  await fastify.register(projectsRoutes)
}
