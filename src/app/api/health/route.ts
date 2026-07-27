/**
 * GET /api/health — is the deployment actually wired up?
 *
 * Exists because the failure it diagnoses is otherwise invisible: a database
 * that cannot be reached surfaces as an empty-bodied 500 on every route that
 * touches it, which is indistinguishable from a bad build. Guarded by
 * CRON_SECRET because the reply names hosts and ports.
 *
 * Never prints credentials — the connection strings are parsed and only their
 * non-secret parts reported.
 */

import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function describeUrl(raw: string | undefined) {
  if (!raw) return { set: false };
  // A value pasted with the surrounding quotes from a .env file is a common
  // and otherwise silent mistake, so report it explicitly.
  const quoted = /^["'].*["']$/.test(raw.trim());
  try {
    const u = new URL(raw.trim().replace(/^["']|["']$/g, ""));
    return {
      set: true,
      quoted,
      host: u.hostname,
      port: u.port,
      user: u.username,
      database: u.pathname.replace(/^\//, ""),
      params: u.search ? u.search.slice(1) : "(none)",
      // The pooler has IPv4; db.<ref>.supabase.co is IPv6-only and unreachable
      // from Vercel's functions.
      looksLikePooler: u.hostname.includes("pooler.supabase.com"),
    };
  } catch {
    return { set: true, quoted, parseError: true };
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const env = {
    DATABASE_URL: describeUrl(process.env.DATABASE_URL),
    DIRECT_URL: describeUrl(process.env.DIRECT_URL),
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN ?? null,
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION ?? null,
    SHOPIFY_ADMIN_ACCESS_TOKEN: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ? "set" : "MISSING",
    SESSION_SECRET: process.env.SESSION_SECRET ? "set" : "MISSING",
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD ? "set" : "unset (falls back)",
    ALLOWED_EVENT_ORIGINS: process.env.ALLOWED_EVENT_ORIGINS ?? null,
  };

  let database: Record<string, unknown>;
  const started = Date.now();
  try {
    const rows = await db.$queryRawUnsafe<{ tests: bigint; events: bigint }[]>(
      'SELECT (SELECT count(*) FROM "AbTest") AS tests, (SELECT count(*) FROM "AbEvent") AS events'
    );
    database = {
      ok: true,
      ms: Date.now() - started,
      tests: Number(rows[0].tests),
      events: Number(rows[0].events),
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    database = {
      ok: false,
      ms: Date.now() - started,
      code: err.code ?? null,
      message: err.message?.split("\n").slice(0, 4).join(" ").slice(0, 400) ?? String(e),
    };
  }

  return Response.json({ env, database }, { status: database.ok ? 200 : 503 });
}
