import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { CopilotSeatRow, CopilotSeatsResponse, UsageEvent } from '@burn-watch/shared'
import { orgIntegrations, organizations, users } from '../../../drizzle/schema.js'
import { requireAdmin } from '../../plugins/jwt.js'
import { credentialCrypto } from '../../credential-crypto.js'
import { listCopilotSeats, fetchCopilotUserDays } from '../../services/copilot.service.js'
import type { CopilotReport, CopilotUserDay } from '../../services/copilot.service.js'
import { upsertUsageEvents } from '../../services/usage.service.js'
import { rebuildDailySnapshot } from '../../services/snapshot.service.js'
import { evaluateBudgetAlerts } from '../../services/budget-alert.service.js'

const PROVIDER = 'copilot'

/**
 * What the sealed credential is bound to, as GCM additional authenticated
 * data. It is the identity of the row the ciphertext lives in, so a token
 * moved to another organization's row stops decrypting rather than quietly
 * becoming that organization's token.
 */
const credentialContext = (orgId: string) => `${orgId}:${PROVIDER}`

const DAY = /^\d{4}-\d{2}-\d{2}$/

const ConnectionSchema = z.object({
  // Trimmed for the reason `credential-crypto` trims its key: a token pasted
  // out of a terminal or a password manager carries a newline often enough
  // that rejecting it would only ever punish a correct credential.
  org: z.string().trim().min(1),
  token: z.string().trim().min(1),
})

const SyncSchema = z.object({ day: z.string().regex(DAY).optional() })

const SeatsQuerySchema = z.object({
  idleAfterDays: z.coerce.number().int().min(1).max(365).default(30),
})

// GitHub's list prices per seat per month. A plan this does not name yields a
// null cost and is counted separately, never priced by guess: a wrong dollar
// figure on a spend dashboard is worse than an absent one.
const SEAT_MONTHLY_USD: Record<string, number | undefined> = { business: 19, enterprise: 39 }

/**
 * Yesterday, in UTC.
 *
 * Today is never the default. GitHub publishes no lag for when a day's report
 * becomes available, and `fetchCopilotUserDays` reads a 404 as "not generated
 * yet", so defaulting to today would make the ordinary sync report an
 * unpublished day every time and train an operator to ignore it.
 */
function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The HTTP status out of the error `copilot.service` throws.
 *
 * Coupled to that module's message format on purpose, and deliberately the
 * only thing taken from it. The message also carries GitHub's response body,
 * which has no business being echoed to an API client, so the status travels
 * and the text does not.
 */
function githubStatusFrom(error: unknown): number | null {
  const match = /failed with (\d{3})/.exec(error instanceof Error ? error.message : '')
  return match ? Number(match[1]) : null
}

/**
 * What to tell an operator when a call to GitHub did not come back.
 *
 * A recovered status means GitHub answered and refused it, and the credential
 * is the first thing worth checking. No status means the failure never reached
 * that point. `listCopilotSeats` exhausting its page cap throws exactly such an
 * error, and telling an operator their token expired would send them to rotate
 * a working one, which is the kind of wrong remedy a 404 read as "healthy"
 * already cost this integration once.
 *
 * The caller logs the error. It carries GitHub's response body, so the log is
 * the only place it belongs.
 */
function upstreamFailure(error: unknown, subject: string) {
  const githubStatus = githubStatusFrom(error)
  return {
    error:
      githubStatus === null
        ? `The ${subject} did not complete, and GitHub never refused it. Check the API log.`
        : `GitHub rejected the ${subject}. The token may have expired or been revoked.`,
    githubStatus,
  }
}

