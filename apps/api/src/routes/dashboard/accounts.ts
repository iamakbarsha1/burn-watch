import type { ClaudeEnrichmentDoc, UserId } from '@burn-watch/db'
import type { ClaudeAccountFlag, ClaudeAccountsResponse, ClaudeOrgRow } from '@burn-watch/shared'

export type AccountDay = Pick<ClaudeEnrichmentDoc, 'userId' | 'date'> &
  Partial<Pick<ClaudeEnrichmentDoc, 'accountHashes' | 'claudeOrgHashes'>>

export interface AccountPerson {
  userId: UserId
  hashedDays: number
  accounts: string[]
  outsideOrgDays: number | null
  claudeSeat: boolean
  flags: ClaudeAccountFlag[]
}

interface Seen {
  users: Set<UserId>
  dates: Set<string>
  first: string
}

/** Ordinal labels by first seen, then by hash, so one range always reads the same. */
function labelled(seen: Map<string, Seen>, word: string): Map<string, string> {
  const order = [...seen].sort(([a, x], [b, y]) => x.first.localeCompare(y.first) || a.localeCompare(b))
  return new Map(order.map(([hash], i) => [hash, `${word} ${i + 1}`]))
}

function see(map: Map<string, Seen>, hash: string, userId: UserId, date: string) {
  const s = map.get(hash) ?? { users: new Set(), dates: new Set(), first: date }
  s.users.add(userId)
  s.dates.add(date)
  if (date < s.first) s.first = date
  map.set(hash, s)
}

/**
 * R2 B6: group one doc per user per day into Claude orgs, accounts and per-person
 * flags. Day level only (Decision 4): a day with two accounts and two orgs
 * cannot say which account was in which org. `own` empty means the company org
 * is not set, so no outside-org or seat flags (Decision 5).
 */
export function groupAccounts(
  docs: AccountDay[],
  opts: { own: string[]; seated: Set<UserId>; seatsEntered: number; viewerId: string },
): Pick<ClaudeAccountsResponse, 'coverage' | 'companyOrgUsers' | 'orgs' | 'accounts'> & { people: AccountPerson[] } {
  const own = new Set(opts.own)
  const orgs = new Map<string, Seen>()
  const accounts = new Map<string, Seen>()
  const users = new Set<UserId>()
  const per = new Map<UserId, { days: number; accounts: Set<string>; outside: number; company: number }>()

  for (const d of docs) {
    users.add(d.userId)
    const acc = d.accountHashes ?? []
    const org = d.claudeOrgHashes ?? []
    if (acc.length === 0 && org.length === 0) continue
    const p = per.get(d.userId) ?? { days: 0, accounts: new Set(), outside: 0, company: 0 }
    p.days++
    for (const h of acc) {
      see(accounts, h, d.userId, d.date)
      p.accounts.add(h)
    }
    for (const h of org) see(orgs, h, d.userId, d.date)
    if (org.some((h) => !own.has(h))) p.outside++
    if (org.some((h) => own.has(h))) p.company++
    per.set(d.userId, p)
  }

  const orgLabel = labelled(orgs, 'Claude org')
  const accLabel = labelled(accounts, 'Account')
  const ownSet = own.size > 0
  const seatsCompared = ownSet && opts.seatsEntered > 0

  const people = [...per].map<AccountPerson>(([userId, p]) => {
    const claudeSeat = opts.seated.has(userId)
    const flags: ClaudeAccountFlag[] = []
    if ([...p.accounts].some((h) => accounts.get(h)!.users.size > 1)) flags.push('shared')
    if (ownSet && p.outside > 0) flags.push('outside-org')
    if (p.accounts.size > 1) flags.push('several')
    if (seatsCompared && claudeSeat && p.company === 0) flags.push('seat-no-use')
    if (seatsCompared && !claudeSeat && p.company > 0) flags.push('use-no-seat')
    return {
      userId,
      hashedDays: p.days,
      accounts: [...p.accounts].map((h) => accLabel.get(h)!).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      outsideOrgDays: ownSet ? p.outside : null,
      claudeSeat,
      flags,
    }
  })

  return {
    coverage: { users: users.size, hashed: per.size },
    companyOrgUsers: ownSet ? [...per.values()].filter((p) => p.company > 0).length : null,
    orgs: [...orgLabel].map<ClaudeOrgRow>(([id, label]) => ({
      id,
      label,
      users: orgs.get(id)!.users.size,
      days: orgs.get(id)!.dates.size,
      ours: own.has(id),
      includesYou: orgs.get(id)!.users.has(opts.viewerId as UserId),
    })),
    accounts: [...accLabel].map(([hash, label]) => ({
      label,
      users: accounts.get(hash)!.users.size,
      days: accounts.get(hash)!.dates.size,
      shared: accounts.get(hash)!.users.size > 1,
    })),
    people,
  }
}
