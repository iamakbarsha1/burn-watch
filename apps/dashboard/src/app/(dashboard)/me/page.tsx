import {
  ACTIVE_DAYS_PER_WEEK,
  type AuditMeResponse,
  MIN_FEATURES,
  type FeatureKey,
  type FreeTierReason,
  type MyOnboarding,
  type MyUsageResponse,
  type OnboardingState,
  type SetupCheckReason,
} from '@burn-watch/shared'
import { fetchAuditMe, fetchMyUsage } from '@/lib/api'
import { SURFACES } from '@/lib/audit'
import { agentById } from '@/lib/agents'
import { FLAG_LABEL } from '@/lib/account-flags'
import { formatCost, formatCount, formatRange, formatTokens, resolveRange } from '@/lib/format'
import { Badge, EmptyRow, EmptyState, PageHeader, Section, StatTile, TableFrame, Td, Th, Tr } from '@/components/ui'
import { HelpVolunteerForm } from './HelpVolunteerForm'

type Params = Record<string, string | undefined>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Names joined, or a dash for none. */
const listOf = (names: string[]) => (names.length ? names.join(', ') : '—')

const WINDOW_DAYS = 14

const FEATURES: Record<FeatureKey, string> = {
  mcp: 'MCP',
  skills: 'Skills',
  subagents: 'Subagents',
  plan: 'Plan mode',
  sdk: 'SDK',
}

const STATES: Record<OnboardingState, string> = {
  onboarded: 'Done',
  inProgress: 'In progress',
  windowEnded: 'Window ended',
  noFeatureData: 'No Claude Code use',
}

