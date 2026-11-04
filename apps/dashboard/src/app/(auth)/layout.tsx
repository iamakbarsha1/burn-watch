import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

// The other half of the removed Edge middleware: an already-signed-in visitor
// hitting /login goes to the dashboard instead of seeing the form again.
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (session) redirect('/')

  return <>{children}</>
}
