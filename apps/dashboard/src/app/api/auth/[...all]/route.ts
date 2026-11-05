import { auth } from '@/lib/auth'
import { toNextJsHandler } from 'better-auth/next-js'
import { isKnownUserEmail } from '@/lib/session'

const handlers = toNextJsHandler(auth)

export const GET = handlers.GET

/**
 * BurnWatch has no public sign-up. An account is only ever a password set on a
 * user an admin already added, so sign-up is gated here rather than on the
 * page: better-auth's endpoint answers a plain POST from anywhere, and a check
 * that lives only in the form is no check at all.
 */
export async function POST(request: Request) {
  if (new URL(request.url).pathname.endsWith('/sign-up/email')) {
    const body = await request.clone().json().catch(() => null)
    const email = body && typeof body.email === 'string' ? body.email : null

    if (!email || !(await isKnownUserEmail(email))) {
      // Same answer for "no such user" and "disabled user". Which emails have
      // BurnWatch accounts is not something this endpoint should confirm.
      return Response.json(
        { message: 'No BurnWatch account for that email. Ask your admin to add you first.' },
        { status: 403 },
      )
    }
  }

  return handlers.POST(request)
}
