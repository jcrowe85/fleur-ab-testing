/**
 * The results-screen summary — written by a model, cached by answer shape.
 *
 * What this is for: the quiz asks thirteen questions, several of them about
 * menopause stage, medications and postpartum timing, and then hands the
 * shopper a discount. The format of the questionnaire promises an answer that
 * the payoff does not deliver, and the segment that suffers most for it is the
 * one whose barrier was never price — 40% of takers are menopausal, they
 * report "moderate" commitment at twice the rate of everyone else, and they
 * convert at half the rate of the stress-shed segment. This gives the
 * questions somewhere to land before the offer.
 *
 * ── Why it is cached, and why the key is deliberately blunt ─────────────────
 *
 * The generation sits on the one part of this funnel where latency is
 * genuinely expensive. The analysing screen covers 2.9 seconds and then
 * advances whether or not anything is ready.
 *
 * A cold call takes 8-26 seconds, measured. It does not race that screen; it
 * loses to it every time. So the cache is not an optimisation here — it is the
 * entire delivery mechanism. A cache hit returns in ~200-400ms and is the only
 * way a shopper ever sees generated copy; a cold request is a background
 * cache-warmer that happens to be triggered by a shopper who will herself see
 * the fallback.
 *
 * Which is why the cells should be warmed before this goes anywhere near
 * production — see scripts/warm-summaries.mjs. Deployed cold, the first
 * shopper in each of the ~41 live cells gets the fallback for no reason.
 *
 * So the key is not the answer set. Ten multi-select questions make nearly
 * every completion unique, and a per-completion key would never hit twice. It
 * is persona x damage class x commitment — the three things the argument
 * actually turns on. Everything else changes the wording without changing what
 * needs to be said, so collapsing it is what makes the cache work at this
 * volume. 54 cells, warm within a few days at current traffic.
 *
 * That coarsening is the tunable knob. `QuizSummary.hits` says whether it is
 * collapsing anything; widen the signature if the copy feels generic, narrow
 * it if the cache stays cold.
 *
 * It also buys back the thing an LLM otherwise costs a company that runs split
 * tests: two shoppers with the same signature see the same words, so the
 * results screen is still a variant that can be tested rather than a
 * per-visitor one-off.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

/* Opus 5, effort low. Low because this is ~150 words of tightly constrained
   copy, not a reasoning problem — the depth would buy nothing and cost time.
   It does not buy enough time to matter, mind: even at low effort a cold call
   is 8-26s and loses to the analysing screen regardless. It is the right
   setting for the work, not a latency strategy. */
const MODEL = "claude-opus-5";
const EFFORT = "low";

/** Generous on purpose, and this was wrong the first time round.
 *
 *  The original 8s was set on the assumption that a generation had to beat the
 *  2.9s analysing screen to be worth anything. Measured, a cold call takes
 *  8-26s, so it never beats that screen — which means a cold request is not
 *  serving the shopper in front of it at all. Its job is to write the row that
 *  serves the next shopper in that cell.
 *
 *  Under that reading a short timeout is actively harmful: it abandons work
 *  that was nearly done and leaves the cell cold for the next visitor too. So
 *  the ceiling is high enough for a slow call to finish and be stored.
 *
 *  Retries are cut to one for the same reason. The SDK's default of two turned
 *  a 8s timeout into a 26s failure — three attempts, each abandoned just before
 *  it would have succeeded — which is exactly what happened on two of the nine
 *  cells generated during the build. */
const GENERATION_TIMEOUT_MS = 30000;
const MAX_RETRIES = 1;

export type Signals = {
  persona: string | null;
  /** Raw answer set, as the quiz recorded it. Used for the prompt, not the key. */
  answers: Record<string, unknown>;
};

export type Summary = { teaser: string; analysis: string };

/* ── The signature ────────────────────────────────────────────────────────── */

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
  if (typeof v === "string") return [v];
  return [];
}

/**
 * Damage, reduced to the three cases the copy treats differently.
 *
 * Colour and heat are one case, not two: both are "some of what reads as
 * thinning is breakage", and the shopper who reports either needs the same
 * reassurance about applying anything to treated hair. This is the biggest
 * single conversion gap in the response data — colour-treated takers convert
 * at 19% against 37% for undamaged — so it earns a place in the key.
 */
function damageClass(answers: Record<string, unknown>): string {
  const d = arr(answers.damage);
  if (d.includes("bleach") || d.includes("chemical")) return "chemical";
  if (d.includes("tension") || d.includes("extensions")) return "tension";
  if (d.includes("color") || d.includes("heat")) return "processed";
  return "none";
}

/**
 * The cache key. Blunt on purpose — see the file header.
 *
 * Sorted and lowercased so two identical shapes cannot produce two keys
 * through ordering alone, which is the usual way a cache like this silently
 * never hits.
 */
