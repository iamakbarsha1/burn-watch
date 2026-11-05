import type { FastifyRequest } from 'fastify'

/**
 * Who to count a rate-limited request against.
 *
 * `request.ip` is the socket's peer, and behind Vercel that is the platform's
 * own proxy — every caller in the world arrives as 127.0.0.1, so a single
 * counter would cover all of them and one noisy client could lock out the
 * company. `x-vercel-forwarded-for` is written by the platform on every
 * request and cannot be forged from outside, unlike `x-forwarded-for`, which
 * would let an attacker mint a fresh identity per request and never be
 * limited. Falls back to `request.ip` off-platform, where it is the real peer.
 */
export function callerAddress(request: FastifyRequest): string {
  const header = request.headers['x-vercel-forwarded-for']
  const value = Array.isArray(header) ? header[0] : header
  return value?.split(',')[0]?.trim() || request.ip
}
