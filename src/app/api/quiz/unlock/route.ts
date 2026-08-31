/**
 * Quiz unlock — record a completion, and answer whether one exists.
 *
 * POST records that a visitor finished the quiz. GET is what the PDP asks
 * before it shows or charges a discounted price.
 *
 * Why this exists at all: the quiz also drops a cookie, and for display alone a
 * cookie was enough — every shopper submitted the same selling plan, so a
 * hand-set cookie bought nothing. Once the unlock decides *which selling plan
 * the form submits*, that cookie becomes the only thing between anyone and
 * $108 off a 6-month plan, and it is settable from the console. So the cookie
 * is now a hint for fast rendering and this is the authority.
 *
 * What this does and does not buy, stated plainly: it means a discount has to
 * be earned by actually completing the quiz rather than by typing one line into
 * devtools. It does not make the price tamper-proof — the cart add happens in
 * the browser, so a determined person can still post a discounted selling plan
 * directly. Closing that needs validation at checkout (a Shopify Function),
 * which is a separate piece of work.
 *
 * Public, like the event ingest: shoppers' browsers call it, so it holds no
 * secret and assumes hostile input.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isAllowedOrigin } from "@/lib/ab";
import { subscribeQuizCompleter } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The answer set rides along now, so the old 1KB ceiling is too tight — a full
   run is ~13 keys with multi-select values. Still bounded: this endpoint is
   public and must assume hostile input. */
const MAX_BODY_BYTES = 8192;
const UNLOCK_DAYS = 90;

/** The ladders the quiz can actually award. Anything else is not a real run. */
const TARGETS = [17, 24, 31] as const;

