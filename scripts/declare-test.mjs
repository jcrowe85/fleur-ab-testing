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
  key: "pdp_redesign_2607",
  name: "PDP redesign — original vs Seed/Absorption rebuild",
  hypothesis:
    "The rebuilt longform PDP (short 4:3 mobile gallery with peek, Absorption-style running order, single-plan pricing) converts browsers to add-to-cart at a higher rate than the pre-redesign layout. Nav, page background and the sticky add-to-cart bar are held constant across both arms so the test measures the page, not the whole night's work.",
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
