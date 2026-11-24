import { ACTIVE_DAYS_PER_WEEK, MIN_FEATURES, type FeatureKey, type MyOnboarding, type OnboardingState } from '@burn-watch/shared'
import { fetchMyUsage } from '@/lib/api'
import { agentById } from '@/lib/agents'
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
  missed: 'Window ended',
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

/** v2 Phase 1: the caller's own numbers. Any role; nobody else can read them. */
export default async function MyUsagePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const { from, to } = resolveRange(params)
  const usage = await fetchMyUsage(from, to).catch(() => null)

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
              label="Current streak"
              value={plural(usage.streak.current, 'day')}
              hint={`Longest ${plural(usage.streak.longest, 'day')}. Only visible to you.`}
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

          <Section title="Help others">
            <HelpVolunteerForm helpVolunteer={usage.helpVolunteer} />
          </Section>

          <p className="text-xs text-ink-2">
            Active day: any tokens that day (UTC). Streaks count all time, and weekends do not break one. Today and
            yesterday may not be synced yet.
          </p>
        </>
      )}
    </div>
  )
}
