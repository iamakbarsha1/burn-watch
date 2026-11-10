import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../../plugins/jwt.js'
import { credentialCrypto } from '../../credential-crypto.js'

process.env.JWT_SECRET ??= 'test-access-secret'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret'

/**
 * Same fake database as `routes/routes.test.ts`: a queue of rows handed back
 * in the order the route asks for them, and a log of what it asked.
 */
const dbState = vi.hoisted(() => ({
  results: [] as unknown[][],
  calls: [] as { op: string; arg: unknown }[],
  failOn: null as string | null,
}))

vi.mock('../../plugins/db.js', async () => {
  const fastifyPlugin = (await import('fastify-plugin')).default

  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
              const next = dbState.results.shift() ?? []
              return Promise.resolve(next).then(onOk, onErr)
            }
          }
          return (...args: unknown[]) => {
            dbState.calls.push({ op: String(prop), arg: args[0] })
            if (dbState.failOn === String(prop)) {
              throw Object.assign(new Error('duplicate key value'), { code: '23505' })
            }
            return chain()
          }
        },
      },
    )

  const DB_METHODS = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'execute',
    'transaction',
    '$with',
    'with',
  ])

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop)
        if (!DB_METHODS.has(name)) return undefined
        if (name === 'transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            dbState.calls.push({ op: 'transaction', arg: undefined })
            try {
              return await fn(db)
            } catch (err) {
              dbState.calls.push({ op: 'rollback', arg: undefined })
              throw err
            }
          }
        }
        return (...args: unknown[]) => {
          dbState.calls.push({ op: name, arg: args[0] })
          return chain()
        }
      },
    },
  )

  return {
    dbPlugin: fastifyPlugin(async (fastify: FastifyInstance) => {
      fastify.decorate('db', db as never)
    }),
  }
})

vi.mock('@fastify/rate-limit', () => ({ default: fp(async () => {}) }))

const { buildServer } = await import('../../build-server.js')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const USER_A = '33333333-3333-4333-8333-333333333333'
const DEVICE_A = '44444444-4444-4444-8444-444444444444'

/** 32 bytes, so `Buffer.from(KEY, 'base64')` round-trips to exactly the key. */
const KEY = Buffer.alloc(32, 7).toString('base64')
/** Decodes to 3 bytes, so it is well-formed base64 of the wrong length. */
const BAD_KEY = 'short'

const TOKEN = 'ghp_averysecrettokenvalue000000000000'
const ORG = 'acme'
const DOWNLOAD = 'https://objects.githubusercontent.com/copilot-report.ndjson'

function sealWith(key: string, plaintext: string): string {
  const crypto = credentialCrypto({ COPILOT_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)
  if (!crypto.available) throw new Error(`test key unusable: ${crypto.reason}`)
  return crypto.seal(plaintext)
}

function openWith(key: string, sealed: string): string {
  const crypto = credentialCrypto({ COPILOT_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)
  if (!crypto.available) throw new Error(`test key unusable: ${crypto.reason}`)
  return crypto.open(sealed)
}

/** Yesterday in UTC, derived the same way the route derives its default. */
function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** What GitHub is pretending to be for one test. No request leaves the process. */
const github = {
  seatsStatus: 200,
  seatsBody: { total_seats: 0, seats: [] as unknown[] },
  reportStatus: 200,
  downloadLinks: [] as string[],
  ndjson: '',
  requests: [] as { url: string; authorization: string | undefined }[],
}

function response(status: number, body: unknown, text?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  } as Response
}

const fetchStub = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(input)
  github.requests.push({ url, authorization: init?.headers?.Authorization })

  if (url.includes('/copilot/billing/seats')) {
    return response(github.seatsStatus, github.seatsBody, 'github says no')
  }
  if (url.includes('/copilot/metrics/reports/users-1-day')) {
    return response(github.reportStatus, { download_links: github.downloadLinks })
  }
  if (url.startsWith(DOWNLOAD)) {
    return response(200, null, github.ndjson)
  }
  throw new Error(`unexpected fetch in test: ${url}`)
})

