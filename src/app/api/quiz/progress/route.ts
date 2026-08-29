/**
 * Quiz progress — where people leave.
 *
 * QuizResponse is a row per completion, so everything it can tell you is
 * conditioned on survival. Persona shares were being read as audience
 * composition when they were composition-after-attrition: if one group
 * abandons more than another, its share is understated *and* its conversion
 * rate is measured on whichever subset tolerated thirteen questions. Nothing in
 * the schema could distinguish those cases.
 *
 * This is the missing denominator. One row per attempt, updated as the shopper
 * advances, carrying the answers they had given by the time they stopped —
 * which is what makes it more than a funnel count, since `lifestage` is the
 * fourth question and anyone past it has already declared menopause,
 * postpartum or stress before quitting.
 *
 * Public, like the event ingest and the unlock: shoppers' browsers call it, it
 * holds no secret, and it assumes hostile input. Nothing here grants anything —
 * a forged row skews a report, it does not buy a discount — so the checks are
 * about keeping junk out of the table rather than defending a reward.
 *
 * Called with sendBeacon, which cannot set Content-Type and does not wait for a
 * reply, so the body arrives as text/plain and the response is always 204.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isAllowedOrigin } from "@/lib/ab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* A partial answer set is the same shape as a full one, so the same ceiling. */
const MAX_BODY_BYTES = 8192;
/* More steps than the quiz has, with room to grow, and small enough that a
   fabricated index cannot be used to sort junk to the top of a report. */
const MAX_STEPS = 40;

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
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Same shape as the id ab-assign.liquid generates; anything else is junk. */
function clampId(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[a-z0-9]{6,}$/i.test(s) && s.length <= max ? s : null;
}

function clampStep(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[a-z0-9_]{1,40}$/i.test(s) ? s : null;
}

function clampIndex(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_STEPS, Math.max(0, Math.round(n)));
}

function done(reason: string, origin: string | null) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(origin), "X-Quiz-Progress": reason },
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

  const visitorId = clampId(body.visitorId);
  const attempt = clampId(body.attempt, 40);
  const step = clampStep(body.step);
  if (!visitorId || !attempt || !step) return done("bad-input", origin);

  const stepIndex = clampIndex(body.stepIndex);
  const completed = body.completed === true;

  const answers =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Prisma.InputJsonValue)
      : undefined;

  try {
    /* Upsert on the attempt, not the visitor: a retake is a second funnel, and
       overwriting the first would erase an abandon every time someone came back
       and succeeded — which is precisely the population this table exists to
       count.

       `furthest` only ever climbs. Going back a step is navigation, not
       progress lost, and the two columns differ exactly there. */
    await db.quizProgress.upsert({
      where: { visitorId_attempt: { visitorId, attempt } },
      create: {
        visitorId,
        attempt,
        step,
        stepIndex,
        furthest: stepIndex,
        completed,
        ...(answers === undefined ? {} : { answers }),
      },
      update: {
        step,
        stepIndex,
        /* completed never goes back to false: a shopper who finishes and then
           scrolls back through the questions has still finished. */
        completed: completed ? true : undefined,
        ...(answers === undefined ? {} : { answers }),
      },
    });

    /* Prisma cannot express "greatest(existing, incoming)" in an update, and a
       read-then-write would race two beacons from the same tab. One statement,
       decided by the database. */
    await db.$executeRaw`
      UPDATE "QuizProgress"
      SET "furthest" = GREATEST("furthest", ${stepIndex})
      WHERE "visitorId" = ${visitorId} AND "attempt" = ${attempt}`;
  } catch {
    /* Instrumentation must never be the reason a quiz fails. */
    return done("write-failed", origin);
  }

  return done("recorded", origin);
}