export function summarySignature(signals: Signals): string {
  const a = signals.answers;
  const parts = [
    signals.persona || "general",
    damageClass(a),
    arr(a.commitment)[0] || "unstated",
  ].map((s) => String(s).toLowerCase().trim());

  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/* ── The prompt ───────────────────────────────────────────────────────────── */

/**
 * Stable, and first in the request, so it caches at the API as well as in our
 * own table. Nothing per-shopper belongs in here — a single interpolated
 * answer would invalidate the prefix on every call and quietly cost us the
 * discount.
 *
 * The constraints are not stylistic garnish. This copy sits above a priced
 * offer, on a page that asked about medications and menopause, written by a
 * model that nobody reviews before a shopper reads it. Each rule below closes
 * something that would otherwise be shipped at scale and unreviewed.
 */
const SYSTEM = `You write the short summary that appears at the top of the results screen of a hair-loss quiz for Fleur, a hair and scalp serum brand. The shopper has just answered around a dozen questions and is about to be shown a discounted subscription offer with a schedule of free gifts.

Your job is to make the questions land — to show her that her answers were read — and then to hand off to the offer below.

VOICE
- Second person, direct, calm. Plain English.
- No exclamation marks. No hype, no "amazing", no "journey", no "we're so glad you're here".
- Never open with "Based on your answers" or "It sounds like".
- British or American spelling both fine; stay consistent within a response.

WHAT YOU MUST NOT DO
- Never diagnose. You may describe what a pattern commonly is; never assert what this person has. "This pattern is usually..." not "You have...".
- Never make a medical claim, promise regrowth, or give a timeline for results.
- Never state a price, a percentage, a discount, or a number of months. The offer panel below owns every figure on this page, and a figure you invent is one the checkout would disprove.
- Never name a specific medication, dose, or condition as applying to this person.
- Never claim the serum treats, cures or reverses anything. It supports the scalp; that is the whole claim.
- Do not contradict what she told you, and do not tell her the cause is something she did not mention.

MEDICAL ANSWERS
If the signals indicate a medical driver (thyroid, PCOS, medication), say plainly that the underlying cause is the first thing to address and that it is worth raising with her doctor. Position the routine as working alongside that, never instead of it. Do not push the offer hard in this case — an honest hand-off is worth more than a sale that will not stick.

OUTPUT
Two fields.

"teaser": one or two sentences, 25-35 words. Never more than 35. It names what her answers point to and starts to explain why. It MUST end mid-thought with an ellipsis character (…) because it is followed by a "read full analysis" link. Do not end it with a complete stop.

"analysis": three short paragraphs separated by a single blank line. 120 words total, and never more than 130 — count them before you answer; overrunning this is the most common way this output goes wrong.
  1. What the pattern she described usually is, and the mechanism behind it.
  2. Anything specific in her answers that changes the picture — scalp condition, processing, tension, how long it has been going on.
  3. The hand-off: what a daily scalp routine is for here, and a single clause pointing at the serum and the gifts that come with it. Understated. She is already looking at the offer; you are giving her a reason to read it, not closing her.`;

/* ── Generation ───────────────────────────────────────────────────────────── */

/** Compact, readable rendering of the answers for the prompt. Labels are the
 *  raw option ids — the model reads them fine, and mapping them to display
 *  labels here would mean keeping a second copy of the quiz's option list in
 *  sync with the theme's. */
function describe(signals: Signals): string {
  const a = signals.answers;
  const lines: string[] = [`persona: ${signals.persona || "general"}`];
  for (const key of Object.keys(a).sort()) {
    const v = arr(a[key]);
    if (v.length) lines.push(`${key}: ${v.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Returns null rather than throwing on any failure. The caller falls back to
 * the theme's hand-written per-persona copy, which is a good answer rather
 * than an empty one — this must never be the reason a shopper does not get
 * the discount she just earned.
 */
export async function generateSummary(signals: Signals): Promise<Summary | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  /* An identity-linked key is rejected outright unless the request names the
     workspace it acts in — a 400, in about 400ms, which looks exactly like a
     working fallback and nothing like a misconfiguration. Sent only when set,
     so a plain workspace-scoped key needs nothing here. */
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1200,
        output_config: {
          effort: EFFORT,
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                teaser: { type: "string" },
                analysis: { type: "string" },
              },
              required: ["teaser", "analysis"],
              additionalProperties: false,
            },
          },
        },
        system: [
          { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: describe(signals) }],
      },
      { timeout: GENERATION_TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    /* A refusal is a 200 with no usable content, so stop_reason is checked
       before the blocks are read rather than after something has already
       thrown on an empty array. */
    if (response.stop_reason === "refusal") return null;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) return null;

    const parsed = JSON.parse(text) as Partial<Summary>;
    if (typeof parsed.teaser !== "string" || typeof parsed.analysis !== "string") return null;

    const teaser = parsed.teaser.trim();
    const analysis = parsed.analysis.trim();
    if (!teaser || !analysis) return null;

    /* The ellipsis is load-bearing: the teaser is rendered directly against a
       "read full analysis" control, and a teaser that closes its own sentence
       makes that control look like it leads nowhere. Append rather than
       reject — the copy is fine, only the punctuation drifted. */
    return {
      teaser: /[…]$/.test(teaser) ? teaser : teaser.replace(/[.\s]+$/, "") + "…",
      analysis,
    };
  } catch (e) {
    /* Swallowed for the shopper, never for us.
       Every failure here degrades to the theme's own copy, which is the right
       behaviour and also completely silent — a revoked key, a wrong workspace
       id or a changed request shape all present as "the fallback is showing",
       which is indistinguishable from working. This line is the only way that
       gets noticed. Message and status only; the request carries a shopper's
       answers and none of that belongs in a log. */
    const err = e as { status?: number; message?: string };
    console.error(
      `[quiz/summary] generation failed: status=${err.status ?? "none"} ${err.message ?? e}`,
    );
    return null;
  }
}

export const SUMMARY_MODEL = MODEL;
