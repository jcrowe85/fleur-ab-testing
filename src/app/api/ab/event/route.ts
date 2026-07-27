/**
 * POST /api/ab/event — public funnel ingest.
 *
 * Called directly by shoppers' browsers, so it cannot hold a secret and must
 * assume hostile input. Everything it accepts is either validated against a
 * fixed allowlist (bucket, event) or length-clamped before it reaches the
 * database, and an unknown test key is dropped rather than creating a row.
 *
 * The theme sends this with `navigator.sendBeacon(url, Blob<text/plain>)`.
 * That matters in two ways:
 *   - text/plain keeps it a CORS *simple* request, so there is no preflight to
 *     fail during the unload that fires on the way to checkout.
 *   - the browser discards the response entirely. Nothing useful can be
 *     signalled back to the page, so status codes here exist for curl and for
 *     the logs, not for the client.
 */

import { db } from "@/lib/db";
import { clamp, isAllowedOrigin, isBucket, isFunnelEvent } from "@/lib/ab";

// Prisma needs the Node runtime; force-dynamic because this is a pure write.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2048;

function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** 204 with a diagnostic header: invisible to beacons, readable from curl. */
function done(outcome: string, origin: string | null, status = 204) {
  return new Response(null, {
    status,
    headers: { ...corsHeaders(origin), "X-Ab-Ingest": outcome },
  });
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  // Enforced server-side, because CORS does NOT protect this endpoint. The
  // beacon is a *simple* request, so the browser sends it and only withholds
  // the response — a disallowed origin's write still lands. Returning CORS
  // headers alone would be decorative; the check has to gate the insert.
  //
  // Logged rather than silent: if a real storefront domain is ever missing
  // from ALLOWED_EVENT_ORIGINS the symptom is an arm with no data, which is
  // indistinguishable from a catastrophic result. This makes it obvious.
  if (!isAllowedOrigin(origin)) {
    console.warn(`[ab/event] rejected origin: ${origin ?? "(none)"}`);
    return done("origin-not-allowed", origin, 403);
  }

  // Read as text rather than req.json(): the beacon's content-type is
  // text/plain, and we want to bound the size before parsing.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return done("unreadable-body", origin, 400);
  }
  if (raw.length > MAX_BODY_BYTES) return done("body-too-large", origin, 413);

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return done("not-an-object", origin, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return done("bad-json", origin, 400);
  }

  const test = clamp(payload.test, 64);
  const visitorId = clamp(payload.visitorId, 64);
  const { bucket, event } = payload;

  if (!test || !visitorId) return done("missing-test-or-visitor", origin, 400);
  if (!isBucket(bucket)) return done("bad-bucket", origin, 400);
  if (!isFunnelEvent(event)) return done("bad-event", origin, 400);

  // The test must be declared up front. This is the guard that stops a typo in
  // the theme's TEST constant from quietly accumulating events under a key
  // nothing will ever read, and it enforces the stopping rule: once stoppedAt
  // is set, no further data can land and change a decision already made.
  const abTest = await db.abTest.findUnique({
    where: { key: test },
    select: { stoppedAt: true },
  });
  if (!abTest) return done("unknown-test", origin);
  if (abTest.stoppedAt) return done("test-stopped", origin);

  // createMany + skipDuplicates rather than a create in a try/catch: the
  // [test, visitorId, event] unique index means a shopper who reloads the PDP
  // or adds to cart twice must not inflate the numerator, and this collapses
  // that to a no-op insert without a round trip to check first.
  const res = await db.abEvent.createMany({
    data: [
      {
        test,
        bucket,
        visitorId,
        event,
        path: clamp(payload.path, 255),
        template: clamp(payload.template, 64),
      },
    ],
    skipDuplicates: true,
  });

  return done(res.count === 1 ? "recorded" : "duplicate-ignored", origin);
}
