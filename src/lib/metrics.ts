/**
 * Turns raw events and synced orders into the funnel the dashboard renders.
 */

import { db } from "@/lib/db";
import { BUCKETS, FUNNEL_EVENTS, type Bucket } from "@/lib/ab";
import { compareProportions, requiredSamplePerArm, type Comparison } from "@/lib/stats";

export type MetricKey = "add_to_cart" | "initiate_checkout" | "purchase";

export const METRIC_LABELS: Record<MetricKey, string> = {
  add_to_cart: "Add to cart",
  initiate_checkout: "Initiate checkout",
  purchase: "Purchase",
};

export interface ArmTotals {
  bucket: Bucket;
  exposures: number;
  add_to_cart: number;
  initiate_checkout: number;
  purchase: number;
  revenue: number;
}

export interface MetricRow {
  key: MetricKey;
  label: string;
  a: number;
  b: number;
  comparison: Comparison;
  /** Visitors per arm needed to call a 10% relative lift on this metric. */
  requiredPerArm: number | null;
}

export interface TestReport {
  test: {
    key: string;
    name: string;
    hypothesis: string | null;
    primaryMetric: string;
    plannedDays: number;
    startedAt: Date | null;
    endsAt: Date | null;
    stoppedAt: Date | null;
  };
  totals: Record<Bucket, ArmTotals>;
  rows: MetricRow[];
  daysElapsed: number | null;
  daysPlanned: number;
  /** True once the planned run is over — until then, interim results are not decision-grade. */
  windowComplete: boolean;
  /** Events recorded before the test was started, excluded from every number above. */
  excludedPreStart: number;
}

function emptyTotals(bucket: Bucket): ArmTotals {
  return {
    bucket,
    exposures: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
    purchase: 0,
    revenue: 0,
  };
}

export async function getTestReport(testKey: string): Promise<TestReport | null> {
  const test = await db.abTest.findUnique({ where: { key: testKey } });
  if (!test) return null;

  // Everything is filtered to the declared run window. QA traffic lands before
  // startedAt by design — ingest opens as soon as the test row exists so the
  // theme can be exercised end to end — and must never reach the result.
  const from = test.startedAt ?? undefined;
  const to = test.stoppedAt ?? undefined;
  const window = from || to ? { gte: from, lte: to } : undefined;

  const [eventGroups, orderGroups, excludedPreStart] = await Promise.all([
    db.abEvent.groupBy({
      by: ["bucket", "event"],
      where: { test: testKey, ...(window ? { createdAt: window } : {}) },
      _count: { _all: true },
    }),
    db.abOrder.groupBy({
      by: ["bucket"],
      where: { test: testKey, ...(window ? { placedAt: window } : {}) },
      _count: { _all: true },
      _sum: { totalPrice: true },
    }),
    test.startedAt
      ? db.abEvent.count({ where: { test: testKey, createdAt: { lt: test.startedAt } } })
      : db.abEvent.count({ where: { test: testKey } }),
  ]);

  const totals = {
    a: emptyTotals("a"),
    b: emptyTotals("b"),
  } as Record<Bucket, ArmTotals>;

  for (const g of eventGroups) {
    const bucket = g.bucket as Bucket;
    if (!totals[bucket]) continue;
    // Each row is already one visitor per event type — the [test, visitorId,
    // event] unique index guarantees it — so a plain count is a visitor count.
    if (g.event === "exposure") totals[bucket].exposures += g._count._all;
    else if ((FUNNEL_EVENTS as readonly string[]).includes(g.event)) {
      totals[bucket][g.event as "add_to_cart" | "initiate_checkout"] += g._count._all;
    }
  }

  for (const g of orderGroups) {
    const bucket = g.bucket as Bucket;
    if (!totals[bucket]) continue;
    totals[bucket].purchase += g._count._all;
    totals[bucket].revenue += Number(g._sum.totalPrice ?? 0);
  }

  const metricKeys: MetricKey[] = ["add_to_cart", "initiate_checkout", "purchase"];
  const rows: MetricRow[] = metricKeys.map((key) => {
    const a = { x: totals.a[key], n: totals.a.exposures };
    const b = { x: totals.b[key], n: totals.b.exposures };
    const comparison = compareProportions(a, b);
    // Powered against the control's observed rate, so the target moves as the
    // baseline becomes better known rather than sitting on a guess.
    const requiredPerArm =
      comparison.rateA > 0 ? requiredSamplePerArm(comparison.rateA, 0.1) : null;
    return { key, label: METRIC_LABELS[key], a: a.x, b: b.x, comparison, requiredPerArm };
  });

  const now = Date.now();
  const daysElapsed = test.startedAt
    ? Math.max(0, Math.floor(((test.stoppedAt?.getTime() ?? now) - test.startedAt.getTime()) / 864e5))
    : null;

  return {
    test: {
      key: test.key,
      name: test.name,
      hypothesis: test.hypothesis,
      primaryMetric: test.primaryMetric,
      plannedDays: test.plannedDays,
      startedAt: test.startedAt,
      endsAt: test.endsAt,
      stoppedAt: test.stoppedAt,
    },
    totals,
    rows,
    daysElapsed,
    daysPlanned: test.plannedDays,
    windowComplete: daysElapsed !== null && daysElapsed >= test.plannedDays,
    excludedPreStart,
  };
}

export async function listTests() {
  return db.abTest.findMany({
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
    select: { key: true, name: true, startedAt: true, stoppedAt: true },
  });
}

export { BUCKETS };
