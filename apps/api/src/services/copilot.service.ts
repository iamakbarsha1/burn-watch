/**
 * Read-only client for GitHub's org-level Copilot APIs, plus the mapper that
 * turns one line of their usage report into a row this app can store.
 *
 * Nothing here writes to the database or knows a Fastify request exists. The
 * route that persists the result owns both, and keeping them apart is what
 * lets every branch below be driven from a fixture with no network, no
 * credentials, and no schema.
 */

const GITHUB_API = 'https://api.github.com'

/**
 * One AI credit is $0.01. GitHub documents credits as "a metrics signal for
 * analyzing consumption, not a billed total", so `costUsd` is an
 * approximation of spend and must never be reconciled against an invoice.
 */
const USD_PER_AI_CREDIT = 0.01

/** GitHub caps `per_page` at 100 on the seats endpoint. */
const SEATS_PER_PAGE = 100

/**
 * A runaway guard, not a product limit. The loop below stops on the first
 * short page, which is the only termination signal the endpoint gives; an
 * upstream change that stopped shortening the last page would spin it
 * forever. 5000 seats is far past any org this serves, so reaching the cap
 * means the pagination contract changed rather than that the org grew.
 */
const MAX_SEAT_PAGES = 50

export type CopilotSeat = {
  login: string
  planType: string
  createdAt: string
  lastActivityAt: string | null
  lastActivityEditor: string | null
  pendingCancellationDate: string | null
}

export type CopilotSeatPage = {
  seats: CopilotSeat[]
  totalSeats: number
  skippedNullAssignee: number
}

/** One developer, one day. Tokens are real; cost is derived from credits. */
export type CopilotUserDay = {
  login: string
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  aiCreditsUsed: number
  costUsd: number
}

type RawSeat = {
  assignee: { login: string } | null
  plan_type: string
  created_at: string
  last_activity_at: string | null
  last_activity_editor: string | null
  pending_cancellation_date: string | null
}

type RawSeatsResponse = { total_seats?: number; seats?: RawSeat[] }

type RawTokenUsage = { prompt_tokens_sum?: unknown; output_tokens_sum?: unknown }

/** Both `totals_by_client[]` entries and `totals_by_cli` carry one of these. */
type RawTokenCarrier = { token_usage?: RawTokenUsage }

/**
 * Figures arrive from a JSON file GitHub generates, where a `token_usage`
 * object is simply absent for a client that recorded nothing. Without this
 * coercion one missing level would make the whole day's token count NaN, and
 * the row would persist as garbage instead of failing.
 */
function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * `X-GitHub-Api-Version` pins the response schema. GitHub ships breaking
 * changes behind new dated versions, so omitting it opts into whatever the
 * current default is, which is how a working client starts receiving
 * differently shaped records with no deploy of our own.
 */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * `target` is a URL for the two API endpoints and a description for a signed
 * download link, whose signature is a credential and has no business in an
 * error string that will end up in a log.
 */
async function apiError(target: string, res: Response): Promise<Error> {
  return new Error(`copilot: GET ${target} failed with ${res.status}: ${await res.text()}`)
}

