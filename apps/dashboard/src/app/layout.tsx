import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BurnWatch — AI Token Usage Dashboard',
  description: 'Track AI token consumption across your engineering team',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
