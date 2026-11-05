// Vercel entrypoint for the API.
//
// This deliberately does NOT use Vercel's Fastify framework preset. That preset
// is what broke every deploy attempt on 2026-11-05: it fails with
// INTERNAL_FUNCTION_INVOCATION_FAILED and zero log output, right down to a
// five-line Fastify app with no dependencies. A plain @vercel/node function on
// the same account serves 200, and so does Fastify behind one. See BW-08.
//
// `.mjs` on purpose: the root package.json has no "type": "module", and adding
// one would change how every other workspace resolves.
import Fastify from 'fastify'
import { configureServer } from '../apps/api/dist/src/build-server.js'

// Module scope, so a warm instance reuses the instance, its Neon pool and its
// Redis connection instead of rebuilding them per request (BW-06).
const app = configureServer(Fastify({ logger: true }))
const ready = app.ready()

export default async function handler(req, res) {
  await ready
  app.server.emit('request', req, res)
}
