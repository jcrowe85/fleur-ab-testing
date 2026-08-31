/**
 * Follow-up questions — "you might also be wondering", made answerable.
 *
 * The summary already ends with three questions her answers imply. They were
 * rendered as text because nothing stood behind them, and a control that looks
 * pressable and does nothing is the exact overpromise this screen has been
 * caught making before. This is what stands behind them.
 *
 * Each answer carries three more questions, so it keeps going as long as she
 * wants it to.
 *
 * ── Why the questions are signed ────────────────────────────────────────────
 *
 * This is a public endpoint that runs a frontier model on demand. Unsigned, it
 * is a free LLM proxy: anyone can POST arbitrary text and have it answered on
 * Fleur's account, at Fleur's cost, in Fleur's voice. The origin check does not
 * help — a simple request still lands, the browser only withholds the reply.
 *
 * So every question this system emits is stamped with an HMAC, and the ask
 * endpoint answers nothing it did not itself write. That reduces the surface
 * from "any prompt" to "a question we generated for this shopper", which is
 * the only thing it was ever meant to do.
 *
 * The signature covers the question text alone. It is deliberately not bound to
 * a visitor or a session: the same question asked by two shoppers is the same
 * question, and binding it tighter would break a shared link or a reload for no
 * security gain — the thing being protected is the prompt, not the identity.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SHARED_RULES, SUMMARY_MODEL, type Signals } from "@/lib/summary";

const EFFORT = (process.env.SUMMARY_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** An answer is a paragraph, not an essay, so this is far below what it needs
 *  — it exists to stop a runaway, not to shape the output. */
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 45000;

/** Long enough for a real question, short enough that the signed payload
 *  cannot become a smuggled prompt if the secret ever leaks. */
export const MAX_QUESTION_CHARS = 160;

export type AskedQuestion = { q: string; sig: string };
export type Answer = { answer: string; questions: AskedQuestion[] };

/* ── Signing ──────────────────────────────────────────────────────────────── */

function secret(): string | null {
  return process.env.SESSION_SECRET || null;
}

/** Normalised before signing so trivial differences — a trailing space, a
 *  smart quote round-tripped through the DOM — do not invalidate a question we
 *  genuinely wrote. */
function canonical(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export function signQuestion(q: string): string {
  const key = secret();
  if (!key) return "";
  return createHmac("sha256", key).update(canonical(q)).digest("hex").slice(0, 32);
}

export function verifyQuestion(q: string, sig: string): boolean {
  const key = secret();
  /* No secret configured means nothing can be verified, and the safe reading of
     that is "answer nothing" rather than "answer everything". */
  if (!key) return false;
  if (typeof q !== "string" || typeof sig !== "string") return false;
  if (q.length > MAX_QUESTION_CHARS) return false;

  const expected = signQuestion(q);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export function signAll(questions: string[]): AskedQuestion[] {
  return questions.map((q) => ({ q, sig: signQuestion(q) }));
}

/* ── The prompt ───────────────────────────────────────────────────────────── */

/**
 * Same voice, same claims, different job. SHARED_RULES is imported rather than
 * restated: these are the rules that make unreviewed copy about hair loss safe
 * to publish, and a second copy of them is a second copy to forget.
 */
const ASK_SYSTEM = `You are answering one follow-up question for a woman who has just read an analysis of her hair loss on Fleur's site. She tapped the question herself from a short list.

${SHARED_RULES}

═══ THIS PARTICULAR JOB ═══

Answer the question she tapped. Only that question.

- She has already read the analysis. Do not restate it. If the answer depends on something from it, refer to it in a clause and move on.
- Answer the question that was asked, not the one you would rather answer. If she asks whether she can colour her hair, the first sentence says whether she can.
- If the honest answer is "we do not know" or "that is one for your doctor", say so plainly and stop. An invented answer is worth less than an honest short one, and this is hair loss — she may be making a medical decision on it.
- Do not sell. She is already past the offer; this is the part where she is deciding whether to trust the thing that made it. A question answered straight does more for that than a pitch does.

═══ OUTPUT ═══

"answer" — 60-90 words. One idea per sentence, an example where it helps. Plain enough for a phone.

"questions" — EXACTLY 3. What she would plausibly ask NEXT, having just read this answer. Each 5-12 words, in her words. They must move forward: do not re-ask what she just asked, and do not repeat the questions she was already offered. Specific beats general — "Can I use it the same day I colour?" not "Any other tips?".`;

/* ── Answering ────────────────────────────────────────────────────────────── */

function describeContext(signals: Signals): string {
  const a = signals.answers || {};
  const lines: string[] = [`her likely cause: ${signals.persona || "unclear"}`];
  for (const key of Object.keys(a).sort()) {
    const v = a[key];
    const list = Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    if (list.length) lines.push(`${key}: ${list.join(", ")}`);
  }
  return lines.join("\n");
}

/** Returns null on any failure. The caller shows nothing rather than an
 *  apology — she still has the analysis, and a broken follow-up should cost
 *  her the follow-up and nothing else. */
export async function answerQuestion(
  question: string,
  signals: Signals,
): Promise<Answer | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );

  try {
    const response = await client.messages.create(
      {
        model: SUMMARY_MODEL,
        max_tokens: MAX_TOKENS,
        output_config: {
          effort: EFFORT,
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                questions: { type: "array", items: { type: "string" } },
              },
              required: ["answer", "questions"],
              additionalProperties: false,
            },
          },
        },
        system: [
          { type: "text", text: ASK_SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: `${describeContext(signals)}\n\nSHE ASKED: ${question}`,
          },
        ],
      },
      { timeout: TIMEOUT_MS, maxRetries: 1 },
    );

    if (response.stop_reason === "refusal") return null;
    if (response.stop_reason === "max_tokens") {
      console.error("[quiz/ask] hit max_tokens");
      return null;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) return null;

    const parsed = JSON.parse(text) as { answer?: string; questions?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!answer) return null;

    /* Signed on the way out, so the next tap is answerable and nothing else
       is. Over-long ones are dropped rather than truncated — a question cut
       mid-sentence would be signed in a form nobody would ever ask. */
    const next = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter(
        (q): q is string =>
          typeof q === "string" && q.trim().length > 0 && q.trim().length <= MAX_QUESTION_CHARS,
      )
      .map((q) => q.trim())
      .slice(0, 3);

    return { answer, questions: signAll(next) };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.error(
      `[quiz/ask] failed: status=${err.status ?? "none"} ${err.message ?? e}`,
    );
    return null;
  }
}
