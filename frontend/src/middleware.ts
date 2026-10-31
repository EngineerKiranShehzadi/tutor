import { NextResponse, type NextRequest } from 'next/server';

// Server-side gate for the signed-in areas: a visitor with no session cookie is
// redirected to /login before any protected page (or its markup) is sent.
//
// It checks only that the httpOnly refresh cookie is PRESENT — this server
// cannot verify it (the signing secret stays with the API), and it does not
// gate by role. The real checks are still the API's (every request) and the
// client layouts' admin redirect; this is defense in depth.
//
// The browser sends the API's cookie here only when the frontend and the API
// share a host (ports do not matter) or the API sets COOKIE_DOMAIN to their
// shared parent domain (see backend/.env.example).
const REFRESH_COOKIE = 'refreshToken';

export function middleware(req: NextRequest) {
  if (req.cookies.has(REFRESH_COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

// Every page under the (dashboard) and (admin) route groups.
export const config = {
  matcher: [
    '/courses/:path*', '/lecture/:path*', '/profile/:path*',
    '/admin/:path*', '/dashboard/:path*', '/agents/:path*', '/lectures/:path*',
    '/questions/:path*', '/settings/:path*', '/students/:path*', '/users/:path*',
  ],
};
