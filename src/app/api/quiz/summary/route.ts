/**
 * Quiz summary — the paragraph above the offer on the results screen.
 *
 * Called from the quiz as the analysing screen starts, so the generation runs
 * behind the 2.9 seconds that screen is already on display. Whatever has not
 * arrived by then is not used: the theme falls back to its own hand-written
 * per-persona copy rather than holding the shopper on a spinner for something
 * she did not ask for.
 *
 * Public, like the event ingest and the unlock: shoppers' browsers call it, so
 * it holds no secret and assumes hostile input. The one thing it does hold is
 * a model key, which is exactly why the call lives here and not in theme JS.
 *
 * ── On cost, which is the reason this endpoint is shaped the way it is ──────
 *
 * A public endpoint that runs a model on demand is a public endpoint that
 * spends money on demand. Three things bound that, in order of how much they
 * matter:
 *
 *   1. The cache. Most requests never reach the model at all — the signature
 *      is coarse and the table warms within days. See lib/summary.ts.
 *   2. The origin check, enforced server-side. CORS alone does not do this: a
 *      simple request still lands, the browser only withholds the response.
 *   3. The body ceiling, so a caller cannot pay us to read their essay.
 *
 * What is deliberately NOT here is a per-visitor rate limit. It would need
 * shared state this app does not have, and the cache already means a shopper
 * hammering the endpoint mostly replays one row. If spend ever looks wrong,
 * that is the thing to add, and QuizSummary.hits is where to look first.
 */

import { db } from "@/lib/db";
import { isAllowedOrigin } from "@/lib/ab";
import { generateSummary, summarySignature, SUMMARY_MODEL } from "@/lib/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* The route cannot wait as long as the batch does — the shopper is gone long
   before either. It is raised anyway, to the platform maximum, because a cold
   request is not serving the person who made it: its whole value is finishing
   and writing the row for whoever is next, and a function killed at 15s throws
   away work that was nearly done.

   Note this is below the 90s model timeout in lib/summary.ts on purpose. In the
   batch the model deadline governs; here the platform stops it first, which is
   the right order — the ceiling that fires is the one belonging to whichever
   context is running. */
export const maxDuration = 60;

const MAX_BODY_BYTES = 8192;

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

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return new Response(null, {
      status: 403,
      headers: { "X-Quiz-Summary": "origin-rejected" },
    });
  }

  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    /* Never cached by anything in between. The body is keyed on one shopper's
       answers, and a shared cache handing it to the next reader would show
       her a paragraph about someone else's hair. */
    "Cache-Control": "no-store, private",
  };

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ summary: null }), {
      status: 413,
      headers: { ...headers, "X-Quiz-Summary": "too-large" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ summary: null }), {
      status: 400,
      headers: { ...headers, "X-Quiz-Summary": "bad-json" },
    });
  }

  const answers =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : null;
  const persona =
    typeof body.persona === "string" && body.persona.length <= 64 ? body.persona : null;
  /* Anything that is not literally "tap" is treated as the quiz, so an older
     caller that has never heard of this field keeps its existing rows. */
  const source = body.source === "tap" ? ("tap" as const) : ("quiz" as const);

  /* No answers means nothing to summarise. Not an error — the theme asks
     before it necessarily has a full set, and a null here just means it keeps
     its own copy. */
  if (!answers || Object.keys(answers).length === 0) {
    return new Response(JSON.stringify({ summary: null }), {
      status: 200,
      headers: { ...headers, "X-Quiz-Summary": "no-answers" },
    });
  }

  const signals = { persona, answers, source };
  const signature = summarySignature(signals);

  /* Cache first, and count the read. The counter is the only visibility into
     whether the signature is coarse enough to be worth having — a table where
     every row has one hit is a log, not a cache. */
  try {
    const hit = await db.quizSummary.update({
      where: { signature },
      data: { hits: { increment: 1 } },
      select: { teaser: true, lead: true, points: true, bridge: true },
    });
    return new Response(JSON.stringify({ summary: hit }), {
      status: 200,
      headers: { ...headers, "X-Quiz-Summary": "cache-hit" },
    });
  } catch (e) {
    /* Only "no such row" may fall through to a generation.
       This was a bare catch, which meant any database hiccup — a cold
       connection on the first request after a deploy, a pooler blip — was read
       as a cache miss and answered by spending 8-26 seconds and real money
       regenerating a row that already existed. Observed doing exactly that on
       the first requests against a freshly started server.
       Anything that is not P2025 is a failure to *read* the cache, not evidence
       the cache is empty, and the honest answer to it is no summary: the theme
       already falls back gracefully, and a fallback costs nothing. */
    const code = (e as { code?: string }).code;
    if (code !== "P2025") {
      console.error(`[quiz/summary] cache read failed: ${code ?? (e as Error).message}`);
      return new Response(JSON.stringify({ summary: null }), {
        status: 200,
        headers: { ...headers, "X-Quiz-Summary": "cache-unavailable" },
      });
    }
  }

  const summary = await generateSummary(signals);
  if (!summary) {
    return new Response(JSON.stringify({ summary: null }), {
      status: 200,
      headers: { ...headers, "X-Quiz-Summary": "unavailable" },
    });
  }

  /* Written after the response is known good. upsert rather than create
     because two shoppers with the same signature can be in flight at once,
     and the loser of that race must not throw away a perfectly good summary
     on a unique violation. */
  try {
    await db.quizSummary.upsert({
      where: { signature },
      create: {
        signature,
        teaser: summary.teaser,
        lead: summary.lead,
        points: summary.points,
        bridge: summary.bridge,
        model: SUMMARY_MODEL,
        persona,
        hits: 1,
      },
      update: { hits: { increment: 1 } },
    });
  } catch {
    /* Caching is an optimisation. Failing to store it must not cost the
       shopper the summary that has already been generated. */
  }

  return new Response(JSON.stringify({ summary }), {
    status: 200,
    headers: { ...headers, "X-Quiz-Summary": "generated" },
  });
}
