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

/**
 * The envelope is bound to the row it lives in, so the tests have to use the
 * same binding the route does. `ORG_A` is the org on the admin token.
 */
const CONTEXT = `${ORG_A}:copilot`

function sealWith(key: string, plaintext: string, context = CONTEXT): string {
  const crypto = credentialCrypto({ COPILOT_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)
  if (!crypto.available) throw new Error(`test key unusable: ${crypto.reason}`)
  return crypto.seal(plaintext, context)
}

function openWith(key: string, sealed: string, context = CONTEXT): string {
  const crypto = credentialCrypto({ COPILOT_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)
  if (!crypto.available) throw new Error(`test key unusable: ${crypto.reason}`)
  return crypto.open(sealed, context)
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

/**
 * One raw seat as GitHub sends it. `over` takes the response's own snake_case
 * field names so a test reads against the upstream shape rather than ours.
 */
const seat = (login: string, over: Record<string, unknown> = {}) => ({
  assignee: { login } as { login: string } | null,
  plan_type: 'business',
  created_at: '2026-01-01T00:00:00Z',
  last_activity_at: null as string | null,
  last_activity_editor: null as string | null,
  pending_cancellation_date: null as string | null,
  ...over,
})

let app: FastifyInstance

const token = (over: Partial<JwtPayload> = {}) =>
  app.jwt.access.sign({ userId: USER_A, orgId: ORG_A, role: 'admin', ...over } as JwtPayload)

const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const admin = () => auth(token())

const STATUS_URL = '/v1/integrations/copilot/status'
const CONNECTION_URL = '/v1/integrations/copilot/connection'
const SYNC_URL = '/v1/integrations/copilot/sync'
const SEATS_URL = '/v1/integrations/copilot/seats'

/** The stored connection, as the sync and seats routes both read it back. */
const connectedRow = () => [{ encryptedToken: sealWith(KEY, TOKEN), githubOrg: ORG }]

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

  /**
   * Reconnecting must replace the credential, never add a second row beside
   * it, because every reader here takes the first row it finds. Asserted
   * through the conflict arbitration rather than by counting rows, since the
   * fake database has no constraints of its own. Migration 0006 supplies the
   * unique index this target names, and the pair was exercised against a real
   * Postgres before being relied on.
   */
  it('reconnecting replaces the credential rather than adding a second row', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([]) // update organizations.github_org

    const res = await put(admin())

    expect(res.statusCode).toBe(200)

    const inserts = dbState.calls.filter((c) => c.op === 'insert')
    expect(inserts).toHaveLength(1)

    const conflict = dbState.calls.find((c) => c.op === 'onConflictDoUpdate')
    expect(conflict).toBeDefined()
    const target = (conflict!.arg as { target: { name: string }[] }).target
    expect(target.map((c) => c.name)).toEqual(['org_id', 'provider'])
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
  /** The rebuild and the alert pass, for one user, in the order they run. */
  const pushRebuildAndAlerts = () => {
    dbState.results.push([]) // rebuild: advisory lock on the user-day
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

  /**
   * A re-sync of a day already stored must overwrite rather than no-op.
   * GitHub documents `ai_credits_used` as a metrics signal and not a billed
   * total, so the figures for a day can change after it first becomes
   * queryable, and this route is admin-triggered precisely so someone can ask
   * again. Ignoring the repeat would make a synced day permanently
   * unrevisable, reported as `skipped` and indistinguishable from a true
   * no-op, with hand-deleting rows the only way back.
   */
  it('is safe to run twice, and a replay overwrites rather than being ignored', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const day = '2026-11-09'
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = userDayLine('alice', day)

    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, login: 'alice' }])
    dbState.results.push([{ id: 'event-1' }]) // the upsert returns the row it replaced
    pushRebuildAndAlerts()
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day },
    })

    expect(res.json().usage).toEqual({ matched: 1, written: 1, skipped: 0 })
    expect(dbState.calls.some((c) => c.op === 'onConflictDoUpdate')).toBe(true)
    expect(dbState.calls.some((c) => c.op === 'onConflictDoNothing')).toBe(false)
  })

  /**
   * A fine-grained PAT carries an expiry, so the credential that worked at
   * connect time is exactly the one likeliest to be dead by the next sync.
   * Before this was wrapped, the error escaped to the global handler, which
   * answers with `{ error: error.message }` — and `apiError` puts GitHub's
   * whole response body in that message.
   */
  it('answers 502 with the GitHub status when the token stopped working', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 401
    dbState.results.push(connectedRow())

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().githubStatus).toBe(401)
  })

  it('keeps the GitHub response body out of the reply when a sync fails', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 500
    dbState.results.push(connectedRow())

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(res.payload).not.toContain('github says no')
  })

  it('writes nothing when the GitHub call fails', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 403
    dbState.results.push(connectedRow())

    await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(writeOps()).toEqual([])
  })

  /**
   * An unpublished report and an idle organization both write nothing, and
   * only the first is worth retrying. GitHub also answers 404, not 403, for
   * a resource a token cannot see, so this is equally what a PAT lacking
   * Copilot metrics looks like. Stamping `last_sync_at` for it would leave
   * such a token reading as healthy forever while pulling nothing, which is
   * why the write is gated rather than the response merely annotated.
   */
  it('reports an unpublished day instead of calling it a quiet one', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.reportStatus = 404
    dbState.results.push(connectedRow())

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().reportPublished).toBe(false)
    expect(res.json().usage).toEqual({ matched: 0, written: 0, skipped: 0 })
  })

  it('does not advance last_sync_at for a day GitHub never published', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.reportStatus = 404
    dbState.results.push(connectedRow())

    await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(writeOps()).toEqual([])
  })

  it('marks a genuinely empty but published report as published', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.downloadLinks = [DOWNLOAD]
    github.ndjson = ''
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await app.inject({
      method: 'POST',
      url: SYNC_URL,
      headers: admin(),
      payload: { day: '2026-11-09' },
    })

    expect(res.json().reportPublished).toBe(true)
    expect(res.json().usage.written).toBe(0)
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

describe('GET /v1/integrations/copilot/seats', () => {
  /**
   * The idle rule is a comparison against the clock, so a real one makes the
   * boundary cases flaky by milliseconds. Only `Date` is faked: Fastify's own
   * timers stay real, and the app is built by the outer hook before this runs.
   */
  const NOW = '2026-11-10T12:00:00.000Z'
  /** Exactly 30 days before NOW, the default window's edge. */
  const EDGE = '2026-10-11T12:00:00.000Z'

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const get = (query = '', headers = admin()) =>
    app.inject({ method: 'GET', url: `${SEATS_URL}${query}`, headers })

  const statusByLogin = (body: { seats: { login: string; status: string }[] }) =>
    Object.fromEntries(body.seats.map((s) => [s.login, s.status]))

  it('calls a seat used exactly at the window active, and one second older idle', async () => {
    // "Older than 30 days" is an age greater than 30 days, and an age of
    // exactly 30 days is not. All three points of the boundary in one test,
    // because they are one rule.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = {
      total_seats: 3,
      seats: [
        seat('edge', { last_activity_at: EDGE }),
        seat('older', { last_activity_at: '2026-10-11T11:59:59.000Z' }),
        seat('newer', { last_activity_at: '2026-10-11T12:00:01.000Z' }),
      ],
    }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await get()

    expect(res.statusCode).toBe(200)
    expect(statusByLogin(res.json())).toEqual({
      edge: 'active',
      older: 'idle',
      newer: 'active',
    })
  })

  it('calls a seat that has never been used idle', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = { total_seats: 1, seats: [seat('never', { last_activity_at: null })] }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await get()

    expect(statusByLogin(res.json())).toEqual({ never: 'idle' })
    expect(res.json().summary).toMatchObject({ idle: 1, active: 0 })
  })

  it('narrowing the window moves a seat from active to idle', async () => {
    // Proves the parameter reaches the comparison rather than only the echo.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = {
      total_seats: 1,
      seats: [seat('alice', { last_activity_at: '2026-10-31T12:00:00.000Z' })], // 10 days ago
    }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const wide = await get()
    expect(statusByLogin(wide.json())).toEqual({ alice: 'active' })

    dbState.results.push(connectedRow())
    dbState.results.push([])

    const narrow = await get('?idleAfterDays=7')
    expect(statusByLogin(narrow.json())).toEqual({ alice: 'idle' })
    expect(narrow.json().idleAfterDays).toBe(7)
  })

  it('defaults the window to 30 days when none is given', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = { total_seats: 0, seats: [] }
    dbState.results.push(connectedRow())

    const res = await get()

    expect(res.json().idleAfterDays).toBe(30)
  })

  it.each(['?idleAfterDays=0', '?idleAfterDays=366', '?idleAfterDays=1.5', '?idleAfterDays=x'])(
    'rejects %s rather than computing a window from it',
    async (query) => {
      process.env.COPILOT_ENCRYPTION_KEY = KEY
      dbState.results.push(connectedRow())

      const res = await get(query)

      expect(res.statusCode).toBe(400)
    },
  )

  it('leaves a plan it has no price for unpriced, and says how many it left out', async () => {
    // A wrong dollar figure on a spend dashboard is worse than an absent one,
    // so an unrecognised plan must never be coerced into the price table.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = {
      total_seats: 2,
      seats: [
        seat('priced', { plan_type: 'business', last_activity_at: null }),
        seat('unpriced', { plan_type: 'copilot_pro_plus', last_activity_at: null }),
      ],
    }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await get()

    const byLogin = Object.fromEntries(
      res.json().seats.map((s: { login: string }) => [s.login, s]),
    )
    expect(byLogin.priced.monthlyCostUsd).toBe(19)
    expect(byLogin.unpriced.monthlyCostUsd).toBeNull()
    expect(res.json().summary).toMatchObject({
      idle: 2,
      idleMonthlyCostUsd: 19,
      unpricedIdleSeats: 1,
    })
  })

  it('links a seat whose login differs in case from github_username', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = { total_seats: 1, seats: [seat('Alice')] }
    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, name: 'Alice Smith', login: 'alice' }])

    const res = await get()

    expect(res.json().seats[0]).toMatchObject({
      // GitHub's casing comes back, not the lowercased match key.
      login: 'Alice',
      userId: USER_A,
      userName: 'Alice Smith',
    })
    expect(res.json().summary.unlinked).toBe(0)
  })

  it('counts the seats no BurnWatch user claims', async () => {
    // A paid licence whose spend cannot be attributed to anyone.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = {
      total_seats: 3,
      seats: [seat('Alice'), seat('Bob'), seat('Carol')],
    }
    dbState.results.push(connectedRow())
    dbState.results.push([{ id: USER_A, name: 'Alice Smith', login: 'alice' }])

    const res = await get()

    expect(res.json().summary.unlinked).toBe(2)
    expect(
      res
        .json()
        .seats.filter((s: { userId: string | null }) => s.userId === null)
        .map((s: { login: string }) => s.login)
        .sort(),
    ).toEqual(['Bob', 'Carol'])
  })

  it('orders idle before active, nulls before timestamps, then by login', async () => {
    // Two reads of the same roster have to read identically, and the longest
    // idle seat is the one an admin is here to find. Fed in an order that is
    // not the answer, so a dropped sort cannot pass by accident.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const recent = '2026-11-10T00:00:00.000Z'
    github.seatsBody = {
      total_seats: 6,
      seats: [
        seat('zeta', { last_activity_at: recent }),
        seat('mike', { last_activity_at: '2026-01-01T00:00:00.000Z' }),
        seat('alpha', { last_activity_at: recent }),
        seat('bravo', { last_activity_at: null }),
        seat('kilo', { last_activity_at: '2025-06-01T00:00:00.000Z' }),
        seat('alfa', { last_activity_at: null }),
      ],
    }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await get()

    expect(res.json().seats.map((s: { login: string }) => s.login)).toEqual([
      'alfa',
      'bravo',
      'kilo',
      'mike',
      'alpha',
      'zeta',
    ])
  })

  it('reports GitHub own total_seats, not the number of rows it could read', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = {
      total_seats: 9,
      seats: [seat('alice'), seat('ghost', { assignee: null })],
    }
    dbState.results.push(connectedRow())
    dbState.results.push([])

    const res = await get()

    expect(res.json().totalSeats).toBe(9)
    expect(res.json().skippedNullAssignee).toBe(1)
    expect(res.json().seats).toHaveLength(1)
  })

  it('names the connected org', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsBody = { total_seats: 0, seats: [] }
    dbState.results.push(connectedRow())

    const res = await get()

    expect(res.json()).toMatchObject({ org: ORG, seats: [], totalSeats: 0 })
  })

  it('returns 503, and never reaches GitHub, when no key is configured', async () => {
    const res = await get()

    expect(res.statusCode).toBe(503)
    expect(res.json().encryption).toBe('missing-key')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns 404 when the org has no Copilot connection', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    dbState.results.push([])

    const res = await get()

    expect(res.statusCode).toBe(404)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('reports a stored credential that no longer decrypts, without leaking crypto internals', async () => {
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    const otherKey = Buffer.alloc(32, 9).toString('base64')
    dbState.results.push([{ encryptedToken: sealWith(otherKey, TOKEN), githubOrg: ORG }])

    const res = await get()

    expect(res.statusCode).toBe(500)
    expect(res.json().error).toContain('Reconnect')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('answers 502 with the GitHub status, and none of its response body', async () => {
    // `apiError` carries GitHub's whole body in the message and the global
    // handler sends `error.message`, so an unwrapped call echoes raw upstream
    // text to the caller.
    process.env.COPILOT_ENCRYPTION_KEY = KEY
    github.seatsStatus = 401
    dbState.results.push(connectedRow())

    const res = await get()

    expect(res.statusCode).toBe(502)
    expect(res.json().githubStatus).toBe(401)
    expect(res.payload).not.toContain('github says no')
  })
})

describe('copilot integration routes — authorization', () => {
  const ROUTES = [
    ['GET', STATUS_URL],
    ['PUT', CONNECTION_URL],
    ['DELETE', CONNECTION_URL],
    ['POST', SYNC_URL],
    ['GET', SEATS_URL],
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
