/**
 * The three Black Friday models, measured side by side.
 *
 * Not a split test, and the difference matters for how the numbers are read.
 * Traffic is bought: each campaign points at the page it is selling, so the
 * three columns carry whatever volume media buying sent them and nobody was
 * randomised between them. A shopper who saw the ladder page is not a
 * counterfactual for one who saw the offers page — she was shown a different
 * ad, at a different cost, to a different audience. So this file computes
 * funnels and rates and stops there: no lift, no confidence interval, no
 * winner. Those belong to lib/stats.ts and to pages that earned them.
 *
 * What it is good for is the question actually being asked: of the people who
 * arrived on each page, how many added, how many reached checkout, how many
 * bought, and what did that come to.
 *
 * Attribution is first touch. A visitor is assigned to the model whose page
 * she lands on, and keeps it — snippets/ab-assign.liquid writes the cookie
 * once and never moves her, so the order is credited to the page that acquired
 * her rather than to whatever she wandered through afterwards. Crossovers are
 * counted rather than assumed away; see `crossovers` below.
 */

import { db } from "@/lib/db";

export const VERSIONS_TEST_KEY = "bf_models_1101";

export interface VersionConfig {
  /** Matches the arm written by the theme and listed in TEST_ARMS. */
  id: string;
  label: string;
  /** One line on what the page sells, for the dashboard. */
  blurb: string;
  /** Where it lives, for the open-in-a-tab links. */
  paths: string[];
  /**
   * The Shopify product this model sells, as a numeric id.
   *
   * Each model has its own product, which is what makes an order attributable
   * even when the cart attribute is missing — a cookie cleared between the add
   * and the checkout, a shopper who finished on another device. The order sync
   * falls back to this. It is not the primary key for attribution, because
   * what is being measured is the page seen rather than the thing bought, and
   * those come apart exactly often enough to be worth keeping separate.
   */
  productId: string;
}

export const VERSIONS: VersionConfig[] = [
  {
    id: "subscription",
    label: "Model 1 — subscription",
    blurb: "Home page and the longform PDP. Subscribe and save, Appstle plans.",
    paths: ["/", "/products/bloom-hair-scalp-serum-longform"],
    productId: "8280308482227",
  },
  {
    id: "ladder",
    label: "Model 2 — bottle ladder",
    blurb: "Every bottle cheaper than the last, down to $25. One-time, no plan.",
    paths: [
      "/pages/black-friday-bottles",
      "/products/bloom-peptide-hair-scalp-serum-black-friday",
    ],
    productId: "8765857792179",
  },
  {
    id: "offers",
    label: "Model 3 — two offers",
    blurb: "25% off one bottle, or buy two get the third free. One-time.",
    paths: [
      "/pages/black-friday-offers",
      "/pages/black-friday-deal",
      "/products/bloom-peptide-hair-scalp-serum-bf-offers",
    ],
    productId: "8766154014899",
  },
];

/** Shopify product id -> arm, for the order sync's fallback. */
export const PRODUCT_TO_VERSION: Record<string, string> = Object.fromEntries(
  VERSIONS.map((v) => [v.productId, v.id])
);

export interface LandingRow {
  path: string;
  visitors: number;
}

export interface VersionTotals extends VersionConfig {
  /** Visitors who landed on this model's pages. The denominator for every rate. */
  visitors: number;
  addToCart: number;
  checkout: number;
  purchases: number;
  revenue: number;
  /** Which of this model's pages they arrived on. */
  landings: LandingRow[];
  /** Assigned here, later seen on another model's page. */
  crossovers: number;
}

export interface VersionsReport {
  key: string;
  name: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  daysElapsed: number | null;
  versions: VersionTotals[];
  /** Column-wise sums, so the table can carry an "all three" row. */
  totals: {
    visitors: number;
    addToCart: number;
    checkout: number;
    purchases: number;
    revenue: number;
  };
  /** Rows recorded before the start stamp, excluded from everything above. */
  excludedPreStart: number;
  /** The newest order pulled in by the sync, so a stalled cron is visible. */
  lastOrderAt: Date | null;
}

export function rate(x: number, n: number): number {
  return n > 0 ? x / n : 0;
}

