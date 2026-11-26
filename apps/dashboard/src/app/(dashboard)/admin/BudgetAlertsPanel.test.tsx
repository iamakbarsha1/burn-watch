import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BudgetAlert } from '@burn-watch/shared'

vi.mock('./actions', () => ({
  createBudgetAlertAction: vi.fn(),
  updateBudgetAlertAction: vi.fn(),
  deleteBudgetAlertAction: vi.fn(),
}))

const { BudgetAlertsTable, CreateBudgetAlertForm } = await import('./BudgetAlertsPanel')

const alert = (over: Partial<BudgetAlert>): BudgetAlert => ({
  id: 'a1',
  type: 'api-spend',
  agent: null,
  monthlyLimitUsd: 0,
  threshold: 0.8,
  createdAt: '2026-11-01T00:00:00.000Z',
  trippedAt: null,
  tripped: false,
  monthToDateSpendUsd: 0,
  idleDays: null,
  limitHits: null,
  idleSeatCount: null,
  people: null,
  ...over,
})

describe('budget alerts', () => {
  it('has no person picker on the create form', () => {
    const html = renderToStaticMarkup(<CreateBudgetAlertForm />)
    expect(html).not.toContain('name="userId"')
    expect(html).toContain('Unused seat')
    expect(html).not.toMatch(/idle seat/i)
  })

  it('shows counts, not names', () => {
    const html = renderToStaticMarkup(
      <BudgetAlertsTable
        alerts={[
          alert({ id: 'a1', type: 'idle-seat', idleDays: 30, idleSeatCount: 3, tripped: true }),
          alert({ id: 'a2', type: 'limit-hit', limitHits: 2, people: 4, tripped: true }),
          alert({ id: 'a3', type: 'api-spend', monthlyLimitUsd: 100, monthToDateSpendUsd: 12.5 }),
        ]}
      />,
    )
    expect(html).toContain('3 unused')
    expect(html).toContain('4 people')
    expect(html).toContain('$12.50')
    expect(html).toContain('href="/adoption?idleDays=30"')
    expect(html).not.toContain('name="userId"')
    expect(html).not.toContain('Scope')
  })
})
