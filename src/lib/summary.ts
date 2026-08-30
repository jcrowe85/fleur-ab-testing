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
/* Raised from "low", which was set when a generation was imagined to be racing
   the 2.9s analysing screen. It never was — everything a shopper sees comes
   from a row warmed offline by scripts/warm-summaries.mjs, where a few extra
   seconds across 43 calls costs nothing. And the bridge is no longer a
   formatting task: it has to identify the specific broken step in this
   shopper's cause and attach the right claim to that step, which at low effort
   came back as the same interchangeable recitation of the claim every time. */
const EFFORT = "high";

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
/* 30s was set when effort was low. At high effort with room to think, a slow
   cell runs past it — five of forty-four timed out at ~60s, which is this
   ceiling times the one retry, and each of those quietly kept its previous
   copy. Since every generation that matters happens in the offline batch, the
   ceiling should be the point where something is genuinely wrong rather than
   merely slow. */
const GENERATION_TIMEOUT_MS = 90000;
const MAX_RETRIES = 1;

export type Signals = {
  persona: string | null;
  /** Raw answer set, as the quiz recorded it. Used for the prompt, not the key. */
  answers: Record<string, unknown>;
  /**
   * How much this shopper actually told us, and it is part of the cache key.
   *
   * "quiz" is thirteen answers: her scalp, her texture, what she has tried, how
   * long it has run. Copy written from that references those specifics, which
   * is what makes it good.
   *
   * "tap" is one chip and maybe a modifier. Nothing else is known.
   *
   * These cannot share a row, and the reason is not quality — it is that
   * quiz-derived copy says "your prescription" and "your oily scalp" to a
   * shopper who tapped one button and mentioned neither. Shipped that way
   * briefly; a menopause tap returned a paragraph about a prescription the
   * reader had never mentioned. Same signature, someone else's answers.
   */
  source?: "quiz" | "tap";
};

/** The icons the theme owns. The model chooses from this list; it never draws
 *  one. Generated SVG would be unreviewed markup injected into the page — it
 *  can break the layout and it is an injection surface on copy that already
 *  ships without a human reading it. */
export const ICONS = [
  "hormone", "scalp", "strand", "follicle", "routine", "clock", "doctor", "colour",
] as const;
export type Icon = (typeof ICONS)[number];

