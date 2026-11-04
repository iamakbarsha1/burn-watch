import { buildServer } from './build-server.js'

// No top-level await anywhere in this module. Vercel's Node adapter imports the
// entrypoint and expects it to settle immediately; awaiting `listen` here left
// the function exiting at init with nothing in the logs. This is the shape the
// Fastify deployment docs show.
const server = buildServer()

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const port = Number(process.env.PORT) || 3001
server.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
})

// The adapter looks for a server or function on the default export.
export default server