const userDayLine = (login: string, day: string, input = 100, output = 50, credits = 3) =>
  JSON.stringify({
    user_login: login,
    day,
    totals_by_client: [{ token_usage: { prompt_tokens_sum: input, output_tokens_sum: output } }],
    ai_credits_used: credits,
  })

const seat = (login: string) => ({
  assignee: { login },
  plan_type: 'business',
  created_at: '2026-01-01T00:00:00Z',
  last_activity_at: null,
  last_activity_editor: null,
  pending_cancellation_date: null,
})

let app: FastifyInstance

const token = (over: Partial<JwtPayload> = {}) =>
  app.jwt.access.sign({ userId: USER_A, orgId: ORG_A, role: 'admin', ...over } as JwtPayload)

const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const admin = () => auth(token())

const STATUS_URL = '/v1/integrations/copilot/status'
const CONNECTION_URL = '/v1/integrations/copilot/connection'
const SYNC_URL = '/v1/integrations/copilot/sync'

beforeEach(async () => {
  dbState.results = []
  dbState.calls = []
  dbState.failOn = null

  github.seatsStatus = 200
  github.seatsBody = { total_seats: 0, seats: [] }
  github.reportStatus = 200
  github.downloadLinks = []
  github.ndjson = ''
  github.requests = []
  fetchStub.mockClear()

  delete process.env.COPILOT_ENCRYPTION_KEY
  vi.stubGlobal('fetch', fetchStub)

  app = buildServer()
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.unstubAllGlobals()
  delete process.env.COPILOT_ENCRYPTION_KEY
})

const writeOps = () =>
  dbState.calls.filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete')

describe('GET /v1/integrations/copilot/status', () => {
  it('reports missing-key, and answers 200 rather than 500, with no key configured', async () => {
    // The degrade case. An unconfigured deployment still has to render the
    // integration panel, so this must never be an error.
    dbState.results.push([{ integrationId: null, githubOrg: null, lastSyncAt: null }])

    const res = await app.inject({ method: 'GET', url: STATUS_URL, headers: admin() })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      encryption: 'missing-key',
      connected: false,
      org: null,
      lastSyncAt: null,
    })
  })

  it('reports malformed-key, distinctly from missing-key, for a key that will not decode', async () => {
    // The distinction is the whole point: this is the only surface on which an
    // operator learns the key is mistyped rather than unset.
    process.env.COPILOT_ENCRYPTION_KEY = BAD_KEY
    dbState.results.push([{ integrationId: null, githubOrg: null, lastSyncAt: null }])

    const res = await app.inject({ method: 'GET', url: STATUS_URL, headers: admin() })

    expect(res.statusCode).toBe(200)
    expect(res.json().encryption).toBe('malformed-key')
  })

  it('reports no org while disconnected, even though the org name is remembered', async () => {
    // DELETE leaves `organizations.github_org` alone so a reconnect does not
    // have to be retyped. The panel must not read that as a live connection.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([{ integrationId: null, githubOrg: ORG, lastSyncAt: null }])

    const res = await app.inject({ method: 'GET', url: STATUS_URL, headers: admin() })

    expect(res.json()).toMatchObject({ connected: false, org: null })
  })

  it('reports ready, the org and the last sync once connected', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([
      {
        integrationId: 'integration-1',
        githubOrg: ORG,
        lastSyncAt: new Date('2026-11-09T10:00:00.000Z'),
      },
    ])

    const res = await app.inject({ method: 'GET', url: STATUS_URL, headers: admin() })

    expect(res.json()).toEqual({
      encryption: 'ready',
      connected: true,
      org: ORG,
      lastSyncAt: '2026-11-09T10:00:00.000Z',
    })
  })
})