export type Point = { icon: Icon; heading: string; body: string };
export type Summary = {
  teaser: string;
  lead: string;
  points: Point[];
  bridge: string;
};

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
    /* First, so the two populations can never collide. See Signals.source. */
    signals.source === "tap" ? "tap" : "quiz",
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
const SYSTEM = `You write the summary shown at the top of the results screen of Fleur's hair quiz, directly above a discounted subscription offer for Fleur's Bloom Hair & Scalp Serum. The reader is a woman who has just answered about a dozen questions on her hair.

═══ VOICE — this is the part that usually goes wrong ═══

Do NOT open by reciting her answers back as a list of attributes. That reads like a database record and it is the single most common failure here.

  Bad:  "Coarse, colour-treated hair breaking mid-strand through menopause, with an oily scalp and a prescription in the mix..."
  Good: "For women going through menopause who also colour their hair, this usually shows up in two places at once..."

Write to her as one of a group she would recognise herself in — "women in perimenopause who colour", "if you have been noticing more in the drain than usual". Recognition, not readout. She should feel described, not processed.

Other voice rules:
- Warm, calm, direct. Plain English. Second person.
- No exclamation marks. No "amazing", "journey", "gorgeous", "queen", "bestie".
- Never open with "Based on your answers" or "It sounds like".
- Contractions are fine. Sound like a knowledgeable person talking, not a leaflet.

═══ THE JOB ═══

Three things, in order:
1. Show her the answers were actually read — through recognition, per the voice rules.
2. Explain what is going on, in mechanism terms she can follow.
3. Bridge to the serum, and give her a reason to believe it applies to HER situation specifically.

Point 3 is the one that is usually missing and it matters most. Many readers — especially women in menopause — are not unconvinced about the price. They are unconvinced anything works at all, often after trying several things that did not. Do not ignore that. Name the doubt where the signals suggest it (moderate or minimal commitment, "tried lots"), then answer it with mechanism rather than enthusiasm.

═══ WHAT THE PRODUCT IS, AND THE ONLY CLAIMS YOU MAY MAKE ═══

Bloom is a topical scalp serum built on copper peptides (GHK-Cu, AHK-Cu, Tripeptide-1, Acetyl Tetrapeptide-3, PTD-DBM).

You may say, in your own words, that its ingredients are clinically studied to:
- improve follicle signalling for stronger, denser-LOOKING hair
- support scalp repair and long-term follicle health
- reactivate biological pathways associated with healthy hair growth

Keep the hedges. "Denser-looking", "support", "help maintain", "associated with". These are the company's approved claims and you may not upgrade them.

FORBIDDEN, without exception:
- Do not promise regrowth, reversal, a cure, or a result.
- Do not give a timeline ("in 90 days", "within weeks").
- Do not diagnose. "This pattern is usually..." never "You have...".
- Do not state a price, a percentage, a discount, or a number of months. The offer panel owns every figure on the page.
- Do not claim it treats a medical condition.
- Do not invent an ingredient, a study, or a statistic.
- Do not describe the product's texture, weight, scent, colour, feel, or how it is applied. You have not been told any of those and every one you have reached for has been wrong. "Lightweight", "non-greasy", "absorbs fast", "a few drops" — all forbidden. Talk about what it does, never what it is like.
- Do not mention free gifts, bundles, or anything that ships with the order. They are not on this screen.

MEDICAL SIGNALS (medication, thyroid, PCOS): say plainly the underlying cause is the first thing to address and worth raising with her doctor. Position the routine as working alongside that, never instead of it. Do not push the offer in this case.

═══ OUTPUT ═══

This screen is already text-heavy and sits directly above the price. Every budget below is a hard ceiling, and they are set so that hitting each one lands the whole block at 110-130 words. Write short. If a sentence can lose four words, lose them.

"teaser" — 18-24 words, never more than 24. The recognition opener. Ends mid-thought with the … character, because a "read full analysis" link follows it. Never a complete stop.

"lead" — one sentence, max 20 words. What is most likely going on.

"points" — EXACTLY 3. Not 2, not 4. Each is:
    "icon"    — one of: hormone, scalp, strand, follicle, routine, clock, doctor, colour
    "heading" — 3-5 words, sentence case, no full stop
    "body"    — ONE sentence, max 18 words. Two sentences is the most common overrun here; do not write two.
  Point 1: the mechanism behind her pattern.
  Point 2: what is specific to her — scalp, processing, tension, how long it has run.
  Point 3: what a daily scalp routine is actually for here.

"bridge" — 55-70 words. This is the most important field and the one most likely to come back generic. Read the rule below twice.

It appears on the page under the heading "The solution with Bloom", so she already knows a product is coming. Do not spend words announcing it. What she does not know is why THIS product answers HER problem, and that is the only thing this field is for.

═══ THREE BEATS, IN ORDER, ALL THREE REQUIRED ═══

BEAT 1 — her broken step. What specifically has gone wrong or been lost in HER cause. It must NOT contain "Bloom", "peptide", "serum", "copper", "GHK" or any claim; it is about her body. It must be impossible to reuse under a different cause — name the actual thing: the oestrogen that fell, the follicles that went to rest together, the inherited cycle that shortens each round, the pregnancy hormones that dropped.

BEAT 2 — Bloom, acting on that exact step. Connect an approved claim to the step named in beat 1, and carry a joining phrase — "that same", "exactly that", "the step your body stopped". Without one you have written two unrelated sentences and it does not count.

BEAT 3 — what that means for her, and this is the beat that was missing. Beats 1 and 2 explain; beat 3 is why she would act. Not a promise, not a timeline, not "results". It is the consequence of the mechanism being addressed at all — that the signal has somewhere to come from now, that the follicles have a scalp worth restarting into, that this is the layer everything she has already tried was not touching. End on her, not on the ingredient.

  BAD — stops after beat 2, so it explains and never turns:
    "Oestrogen was holding that growth signal, and it isn't returning. Copper peptides like GHK-Cu are studied for supporting that same follicle signalling from outside."

  GOOD — the same two beats, then the turn:
    "Oestrogen was holding that growth signal steady, and it isn't coming back on its own. Copper peptides act on that same signalling from the outside — GHK-Cu is studied for exactly that step. Which means the shampoos and thickening sprays were never wrong so much as aimed at the wrong layer: they treated the hair you have, not the signal deciding what grows next."

MEDICAL SIGNALS: if her answers mention a medication or condition, give it ONE clause — the cause comes first and is worth raising with her doctor — and then get on with the three beats. It is a caveat, not the subject. Only when her whole picture is medical does the hand-off become the point, and then the three beats are replaced by it.

`;

/**
 * Appended for taps only, after the signals rather than in the system prompt —
 * the system block is cached and must stay byte-identical across both paths.
 *
 * Every line here closes something observed going wrong. A tap knows her cause
 * and how she treats her hair. It does not know her scalp, her texture, her
 * medications or how long this has run, and the model will happily supply all
 * four if not told they are absent.
 */
