/**
 * Declare (or re-declare) an experiment.
 *
 *   node scripts/declare-test.mjs                 # create/update, do not start
 *   node scripts/declare-test.mjs --start         # stamp startedAt = now
 *   node scripts/declare-test.mjs --stop          # stamp stoppedAt = now
 *
 * A key may be given to pick which of the declarations below to apply; the
 * first is the default. More than one can be live at a time because they are
 * different surfaces, not different arms — the theme decides which key a page
 * belongs to (snippets/ab-assign.liquid) and a page belongs to exactly one.
 *
 *   node scripts/declare-test.mjs tof_lander_donny_1010 --start
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

const TESTS = [
{
  key: "pdp_quiz_unlock_1010",
  name: "PDP quiz unlock — standing discount vs price earned through the quiz (clean rerun)",
  hypothesis:
    "Same treatment as pdp_quiz_unlock_2708, asked again on a page that is allowed to stand still. Arm A is the page as it ships: subscription plans at the discounted price, $48 / $132 / $240, with Save flags. Arm B shows the full-price plans — $58 / $174 / $348 — and turns those flags into links into the discount quiz, which earns the price back and adds 5% more for a phone number. It is a price rise gated behind thirteen questions, so add to cart and order completion can move in opposite directions, which is why the stopping rule is powered for purchases. The previous run could not answer this and the reasons are written down rather than relitigated: (1) the product page took 74 commits during the run, most of them in the week of 2026-09-06 and almost all of them improving how the discount is sold, which arm B hides until the quiz is passed — arm A's add-to-cart rose 51% across the run while arm B's rose 8%, and the two arms stopped being a comparison on about 2026-09-07; (2) a creator ad shipped 2026-08-31 with ab3=b in its destination URL and pinned roughly 1,800 shoppers into arm B, which is where the sample-ratio mismatch from 2026-09-03 came from; (3) the order sync outgrew its timeout on 2026-09-15 and silently stopped attributing purchases, so the primary metric has no data after 2026-09-11. All three are fixed or neutralised before this run starts. The run's own precondition is the first one: no changes to the longform product page, its sections or its scripts while this is live. A page improved mid-flight is not a treatment, and the last run is the evidence.",
  // Purchases, as before — this is a price mechanism and add-to-cart cannot
  // see the trade it makes. add_to_cart and initiate_checkout are carried as
  // guardrails, and revenue per visitor is read at the end as a directional
  // number only: at this traffic it cannot reach significance and was never
  // going to, so promoting it to the decision metric afterwards would be
  // peeking with extra steps.
  primaryMetric: "purchase",
  // 28, not 21. Traffic has roughly halved since the last run — about 525 new
  // visitors per arm per day against 662 — so 21 days now resolves only a 34%
  // relative move on a 1.40% purchase baseline. 28 days gets that to 29%.
  // Neither reaches the ~8% difference the last run actually showed, and that
  // is the honest shape of this question: this run can rule a large effect in
  // or out, and nothing finer.
  plannedDays: 28,
},
{
  key: "tof_lander_donny_1010",
  name: "Donny TOF lander — standalone funnel, not split",
  hypothesis:
    "Not an experiment: a measurement. The Donny TOF lander shows one page to everyone — arm A's pricing, the discounted plans — and reports its own funnel under its own key so the lander can be judged on its own terms. Both of its surfaces are covered: the page template page.tof-lander-donny, and product.tof, which wraps the same longform-product buy box and would otherwise have been inside the PDP test by accident. Everybody lands in bucket 'a' and bucket 'b' stays empty, which is what the dashboard means by 'not split' — there is no comparison to wait for, so the numbers to read are exposures, add-to-cart, checkout, orders and revenue per visitor, against the PDP's own figures over the same window rather than against a second arm. Deliberately no arm cookie is written here: a shopper who arrives on the lander and later reaches the PDP must be randomised there, the same care the VSL template already takes. One consequence worth knowing when reading revenue: a shopper who buys after seeing both surfaces carries both cart attributes, so her order is attributed to the lander and to the PDP test. That is correct for two separate measurements and wrong if the two are ever added together.",
  primaryMetric: "purchase",
  // Matched to the PDP rerun's window so the two are read over the same days
  // and the same traffic mix, which is the only way the comparison between
  // them means anything.
  plannedDays: 28,
},
];

const db = new PrismaClient();
const arg = process.argv.slice(2);
const wanted = arg.find((a) => !a.startsWith("--"));
const TEST = wanted ? TESTS.find((t) => t.key === wanted) : TESTS[0];
if (!TEST) {
  console.error(`No declaration for "${wanted}". Declared here:`);
  for (const t of TESTS) console.error(`  ${t.key}`);
  process.exit(1);
}

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
