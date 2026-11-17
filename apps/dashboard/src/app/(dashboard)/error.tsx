'use client'

import { useEffect } from 'react'
import { buttonClass, EmptyState, PageHeader } from '@/components/ui'

/**
 * What every dashboard page shows when its read fails.
 *
 * Each page used to wrap its one fetch in `try {} catch {}` and fall through to
 * its own empty state, so a failed read rendered "No data for this range" — the
 * same words an org with no spend sees. On a page whose entire job is reporting
 * what happened, that is the worst available answer: it is confident, it is
 * wrong, and nothing on screen suggests looking further.
 *
 * Deleting those five catches lets the error reach this boundary instead. The
 * message is deliberately not rendered: React strips a server-side error's
 * message in production and hands the client a digest, so printing it would
 * show operators real text in development and an empty string in production.
 * The digest is what correlates this screen with the server log that does have
 * the message, so that is what goes on the page.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('dashboard read failed', error)
  }, [error])

  return (
    <div>
      <PageHeader title="This page could not load" />
      <EmptyState
        title="The API did not answer this read"
        message={
          <>
            <span className="block">
              Nothing here is a report about your usage — the data was never fetched. The server log
              carries the reason.
            </span>
            {error.digest && (
              <span className="mt-2 block font-mono text-xs text-ink-3">
                reference {error.digest}
              </span>
            )}
            <button type="button" onClick={reset} className={`${buttonClass} mt-4`}>
              Try again
            </button>
          </>
        }
      />
    </div>
  )
}