/** v2 Phase 2: the person's own first 14 days. Nobody else sees this. */
function FirstDays({ o }: { o: MyOnboarding }) {
  const items = [
    { label: `Tokens on ${ACTIVE_DAYS_PER_WEEK} or more days in week 1`, have: o.activeWeek1, need: ACTIVE_DAYS_PER_WEEK, unit: 'days' },
    { label: `Tokens on ${ACTIVE_DAYS_PER_WEEK} or more days in week 2`, have: o.activeWeek2, need: ACTIVE_DAYS_PER_WEEK, unit: 'days' },
    { label: `${MIN_FEATURES} or more Claude Code features`, have: o.features.length, need: MIN_FEATURES, unit: 'features' },
  ]
  return (
    <Section
      title="Your first 14 days"
      description={`From your first sync on ${o.firstSync}. Only you can see this.`}
    >
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink">
        <Badge tone={o.state === 'onboarded' ? 'good' : 'neutral'}>{STATES[o.state]}</Badge>
        {o.state !== 'onboarded' && o.dayOfWindow < WINDOW_DAYS && (
          <span className="text-ink-2">{`Day ${o.dayOfWindow} of ${WINDOW_DAYS}`}</span>
        )}
      </p>
      <ul className="space-y-1 text-sm">
        {items.map((i) => (
          <li key={i.label} className="flex flex-wrap gap-x-3">
            <span className="text-ink">{i.label}</span>
            <span className="text-ink-2">{i.have >= i.need ? 'Done' : `${i.have} of ${i.need} ${i.unit}`}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-2">
        {`Features used: ${listOf(o.features.map((k) => FEATURES[k]))}. Features count MCP, skills, subagents, plan mode and SDK.`}
      </p>
    </Section>
  )
}

/** A seat counts as unused from this many days, the Unused seats card's default. */
const UNUSED_DAYS = 14

const FREE_TIER_NOTE: Record<FreeTierReason, string> = {
  'free-tier-agent': 'free tier: the provider may train on what you send',
  'unpriced-model': 'no price on file for this model, so it may be a free tier',
}

const CHECK_NOTE: Record<SetupCheckReason, string> = {
  'agent-blocked': 'this agent is not on the org\'s allowed list',
  'agent-not-set': 'the org has no rule for this agent yet',
  'model-not-listed': 'this model is not on the org\'s list for this agent',
}

const agentModel = (agent: string, model: string) => `${agentById(agent)?.label ?? agent} · ${model}`

/** v2 Phase 3: the facts an admin can see about you, shown to you first. */
function YourSetup({ u }: { u: MyUsageResponse }) {
  const empty = !u.seats.length && !u.freeTier.length && !u.setupChecks.length && !u.accountFlags.length
  return (
    <Section title="Your setup" description="Your seats and anything about your setup worth a look. Admins see the same.">
      {empty ? (
        <p className="text-sm text-ink-2">Nothing to note: no seats on file and nothing outside the org&apos;s setup.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {u.seats.map((s) => (
            <li key={`seat:${s.agent}`} className="flex flex-wrap gap-x-3">
              <span className="text-ink">{`${agentById(s.agent)?.label ?? s.agent} seat`}</span>
              <span className="text-ink-2">
                {s.daysUnused >= UNUSED_DAYS ? `unused for ${s.daysUnused} days` : 'in use'}
              </span>
            </li>
          ))}
          {u.freeTier.map((f) => (
            <li key={`free:${f.agent}:${f.modelName}`} className="flex flex-wrap gap-x-3">
              <span className="text-ink">{agentModel(f.agent, f.modelName)}</span>
              <span className="text-ink-2">{`${FREE_TIER_NOTE[f.reason]} (${plural(f.days, 'day')})`}</span>
            </li>
          ))}
          {u.setupChecks.map((c) => (
            <li key={`check:${c.agent}:${c.modelName}`} className="flex flex-wrap gap-x-3">
              <span className="text-ink">{agentModel(c.agent, c.modelName)}</span>
              <span className="text-ink-2">{`outside the org's agent rules: ${CHECK_NOTE[c.reason]} (${plural(c.days, 'day')})`}</span>
            </li>
          ))}
          {u.accountFlags.map((f) => (
            <li key={`flag:${f}`} className="flex flex-wrap gap-x-3">
              <span className="text-ink">Claude account</span>
              <span className="text-ink-2">{FLAG_LABEL[f]}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const scopeLabel = (scope: string | null) =>
  scope === 'org' ? 'Whole org' : scope === 'managed teams' ? 'Teams they manage' : (scope ?? 'A deleted team')

/** v2 Phase 4: views of groups the caller is in. null: the read failed. */
function WhoViewed({ audit }: { audit: AuditMeResponse | null }) {
  return (
    <Section
      title="Who viewed my data"
      description="Views that included you: the whole org, a team you are in, or the teams your manager runs. Each view counts the people it covered at the time. Views before 2026-11-27 go by the teams you are in today."
    >
      {audit === null ? (
        <p className="text-sm text-ink-2">Could not read who viewed your data. Try again in a moment.</p>
      ) : (
        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Who</Th>
                <Th>What they opened</Th>
                <Th>Covering</Th>
                <Th>Day</Th>
                <Th numeric>Views</Th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.length === 0 ? (
                <EmptyRow colSpan={5}>No one has viewed data that includes you in the last 90 days.</EmptyRow>
              ) : (
                audit.rows.map((r, i) => (
                  <Tr key={i}>
                    <Td className="text-ink">
                      {r.viewer.name ?? 'A removed user'} <span className="text-ink-2">{`(${r.viewer.role})`}</span>
                    </Td>
                    <Td>{SURFACES[r.surface] ?? r.surface}</Td>
                    <Td>{scopeLabel(r.scope)}</Td>
                    <Td>{r.at.slice(0, 10)}</Td>
                    <Td numeric>{formatCount(r.count)}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>
      )}
    </Section>
  )
}

/** v2 Phase 1: the caller's own numbers. Any role; nobody else can read them. */
export default async function MyUsagePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const { from, to } = resolveRange(params)
  const [usage, audit] = await Promise.all([
    fetchMyUsage(from, to).catch(() => null),
    fetchAuditMe().catch(() => null),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title="My usage" subtitle={formatRange(from, to)} />

      <p className="text-sm text-ink-2">
        Only you can see this page&apos;s numbers. Managers and admins see team totals, never yours.
      </p>

      {usage === null ? (
        <EmptyState title="Could not read your usage." message="Try again in a moment." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile label="Active days" value={`${usage.activeDays} of ${usage.rangeDays}`} hint="Days with any tokens" />
            <StatTile
              label="Consecutive days"
              value={plural(usage.consecutiveDays.current, 'day')}
              hint={`Longest ${plural(usage.consecutiveDays.longest, 'day')}. Only visible to you.`}
            />
            <StatTile label="Tokens" value={formatTokens(usage.totalTokens)} />
            <StatTile label="Sessions" value={formatCount(usage.sessions)} />
            <StatTile label="Cost" value={formatCost(usage.totalCostUsd)} />
          </div>

          <Section title="By agent">
            <TableFrame>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th numeric>Tokens</Th>
                    <Th numeric>Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {usage.agents.length === 0 ? (
                    <EmptyRow colSpan={3}>No usage in this range.</EmptyRow>
                  ) : (
                    usage.agents.map((a) => (
                      <Tr key={a.agent}>
                        <Td className="font-medium text-ink">{agentById(a.agent)?.label ?? a.agent}</Td>
                        <Td numeric>{formatTokens(a.tokens)}</Td>
                        <Td numeric>{formatCost(a.costUsd)}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableFrame>
          </Section>

          <Section title="What you used">
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-ink-2">Agents</dt>
                <dd className="text-ink">{listOf(usage.features.agents.map((a) => agentById(a)?.label ?? a))}</dd>
              </div>
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-ink-2">MCP servers</dt>
                <dd className="text-ink">{listOf(usage.features.mcpServers)}</dd>
              </div>
            </dl>
          </Section>

          {usage.onboarding && <FirstDays o={usage.onboarding} />}

          <YourSetup u={usage} />

          <Section title="Help others">
            <HelpVolunteerForm helpVolunteer={usage.helpVolunteer} />
          </Section>

          <p className="text-xs text-ink-2">
            Active day: any tokens that day (UTC). Consecutive days count all time, and weekends do not break a run. Today and
            yesterday may not be synced yet.
          </p>
        </>
      )}

      <WhoViewed audit={audit} />
    </div>
  )
}
