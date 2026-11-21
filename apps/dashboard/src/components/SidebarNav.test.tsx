import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  useLinkStatus: () => ({ pending: false }),
}))

const { SidebarNav } = await import('./SidebarNav')

const hrefs = (role: string) =>
  [...renderToStaticMarkup(<SidebarNav role={role} />).matchAll(/href="([^"]+)"/g)].map((m) => m[1])

describe('SidebarNav', () => {
  it('puts Adoption right after Governance for admins and managers', () => {
    for (const role of ['admin', 'manager']) {
      const list = hrefs(role)
      expect(list.indexOf('/adoption')).toBe(list.indexOf('/governance') + 1)
    }
  })

  it('hides Adoption from a developer', () => {
    expect(hrefs('developer')).not.toContain('/adoption')
  })
})
