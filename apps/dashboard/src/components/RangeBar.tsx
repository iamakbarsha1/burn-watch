'use client'

import { usePathname } from 'next/navigation'
import { DateRangePicker } from './DateRangePicker'

/**
 * One filter row, above everything it scopes — rather than a copy of the picker
 * inside each page header, which is how it drifted out of sync before.
 *
 * It hides itself on the pages a date range means nothing to. Devices, Setup
 * and Admin are not time-sliced, and a control that visibly does nothing is
 * worse than no control.
 */
const RANGE_SCOPED = new Set(['/', '/users', '/trends', '/activity', '/projects'])

export function RangeBar() {
  const pathname = usePathname()
  if (!RANGE_SCOPED.has(pathname)) return null

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface-0/85 backdrop-blur-md">
      <div className="flex justify-end px-4 py-3 sm:px-6">
        <DateRangePicker />
      </div>
    </div>
  )
}
