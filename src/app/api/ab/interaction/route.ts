/**
 * Interaction ingest — the events the funnel ingest cannot hold.
 *
 * /api/ab/event exists for the three funnel steps and deduplicates on
 * [test, visitorId, event], which is right for "did this visitor add to cart"
 * and wrong for anything asked more than once: nine quiz steps collapse to one
 * row, and so do two presses of the same control.
 *
 * This one appends. It is the difference between knowing a shopper reached the
 * quiz and knowing she left it on question four.
 *
 * Public, like the other two: shoppers' browsers call it, it holds no secret,
 * and it grants nothing — a forged row skews a report, it does not buy a
 * discount. Called with sendBeacon, so the body arrives as text/plain, nothing
 * waits for the reply, and the response is always 204.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isAllowedOrigin, isBucket } from "@/lib/ab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;

/* Named explicitly rather than accepting anything. The tap has been firing
   `persona_tap` into a validator that never listed it, and silence looked
   identical to nobody clicking — an allowlist that is checked is worth more
   than one that is permissive. */
const EVENTS = [
  "quiz_view",
  "quiz_step",
  "quiz_done",
  "tap_view",
  "tap_cause",
  "tap_answer",
  "tap_add",
  "tap_quiz",
  "tap_close",
] as const;

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

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

function str(v: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  if (pattern && !pattern.test(s)) return null;
  return s;
}

function done(reason: string, origin: string | null) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(origin), "X-Ab-Interaction": reason },
  });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  /* Enforced server-side. CORS does not protect this: a simple request still
     lands, the browser only withholds the response from the caller. */
  if (!isAllowedOrigin(origin)) return done("origin-rejected", origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return done("too-large", origin);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return done("bad-json", origin);
  }

  const test = str(body.test, 64);
  const visitorId = str(body.visitorId, 64, /^[a-z0-9]{6,}$/i);
  const event = str(body.event, 32);
  const bucket = body.bucket;

  if (!test || !visitorId) return done("missing-test-or-visitor", origin);
  if (!isBucket(bucket)) return done("bad-bucket", origin);
  if (!event || !(EVENTS as readonly string[]).includes(event)) return done("bad-event", origin);

  /* The test has to exist and still be running, same rule as the funnel ingest:
     rows for a concluded test are rows nothing will read, and the stopping rule
     is worth enforcing in one place rather than remembering in two. */
  const abTest = await db.abTest.findUnique({ where: { key: test }, select: { stoppedAt: true } });
  if (!abTest) return done("unknown-test", origin);
  if (abTest.stoppedAt) return done("test-stopped", origin);

  const idxRaw = Number(body.idx);
  const idx = Number.isFinite(idxRaw) ? Math.min(99, Math.max(0, Math.round(idxRaw))) : null;

  const detail =
    body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? (body.detail as Prisma.InputJsonValue)
      : undefined;

  try {
    await db.abInteraction.create({
      data: {
        test,
        bucket,
        visitorId,
        event,
        step: str(body.step, 64, /^[a-z0-9_,-]{1,64}$/i),
        idx,
        attempt: str(body.attempt, 40, /^[a-z0-9]{6,}$/i),
        path: str(body.path, 255),
        ...(detail === undefined ? {} : { detail }),
      },
    });
  } catch {
    /* Instrumentation must never be the reason a page fails. */
    return done("write-failed", origin);
  }

  return done("recorded", origin);
}
