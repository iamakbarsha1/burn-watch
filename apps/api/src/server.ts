import { buildServer } from './app.js'

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