const TAP_CONSTRAINT = `IMPORTANT — you have been told almost nothing about this person.

She tapped one button. The lines above are the whole of what she said.

You do NOT know: her scalp condition, her hair texture or type, what treatments she has tried, whether she takes any medication, how long this has been going on, where on her head it shows, or her age.

Do not mention any of them. Specifically, never write "your prescription", "your oily scalp", "coarse hair", "years of colour", "what you've already tried", or any other detail she did not give you. A sentence that describes a stranger is worse than a general one — she will know it is not about her.

Write only from her cause and, if given, how she treats her hair. Being general about what you were not told is correct here; inventing it is not.

The three beats and every claim rule still apply. The bridge still has to name the broken step in her cause and attach the claim to that same step — you have enough for that, because her cause is the one thing she did tell you.`;

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
        /* Thinking tokens are billed against max_tokens, so this is not
           "how long is the copy" — it is thinking plus copy. At effort high the
           reasoning alone can run past 2000, which truncated the JSON mid-string
           and surfaced as an unterminated-string parse error rather than
           anything that named a token limit. Generous, because this runs as an
           offline batch where a larger ceiling costs nothing unless it is
           used. */
        max_tokens: 8000,
        output_config: {
          effort: EFFORT,
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                teaser: { type: "string" },
                lead: { type: "string" },
                /* No minItems/maxItems: structured outputs reject any minItems
                   other than 0 or 1, and sending 3 fails the whole request with
                   a 400. So the count cannot be enforced here at all — "exactly
                   3" in the prompt is a strong hint and the parse below is what
                   actually holds the line, truncating a fourth point rather
                   than throwing away an otherwise good response. */
                points: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      icon: { type: "string", enum: [...ICONS] },
                      heading: { type: "string" },
                      body: { type: "string" },
                    },
                    required: ["icon", "heading", "body"],
                    additionalProperties: false,
                  },
                },
                bridge: { type: "string" },
              },
              required: ["teaser", "lead", "points", "bridge"],
              additionalProperties: false,
            },
          },
        },
        system: [
          { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content:
              signals.source === "tap"
                ? `${describe(signals)}\n\n${TAP_CONSTRAINT}`
                : describe(signals),
          },
        ],
      },
      { timeout: GENERATION_TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    /* A refusal is a 200 with no usable content, so stop_reason is checked
       before the blocks are read rather than after something has already
       thrown on an empty array. */
    if (response.stop_reason === "refusal") return null;

    /* Truncation is worth naming rather than letting JSON.parse fail on a
       half-written string — the parse error says nothing about the cause and
       sent me looking in the wrong place once already. */
    if (response.stop_reason === "max_tokens") {
      console.error("[quiz/summary] hit max_tokens; raise it or shorten the output spec");
      return null;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) return null;

    const parsed = JSON.parse(text) as Partial<Summary>;
    const teaser = typeof parsed.teaser === "string" ? parsed.teaser.trim() : "";
    const lead = typeof parsed.lead === "string" ? parsed.lead.trim() : "";
    const bridge = typeof parsed.bridge === "string" ? parsed.bridge.trim() : "";
    if (!teaser || !lead || !bridge) return null;

    /* This is where the count is actually enforced — the schema cannot do it
       (see above) and the prompt only asks. Four points get truncated to three
       rather than rejected: the copy is fine, there is just more of it than the
       screen has room for. Fewer than three is a genuine under-delivery and
       falls back.

       It is also the boundary between an external service and the storefront,
       so the shape is validated here rather than assumed — an unrecognised icon
       drops the point instead of rendering a broken glyph into the page. */
    const points: Point[] = (Array.isArray(parsed.points) ? parsed.points : [])
      .filter(
        (p): p is Point =>
          !!p &&
          typeof p.heading === "string" &&
          typeof p.body === "string" &&
          (ICONS as readonly string[]).includes(p.icon),
      )
      .map((p) => ({ icon: p.icon, heading: p.heading.trim(), body: p.body.trim() }))
      .slice(0, 3);
    if (points.length !== 3) return null;

    /* The ellipsis is load-bearing: the teaser is rendered directly against a
       "read full analysis" control, and a teaser that closes its own sentence
       makes that control look like it leads nowhere. Append rather than
       reject — the copy is fine, only the punctuation drifted. */
    return {
      teaser: /[…]$/.test(teaser) ? teaser : teaser.replace(/[.\s]+$/, "") + "…",
      lead,
      points,
      bridge,
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
