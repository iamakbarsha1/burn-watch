import { describe, it, expect } from 'vitest'
import { viewerScope, type JwtPayload } from './jwt.js'

const as = (role: string) => ({ userId: 'u1', orgId: 'o1', role }) as unknown as JwtPayload

describe('viewerScope', () => {
  it('lets an admin read the whole org', () => {
    expect(viewerScope(as('admin'))).toBeUndefined()
  })
  it.each(['developer', 'manager'])('limits %s to their own user', (role) => {
    expect(viewerScope(as(role))).toBe('u1')
  })
})
