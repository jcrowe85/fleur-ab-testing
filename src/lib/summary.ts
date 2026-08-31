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

/* Opus 5.
   Back to low, and the history is worth keeping because it was a mistake with a
   lesson in it.

   Effort went low -> high to fix bridges that came back as interchangeable
   recitations of the same claim. It worked, so it looked like the fix. It was
   not: what actually fixed them was making the bridge's structure mandatory —
   beat one names her broken step and may not mention the product, beat two
   attaches the claim to that same step and must carry a joining phrase. Once
   the prompt said that, low effort produced the same bridges. The effort raise
   had been paying to have the model infer a rule that could simply be written
   down.

   Measured at full depth, same prompt, same answers:
     low     17.1s   419 words   all sections, bridge intact
     medium  22.8s   419 words   all sections, bridge intact
     high    39-61s  399 words   no better, and that spread is not noise to
                                 plan around — it is the difference between
                                 fitting inside the remaining screens and not.

   SUMMARY_EFFORT overrides without a deploy, so this is tunable against real
   output rather than argued about. */
const MODEL = "claude-opus-5";
const EFFORT = (process.env.SUMMARY_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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
  /** Defaults to the shape of `source`: a tap gets a taste, the quiz gets the
   *  thing the taste advertised. Passed separately because they are different
   *  questions — where the answers came from, and how much room to spend. */
  depth?: Depth;
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

/**
 * How much room the answer gets, and it is not a formatting switch.
 *
 * "tap" is a taste on the product page with something fuller behind a link.
 * "full" is what that link promised. They were the same length once — every
 * row, both paths, 136-165 words — which made "get your full analysis" a
 * promise the quiz could not keep. A shopper who answers thirteen questions
 * and receives the same paragraph she already read has been told the quiz was
 * worth taking and found out it was not.
 */
export type Depth = "tap" | "full";

export type Summary = {
  teaser: string;
  lead: string;
  points: Point[];
  bridge: string;
  /** full only — the answers only she gave, and why each one matters. */
  specifics?: string;
  /** full only — month by month, honestly, including that month one is quiet. */
  timeline?: string;
  /** full only — what she would ask next, in her words, ready to be tapped. */
  questions?: string[];
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

  /* A tap keys on everything she actually selected, not on the persona those
     selections collapse to.

     It used to key on the collapsed persona, and that made the multi-select a
     lie: PRIORITY resolves perimenopause + menopause + stress down to
     "menopause", so all three landed on the row that menopause alone would
     have. She could see three chips lit and read copy that answered one. A
     control that appears to listen and does not is worse than one that never
     offered.

     So the key is the selection set. Common patterns still repeat and still
     hit; exotic ones miss and generate, which is correct — the answer should
     be about what she chose, and if nobody has chosen that before then nobody
     has written it yet. */
  const parts =
    signals.source === "tap"
      ? [
          "tap",
          signals.persona || "general",
          arr(a.lifestage).slice().sort().join(","),
          arr(a.menopause_stage).slice().sort().join(","),
          arr(a.damage).slice().sort().join(","),
        ]
      : [
          "quiz",
          signals.persona || "general",
          damageClass(a),
          arr(a.commitment)[0] || "unstated",
        ];

  return createHash("sha256")
    .update(parts.map((s) => String(s).toLowerCase().trim()).join("|"))
    .digest("hex")
    .slice(0, 32);
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
/**
 * Voice, plain language and the claim rules — shared verbatim by the summary
 * and by the follow-up answers.
 *
 * Factored rather than duplicated because these are the rules that keep
 * unreviewed copy about hair loss safe to publish, and a second copy of them
 * is a second copy to forget to update. The two prompts differ in what they
 * are asked to write, never in what they are allowed to say.
 */
export const SHARED_RULES = `═══ VOICE — this is the part that usually goes wrong ═══

Do NOT open by reciting her answers back as a list of attributes. That reads like a database record and it is the single most common failure here.

  Bad:  "Coarse, colour-treated hair breaking mid-strand through menopause, with an oily scalp and a prescription in the mix..."
  Good: "For women going through menopause who also colour their hair, this usually shows up in two places at once..."

Write to her as one of a group she would recognise herself in — "women in perimenopause who colour", "if you have been noticing more in the drain than usual". Recognition, not readout. She should feel described, not processed.

═══ PLAIN LANGUAGE — the second thing that goes wrong ═══

She is not a clinician. She is a woman who noticed more hair in the shower and is trying to work out what to do. Write for someone reading on a phone who did not come here to study.

Measured, the copy this replaces scored grade 8 on Flesch-Kincaid, which sounds acceptable — but that metric counts syllables, not ideas, and the weight was never in the words. It was in unglossed jargon and in metaphors doing an explanation's work. Aim for grade 6.

- Never use a technical term without saying what it means in the same breath. Not "follicle signalling" but "the signal that tells your hair to keep growing". Not "the anagen phase" but "the stretch when a hair is actively growing".
- Concrete beats abstract. Not "the layer deciding what grows next" but "your scalp, where new hair starts".
- One idea per sentence. If a sentence has an em-dash carrying a second thought, split it.
- Do not make her assemble the picture from a metaphor. "The strand is being asked to survive more with less" is writing, not explaining.
- Short sentences. Average about twelve words. Some can be five.
- Say "your hair", "your scalp", "the shower drain", "your part" — things she can see.

GIVE EXAMPLES. This is the fastest way to make a mechanism land, and the copy this replaces almost never did it. After explaining something, show it:
  "hair spends less time growing" → "a hair that used to grow for four years now grows for two, so it never gets as long or as thick before it goes"
  "colour lifts the cuticle" → "like a roof tile lifted at the edge — water gets out, and the strand dries faster than it should"
  "diffuse thinning" → "not a bald patch. More like the same number of hairs, each one a little finer, so your ponytail is thinner than it was"
An example is not decoration; if she cannot picture it, she has not understood it.

You may name an ingredient (GHK-Cu, copper peptides) because that is a proper noun and she may want to look it up. You may not leave a *process* unexplained.

Other voice rules:
- Warm, calm, direct. Plain English. Second person.
- No exclamation marks. No "amazing", "journey", "gorgeous", "queen", "bestie".
- Never open with "Based on your answers" or "It sounds like".
- Contractions are fine. Sound like a knowledgeable person talking, not a leaflet.

═══ MORE THAN ONE CAUSE ═══

She may have named several. Do not pick the largest and quietly drop the rest — she can see what she selected, and copy that answers only one of them tells her the page was not listening.

The combination IS the story, and combinations are not additive. Say how they interact.

  perimenopause + a stressful stretch — not menopause with a footnote. A slow, even thinning that was already underway, and then a sudden shed dropped on top of it. They look different from each other: one is gradual and spread out, the other arrives in weeks and then stops. Name both, and say which is which, because she is watching two things happen at once and cannot tell them apart.

  family history + menopause — the inherited pattern decides where, the hormones decide when. It was always going to happen at the part and the crown; falling oestrogen is why it started now rather than in ten years.

  medication + anything else — the medical cause comes first and goes to her doctor, and then say plainly what the other cause is still doing, because it does not stop mattering while she sorts that out.

If she named only one, none of this applies — write to the one she gave.

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
`;

const SYSTEM = `You write the summary shown at the top of the results screen of Fleur's hair quiz, directly above a discounted subscription offer for Fleur's Bloom Hair & Scalp Serum. The reader is a woman who has just answered about a dozen questions on her hair.

${SHARED_RULES}
═══ THE JOB ═══

Three things, in order:
1. Show her the answers were actually read — through recognition, per the voice rules.
2. Explain what is going on, in mechanism terms she can follow.
3. Bridge to the serum, and give her a reason to believe it applies to HER situation specifically.

Point 3 is the one that is usually missing and it matters most. Many readers — especially women in menopause — are not unconvinced about the price. They are unconvinced anything works at all, often after trying several things that did not. Do not ignore that. Name the doubt where the signals suggest it (moderate or minimal commitment, "tried lots"), then answer it with mechanism rather than enthusiasm.

═══ OUTPUT ═══

You will be told which of two depths to write, and they are genuinely different pieces of work. Do not write the short one at length or the long one thinly.

──────── DEPTH: tap ────────

She tapped one button on the product page. This is a taste, and something fuller sits behind a link.

Total 130-160 words across lead + points + bridge.

"teaser"  — 18-24 words, ends mid-thought with … . The recognition opener.
"lead"    — one sentence, max 20 words. What is most likely going on.
"points"  — EXACTLY 3. { icon, heading 3-5 words, body ONE sentence max 18 words }.
"bridge"  — 28-35 words. The three beats, compressed.
"specifics", "timeline", "questions" — omit entirely.

──────── DEPTH: full ────────

She answered thirteen questions and was promised a full analysis. If this reads like the tap version she will feel cheated, and she will be right — that is the single worst outcome for this field. It must be visibly, obviously more.

Total 380-450 words. Use the room.

"teaser"    — 18-24 words, ends with … .
"lead"      — 2 sentences, max 45 words. What is most likely going on.
"points"    — EXACTLY 4. { icon, heading 3-6 words, body 30-45 words }. Deeper than the tap's: explain the mechanism properly, in plain language.
"specifics" — 60-80 words. THIS IS THE SECTION THE TAP CANNOT HAVE, and it is what makes the analysis full. Use the answers only she gave: her scalp, her hair type and texture, how long it has run, where it shows, what she has already tried. Name them. Say what each one changes about her situation. Nothing generic may appear here — if a sentence would be true of another woman with the same cause, cut it.
"timeline"  — 50-70 words. What actually happens, month by month, if she starts. Be honest that month one shows nothing. No promises, no guaranteed outcomes — describe the process, not a result.
"bridge"    — 55-70 words. The three beats in full.
"questions" — EXACTLY 3. Questions she would plausibly ask next, given HER answers, that nothing above has answered. Each 5-12 words, phrased as she would ask it. Specific to her: "Will this work while I am on my thyroid medication?" not "How long until results?". These are shown as things she can tap to ask.
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

/** A tap is a taste; anything else was asked thirteen questions and promised
 *  more than a taste. */
function depthOf(signals: Signals): Depth {
  return signals.depth ?? (signals.source === "tap" ? "tap" : "full");
}

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
                specifics: { type: "string" },
                timeline: { type: "string" },
                questions: { type: "array", items: { type: "string" } },
              },
              /* The three long-form fields are not required: at tap depth they
                 are explicitly omitted, and a schema demanding them would make
                 the model pad the short version to satisfy it. */
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
            content: [
              describe(signals),
              `DEPTH: ${depthOf(signals)}`,
              signals.source === "tap" ? TAP_CONSTRAINT : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
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
      .slice(0, depthOf(signals) === "full" ? 4 : 3);
    if (points.length < 3) return null;

    /* The ellipsis is load-bearing: the teaser is rendered directly against a
       "read full analysis" control, and a teaser that closes its own sentence
       makes that control look like it leads nowhere. Append rather than
       reject — the copy is fine, only the punctuation drifted. */
    const out: Summary = {
      teaser: /[…]$/.test(teaser) ? teaser : teaser.replace(/[.\s]+$/, "") + "…",
      lead,
      points,
      bridge,
    };

    /* Carried only at full depth. A tap that came back with a timeline anyway
       would quietly erase the difference the link promised, so the depth we
       asked for decides what is kept — not what the model happened to send. */
    if (depthOf(signals) === "full") {
      if (typeof parsed.specifics === "string" && parsed.specifics.trim()) {
        out.specifics = parsed.specifics.trim();
      }
      if (typeof parsed.timeline === "string" && parsed.timeline.trim()) {
        out.timeline = parsed.timeline.trim();
      }
      const qs = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
        .slice(0, 3);
      if (qs.length) out.questions = qs;
    }

    return out;
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

