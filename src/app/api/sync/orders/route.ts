/**
 * GET/POST /api/sync/orders — reconcile Shopify orders into AbOrder.
 *
 * Purchase is the one metric that does not come from the browser. A
 * client-side purchase beacon misses every order that completes on the
 * checkout domain, after a bounce, or on a device that dropped the script —
 * and it would miss them unevenly between arms if one arm happened to be
 * slower. So the bucket rides to the order on a cart attribute and is read
 * back here from Shopify, which is the system of record for revenue.
 *
 * Idempotent: orders are upserted by Shopify id, so re-running only refreshes.
 */

import { db } from "@/lib/db";
import { cartAttributeFor, isBucket } from "@/lib/ab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* The default is ten seconds, which this outgrew in the middle of test 02 and
   then failed silently for 25 days — see the watermark comment below. */
export const maxDuration = 60;

const PAGE_SIZE = 100;

/* Stop paginating here and let the next run continue. Well under maxDuration:
   a run that is killed mid-page still keeps the orders it wrote, but it also
   never reports why it stopped, and "it just stops" is the failure this whole
   change exists to remove. */
const BUDGET_MS = 45_000;

/* How far back before the watermark to look again.
   The watermark is the newest order already attributed, so without an overlap
   the scan would start exactly where it finished and miss anything that landed
   out of order — a cart attribute written late, an order created while the
   previous run was paginating. Two days is far more than either needs and
   costs one extra page. */
const OVERLAP_MS = 2 * 864e5;

interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customAttributes: { key: string; value: string }[];
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  // Vercel Cron signs its own requests; accept those too.
  return req.headers.get("x-vercel-cron") !== null;
}

async function shopify<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

const ORDERS_QUERY = `
  query AbOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
      }
    }
  }
`;

async function sync() {
  const startedAtMs = Date.now();

  // Only running tests are reconciled — a stopped test's totals must not move
  // after the decision was made.
  const tests = await db.abTest.findMany({
    where: { startedAt: { not: null }, stoppedAt: null },
  });
  if (tests.length === 0) {
    return { tests: 0, scanned: 0, attributed: 0, elapsedMs: 0, results: [] };
  }

  const results: {
    test: string;
    scanned: number;
    attributed: number;
    from: string;
    truncated: boolean;
  }[] = [];
  let scannedTotal = 0;
  let attributedTotal = 0;

  for (const test of tests) {
    const attr = cartAttributeFor(test.key);

    /* Resume from the newest order already attributed, not from the start of
       the test.
       Scanning from startedAt every hour meant the work grew with the run's
       age: by day 20 of test 02 it was 28 pages of Shopify round trips, it
       crossed the function's timeout around 2026-09-15, and because the scan
       runs oldest-first every run after that died among orders already in the
       table and never reached the new ones. Nothing errored and the cron kept
       firing — the table simply stopped moving, and 25 days of purchases went
       unattributed on a test whose primary metric is purchases.
       Resuming makes the hourly cost constant instead of linear, so this
       cannot come back as the run gets longer. */
    const watermark = await db.abOrder.aggregate({
      where: { test: test.key },
      _max: { placedAt: true },
    });
    const resumeFrom = watermark._max.placedAt
      ? new Date(watermark._max.placedAt.getTime() - OVERLAP_MS)
      : test.startedAt!;
    /* Never before the test started: an order placed earlier cannot carry this
       test's bucket, and the analysis would exclude it anyway. */
    const since =
      resumeFrom > test.startedAt! ? resumeFrom : test.startedAt!;
    // Shopify's search grammar, not GraphQL — created_at with an ISO bound.
    const filter = `created_at:>=${since.toISOString()}`;

    let after: string | null = null;
    let hasNext = true;
    let scanned = 0;
    let attributed = 0;
    let truncated = false;

    while (hasNext) {
      /* Out of budget. Everything written so far has moved the watermark, so
         the next run picks up from here rather than starting over. */
      if (Date.now() - startedAtMs > BUDGET_MS) {
        truncated = true;
        break;
      }
      const data: {
        orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ShopifyOrder[] };
      } = await shopify(ORDERS_QUERY, { first: PAGE_SIZE, after, query: filter });

      for (const order of data.orders.nodes) {
        scanned++;
        // Cancelled orders are not conversions. Refunds are left alone
        // deliberately: a refund says something about the product, not about
        // which page the shopper saw.
        if (order.cancelledAt) continue;

        const bucket = order.customAttributes.find((a) => a.key === attr)?.value;
        if (!isBucket(bucket)) continue;

        const visitorId =
          order.customAttributes.find((a) => a.key === "_ab_vid")?.value ?? null;

        await db.abOrder.upsert({
          where: { id: order.id },
          create: {
            id: order.id,
            test: test.key,
            bucket,
            orderName: order.name,
            visitorId,
            totalPrice: order.totalPriceSet.shopMoney.amount,
            currency: order.totalPriceSet.shopMoney.currencyCode,
            placedAt: new Date(order.createdAt),
          },
          update: {
            bucket,
            totalPrice: order.totalPriceSet.shopMoney.amount,
            currency: order.totalPriceSet.shopMoney.currencyCode,
            placedAt: new Date(order.createdAt),
          },
        });
        attributed++;
      }

      hasNext = data.orders.pageInfo.hasNextPage;
      after = data.orders.pageInfo.endCursor;
    }

    scannedTotal += scanned;
    attributedTotal += attributed;
    results.push({
      test: test.key,
      scanned,
      attributed,
      from: since.toISOString(),
      /* Loud on purpose. A truncated run is correct — it will finish next hour
         — but a run that is *always* truncated means the budget is no longer
         enough, and that is the shape of the bug this replaced. */
      truncated,
    });
  }

  return {
    tests: tests.length,
    scanned: scannedTotal,
    attributed: attributedTotal,
    elapsedMs: Date.now() - startedAtMs,
    results,
  };
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ ok: true, ...(await sync()) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const POST = GET;
