/**
 * Pre-generate the results-screen summaries for every signature that real
 * completions actually land in.
 *
 * Why this exists: a cold generation takes 8-26 seconds and the analysing
 * screen it has to beat lasts 2.9. A shopper therefore never sees generated
 * copy from her own request — only from a row somebody else's request wrote.
 * Deployed cold, the first shopper in each cell gets the fallback for no
 * reason other than being first, and with ~41 live cells against ~50
 * completions a day that is a meaningful share of the first week.
 *
 * So the cells are warmed from history before the feature goes live, and again
 * after any change to the prompt or the signature.
 *
 * Reads the real answer sets out of QuizResponse rather than inventing
 * representative ones: the prompt sees the full answer set, so a hand-written
 * stand-in would produce copy subtly unlike what the same cell produces in
 * production.
 *
 *   node scripts/warm-summaries.mjs             # fill cells that have no row
 *   node scripts/warm-summaries.mjs --force     # regenerate every cell
 *   node scripts/warm-summaries.mjs --limit 5   # first N cells only
 *   node scripts/warm-summaries.mjs --tap-space # cover what the PDP tap can reach
 *
 * --tap-space exists because the PDP persona tap can produce combinations no
 * quiz taker ever has. History covers what people answered; the tap covers what
 * they can select, and those are not the same set — three of its eighteen cells
 * had never occurred in 222 completions. A tap landing on a cold cell shows
 * nothing, so the reachable space has to be warmed whether or not anyone has
 * walked it.
 *
 * Note these rows are keyed on the same signature as the quiz's, so a cell can
 * be warmed by either path and both then read it. That is deliberate: the extra
 * answers a quiz taker gives enrich the writing, but the argument turns on
 * persona, damage and commitment alone — which is all either path targets on.
 *
 * Cells are ordered by how many completions they cover, so an interrupted run
 * has still warmed the ones that matter most.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { generateSummary, summarySignature, SUMMARY_MODEL } from "../src/lib/summary.ts";

const db = new PrismaClient();

const force = process.argv.includes("--force");
const tapSpace = process.argv.includes("--tap-space");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

/* The same three-way reduction as damageClass() in lib/summary.ts. Kept in SQL
   because grouping has to happen in the database — pulling every response back
   to bucket it in JS would work but makes the ordering (by cell size) a second
   pass over the same rows. If damageClass changes, this changes with it. */
const CELLS = `
  with r as (
    select coalesce(persona, 'general') persona, answers::jsonb a
    from "QuizResponse"
  ),
  s as (
    select persona, a,
      case
        when a->'damage' ?| array['bleach','chemical'] then 'chemical'
        when a->'damage' ?| array['tension','extensions'] then 'tension'
        when a->'damage' ?| array['color','heat'] then 'processed'
        else 'none'
      end damage,
      coalesce(a->'commitment'->>0, 'unstated') commitment
    from r
  ),
  ranked as (
    select persona, damage, commitment, a,
      count(*) over (partition by persona, damage, commitment) n,
      row_number() over (partition by persona, damage, commitment order by random()) rn
    from s
  )
  select persona, damage, commitment, n::int, a answers
  from ranked where rn = 1 order by n desc
`;

/* The tap's reachable space: every cause chip crossed with every modifier
   outcome. Commitment is not asked at the tap, so it defaults to the middle —
   which is also where most takers actually sit. Answers are deliberately thin:
   one tap is all she gave, and copy written as though she gave more would be
   describing a shopper who does not exist. */
const TAP_PERSONAS = ["menopause", "telogen", "hereditary", "medical", "postpartum", "general"];
const TAP_DAMAGE = { processed: ["color"], tension: ["tension"], none: ["none"] };

function tapCells() {
  const out = [];
  for (const persona of TAP_PERSONAS) {
    for (const [label, damage] of Object.entries(TAP_DAMAGE)) {
      out.push({
        persona,
        damage: label,
        commitment: "moderate",
        n: 0,
        answers: { damage, commitment: ["moderate"] },
      });
    }
  }
  return out;
}

const rows = tapSpace ? tapCells() : await db.$queryRawUnsafe(CELLS);
console.log(
  tapSpace
    ? `${rows.length} cells reachable from the PDP tap\n`
    : `${rows.length} distinct cells across the response history\n`,
);

let generated = 0;
let skipped = 0;
let failed = 0;
let count = 0;

for (const row of rows) {
  if (count++ >= limit) break;

  const signals = { persona: row.persona, answers: row.answers };
  const signature = summarySignature(signals);
  const label = `${row.persona} / ${row.damage} / ${row.commitment}`.padEnd(38);

  if (!force) {
    const existing = await db.quizSummary.findUnique({ where: { signature } });
    if (existing) {
      console.log(`${label} n=${String(row.n).padStart(3)}  already warm`);
      skipped++;
      continue;
    }
  }

  const started = Date.now();
  const summary = await generateSummary(signals);
  const ms = Date.now() - started;

  if (!summary) {
    console.log(`${label} n=${String(row.n).padStart(3)}  FAILED (${ms}ms)`);
    failed++;
    continue;
  }

  await db.quizSummary.upsert({
    where: { signature },
    create: {
      signature,
      teaser: summary.teaser,
      lead: summary.lead,
      points: summary.points,
      bridge: summary.bridge,
      model: SUMMARY_MODEL,
      persona: row.persona,
      /* Warmed rows start at zero: hits counts shoppers served, and a warm run
         has served nobody. Seeding it would make the counter useless for the
         one thing it is for — telling you whether the signature is actually
         collapsing traffic. */
      hits: 0,
    },
    update: {
      teaser: summary.teaser,
      lead: summary.lead,
      points: summary.points,
      bridge: summary.bridge,
      model: SUMMARY_MODEL,
    },
  });

  const words = [summary.lead, ...summary.points.map((p) => p.heading + ' ' + p.body), summary.bridge].join(' ').split(/\s+/).length;
  console.log(`${label} n=${String(row.n).padStart(3)}  ok (${ms}ms, ${words}w)`);
  generated++;
}

console.log(`\ngenerated ${generated}, already warm ${skipped}, failed ${failed}`);
if (failed) console.log("Re-run to retry the failures — warm cells are skipped.");

await db.$disconnect();
