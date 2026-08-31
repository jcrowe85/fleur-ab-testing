/**
 * Answer one follow-up question from the results screen.
 *
 * Public, like the rest of the quiz surface: shoppers' browsers call it, so it
 * holds no secret and assumes hostile input. Unlike the rest, it runs a
 * frontier model on demand, which makes it the one endpoint here that costs
 * money per request from anyone who can reach it.
 *
 * Two things bound that, and neither is the origin check — a simple request
 * still lands whatever CORS says, the browser only withholds the reply:
 *
 *   1. The signature. Every question this system emits is stamped with an
 *      HMAC, and this answers nothing it did not itself write. That is the
 *      difference between "a question we generated" and "any prompt at all".
 *   2. The body ceiling, so nobody can pay us to read their essay.
 *
 * There is deliberately no cache. A follow-up is asked once, in the middle of
 * reading, and storing answers keyed on a free-form question would be a table
 * of near-duplicates for no gain.
 */

import { isAllowedOrigin } from "@/lib/ab";
import { answerQuestion, verifyQuestion, MAX_QUESTION_CHARS } from "@/lib/ask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    return new Response(null, { status: 403, headers: { "X-Quiz-Ask": "origin-rejected" } });
  }

  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "Cache-Control": "no-store, private",
  };

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ answer: null }), {
      status: 413,
      headers: { ...headers, "X-Quiz-Ask": "too-large" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ answer: null }), {
      status: 400,
      headers: { ...headers, "X-Quiz-Ask": "bad-json" },
    });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const sig = typeof body.sig === "string" ? body.sig : "";

  /* The whole security model in one line: we answer our own questions. A
     mismatch is not an error to explain, it is a request that should never
     have been made, so it gets a flat refusal and no detail. */
  if (!question || question.length > MAX_QUESTION_CHARS || !verifyQuestion(question, sig)) {
    return new Response(JSON.stringify({ answer: null }), {
      status: 403,
      headers: { ...headers, "X-Quiz-Ask": "unsigned" },
    });
  }

  const answers =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};
  const persona =
    typeof body.persona === "string" && body.persona.length <= 64 ? body.persona : null;

  const result = await answerQuestion(question, { persona, answers });
  if (!result) {
    return new Response(JSON.stringify({ answer: null }), {
      status: 200,
      headers: { ...headers, "X-Quiz-Ask": "unavailable" },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...headers, "X-Quiz-Ask": "answered" },
  });
}
