import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  listCopilotSeats,
  fetchCopilotUserDays,
  parseUserDayRecord,
  type CopilotSeat,
} from './copilot.service.js'

/**
 * Both fixtures are the literal upstream shapes, not a convenient subset: the
 * seats file keeps the null-assignee seat and the fields GitHub documents as
 * nullable, and the NDJSON file keeps its blank line, its nested
 * `totals_by_model` arrays, and one enterprise-scoped record with no
 * `organization_id`. A fixture trimmed to what the mapper happens to read
 * would stop catching the day the mapper reads something else.
 */
const FIXTURES = join(import.meta.dirname, '..', '..', 'test', 'fixtures')

const seatsFixture = JSON.parse(
  readFileSync(join(FIXTURES, 'copilot-seats.json'), 'utf8'),
) as { total_seats: number; seats: Record<string, unknown>[] }

const ndjsonFixture = readFileSync(join(FIXTURES, 'copilot-user-days.ndjson'), 'utf8')

const TOKEN = 'ghp-test-token'
const ORG = 'acme'
const DAY = '2026-10-19'
const SEATS_URL = `https://api.github.com/orgs/${ORG}/copilot/billing/seats`
const REPORT_URL = `https://api.github.com/orgs/${ORG}/copilot/metrics/reports/users-1-day?day=${DAY}`
const DOWNLOAD_URL = 'https://objects.githubusercontent.com/copilot/report-1?sig=secret-signature'

type Reply = { status?: number; body?: unknown; text?: string }

/**
 * Routes by URL so each test declares only the responses it cares about.
 * `calls` records headers as well as URLs: whether the signed download link
 * is fetched *without* an `Authorization` header is part of the contract
 * here, not an implementation detail.
 */
function stubFetch(route: (url: string) => Reply) {
  const calls: { url: string; headers: Record<string, string> | undefined }[] = []

  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    calls.push({ url, headers: init?.headers })
    const reply = route(url)
    const status = reply.status ?? 200
    const text = reply.text ?? JSON.stringify(reply.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response
  }) as unknown as typeof fetch

  return { impl, calls }
}

/**
 * A full 100-seat page, cloned from the fixture's real seat so the shape
 * stays honest. Pagination only continues on a page of exactly `per_page`,
 * so a short hand-written page would never exercise it.
 */
function fullSeatPage() {
  return {
    total_seats: 103,
    seats: Array.from({ length: 100 }, (_unused, i) => ({
      ...seatsFixture.seats[0],
      assignee: { login: `dev${i}`, id: 100 + i, type: 'User' },
    })),
  }
}

function fixtureLine(login: string): string {
  const found = ndjsonFixture.split('\n').find((l) => l.includes(`"user_login":"${login}"`))
  if (!found) throw new Error(`fixture has no NDJSON line for ${login}`)
  return found
}

