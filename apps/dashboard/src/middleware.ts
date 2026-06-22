import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const sessionCookie = request.cookies.get('better-auth.session_token')
  const isLoginPage = request.nextUrl.pathname === '/login'

  if (!sessionCookie && !isLoginPage) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (sessionCookie && isLoginPage) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
