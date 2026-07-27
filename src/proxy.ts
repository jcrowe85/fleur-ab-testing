import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const AUTH_COOKIE = "fleur_ab_session";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The public ingest MUST stay open. Shoppers' browsers post here and cannot
  // hold a session; the route protects itself with the origin allowlist. This
  // has to come first — sending a beacon to /login would return a 307 that
  // sendBeacon silently swallows, and the test would collect nothing while
  // looking healthy.
  if (pathname.startsWith("/api/ab/")) return NextResponse.next();

  // Order sync authenticates with CRON_SECRET, not the dashboard cookie.
  if (pathname.startsWith("/api/sync/")) return NextResponse.next();

  // Health check authenticates with CRON_SECRET too.
  if (pathname.startsWith("/api/health")) return NextResponse.next();

  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  if (req.cookies.get(AUTH_COOKIE)?.value === process.env.SESSION_SECRET) {
    return NextResponse.next();
  }

  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = `?from=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
