import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession, getUserRole } from '@/lib/session'
import { SidebarNav } from '@/components/SidebarNav'
import { RangeBar } from '@/components/RangeBar'
import { SignOutButton } from './SignOutButton'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Replaces the old Edge middleware, which Vercel Services does not allow.
  // This gate is also stronger than the one it replaces: the middleware only
  // checked that a session cookie existed, while `getSession` validates it.
  const session = await getSession()
  if (!session) redirect('/login')
  const role = await getUserRole()

  return (
    <div className="flex min-h-screen bg-surface-0">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-surface-1 py-5 md:flex">
        <Link
          href="/"
          className="mb-6 rounded-lg px-6 text-base font-semibold tracking-tight text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          BurnWatch
        </Link>

        {/* useSearchParams inside the nav needs a boundary so the whole shell
            does not get pulled out of the static render. */}
        <Suspense fallback={<div className="flex-1" />}>
          <SidebarNav role={role} />
        </Suspense>

        {session.user && (
          <div className="mt-4 border-t border-line px-6 pt-4">
            <p className="truncate text-xs text-ink-2" title={session.user.email}>
              {session.user.email}
            </p>
            <SignOutButton />
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Small screens lose the sidebar, so the nav moves to a scrolling
            strip at the top rather than disappearing. */}
        <header className="sticky top-0 z-30 border-b border-line bg-surface-1 md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight text-ink">
              BurnWatch
            </Link>
            <SignOutButton />
          </div>
          <div className="scroll-strip px-2 pb-2">
            <Suspense fallback={null}>
              <SidebarNav orientation="horizontal" role={role} />
            </Suspense>
          </div>
        </header>

        <Suspense fallback={null}>
          <RangeBar />
        </Suspense>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  )
}
