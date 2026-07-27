import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

const AUTH_COOKIE = "fleur_ab_session";

/**
 * The passphrase you type and the value stored in the cookie are deliberately
 * two different secrets.
 *
 * DASHBOARD_PASSWORD is meant to be memorable, which means it is short enough
 * to be guessed. SESSION_SECRET is the long random string that actually sits
 * in the cookie and is what the proxy checks on every request. If one value
 * did both jobs, shortening it to something you can remember would also
 * shorten the thing standing between the internet and the dashboard.
 */
function equal(a: string, b: string): boolean {
  // Constant-time: a plain === leaks how many leading characters matched,
  // which is enough to recover a short password one character at a time.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const form = await req.formData();
  const passphrase = String(form.get("passphrase") ?? "");
  const from = String(form.get("from") ?? "/") || "/";

  const sessionSecret = process.env.SESSION_SECRET;
  // Falls back to SESSION_SECRET so the dashboard keeps working before
  // DASHBOARD_PASSWORD has been set in the environment.
  const password = process.env.DASHBOARD_PASSWORD || sessionSecret;

  if (!sessionSecret || !password || !equal(passphrase, password)) {
    return NextResponse.redirect(new URL(`/login?error=1`, req.url), { status: 303 });
  }

  // Redirect to a path on our own origin only — `from` arrives from the query
  // string, and echoing it into a Location header unchecked is an open redirect.
  const target = from.startsWith("/") && !from.startsWith("//") ? from : "/";
  const res = NextResponse.redirect(new URL(target, req.url), { status: 303 });
  res.cookies.set(AUTH_COOKIE, sessionSecret, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE(req: Request) {
  const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
