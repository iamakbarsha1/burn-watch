import { describe, it, expect } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { callerAddress } from './caller-address.js'

const request = (headers: Record<string, string | string[]>, ip = '127.0.0.1') =>
  ({ headers, ip }) as unknown as FastifyRequest

describe('callerAddress', () => {
  it('counts against the caller, not the Vercel proxy that relayed them', () => {
    expect(callerAddress(request({ 'x-vercel-forwarded-for': '27.5.141.208' }))).toBe('27.5.141.208')
  })

  it('ignores x-forwarded-for, which a client can set to anything', () => {
    const req = request({ 'x-forwarded-for': '1.1.1.1', 'x-vercel-forwarded-for': '27.5.141.208' })
    expect(callerAddress(req)).toBe('27.5.141.208')
  })

  it('takes the original client from a relay chain', () => {
    expect(callerAddress(request({ 'x-vercel-forwarded-for': '27.5.141.208, 10.0.0.1' }))).toBe(
      '27.5.141.208',
    )
  })

  it('falls back to the socket peer off-platform', () => {
    expect(callerAddress(request({}, '192.168.1.5'))).toBe('192.168.1.5')
    expect(callerAddress(request({ 'x-vercel-forwarded-for': '' }, '192.168.1.5'))).toBe('192.168.1.5')
  })
})