export async function getVersionsReport(): Promise<VersionsReport | null> {
  const test = await db.abTest.findUnique({ where: { key: VERSIONS_TEST_KEY } });
  if (!test) return null;

  const from = test.startedAt ?? undefined;
  const to = test.stoppedAt ?? undefined;
  const window = from || to ? { gte: from, lte: to } : undefined;

  const [eventGroups, orderGroups, landingRows, crossoverRows, excludedPreStart, newest] =
    await Promise.all([
      db.abEvent.groupBy({
        by: ["bucket", "event"],
        where: { test: VERSIONS_TEST_KEY, ...(window ? { createdAt: window } : {}) },
        _count: { _all: true },
      }),
      db.abOrder.groupBy({
        by: ["bucket"],
        where: { test: VERSIONS_TEST_KEY, ...(window ? { placedAt: window } : {}) },
        _count: { _all: true },
        _sum: { totalPrice: true },
      }),
      /* Where each visitor came in. The exposure row is written once per
         visitor — the [test, visitorId, event] unique index sees to that — and
         the insert that wins is the first one, so its path is the page she
         landed on rather than the last one she opened. Trailing slashes are
         folded so one page is not two rows. */
      db.$queryRaw<{ bucket: string; path: string; n: number }[]>`
        SELECT bucket,
               COALESCE(NULLIF(regexp_replace(path, '/+$', ''), ''), '/') AS path,
               count(*)::int AS n
        FROM "AbEvent"
        WHERE test = ${VERSIONS_TEST_KEY}
          AND event = 'exposure'
          AND path IS NOT NULL
          AND "createdAt" >= ${test.startedAt ?? new Date(0)}
          AND "createdAt" <= ${test.stoppedAt ?? new Date()}
        GROUP BY 1, 2
        ORDER BY 3 DESC`,
      /* Distinct visitors, not rows: the interaction table appends, so a
         shopper who bounces between two models all afternoon would otherwise
         read as a crowd. */
      db.$queryRaw<{ bucket: string; n: number }[]>`
        SELECT bucket, count(DISTINCT "visitorId")::int AS n
        FROM "AbInteraction"
        WHERE test = ${VERSIONS_TEST_KEY}
          AND event = 'version_crossover'
          AND "createdAt" >= ${test.startedAt ?? new Date(0)}
          AND "createdAt" <= ${test.stoppedAt ?? new Date()}
        GROUP BY 1`,
      test.startedAt
        ? db.abEvent.count({
            where: { test: VERSIONS_TEST_KEY, createdAt: { lt: test.startedAt } },
          })
        : db.abEvent.count({ where: { test: VERSIONS_TEST_KEY } }),
      db.abOrder.aggregate({
        where: { test: VERSIONS_TEST_KEY },
        _max: { placedAt: true },
      }),
    ]);

  const byId = new Map<string, VersionTotals>(
    VERSIONS.map((v) => [
      v.id,
      { ...v, visitors: 0, addToCart: 0, checkout: 0, purchases: 0, revenue: 0, landings: [], crossovers: 0 },
    ])
  );

  for (const g of eventGroups) {
    const row = byId.get(g.bucket);
    if (!row) continue;
    if (g.event === "exposure") row.visitors += g._count._all;
    else if (g.event === "add_to_cart") row.addToCart += g._count._all;
    else if (g.event === "initiate_checkout") row.checkout += g._count._all;
  }

  for (const g of orderGroups) {
    const row = byId.get(g.bucket);
    if (!row) continue;
    row.purchases += g._count._all;
    row.revenue += Number(g._sum.totalPrice ?? 0);
  }

  for (const r of landingRows) {
    byId.get(r.bucket)?.landings.push({ path: r.path, visitors: r.n });
  }

  for (const r of crossoverRows) {
    const row = byId.get(r.bucket);
    if (row) row.crossovers = r.n;
  }

  const versions = VERSIONS.map((v) => byId.get(v.id)!);
  const totals = versions.reduce(
    (acc, v) => ({
      visitors: acc.visitors + v.visitors,
      addToCart: acc.addToCart + v.addToCart,
      checkout: acc.checkout + v.checkout,
      purchases: acc.purchases + v.purchases,
      revenue: acc.revenue + v.revenue,
    }),
    { visitors: 0, addToCart: 0, checkout: 0, purchases: 0, revenue: 0 }
  );

  const daysElapsed = test.startedAt
    ? Math.floor(((test.stoppedAt?.getTime() ?? Date.now()) - test.startedAt.getTime()) / 864e5)
    : null;

  return {
    key: test.key,
    name: test.name,
    startedAt: test.startedAt,
    stoppedAt: test.stoppedAt,
    daysElapsed,
    versions,
    totals,
    excludedPreStart,
    lastOrderAt: newest._max.placedAt ?? null,
  };
}
