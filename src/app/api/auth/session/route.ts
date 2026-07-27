import { NextResponse } from "next/server";

export const runtime = "nodejs";

const AUTH_COOKIE = "fleur_ab_session";

export async function POST(req: Request) {
  const form = await req.formData();
  const passphrase = String(form.get("passphrase") ?? "");
  const from = String(form.get("from") ?? "/") || "/";
  const secret = process.env.SESSION_SECRET;

  if (!secret || passphrase !== secret) {
    return NextResponse.redirect(new URL(`/login?error=1`, req.url), { status: 303 });
  }

  // Redirect to a path from our own origin only — `from` arrives from the
  // query string, and echoing it into a Location header unchecked is an open
  // redirect.
  const target = from.startsWith("/") && !from.startsWith("//") ? from : "/";
  const res = NextResponse.redirect(new URL(target, req.url), { status: 303 });
  res.cookies.set(AUTH_COOKIE, secret, {
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
