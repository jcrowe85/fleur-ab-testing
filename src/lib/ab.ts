/**
 * Shared A/B vocabulary.
 *
 * The event names and bucket ids here must match the theme exactly —
 * snippets/ab-assign.liquid writes the bucket, assets/ab-track.js sends the
 * events. A rename on one side without the other silently stops recording a
 * funnel step, which looks like a real drop rather than a bug.
 */

export const BUCKETS = ["a", "b"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Ordered — the funnel reads top to bottom, and the dashboard renders the
 * columns in this order. Purchase is deliberately absent: it does not come
 * from the browser. It is reconciled from Shopify orders via the bucket
 * stamped into the cart attribute, because a client-side purchase beacon
 * misses anything that completes on the checkout domain or after a bounce.
 */
export const FUNNEL_EVENTS = [
  "exposure",
  "add_to_cart",
  "initiate_checkout",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export function isBucket(v: unknown): v is Bucket {
  return typeof v === "string" && (BUCKETS as readonly string[]).includes(v);
}

export function isFunnelEvent(v: unknown): v is FunnelEvent {
  return (
    typeof v === "string" && (FUNNEL_EVENTS as readonly string[]).includes(v)
  );
}

/** Storefront origins permitted to call the public ingest endpoint. */
export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_EVENT_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin.replace(/\/$/, ""));
}

/**
 * Cart attribute the theme stamps with the bucket, e.g.
 * `ab_pdp_redesign_2607`. Shopify carries cart attributes through to the
 * order, which is what makes purchase attributable without session stitching.
 */
export function cartAttributeFor(testKey: string): string {
  return `ab_${testKey}`;
}

/** Trim to a column-safe length without throwing on absurd input. */
export function clamp(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}
