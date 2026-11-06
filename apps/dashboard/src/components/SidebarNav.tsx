'use client'

import Link, { useLinkStatus } from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/users', label: 'Leaderboard' },
  { href: '/trends', label: 'Trends' },
  { href: '/activity', label: 'Activity' },
  { href: '/projects', label: 'Projects' },
  { href: '/devices', label: 'Devices' },
  { href: '/setup', label: 'Setup' },
  { href: '/admin', label: 'Admin' },
]

/**
 * The sidebar carries the selected date range from page to page.
 *
 * These used to be bare `<Link href="/users">`, so the query string died on
 * every click: you picked "All time" on Overview, clicked Trends, and landed
 * back on that page's own default. Forwarding the params is what makes the
 * range stick, and keeping it in the URL is what makes it survive a refresh —
 * no extra storage, and the link is still shareable.
 */
/**
 * The clicked item answers immediately, even though the page behind it is still
 * being rendered on the server. A dashboard page waits on a session lookup and
 * an API round trip — half a second on a warm function, a couple of seconds on
 * a cold one — and with nothing acknowledging the click the whole app read as
 * frozen. `useLinkStatus` is scoped to the link that was actually pressed, so
 * the feedback lands on the thing the reader just touched.
 */
function NavPending() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <span
      role="status"
      aria-label="Loading"
      className="absolute inset-y-0 right-3 my-auto size-3 animate-spin rounded-full border border-ink-3 border-t-transparent"
    />
  )
}

export function SidebarNav({
  orientation = 'vertical',
  role,
}: {
  orientation?: 'vertical' | 'horizontal'
  role?: string | null
}) {
  const pathname = usePathname()
  const params = useSearchParams().toString()
  const query = params ? `?${params}` : ''
  const horizontal = orientation === 'horizontal'
  // Cosmetic only: `/admin` still redirects non-admins on its own, via
  // getUserRole() in the page itself. This just stops a dead link from
  // showing up in the first place.
  const items = NAV.filter((item) => item.href !== '/admin' || role === 'admin')

  return (
    <nav
      className={horizontal ? '' : 'flex-1 px-3'}
      aria-label={horizontal ? 'Main (compact)' : 'Main'}
    >
      <ul className={horizontal ? 'flex w-max items-center gap-1 px-1' : 'space-y-0.5'}>
        {items.map((item) => {
          const active = pathname === item.href
          return (
            <li key={item.href}>
              <Link
                href={`${item.href}${query}`}
                aria-current={active ? 'page' : undefined}
                className={`relative rounded-lg text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                  horizontal ? 'block px-3 py-1.5 whitespace-nowrap' : 'block px-3 py-2'
                } ${
                  active
                    ? 'bg-surface-3 font-medium text-ink'
                    : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {active && !horizontal && (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand"
                  />
                )}
                {item.label}
                {!horizontal && <NavPending />}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