export async function listCopilotSeats(
  token: string,
  org: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotSeatPage> {
  const seats: CopilotSeat[] = []
  let skippedNullAssignee = 0
  let totalSeats = 0

  for (let page = 1; page <= MAX_SEAT_PAGES; page++) {
    const url = `${GITHUB_API}/orgs/${encodeURIComponent(org)}/copilot/billing/seats?per_page=${SEATS_PER_PAGE}&page=${page}`
    const res = await fetchImpl(url, { headers: githubHeaders(token) })
    if (!res.ok) throw await apiError(url, res)

    const body = (await res.json()) as RawSeatsResponse

    // `total_seats` is recomputed per request, so a seat added or revoked
    // mid-walk makes a later page disagree with the first. Keep the first
    // response's figure: it is the snapshot this page sequence started from.
    if (page === 1) totalSeats = body.total_seats ?? 0

    const pageSeats = body.seats ?? []
    for (const seat of pageSeats) {
      // `assignee` is schema-nullable and GitHub documents no reason why. A
      // seat with no login cannot be attributed to a developer, so it is
      // dropped. Never silently, though: the count rides along with the
      // result so a caller can tell an incomplete roster from a small one.
      const login = seat.assignee?.login
      if (!login) {
        skippedNullAssignee++
        continue
      }

      seats.push({
        login,
        planType: seat.plan_type,
        createdAt: seat.created_at,
        lastActivityAt: seat.last_activity_at ?? null,
        lastActivityEditor: seat.last_activity_editor ?? null,
        pendingCancellationDate: seat.pending_cancellation_date ?? null,
      })
    }

    if (pageSeats.length < SEATS_PER_PAGE) break
  }

  return { seats, totalSeats, skippedNullAssignee }
}

export async function fetchCopilotUserDays(
  token: string,
  org: string,
  day: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotUserDay[]> {
  const url = `${GITHUB_API}/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${encodeURIComponent(day)}`
  const res = await fetchImpl(url, { headers: githubHeaders(token) })

  // GitHub publishes no lag or cutoff for when a day's report appears, so a
  // 404 on a recent day means "not generated yet" at least as often as it
  // means "never will be". Raising it would turn every sync of a day near
  // the boundary into a failure an operator has to learn to ignore.
  if (res.status === 404) return []
  if (!res.ok) throw await apiError(url, res)

  // The endpoint hands back pointers, not data: signed URLs to NDJSON files.
  const body = (await res.json()) as { download_links?: string[] }
  const rows: CopilotUserDay[] = []

  for (const link of body.download_links ?? []) {
    // Unverified: the links are pre-authenticated, their expiry is
    // undocumented, and GitHub does not say whether an extra `Authorization`
    // header is accepted or rejected on them, so this sends none. A 401 or
    // 403 here is the first sign that assumption needs rechecking.
    const file = await fetchImpl(link)
    if (!file.ok) throw await apiError('a Copilot report download link', file)

    for (const line of (await file.text()).split('\n')) {
      const row = parseUserDayRecord(line)
      if (row) rows.push(row)
    }
  }

  return rows
}

// ponytail: one row per user-day, never per model. The report does carry real
// per-model token counts under `totals_by_client[].totals_by_model[]`, but
// credits are only ever reported per user-day, and models carry very
// different credit multipliers. Splitting the day's cost by each model's
// token share would reconcile exactly at the daily total while being wrong
// for every individual model, which is worse than not reporting it. Upgrade
// path: the org-aggregate billing API exposes per-model SKU figures, which
// give a real per-model cost to attribute against instead of a guess.
export function parseUserDayRecord(line: string): CopilotUserDay | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const record = JSON.parse(trimmed) as Record<string, unknown>
  const login = record.user_login

  if (typeof login !== 'string' || !login) {
    // Loud on purpose. If the identity field is renamed or nested, mapping
    // the record to zeros would hide a whole day of one developer's spend
    // behind a row that reads as merely idle, and the gap would only surface
    // as an unexplained drop in the org total months later.
    const keys = record !== null && typeof record === 'object' ? Object.keys(record) : []
    throw new Error(
      `copilot: NDJSON record has no user_login. Observed top-level keys: ${keys.join(', ') || '(none)'}`,
    )
  }

  let inputTokens = 0
  let outputTokens = 0
  const add = (usage: RawTokenUsage | undefined) => {
    inputTokens += toNumber(usage?.prompt_tokens_sum)
    outputTokens += toNumber(usage?.output_tokens_sum)
  }

  // `totals_by_model[]` is a breakdown of its parent client, not a sibling of
  // it, so descending into it would count the same tokens a second time. The
  // CLI total is a separate carrier and does add.
  const clients = Array.isArray(record.totals_by_client)
    ? (record.totals_by_client as RawTokenCarrier[])
    : []
  for (const client of clients) add(client?.token_usage)
  add((record.totals_by_cli as RawTokenCarrier | undefined)?.token_usage)

  const aiCreditsUsed = toNumber(record.ai_credits_used)
  const totalTokens = inputTokens + outputTokens

  // Every seat appears in the report every day, active or not. Emitting a row
  // of zeros for each of them buries the days that carry real spend.
  if (totalTokens === 0 && aiCreditsUsed === 0) return null

  return {
    login,
    date: typeof record.day === 'string' ? record.day : '',
    inputTokens,
    outputTokens,
    totalTokens,
    aiCreditsUsed,
    costUsd: aiCreditsUsed * USD_PER_AI_CREDIT,
  }
}
