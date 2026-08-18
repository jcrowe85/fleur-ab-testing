/**
 * Declare (or re-declare) an experiment.
 *
 *   node scripts/declare-test.mjs                 # create/update, do not start
 *   node scripts/declare-test.mjs --start         # stamp startedAt = now
 *   node scripts/declare-test.mjs --stop          # stamp stoppedAt = now
 *
 * The row is written BEFORE any data arrives, on purpose. primaryMetric and
 * plannedDays are the stopping rule; recording them up front is what makes the
 * eventual result honest, because the alternative — picking the metric and the
 * end date once you can see which choice wins — is exactly how peeking turns a
 * coin flip into a "significant" result.
 *
 * startedAt is not a gate on ingest. Events are accepted as soon as the row
 * exists so the theme integration can be QA'd end to end; the analysis filters
 * to createdAt >= startedAt, which keeps that QA traffic out of the numbers.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const TEST = {
  key: "pdp_pricing_presentation_2608",
  name: "PDP purchase options — cards at charged price vs rows at per-bottle price",
  hypothesis:
    "Presenting the plans as compact rows priced per bottle ($48 / $44 / $40) moves shoppers up the plan ladder against the pre-rebuild cards priced at the amount charged ($48 / $132 / $240), because the longer plans then read as cheaper rather than as a larger bill. Deliberately two variables: layout and price framing move together, so a win cannot be attributed to either on its own. This replaced pdp_pricing_perbottle_2608, which held the geometry constant to isolate the wording — the question being asked here is which presentation sells, not which half of it does. Read the result accordingly, and split it back apart if the reason matters more than the outcome.",
  // AOV is the point of this test, not conversion — test 01 already won that
  // and the job here is to not give it back. add_to_cart is carried as a
  // guardrail; the decision metric is revenue per visitor and multi-month
  // attach rate, both read at the end rather than used as a stopping rule.
  primaryMetric: "add_to_cart",
  plannedDays: 21,
};

const db = new PrismaClient();
const arg = process.argv.slice(2);

const now = new Date();
const start = arg.includes("--start");
const stop = arg.includes("--stop");

const endsAt = start
  ? new Date(now.getTime() + TEST.plannedDays * 864e5)
  : undefined;

const row = await db.abTest.upsert({
  where: { key: TEST.key },
  create: {
    ...TEST,
    ...(start ? { startedAt: now, endsAt } : {}),
    ...(stop ? { stoppedAt: now } : {}),
  },
  update: {
    name: TEST.name,
    hypothesis: TEST.hypothesis,
    primaryMetric: TEST.primaryMetric,
    plannedDays: TEST.plannedDays,
    ...(start ? { startedAt: now, endsAt, stoppedAt: null } : {}),
    ...(stop ? { stoppedAt: now } : {}),
  },
});

const fmt = (d) => (d ? new Date(d).toISOString().replace(".000Z", "Z") : "—");
console.log(`test        ${row.key}`);
console.log(`metric      ${row.primaryMetric}  (powered for ${row.plannedDays} days)`);
console.log(`startedAt   ${fmt(row.startedAt)}`);
console.log(`endsAt      ${fmt(row.endsAt)}`);
console.log(`stoppedAt   ${fmt(row.stoppedAt)}`);
console.log(
  row.startedAt
    ? "\nRunning. Events after startedAt count toward the result."
    : "\nDeclared but NOT started — ingest is live for QA, nothing counts yet.\nRun with --start when both arms are deployed."
);

await db.$disconnect();