export async function copilotIntegrationRoutes(fastify: FastifyInstance) {
  // GET /copilot/status — what the dashboard renders the integration panel
  // from. Answers 200 whatever the encryption key is doing, because an absent
  // key is the degrade case this whole feature is built around rather than a
  // fault. The three encryption states stay distinct all the way out: this is
  // the only surface on which an operator ever learns their key was mistyped
  // rather than never set, and collapsing them into one "unavailable" would
  // send them looking for a secret that is already there.
  fastify.get('/copilot/status', { preHandler: requireAdmin(fastify) }, async (request) => {
    const crypto = credentialCrypto()

    const [row] = await fastify.db
      .select({
        integrationId: orgIntegrations.id,
        githubOrg: organizations.githubOrg,
        lastSyncAt: orgIntegrations.lastSyncAt,
      })
      .from(organizations)
      .leftJoin(
        orgIntegrations,
        and(eq(orgIntegrations.orgId, organizations.id), eq(orgIntegrations.provider, PROVIDER)),
      )
      .where(eq(organizations.id, request.user.orgId))
      .limit(1)

    const connected = row?.integrationId != null

    return {
      encryption: crypto.available ? ('ready' as const) : crypto.reason,
      connected,
      // Gated on `connected` so a disconnect does not leave the panel naming
      // an org nothing is being pulled from.
      org: connected ? row?.githubOrg ?? null : null,
      lastSyncAt: row?.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    }
  })

  // PUT /copilot/connection — store the org and its token.
  fastify.put(
    '/copilot/connection',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      const body = ConnectionSchema.parse(request.body)
      const orgId = request.user.orgId

      const crypto = credentialCrypto()
      if (!crypto.available) {
        // 503 rather than 500: the request is well formed and the operator can
        // fix it, by setting the key. Storing the token in the clear instead
        // would turn a configuration gap into a leaked credential.
        return reply
          .status(503)
          .send({ error: 'Credential encryption is not configured', encryption: crypto.reason })
      }

      // Proven before it is stored. A token that cannot read the seat roster
      // cannot run a sync either, and the operator is here now with the
      // credential in hand — far better than discovering it at the next sync,
      // by which point nobody remembers which token was pasted.
      try {
        await listCopilotSeats(body.token, body.org)
      } catch (error) {
        // Logged for the same reason the other two call sites log: the thrown
        // error names why the walk stopped, and the 400 below deliberately
        // does not carry it. Kept at 400 with this wording because the
        // operator is standing here with a token they just pasted, so "that
        // token did not work" is the right first thing to say whatever broke.
        request.log.error(error)
        return reply.status(400).send({
          error: 'GitHub rejected this token for that organization',
          githubStatus: githubStatusFrom(error),
        })
      }

      const encryptedToken = crypto.seal(body.token, credentialContext(orgId))

      await fastify.db.transaction(async (tx) => {
        // The org name lives on `organizations.github_org`, which already
        // exists, rather than beside the ciphertext. It is not a secret, and
        // keeping it readable is what lets GET /status name the org while the
        // encryption key is missing.
        await tx
          .update(organizations)
          .set({ githubOrg: body.org })
          .where(eq(organizations.id, orgId))

        // A plain upsert, arbitrated by the unique index migration 0006 puts on
        // (org_id, provider). Reconnecting replaces the credential in place.
        // `last_sync_at` is deliberately left alone: a new token for the same
        // org does not undo the sync history behind it.
        await tx
          .insert(orgIntegrations)
          .values({ orgId, provider: PROVIDER, encryptedToken })
          .onConflictDoUpdate({
            target: [orgIntegrations.orgId, orgIntegrations.provider],
            set: { encryptedToken },
          })
      })

      // The token never travels back, not even a prefix of it. `connected` is
      // the whole of what the caller needs to know.
      return { connected: true, org: body.org }
    },
  )

  // DELETE /copilot/connection — 204 whether or not a row was there, so a
  // double click is not an error. `organizations.github_org` is left alone:
  // GET /status reads it only when connected, and keeping it means a
  // reconnect to the same org does not have to be retyped.
  fastify.delete(
    '/copilot/connection',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      await fastify.db
        .delete(orgIntegrations)
        .where(
          and(
            eq(orgIntegrations.orgId, request.user.orgId),
            eq(orgIntegrations.provider, PROVIDER),
          ),
        )
      return reply.status(204).send()
    },
  )

  // POST /copilot/sync — admin-triggered, never scheduled.
  fastify.post('/copilot/sync', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const body = SyncSchema.parse(request.body ?? {})
    const day = body.day ?? yesterdayUtc()
    const orgId = request.user.orgId

    const crypto = credentialCrypto()
    if (!crypto.available) {
      return reply
        .status(503)
        .send({ error: 'Credential encryption is not configured', encryption: crypto.reason })
    }

    const [row] = await fastify.db
      .select({
        encryptedToken: orgIntegrations.encryptedToken,
        githubOrg: organizations.githubOrg,
      })
      .from(orgIntegrations)
      .innerJoin(organizations, eq(organizations.id, orgIntegrations.orgId))
      .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, PROVIDER)))
      .limit(1)

    if (!row?.githubOrg) {
      return reply.status(404).send({ error: 'Copilot is not connected for this organization' })
    }

    let token: string
    try {
      token = crypto.open(row.encryptedToken, credentialContext(orgId))
    } catch {
      // A stored credential that no longer verifies is a real fault, and the
      // only repair is to store it again. Said in those words rather than
      // letting node's GCM message reach the client.
      return reply.status(500).send({
        error: 'The stored Copilot credential could not be decrypted. Reconnect the integration.',
      })
    }

    // Wrapped for the same reason PUT wraps its own call, and the failure here
    // is likelier: a fine-grained PAT carries an expiry, and the token that
    // worked at connect time is the one most likely to be revoked, expired or
    // rate-limited by the time a sync runs.
    //
    // Letting it escape was not merely untidy. `apiError` puts GitHub's whole
    // response body in the message, and the global handler in `build-server`
    // used to answer every unhandled error with `{ error: error.message }`,
    // so an upstream failure echoed raw GitHub response text back to the
    // caller, from a module that takes care elsewhere to keep a signed URL
    // out of a log. The handler now hides a 500's message, but a GitHub
    // failure is a 502 with the GitHub status attached, not a 500, so the
    // wrap stays. The status travels; the body does not.
    let seatPage: Awaited<ReturnType<typeof listCopilotSeats>>
    let report: CopilotReport
    try {
      ;[seatPage, report] = await Promise.all([
        listCopilotSeats(token, row.githubOrg),
        fetchCopilotUserDays(token, row.githubOrg, day),
      ])
    } catch (error) {
      request.log.error(error)
      return reply.status(502).send(upstreamFailure(error, 'sync'))
    }

    // Matched case-insensitively. GitHub logins are, and `github_username` is
    // typed in by hand on our side, so a capitalised entry would otherwise
    // drop a developer's whole day of spend without a word — the exact defect
    // `unmatchedLogins` exists to make visible, so it should not be one this
    // route creates for itself.
    const byLogin = new Map<string, CopilotUserDay[]>()
    for (const d of report.rows) {
      const key = d.login.toLowerCase()
      const bucket = byLogin.get(key)
      if (bucket) bucket.push(d)
      else byLogin.set(key, [d])
    }

    const logins = [...byLogin.keys()]
    const matchedUsers = logins.length
      ? await fastify.db
          .select({ id: users.id, login: sql<string>`lower(${users.githubUsername})` })
          .from(users)
          .where(
            and(eq(users.orgId, orgId), inArray(sql`lower(${users.githubUsername})`, logins)),
          )
      : []

    let matched = 0
    let written = 0
    let skipped = 0
    const claimed = new Set<string>()

    for (const user of matchedUsers) {
      const days = byLogin.get(user.login)
      if (!days) continue
      claimed.add(user.login)
      matched += days.length

      // Summed to exactly one event, never one per record.
      //
      // Every row a developer-day produces carries the identical key
      // `(user, 'copilot', day, 'copilot', null, 'copilot-org')`, so more than
      // one event for one developer is more than one row with one key in a
      // single INSERT. Postgres refuses that outright under ON CONFLICT DO
      // UPDATE, with "command cannot affect row a second time" (SQLSTATE
      // 21000), and under DO NOTHING it silently keeps the first and drops
      // the rest. Neither is acceptable, and the second is worse for being
      // quiet. A report sharded across several `download_links` is the
      // obvious way to get here, and nothing in GitHub's documentation
      // promises it will not be.
      //
      // Summing is also the right answer on the merits: the figures are
      // additive counts for one developer on one day, whatever file they
      // arrived in.
      const summed = days.reduce(
        (a, d) => ({
          inputTokens: a.inputTokens + d.inputTokens,
          outputTokens: a.outputTokens + d.outputTokens,
          totalTokens: a.totalTokens + d.totalTokens,
          costUsd: a.costUsd + d.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      )

      const events: UsageEvent[] = [
        {
          agent: 'copilot',
          // The requested day, not the record's own. A single-day report only
          // ever describes the day it was asked for, and using it keeps the
          // rebuild below over the same date as the rows it just wrote.
          date: day,
          // One row per developer-day. See the `ponytail:` note in
          // copilot.service.ts for why this is never split per model.
          modelName: 'copilot',
          inputTokens: summed.inputTokens,
          outputTokens: summed.outputTokens,
          // Copilot reports neither, so these are 0 rather than absent — the
          // column is NOT NULL and a zero is the honest figure.
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          totalTokens: summed.totalTokens,
          costUsd: summed.costUsd,
          // Copilot seats are paid for. A credit-derived cost is approximate,
          // but it is not free.
          isFreeTier: false,
        },
      ]

      // One transaction per developer, the same shape POST /v1/usage uses and
      // for the same reason: a failed rebuild must not leave spend recorded
      // but missing from the snapshot. Per developer rather than per org so
      // one bad row cannot discard everyone else's sync.
      const counts = await fastify.db.transaction(async (tx) => {
        const c = await upsertUsageEvents(tx, user.id, null, day, events, 'copilot-org')
        // Safe to repeat, though not by inserting nothing: an org row now
        // overwrites on conflict, so a re-sync replaces the day's figures
        // with whatever GitHub currently reports. The rebuild recomputes the
        // day from scratch rather than adding to it, and a budget alert
        // latches per calendar month instead of firing again, so repeating a
        // sync converges rather than accumulating.
        await rebuildDailySnapshot(tx, user.id, day)
        await evaluateBudgetAlerts(tx, orgId, user.id, day)
        return c
      })

      written += counts.accepted
      skipped += counts.skipped
    }

    // Only a sync that actually read a report counts as a sync. Stamping this
    // unconditionally made an unpublished day indistinguishable from a quiet
    // one on the panel, which would then show a last-synced date for a run
    // that fetched nothing. A stalled `lastSyncAt` is the signal an operator
    // needs when a token silently lacks the metrics permission.
    if (report.published) {
      await fastify.db
        .update(orgIntegrations)
        .set({ lastSyncAt: new Date() })
        .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, PROVIDER)))
    }

    return {
      day,
      // False means GitHub has no report for this day yet, which is the
      // expected answer near the day boundary and is also what a token
      // without Copilot metrics permission looks like, since GitHub answers
      // 404 rather than 403 for a resource a token cannot see. Either way the
      // remedy is the caller's to choose, so the distinction travels.
      reportPublished: report.published,
      seats: { total: seatPage.totalSeats, skippedNullAssignee: seatPage.skippedNullAssignee },
      usage: { matched, written, skipped },
      // Never optional, and never empty by omission. A developer whose
      // `github_username` is unset contributes nothing and looks identical to
      // one who did no work, which is the whole of what BW-33 was. Reported in
      // GitHub's own casing, not the lowercased match key, so an operator can
      // paste it straight into the user record. Sorted so two runs of the same
      // day read the same.
      unmatchedLogins: logins
        .filter((l) => !claimed.has(l))
        .map((l) => byLogin.get(l)![0].login)
        .sort(),
    }
  })

  // GET /copilot/seats. Who holds a licence, and which of those seats is idle.
  //
  // Read live and stored nowhere. A roster is current state rather than a time
  // series, so a table here would hold a copy that disagrees with GitHub
  // between syncs while GitHub remains the thing that actually issues seats.
  // The cost of that choice is a full seat walk per request, which is why
  // nothing calls this on page load.
  fastify.get('/copilot/seats', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { idleAfterDays } = SeatsQuerySchema.parse(request.query)
    const orgId = request.user.orgId

    const crypto = credentialCrypto()
    if (!crypto.available) {
      return reply
        .status(503)
        .send({ error: 'Credential encryption is not configured', encryption: crypto.reason })
    }

    const [row] = await fastify.db
      .select({
        encryptedToken: orgIntegrations.encryptedToken,
        githubOrg: organizations.githubOrg,
      })
      .from(orgIntegrations)
      .innerJoin(organizations, eq(organizations.id, orgIntegrations.orgId))
      .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, PROVIDER)))
      .limit(1)

    if (!row?.githubOrg) {
      return reply.status(404).send({ error: 'Copilot is not connected for this organization' })
    }

    let token: string
    try {
      token = crypto.open(row.encryptedToken, credentialContext(orgId))
    } catch {
      return reply.status(500).send({
        error: 'The stored Copilot credential could not be decrypted. Reconnect the integration.',
      })
    }

    // Wrapped for the reason the sync route wraps its own call, written out
    // above: the failure is GitHub's, so it answers 502 with the GitHub status
    // rather than a generic 500. The status travels; the body does not.
    let seatPage: Awaited<ReturnType<typeof listCopilotSeats>>
    try {
      seatPage = await listCopilotSeats(token, row.githubOrg)
    } catch (error) {
      request.log.error(error)
      return reply.status(502).send(upstreamFailure(error, 'seat roster read'))
    }

    // Matched the way POST /copilot/sync matches, down to the lowercasing on
    // both sides. GitHub logins are case-insensitive and `github_username` is
    // typed in by hand here, so a second matcher that disagreed would link a
    // developer on one route and call them unknown on the other.
    const logins = [...new Set(seatPage.seats.map((s) => s.login.toLowerCase()))]
    const linked = logins.length
      ? await fastify.db
          .select({
            id: users.id,
            name: users.name,
            login: sql<string>`lower(${users.githubUsername})`,
          })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(sql`lower(${users.githubUsername})`, logins)))
      : []
    // `github_username` carries no uniqueness constraint, so one login can
    // match two users. The seat still goes to exactly one of them, the lowest
    // id, so two reads of the same roster agree; and the login is reported
    // so nobody reads that pick as a fact. Chosen here rather than by ORDER
    // BY so the rule does not depend on which row the driver hands back
    // first.
    const userByLogin = new Map<string, (typeof linked)[number]>()
    const ambiguous = new Set<string>()
    for (const u of linked) {
      const held = userByLogin.get(u.login)
      if (!held) {
        userByLogin.set(u.login, u)
        continue
      }
      ambiguous.add(u.login)
      if (u.id < held.id) userByLogin.set(u.login, u)
    }

    const cutoff = Date.now() - idleAfterDays * 86_400_000

    const seats: CopilotSeatRow[] = seatPage.seats.map((seat) => {
      const user = userByLogin.get(seat.login.toLowerCase())
      // Strict, so a seat used exactly `idleAfterDays` ago is still active.
      // An unreadable timestamp parses to NaN and `NaN < cutoff` is false, so
      // it lands as active too. That is wanted rather than overlooked: garbage
      // must not inflate the idle dollar figure an admin acts on.
      const idle = seat.lastActivityAt === null || Date.parse(seat.lastActivityAt) < cutoff

      return {
        login: seat.login,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
        status: idle ? 'idle' : 'active',
        lastActivityAt: seat.lastActivityAt,
        lastActivityEditor: seat.lastActivityEditor,
        planType: seat.planType,
        monthlyCostUsd: SEAT_MONTHLY_USD[seat.planType] ?? null,
        pendingCancellationDate: seat.pendingCancellationDate,
      }
    })

    // Idle first, then longest idle first, then login. Compared as plain
    // strings because ISO-8601 sorts lexicographically and does so the same
    // way in every locale, with a null collapsing to '' and sorting ahead of
    // any real timestamp. Two reads of the same roster have to read the same.
    seats.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'idle' ? -1 : 1
      const at = a.lastActivityAt ?? ''
      const bt = b.lastActivityAt ?? ''
      if (at !== bt) return at < bt ? -1 : 1
      return a.login.localeCompare(b.login)
    })

    const idleSeats = seats.filter((s) => s.status === 'idle')

    const response: CopilotSeatsResponse = {
      org: row.githubOrg,
      idleAfterDays,
      totalSeats: seatPage.totalSeats,
      skippedNullAssignee: seatPage.skippedNullAssignee,
      seats,
      summary: {
        active: seats.length - idleSeats.length,
        idle: idleSeats.length,
        unlinked: seats.filter((s) => s.userId === null).length,
        idleMonthlyCostUsd: idleSeats.reduce((sum, s) => sum + (s.monthlyCostUsd ?? 0), 0),
        unpricedIdleSeats: idleSeats.filter((s) => s.monthlyCostUsd === null).length,
      },
      // GitHub's casing, sorted, and never absent, on the same terms as
      // `unmatchedLogins` above.
      ambiguousLogins: seatPage.seats
        .filter((s) => ambiguous.has(s.login.toLowerCase()))
        .map((s) => s.login)
        .sort(),
    }
    return response
  })
}
