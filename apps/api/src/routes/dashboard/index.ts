import type { FastifyInstance } from 'fastify'
import { requireDashboardAuth } from '../../plugins/jwt.js'
import { overviewRoutes } from './overview.js'
import { leaderboardRoutes } from './leaderboard.js'
import { trendsRoutes } from './trends.js'
import { activityRoutes } from './activity.js'
import { projectsRoutes } from './projects.js'
import { budgetAlertsRoutes } from './budget-alerts.js'
import { teamsRoutes } from './teams.js'
import { seatsRoutes } from './seats.js'
import { governanceRoutes } from './governance.js'
import { adoptionRoutes } from './adoption.js'

export async function dashboardRoutes(fastify: FastifyInstance) {
  // All dashboard routes require authenticated user
  fastify.addHook('preHandler', requireDashboardAuth(fastify))

  await fastify.register(overviewRoutes)
  await fastify.register(leaderboardRoutes)
  await fastify.register(trendsRoutes)
  await fastify.register(activityRoutes)
  await fastify.register(projectsRoutes)
  await fastify.register(budgetAlertsRoutes)
  await fastify.register(teamsRoutes)
  await fastify.register(seatsRoutes)
  await fastify.register(governanceRoutes)
  await fastify.register(adoptionRoutes)
}
