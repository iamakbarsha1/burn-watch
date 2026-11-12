import type { ReactNode } from 'react'

/**
 * The shared vocabulary every page is built from. Before this, each page
 * inlined its own card padding, border radius and muted grey, and they had
 * drifted apart; worse, inline styles cannot express hover, focus or
 * breakpoints at all, so nothing in the dashboard reacted to a pointer.
 */

export const cardClass =
  'rounded-[var(--radius-card)] border border-line bg-surface-1'

/** Shared control chrome, so an input and a button line up without fiddling. */
export const inputClass =
  'h-10 rounded-lg border border-line bg-surface-0 px-3 text-sm text-ink ' +
  'placeholder:text-ink-3 outline-none transition-colors ' +
  'focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40'

export const buttonClass =
  'inline-flex h-10 items-center justify-center rounded-lg bg-brand px-4 text-sm ' +
  'font-medium text-white transition-colors outline-none hover:bg-brand/85 ' +
  'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-50'

export const secondaryButtonClass =
  'inline-flex h-10 items-center justify-center rounded-lg border border-line ' +
  'bg-surface-2 px-4 text-sm font-medium text-ink transition-colors outline-none ' +
  'hover:border-line-strong hover:bg-surface-3 focus-visible:ring-2 ' +
  'focus-visible:ring-brand/50'

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`${cardClass} ${className}`}>{children}</div>
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
    </div>
  )
}

export function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`${cardClass} p-5 sm:p-6`}>
      <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
      {description && <p className="mt-1 mb-4 text-sm text-ink-2">{description}</p>}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </section>
  )
}

/**
 * A stat tile is a chart with one mark, so it follows the same rules: the
 * figure wears ink, never a series colour, and takes proportional figures —
 * tabular digits make a large standalone number look gappy.
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  accent,
}: {
  label: string
  value: string
  hint?: string
  delta?: number
  accent?: string
}) {
  return (
    <div
      className={`${cardClass} group relative overflow-hidden p-5 transition-colors hover:border-line-strong`}
    >
      {accent && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: accent }}
        />
      )}
      <p className="text-xs font-medium tracking-wide text-ink-2 uppercase">{label}</p>
      <p className="mt-2 text-3xl leading-none font-semibold text-ink">{value}</p>
      {delta !== undefined && (
        <p className={`mt-2 text-xs ${delta >= 0 ? 'text-warn' : 'text-good'}`}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs yesterday
        </p>
      )}
      {hint && <p className="mt-2 text-xs text-ink-3">{hint}</p>}
    </div>
  )
}

export function EmptyState({ title, message }: { title: string; message?: ReactNode }) {
  return (
    <div className={`${cardClass} px-6 py-14 text-center`}>
      <p className="text-sm font-medium text-ink">{title}</p>
      {message && <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">{message}</p>}
    </div>
  )
}

/* ---------- table ---------- */

export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className={`${cardClass} overflow-hidden`}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

export function Th({
  children,
  numeric = false,
}: {
  children: ReactNode
  numeric?: boolean
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-medium tracking-wide text-ink-2 uppercase whitespace-nowrap ${
        numeric ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}

/** Columns of figures only line up with tabular digits — that is what they are for. */
export function Td({
  children,
  numeric = false,
  className = '',
}: {
  children: ReactNode
  numeric?: boolean
  className?: string
}) {
  return (
    <td
      className={`px-4 py-3 align-middle text-sm ${
        numeric ? 'text-right tabular-nums whitespace-nowrap' : 'text-left'
      } ${className}`}
    >
      {children}
    </td>
  )
}

export function Tr({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t border-line transition-colors hover:bg-surface-2">{children}</tr>
  )
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-ink-2">
        {children}
      </td>
    </tr>
  )
}

/**
 * Status never rides on colour alone — each tone ships with its own word, and
 * the dot is the redundant channel rather than the only one.
 */
const BADGE_TONES = {
  good: 'border-good/35 bg-good/12 text-good',
  warn: 'border-warn/35 bg-warn/12 text-warn',
  bad: 'border-bad/35 bg-bad/12 text-bad',
  neutral: 'border-line-strong bg-surface-2 text-ink-2',
} as const

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof BADGE_TONES
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

/** A dot in the series hue, so a legend or a table cell names its agent twice. */
export function SeriesDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  )
}