describe('PUT /v1/integrations/copilot/connection', () => {
  const put = (
    headers?: Record<string, string>,
    payload: Record<string, unknown> = { org: ORG, token: TOKEN },
  ) => app.inject({ method: 'PUT', url: CONNECTION_URL, headers, payload })

  it('returns 503 with the encryption reason, and stores nothing, when no key is configured', async () => {
    const res = await put(admin())

    expect(res.statusCode).toBe(503)
    expect(res.json().encryption).toBe('missing-key')
    expect(writeOps()).toHaveLength(0)
    // It must not even reach GitHub: there is nowhere to put the answer.
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns 503 for a malformed key too, rather than storing the token in the clear', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = BAD_KEY

    const res = await put(admin())

    expect(res.statusCode).toBe(503)
    expect(res.json().encryption).toBe('malformed-key')
    expect(writeOps()).toHaveLength(0)
  })

  it('rejects a token GitHub refuses, reports its status, and stores nothing', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 401

    const res = await put(admin())

    expect(res.statusCode).toBe(400)
    expect(res.json().githubStatus).toBe(401)
    expect(writeOps()).toHaveLength(0)
  })

  it('validates against the seats endpoint before storing anything', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 403

    await put(admin())

    expect(github.requests.some((r) => r.url.includes('/copilot/billing/seats'))).toBe(true)
  })

  it('stores a sealed token that opens back to exactly what was sent', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([]) // update organizations.github_org
    dbState.results.push([]) // update org_integrations ... returning, no existing row
    dbState.results.push([]) // insert org_integrations

    const res = await put(admin())

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ connected: true, org: ORG })

    const written = dbState.calls
      .filter((c) => c.op === 'values')
      .map((c) => c.arg as Record<string, unknown>)
      .find((v) => 'encryptedToken' in v)

    const stored = String(written?.encryptedToken)
    expect(stored).not.toBe(TOKEN)
    expect(stored).not.toContain(TOKEN)
    expect(stored.startsWith('v1.')).toBe(true)
    expect(openWith(KEY, stored)).toBe(TOKEN)
  })

  it('updates the existing row rather than inserting a second one', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([]) // update organizations.github_org
    dbState.results.push([{ id: 'integration-1' }]) // update matched an existing row

    const res = await put(admin())

    expect(res.statusCode).toBe(200)
    expect(dbState.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('rejects a body with no token', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const res = await put(admin(), { org: ORG })
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /v1/integrations/copilot/connection', () => {
  it('removes the row and answers 204 with no body', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([])

    const res = await app.inject({ method: 'DELETE', url: CONNECTION_URL, headers: admin() })

    expect(res.statusCode).toBe(204)
    expect(res.payload).toBe('')
    expect(dbState.calls.some((c) => c.op === 'delete')).toBe(true)
  })
})