function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function clampId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  // Same shape as the id ab-assign.liquid generates; anything else is junk.
  if (!/^[a-z0-9]{8,64}$/i.test(s)) return null;
  return s;
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  // Enforced server-side. CORS does not protect this: a simple request still
  // lands, the browser only withholds the response from the caller.
  if (!isAllowedOrigin(origin)) {
    return new Response(null, {
      status: 403,
      headers: { "X-Quiz-Unlock": "origin-rejected" },
    });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(null, {
      status: 413,
      headers: { ...corsHeaders(origin), "X-Quiz-Unlock": "too-large" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(null, {
      status: 400,
      headers: { ...corsHeaders(origin), "X-Quiz-Unlock": "bad-json" },
    });
  }

  const visitorId = clampId(body.visitorId);
  const target = Number(body.target);
  if (!visitorId || !TARGETS.includes(target as (typeof TARGETS)[number])) {
    return new Response(null, {
      status: 400,
      headers: { ...corsHeaders(origin), "X-Quiz-Unlock": "bad-input" },
    });
  }

  // Trusted only as a label on the record, never as an award: the bonus is a
  // one-time code applied at checkout by Shopify, not something this grants.
  const bonus = Number(body.bonus) > 0 ? Math.min(20, Math.round(Number(body.bonus))) : 0;
  const email =
    typeof body.email === "string" && body.email.length <= 320 ? body.email : null;
  const phone =
    typeof body.phone === "string" && body.phone.length <= 32 ? body.phone : null;

  const expiresAt = new Date(Date.now() + UNLOCK_DAYS * 864e5);

  // Upsert, not create: retaking the quiz refreshes the window and can only
  // move the target, which keeps a second run from being a silent no-op.
  await db.quizUnlock.upsert({
    where: { visitorId },
    create: { visitorId, target, bonus, email, expiresAt },
    update: { target, bonus, email, expiresAt },
  });

  /* The answers, kept as a row per completion rather than upserted.
     The unlock above is state — what this visitor is currently owed — so it is
     overwritten. This is a record of what they said and when, and a retake is a
     second data point rather than a correction to the first.

     Written only when there are answers to write: the phone step re-posts to
     attach the bonus and would otherwise file an empty second response. */
  const answers =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : null;
  const persona =
    typeof body.persona === "string" && body.persona.length <= 64 ? body.persona : null;

  if (answers && Object.keys(answers).length > 0) {
    try {
      /* One row per completion, not per post.
         The quiz posts twice — once when the email is given, once when the
         phone is, to attach the bonus — so a naive insert filed two rows for
         every run that included the SMS step: a partial one at bonus 0 and the
         real one at bonus 5. That inflates any count of completions by the
         opt-in rate, and silently, because both rows look valid.

         So a post that lands close behind another from the same visitor
         updates it rather than adding to it. The later post is the fuller
         picture — it carries the bonus and any answers given since — so it
         wins outright.

         The window is what separates "still finishing" from "came back and did
         it again". Two hours is long enough for anyone working through it
         slowly, and short enough that a genuine retake later is what it should
         be: a second row, a second data point. */
      const CONTINUATION_MS = 2 * 60 * 60 * 1000;
      const recent = await db.quizResponse.findFirst({
        where: { visitorId, createdAt: { gte: new Date(Date.now() - CONTINUATION_MS) } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      /* Cast for Prisma's Json input type, which does not accept a bare
         Record. The shape is validated above: an object, not an array. */
      const payload = {
        email,
        target,
        bonus,
        persona,
        answers: answers as Prisma.InputJsonValue,
      };

      if (recent) {
        await db.quizResponse.update({ where: { id: recent.id }, data: payload });
      } else {
        await db.quizResponse.create({ data: { visitorId, ...payload } });
      }
    } catch {
      /* Analysis data must never cost the shopper their unlock. */
    }
  }

  /* Consent, written where Klaviyo will honour it.
     The browser's identify call sets the profile's attributes but cannot set
     consent, which is why every quiz profile read back with "sms consent: NONE"
     — a number collected against a promise to text it that nothing was allowed
     to text.

     Awaited so a failure is visible in the response rather than lost, but never
     fatal: the unlock is what the shopper is waiting on, and a Klaviyo outage
     must not cost them the discount they just earned. */
  let subscribed;
  try {
    subscribed = await subscribeQuizCompleter({ email, phone });
  } catch (e) {
    subscribed = { email: "failed", sms: "failed", detail: (e as Error).message };
  }

  return new Response(JSON.stringify({ ok: true, target, bonus, subscribed }), {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "X-Quiz-Unlock": "recorded",
    },
  });
}

export async function GET(req: Request) {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const visitorId = clampId(url.searchParams.get("vid"));

  // Never cached, by anything. A shared cache holding one shopper's unlock
  // would hand every later reader a discount they did not earn.
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "Cache-Control": "no-store, private",
  };

  if (!visitorId) {
    return new Response(JSON.stringify({ unlocked: false }), { status: 200, headers });
  }

  const row = await db.quizUnlock.findUnique({ where: { visitorId } });
  const live = row && row.expiresAt.getTime() > Date.now();

  /* Her persona rides along, so the PDP does not ask a question she has
     already answered thirteen ways. The tap below the buy box is for shoppers
     we know nothing about; putting it in front of someone who finished the
     quiz would read as the page forgetting her.

     Read separately from the unlock because they answer different questions —
     the unlock is what she is owed and expires, this is what she told us and
     does not. A shopper whose discount has lapsed should still get a page
     written for her cause. Latest completion wins: a retake is a correction. */
  let persona: string | null = null;
  try {
    const response = await db.quizResponse.findFirst({
      where: { visitorId },
      orderBy: { createdAt: "desc" },
      select: { persona: true },
    });
    persona = response?.persona ?? null;
  } catch {
    /* Personalisation is a nicety; the unlock is not. Never let this cost her
       the discount. */
  }

  return new Response(
    JSON.stringify(
      live
        ? { unlocked: true, target: row.target, bonus: row.bonus, persona }
        : { unlocked: false, persona }
    ),
    { status: 200, headers }
  );
}
