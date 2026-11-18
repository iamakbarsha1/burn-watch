import { describe, it, expect } from 'vitest'
import { viewerScope, type JwtPayload } from './jwt.js'

const as = (role: string) => ({ userId: 'u1', orgId: 'o1', role }) as unknown as JwtPayload

// The manager case reads team rows, so it lives in routes.test.ts, which has the store fake.
describe('viewerScope', () => {
  it('lets an admin read the whole org', async () => {
    expect(await viewerScope(as('admin'))).toBeUndefined()
  })
  it('limits a developer to their own user', async () => {
    expect(await viewerScope(as('developer'))).toEqual(['u1'])
  })
})