describe('POST /v1/integrations/copilot/sync', () => {
  const connectedRow = () => [{ encryptedToken: sealWith(KEY, TOKEN), githubOrg: ORG }]

  /** The rebuild and the alert pass, for one user, in the order they run. */
  const pushRebuildAndAlerts = () => {
    dbState.results.push([]) // rebuild: usage aggregated by agent
    dbState.results.push([]) // rebuild: enrichment
    dbState.results.push([{ orgId: ORG_A }]) // rebuild: user lookup
    dbState.results.push([]) // rebuild: snapshot upsert
    dbState.results.push([]) // evaluate: no budget alerts for this org
  }

  it('defaults to yesterday in UTC, never today', async () => {
    // Today's report 404s, because GitHub publishes no lag for availability,
    // so defaulting to it would make the ordinary sync a silent no-op.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push(connectedRow())
    dbState.results.push([]) // update last_sync_at

    const res = await app.inject({ method: 'POST', url: SYNC_URL, headers: admin() })

    expect(res.statusCode).toBe(200)
    expect(res.json().day).toBe(yesterdayUtc())
    expect(res.json().day).not.toBe(todayUtc())

    const report = github.requests.find((r) => r.url.includes('users-1-day'))
    expect(report?.url).toContain(`day=${yesterdayUtc()}`)
    expect(report?.url).not.toContain(`day=${todayUtc()}`)
  })

  it('honours an explicit day', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-10-01' },
    })

    expect(res.json().day).toBe('2026-10-01')
    expect(github.requests.find((r) => r.url.includes('users-1-day'))?.url).toContain(
      'day=2026-10-01',
    )
  })

  it('maps a login to a user by github_username, ignoring case', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.seatsBody = { total_seats: 1, seats: [seat('Alice')] }
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('Alice', day)

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }]) // users matched on lower(github_username)
    dbState.results.push([{ id: 'event-1' }]) // usage insert ... returning
    pushRebuildAndAlerts()
    dbState.results.push([]) // update last_sync_at

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      day,
      seats: { total: 1, skippedNullAssignee: 0 },
      usage: { matched: 1, written: 1, skipped: 0 },
      unmatchedLogins: [],
    })
  })

  it('writes the row as copilot-org with a null deviceId and one copilot model', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('alice', day, 100, 50, 3)

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }])
    dbState.results.push([{ id: 'event-1' }])
    pushRebuildAndAlerts()
    dbState.results.push([])

    await app.inject({ method: 'POST', url: SYNC_URL, headers: admin(), payload: { day } })

    const rows = dbState.calls
      .filter((c) => c.op === 'values')
      .map((c) => c.arg)
      .find((arg): arg is Record<string, unknown>[] => Array.isArray(arg))

    expect(rows).toHaveLength(1)
    expect(rows?.[0]).toMatchObject({
      userId: USER_A,
      deviceId: null,
      source: 'copilot-org',
      agent: 'copilot',
      modelName: 'copilot',
      date: day,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 150,
      isFreeTier: false,
    })
  })

  it('runs each developer write, rebuild and alert pass in one transaction', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('alice', day)

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }])
    dbState.results.push([{ id: 'event-1' }])
    pushRebuildAndAlerts()
    dbState.results.push([])

    await app.inject({ method: 'POST', url: SYNC_URL, headers: admin(), payload: { day } })

    const ops = dbState.calls.map((c) => c.op)
    // The usage insert lands after the transaction opens, so a failing rebuild
    // cannot leave spend recorded but absent from the snapshot.
    expect(ops.indexOf('transaction')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('transaction')).toBeLessThan(ops.indexOf('insert'))
    expect(ops).not.toContain('rollback')
  })

  it('reports an unmatched login instead of dropping it, in GitHub own casing', async () => {
    // BW-33: a developer whose github_username is unset contributes nothing
    // and looks exactly like one who did no work.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.seatsBody = { total_seats: 2, seats: [seat('Alice'), seat('Bob')] }
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = [userDayLine('Alice', day), userDayLine('Bob', day)].join('\n')

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }]) // only Alice is known
    dbState.results.push([{ id: 'event-1' }])
    pushRebuildAndAlerts()
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day },
    })

    expect(res.json().unmatchedLogins).toEqual(['Bob'])
    expect(res.json().usage.matched).toBe(1)
  })

  it('counts a seat GitHub reports with no assignee', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = { total_seats: 2, seats: [seat('alice'), { ...seat('x'), assignee: null }] }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(res.json().seats).toEqual({ total: 2, skippedNullAssignee: 1 })
  })

  it('is safe to run twice: a replay writes nothing and reports it as skipped', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('alice', day)

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }])
    dbState.results.push([]) // insert ... returning, the unique constraint swallowed it
    pushRebuildAndAlerts()
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day },
    })

    expect(res.json().usage).toEqual({ matched: 1, written: 0, skipped: 1 })
    expect(dbState.calls.some((c) => c.op === 'onConflictDoNothing')).toBe(true)
  })

  it('returns 503, and never reaches GitHub, when no key is configured', async () => {
    const res = await app.inject({ method: 'POST', url: SYNC_URL, headers: admin() })

    expect(res.statusCode).toBe(503)
    expect(res.json().encryption).toBe('missing-key')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns 404 when the org has no Copilot connection', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([])

    const res = await app.inject({ method: 'POST', url: SYNC_URL, headers: admin() })

    expect(res.statusCode).toBe(404)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('reports a stored credential that no longer decrypts, without leaking crypto internals', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    // Sealed under a different key, so opening it fails authentication.
    const otherKey = Buffer.alloc(32, 9).toString('base64')
    dbState.results.push([{ encryptedToken: sealWith(otherKey, TOKEN), githubOrg: ORG }])

    const res = await app.inject({ method: 'POST', url: SYNC_URL, headers: admin() })

    expect(res.statusCode).toBe(500)
    expect(res.json().error).toContain('Reconnect')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('rejects a day that is not YYYY-MM-DD', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '20261109' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('copilot integration routes — authorization', () => {
  const ROUTES = [
    ['GET', STATUS_URL],
    ['PUT', CONNECTION_URL],
    ['DELETE', CONNECTION_URL],
    ['POST', SYNC_URL],
  ] as const

  it.each(ROUTES)('%s %s returns 401 without a token', async (method, url) => {
    const res = await app.inject({ method, url, payload: { org: ORG, token: TOKEN } })
    expect(res.statusCode).toBe(401)
  })

  it.each(
    ROUTES.flatMap(([method, url]) =>
      (['developer', 'manager', 'device'] as const).map((role) => [method, url, role] as const),
    ),
  )('%s %s returns 403 for a %s token', async (method, url, role) => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY

    const res = await app.inject({
      method,
      url,
      headers: auth(token({ role, deviceId: DEVICE_A })),
      payload: { org: ORG, token: TOKEN },
    })

    expect(res.statusCode).toBe(403)
    // Rejected before anything was read or written, and before GitHub was asked.
    expect(dbState.calls).toHaveLength(0)
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

describe('copilot integration routes — the token never leaves', () => {
  it('is absent from every response body across connect, status and sync', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'

    // Connect.
    dbState.results.push([]) // update organizations.github_org
    dbState.results.push([]) // update org_integrations ... returning
    dbState.results.push([]) // insert org_integrations
    const connected = await app.inject({
      method: 'PUT',
      url: CONNECTION_URL,
      headers: admin(),
      payload: { org: ORG, token: TOKEN },
    })

    // Status.
    dbState.results.push([
      { integrationId: 'integration-1', githubOrg: ORG, lastSyncAt: null },
    ])
    const status = await app.inject({ method: 'GET', url: STATUS_URL, headers: admin() })

    // Sync.
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('alice', day)
    dbState.results.push([{ encryptedToken: sealWith(KEY, TOKEN), githubOrg: ORG }])
    dbState.results.push([{ id: USER_A, login: 'alice' }])
    dbState.results.push([{ id: 'event-1' }])
    dbState.results.push([])
    dbState.results.push([])
    dbState.results.push([{ orgId: ORG_A }])
    dbState.results.push([])
    dbState.results.push([])
    dbState.results.push([])
    const synced = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day },
    })

    for (const res of [connected, status, synced]) {
      expect(res.payload).not.toContain(TOKEN)
      // Not even a prefix of it, which would be enough to confirm a guess.
      expect(res.payload).not.toContain(TOKEN.slice(0, 12))
    }

    // The token did reach GitHub, which is the only place it belongs.
    expect(github.requests.some((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('is absent from the error body when GitHub refuses it', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 401

    const res = await app.inject({
      method: 'PUT',
      url: CONNECTION_URL,
      headers: admin(),
      payload: { org: ORG, token: TOKEN },
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).not.toContain(TOKEN)
    // GitHub's own response body is not echoed either.
    expect(res.payload).not.toContain('github says no')
  })
})
