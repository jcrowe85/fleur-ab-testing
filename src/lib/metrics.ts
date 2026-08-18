/**
 * Turns raw events and synced orders into the funnel the dashboard renders.
 */

import { db } from "@/lib/db";
import { allowedOrigins, BUCKETS, FUNNEL_EVENTS, type Bucket } from "@/lib/ab";
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

/** New visitors entering the test on one UTC day, per arm. */
export interface DailyNewVisitors {
  day: string;
  a: number;
  b: number;
  /** The binding arm — the target has to be met by both, so the smaller one paces the run. */
  perArm: number;
}

/**
 * Whether the planned window will actually deliver the sample the primary metric
 * was powered for. The exposure row is written once per visitor for the life of
 * the cookie, so these are *new* visitors: a returning shopper adds nothing. That
 * makes the daily figure decay as the audience is used up, and a straight-line
 * projection the optimistic bound rather than the expected one.
 */
export interface Pacing {
  requiredPerArm: number | null;
  perArmNow: number;
  perArmPerDay: number | null;
  projectedPerArm: number | null;
  daysRemaining: number;
  daily: DailyNewVisitors[];
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
  /** Null until the test is started — there is nothing to pace against before then. */
  pacing: Pacing | null;
  /**
   * The live page the test renders on. Read back from the exposure events
   * rather than configured, so it cannot drift out of step with where the
   * variant is actually being served. Null if nothing has been recorded yet,
   * or if no storefront origin is configured.
   */
  surfaceUrl: string | null;
}

/** Below this, the elapsed slice is too thin for a daily rate to mean anything. */
const MIN_DAYS_TO_PROJECT = 0.25;

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

  const [eventGroups, orderGroups, excludedPreStart, dailyRows, surfaceRows] = await Promise.all([
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
    // New visitors per day. Grouped on the exposure row, which the
    // [test, visitorId, event] unique index writes exactly once per visitor, so
    // this is arrivals — not sessions, and not the same shopper coming back.
    test.startedAt
      ? db.$queryRaw<{ day: Date; bucket: string; n: number }[]>`
          SELECT date_trunc('day', "createdAt") AS day, bucket, count(*)::int AS n
          FROM "AbEvent"
          WHERE test = ${testKey}
            AND event = 'exposure'
            AND "createdAt" >= ${test.startedAt}
            AND "createdAt" <= ${test.stoppedAt ?? new Date()}
          GROUP BY 1, 2
          ORDER BY 1`
      : Promise.resolve([]),
    // The busiest exposure path is the page under test. The surface marker only
    // fires where the variant is on screen, so this is the page itself rather
    // than every product template in the store. Trailing slashes are folded in
    // so one page does not split its own count across two spellings.
    db.$queryRaw<{ path: string }[]>`
      SELECT COALESCE(NULLIF(regexp_replace(path, '/+$', ''), ''), '/') AS path
      FROM "AbEvent"
      WHERE test = ${testKey} AND event = 'exposure' AND path IS NOT NULL
      GROUP BY 1
      ORDER BY count(*) DESC
      LIMIT 1`,
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
  const elapsedDaysExact = test.startedAt
    ? Math.max(0, ((test.stoppedAt?.getTime() ?? now) - test.startedAt.getTime()) / 864e5)
    : null;
  const daysElapsed = elapsedDaysExact === null ? null : Math.floor(elapsedDaysExact);

  let pacing: Pacing | null = null;
  if (test.startedAt && elapsedDaysExact !== null) {
    const byDay = new Map<string, DailyNewVisitors>();
    for (const r of dailyRows) {
      const day = r.day.toISOString().slice(0, 10);
      const entry = byDay.get(day) ?? { day, a: 0, b: 0, perArm: 0 };
      if (r.bucket === "a" || r.bucket === "b") entry[r.bucket] = r.n;
      entry.perArm = Math.min(entry.a, entry.b);
      byDay.set(day, entry);
    }

    // The target has to be cleared by both arms, so the smaller one is the one
    // that decides whether the window is long enough.
    const perArmNow = Math.min(totals.a.exposures, totals.b.exposures);
    const canProject = elapsedDaysExact >= MIN_DAYS_TO_PROJECT;
    const perArmPerDay = canProject ? perArmNow / elapsedDaysExact : null;
    const daysRemaining = Math.max(0, test.plannedDays - elapsedDaysExact);
    const primary = rows.find((r) => r.key === test.primaryMetric);

    pacing = {
      requiredPerArm: primary?.requiredPerArm ?? null,
      perArmNow,
      perArmPerDay,
      projectedPerArm:
        perArmPerDay === null ? null : Math.round(perArmNow + perArmPerDay * daysRemaining),
      daysRemaining,
      daily: [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day)),
    };
  }

  // The first allowed origin is the customer-facing storefront; the rest are
  // the myshopify fallbacks, which are not where you want to spot-check.
  const storefront = allowedOrigins()[0] ?? null;
  const surfacePath = surfaceRows[0]?.path ?? null;
  let surfaceUrl: string | null = null;
  if (storefront && surfacePath) {
    try {
      surfaceUrl = new URL(surfacePath, storefront).toString();
    } catch {
      surfaceUrl = null;
    }
  }

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
    pacing,
    surfaceUrl,
  };
}

export async function listTests() {
  return db.abTest.findMany({
    // nulls last is load-bearing, not tidiness. The dashboard opens on
    // tests[0], and Postgres sorts NULLs first on DESC — so a test that was
    // declared but never started outranked the one actually running, and the
    // dashboard opened on a row with no data in it.
    orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { key: true, name: true, startedAt: true, stoppedAt: true },
  });
}

export { BUCKETS };
