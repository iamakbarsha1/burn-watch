'use client'

import type { ReactNode } from 'react'
import { inputClass } from '@/components/ui'

/**
 * Login and signup were the same card copied twice, down to the hard-coded
 * `#7f1d1d` error box. One shell, so a change to the sign-in surface cannot
 * land on only one of them.
 */
export function AuthCard({
  title,
  subtitle,
  error,
  footer,
  children,
}: {
  title: string
  subtitle: string
  error?: string
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-[var(--radius-card)] border border-line bg-surface-1 p-7">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-2">{subtitle}</p>

          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad"
            >
              {error}
            </p>
          )}

          {children}
        </div>
        <p className="mt-4 text-center text-sm text-ink-2">{footer}</p>
      </div>
    </div>
  )
}

export function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-ink-2">
        {label}
      </label>
      <input id={id} className={`${inputClass} w-full disabled:opacity-60`} {...props} />
    </div>
  )
}

export const authLinkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'
