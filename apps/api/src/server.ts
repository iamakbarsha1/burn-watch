// Fastify is imported here, in the entrypoint, on purpose. Vercel's adapter
// scans the entrypoint for a direct fastify import and fails the build with
// "No entrypoint found which imports fastify" if the instance is created in
// another module.
import Fastify from 'fastify'
import { configureServer } from './build-server.js'

// No top-level await: the adapter imports this module and expects it to settle
// immediately.
const server = configureServer(Fastify({ logger: true }))

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const port = Number(process.env.PORT) || 3001
server.listen({ port, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
})

export default server
