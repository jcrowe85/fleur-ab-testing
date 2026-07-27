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

const PAGE_SIZE = 100;

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
  // Only running tests are reconciled — a stopped test's totals must not move
  // after the decision was made.
  const tests = await db.abTest.findMany({
    where: { startedAt: { not: null }, stoppedAt: null },
  });
  if (tests.length === 0) return { tests: 0, scanned: 0, attributed: 0, results: [] };

  const results: { test: string; scanned: number; attributed: number }[] = [];
  let scannedTotal = 0;
  let attributedTotal = 0;

  for (const test of tests) {
    const attr = cartAttributeFor(test.key);
    const since = test.startedAt!;
    // Shopify's search grammar, not GraphQL — created_at with an ISO bound.
    const filter = `created_at:>=${since.toISOString()}`;

    let after: string | null = null;
    let hasNext = true;
    let scanned = 0;
    let attributed = 0;

    while (hasNext) {
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
    results.push({ test: test.key, scanned, attributed });
  }

  return { tests: tests.length, scanned: scannedTotal, attributed: attributedTotal, results };
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
