import { buildServer } from './build-server.js'

const server = await buildServer()

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const port = Number(process.env.PORT) || 3001
await server.listen({ port, host: '0.0.0.0' })

// Vercel's Node adapter imports this module and looks for a server or function
// on the default export; without one it exits with "Invalid export found in
// module". The `listen` above is what the Fastify docs show and is what local
// dev uses, so both shapes are satisfied.
export default server