describe('listCopilotSeats', () => {
  // `endsWith`, not `includes`: the query string carries `per_page=100`, which
  // contains `page=1` and would hand the full page back for every page number.
  const firstPageFull = (url: string): Reply =>
    url.endsWith('page=1') ? { body: fullSeatPage() } : { body: seatsFixture }

  it('walks pages until a short one and keeps them in order', async () => {
    const { impl, calls } = stubFetch(firstPageFull)

    const result = await listCopilotSeats(TOKEN, ORG, impl)

    expect(calls.map((c) => c.url)).toEqual([
      `${SEATS_URL}?per_page=100&page=1`,
      `${SEATS_URL}?per_page=100&page=2`,
    ])
    // 100 from the full page, then 2 of the fixture's 3 (one assignee is null).
    expect(result.seats).toHaveLength(102)
    expect(result.seats[0].login).toBe('dev0')
    expect(result.seats[99].login).toBe('dev99')
    expect(result.seats[100].login).toBe('octocat')
    expect(result.seats[101].login).toBe('hubot')
  })

  it('reports the first page total, not whatever the last page claimed', async () => {
    const { impl } = stubFetch(firstPageFull)
    // The fixture used as page 2 says 3; the walk started from a page saying 103.
    expect((await listCopilotSeats(TOKEN, ORG, impl)).totalSeats).toBe(103)
  })

  it('stops after a single short page', async () => {
    const { impl, calls } = stubFetch(() => ({ body: seatsFixture }))
    const result = await listCopilotSeats(TOKEN, ORG, impl)
    expect(calls).toHaveLength(1)
    expect(result.totalSeats).toBe(3)
  })

  it('skips a seat with a null assignee and reports how many it dropped', async () => {
    const { impl } = stubFetch(() => ({ body: seatsFixture }))
    const result = await listCopilotSeats(TOKEN, ORG, impl)
    expect(result.seats.map((s) => s.login)).toEqual(['octocat', 'hubot'])
    expect(result.skippedNullAssignee).toBe(1)
  })

  it('maps the nullable seat fields rather than dropping them', async () => {
    const { impl } = stubFetch(() => ({ body: seatsFixture }))
    const { seats } = await listCopilotSeats(TOKEN, ORG, impl)

    const expected: CopilotSeat = {
      login: 'octocat',
      planType: 'business',
      createdAt: '2026-08-01T10:00:00-06:00',
      lastActivityAt: '2026-10-19T08:17:14-06:00',
      lastActivityEditor: 'vscode/1.106.0/copilot/1.420.0',
      pendingCancellationDate: null,
    }
    expect(seats[0]).toEqual(expected)
    expect(seats[1].planType).toBe('enterprise')
    expect(seats[1].pendingCancellationDate).toBe('2026-11-30')
  })

  it('sends the bearer token and pins the api version', async () => {
    const { impl, calls } = stubFetch(() => ({ body: seatsFixture }))
    await listCopilotSeats(TOKEN, ORG, impl)
    expect(calls[0].headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
  })

  it('throws with the status and body on a non-2xx', async () => {
    const { impl } = stubFetch(() => ({ status: 401, text: '{"message":"Bad credentials"}' }))
    await expect(listCopilotSeats(TOKEN, ORG, impl)).rejects.toThrow(
      /failed with 401: \{"message":"Bad credentials"\}/,
    )
  })
})

describe('parseUserDayRecord', () => {
  it('sums each client and the CLI total once, never the model breakdown', () => {
    const row = parseUserDayRecord(fixtureLine('login1'))
    // 2400 + 480 across the two clients, plus 3800 from the CLI. Descending
    // into totals_by_model would add 1800 + 600 + 480 on top and give 9560.
    expect(row?.inputTokens).toBe(6680)
    // 900 + 120 across the clients, plus 5000 from the CLI; the model rows
    // would add 600 + 300 + 120 on top and give 7040.
    expect(row?.outputTokens).toBe(6020)
    expect(row?.totalTokens).toBe(12700)
  })

  it('treats a missing token_usage at any level as zero instead of throwing', () => {
    // login2 carries a client with no token_usage at all, a client whose
    // usage has only the prompt field, and a totals_by_cli with no usage.
    const row = parseUserDayRecord(fixtureLine('login2'))
    expect(row?.inputTokens).toBe(40)
    expect(row?.outputTokens).toBe(0)
    expect(row?.totalTokens).toBe(40)
  })

  it('handles a record with no totals_by_cli key at all', () => {
    const row = parseUserDayRecord(fixtureLine('login4'))
    expect(row?.inputTokens).toBe(20)
    expect(row?.outputTokens).toBe(10)
    expect(row?.totalTokens).toBe(30)
  })

  it('converts credits to dollars at a cent each and keeps the fraction', () => {
    expect(parseUserDayRecord(fixtureLine('login1'))?.aiCreditsUsed).toBe(12.5)
    expect(parseUserDayRecord(fixtureLine('login1'))?.costUsd).toBe(0.125)
    // Half a credit, where rounding credits to an integer would report $0.
    expect(parseUserDayRecord(fixtureLine('login2'))?.costUsd).toBe(0.005)
    expect(parseUserDayRecord(fixtureLine('login4'))?.costUsd).toBe(0.02)
  })

  it('skips a record with no tokens and no credits', () => {
    expect(parseUserDayRecord(fixtureLine('login3'))).toBeNull()
  })

  it('returns null for a blank line', () => {
    expect(parseUserDayRecord('')).toBeNull()
    expect(parseUserDayRecord('   \n')).toBeNull()
  })

  it('throws and names the observed keys when user_login is absent', () => {
    expect(() => parseUserDayRecord('{"user_id":7,"day":"2026-10-19","ai_credits_used":3}')).toThrow(
      'copilot: NDJSON record has no user_login. Observed top-level keys: user_id, day, ai_credits_used',
    )
  })

  it('carries identity, date and every mapped figure through', () => {
    expect(parseUserDayRecord(fixtureLine('login1'))).toEqual({
      login: 'login1',
      date: '2026-10-19',
      inputTokens: 6680,
      outputTokens: 6020,
      totalTokens: 12700,
      aiCreditsUsed: 12.5,
      costUsd: 0.125,
    })
  })
})

describe('fetchCopilotUserDays', () => {
  const reportThenFile = (url: string): Reply =>
    url.startsWith(REPORT_URL)
      ? { body: { download_links: [DOWNLOAD_URL], report_day: DAY } }
      : { text: ndjsonFixture }

  it('follows the download links and maps every usable line', async () => {
    const { impl, calls } = stubFetch(reportThenFile)
    const rows = await fetchCopilotUserDays(TOKEN, ORG, DAY, impl)

    expect(calls.map((c) => c.url)).toEqual([REPORT_URL, DOWNLOAD_URL])
    // login3 did nothing that day, and the file carries a blank line.
    expect(rows.map((r) => r.login)).toEqual(['login1', 'login2', 'login4'])
    expect(rows.map((r) => r.totalTokens)).toEqual([12700, 40, 30])
  })

  it('sends no Authorization header to the pre-authenticated download link', async () => {
    const { impl, calls } = stubFetch(reportThenFile)
    await fetchCopilotUserDays(TOKEN, ORG, DAY, impl)
    expect(calls[0].headers?.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[1].headers).toBeUndefined()
  })

  it('reads a 404 as a report that is not published yet', async () => {
    const { impl } = stubFetch(() => ({ status: 404, text: '{"message":"Not Found"}' }))
    await expect(fetchCopilotUserDays(TOKEN, ORG, DAY, impl)).resolves.toEqual([])
  })

  it('throws with the status and body on any other non-2xx', async () => {
    const { impl } = stubFetch(() => ({ status: 500, text: 'upstream exploded' }))
    await expect(fetchCopilotUserDays(TOKEN, ORG, DAY, impl)).rejects.toThrow(
      /failed with 500: upstream exploded/,
    )
  })

  it('keeps the signature of a failed download link out of the error', async () => {
    const { impl } = stubFetch((url) =>
      url.startsWith(REPORT_URL)
        ? { body: { download_links: [DOWNLOAD_URL] } }
        : { status: 403, text: 'expired' },
    )
    const err = await fetchCopilotUserDays(TOKEN, ORG, DAY, impl).catch((e: unknown) => e)
    expect(String(err)).toContain('download link failed with 403: expired')
    expect(String(err)).not.toContain('secret-signature')
  })

  it('returns nothing when the report carries no download_links key', async () => {
    const { impl } = stubFetch(() => ({ body: { report_day: DAY } }))
    await expect(fetchCopilotUserDays(TOKEN, ORG, DAY, impl)).resolves.toEqual([])
  })
})
