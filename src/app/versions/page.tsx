/**
 * The three Black Friday models, one row each.
 *
 * Deliberately not the A/B dashboard. That page exists to decide something,
 * so it carries a stopping rule, a sample target and a confidence interval,
 * and it is right to refuse to call a winner before the window closes. This
 * page decides nothing. Traffic is bought and aimed, the three columns will
 * never be balanced, and nobody was randomised — so there is no lift here and
 * no p-value, because a difference between these rows describes two different
 * audiences as much as it describes two different pages.
 *
 * What it answers is the question that was asked: for each page, how many
 * people came, how many added, how many reached checkout, how many bought,
 * and what that came to.
 */

import { getVersionsReport, rate, type VersionTotals } from "@/lib/versions";

export const dynamic = "force-dynamic";

const num = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const STOREFRONT = "https://tryfleur.com";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15 p-4">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-xs opacity-60">{sub}</div> : null}
    </div>
  );
}

/**
 * A bar behind a number, scaled against the best row in its column.
 *
 * The three rows will differ by an order of magnitude on volume, because spend
 * does — so a column of bare figures makes the small one unreadable and the
 * rate columns, which are the ones that compare fairly, get lost beside it.
 * The bar is per column, so each is read against its own leader.
 */
function Cell({
  value,
  display,
  max,
  tint,
}: {
  value: number;
  display: string;
  max: number;
  tint: string;
}) {
  const w = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <td className="relative py-3 px-3 text-right tabular-nums">
      <span
        aria-hidden
        className="absolute inset-y-1 right-1 rounded"
        style={{ width: `${w}%`, backgroundColor: tint }}
      />
      <span className="relative">{display}</span>
    </td>
  );
}

function VersionRows({ versions }: { versions: VersionTotals[] }) {
  const max = {
    visitors: Math.max(...versions.map((v) => v.visitors), 0),
    addToCart: Math.max(...versions.map((v) => v.addToCart), 0),
    checkout: Math.max(...versions.map((v) => v.checkout), 0),
    purchases: Math.max(...versions.map((v) => v.purchases), 0),
    revenue: Math.max(...versions.map((v) => v.revenue), 0),
    cvr: Math.max(...versions.map((v) => rate(v.purchases, v.visitors)), 0),
    rpv: Math.max(...versions.map((v) => rate(v.revenue, v.visitors)), 0),
  };
  const fill = "rgba(42,120,214,0.14)";
  const fillWarm = "rgba(129,34,33,0.12)";

  return (
    <>
      {versions.map((v) => (
        <tr key={v.id} className="border-b border-black/5 dark:border-white/10 align-top">
          <td className="py-3 pr-4">
            <div className="font-medium">{v.label}</div>
            <div className="mt-0.5 text-xs opacity-60">{v.blurb}</div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {v.landings.length > 0
                ? v.landings.map((l) => (
                    <span key={l.path} className="opacity-70 tabular-nums">
                      <a
                        href={`${STOREFRONT}${l.path}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {l.path}
                      </a>{" "}
                      {num(l.visitors)}
                    </span>
                  ))
                : v.paths.map((p) => (
                    <a
                      key={p}
                      href={`${STOREFRONT}${p}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="opacity-40 underline decoration-dotted underline-offset-2"
                    >
                      {p}
                    </a>
                  ))}
            </div>
          </td>
          <Cell value={v.visitors} display={num(v.visitors)} max={max.visitors} tint={fill} />
          <Cell value={v.addToCart} display={num(v.addToCart)} max={max.addToCart} tint={fill} />
          <td className="py-3 px-3 text-right tabular-nums opacity-60 text-xs">
            {pct(rate(v.addToCart, v.visitors))}
          </td>
          <Cell value={v.checkout} display={num(v.checkout)} max={max.checkout} tint={fill} />
          <td className="py-3 px-3 text-right tabular-nums opacity-60 text-xs">
            {pct(rate(v.checkout, v.visitors))}
          </td>
          <Cell
            value={v.purchases}
            display={num(v.purchases)}
            max={max.purchases}
            tint={fillWarm}
          />
          <Cell
            value={rate(v.purchases, v.visitors)}
            display={pct(rate(v.purchases, v.visitors))}
            max={max.cvr}
            tint={fillWarm}
          />
          <Cell
            value={v.revenue}
            display={money(v.revenue)}
            max={max.revenue}
            tint={fillWarm}
          />
          <Cell
            value={rate(v.revenue, v.visitors)}
            display={money2(rate(v.revenue, v.visitors))}
            max={max.rpv}
            tint={fillWarm}
          />
          <td className="py-3 pl-3 text-right tabular-nums opacity-60 text-xs">
            {v.purchases > 0 ? money(v.revenue / v.purchases) : "—"}
          </td>
        </tr>
      ))}
    </>
  );
}

export default async function VersionsPage() {
  const report = await getVersionsReport();

  if (!report) {
    return (
      <main className="mx-auto max-w-6xl p-6 sm:p-10">
        <h1 className="text-2xl font-semibold">Black Friday models</h1>
        <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <strong>Not declared yet.</strong> Run{" "}
          <code>node scripts/declare-test.mjs bf_models_1101 --start</code> once the theme is
          deployed. Nothing is recorded until that row exists — the ingest drops events for
          an unknown key rather than inventing one.
        </p>
      </main>
    );
  }

  const { versions, totals, startedAt, daysElapsed, excludedPreStart, lastOrderAt } = report;
  const crossovers = versions.reduce((n, v) => n + v.crossovers, 0);
  const staleHours = lastOrderAt ? (Date.now() - lastOrderAt.getTime()) / 36e5 : null;

  return (
    <main className="mx-auto max-w-[88rem] p-6 sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Black Friday — three models</h1>
          <p className="mt-1 text-sm opacity-60 font-mono">{report.key}</p>
        </div>
        <nav className="flex gap-2 text-xs">
          <a
            href="/"
            className="rounded border border-black/15 dark:border-white/20 px-2 py-1 opacity-70"
          >
            split tests
          </a>
          <span className="rounded border border-black/40 dark:border-white/50 px-2 py-1">
            models
          </span>
        </nav>
      </header>

      {!startedAt ? (
        <p className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <strong>Declared but not started.</strong> Ingest is open so the theme can be
          exercised end to end, and {num(excludedPreStart)} event
          {excludedPreStart === 1 ? " has" : "s have"} been recorded — none of it counts.
          Run <code>node scripts/declare-test.mjs bf_models_1101 --start</code> when the
          tracking is live on all three.
        </p>
      ) : null}

      <section className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="Traffic"
          value={num(totals.visitors)}
          sub={startedAt ? `over ${daysElapsed} day${daysElapsed === 1 ? "" : "s"}` : "not started"}
        />
        <Stat label="Orders" value={num(totals.purchases)} sub="from Shopify, not the browser" />
        <Stat label="Sales" value={money(totals.revenue)} sub="all three models" />
        <Stat
          label="Crossover"
          value={totals.visitors > 0 ? pct(rate(crossovers, totals.visitors)) : "—"}
          sub={
            crossovers === 0
              ? "nobody has seen two models"
              : `${num(crossovers)} saw a second model's page`
          }
        />
      </section>

      {staleHours !== null && staleHours > 3 ? (
        <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          Newest attributed order is {Math.round(staleHours)} hours old. The sync runs hourly —
          if that keeps climbing, check <code>/api/sync/orders</code>.
        </p>
      ) : null}

      <section className="mt-8 overflow-x-auto">
        <table className="w-full text-sm border-collapse" style={{ minWidth: "1100px" }}>
          <thead>
            <tr className="text-left border-b border-black/15 dark:border-white/20">
              <th className="py-2 pr-4 font-medium">Page</th>
              <th className="py-2 px-3 font-medium text-right">Traffic</th>
              <th className="py-2 px-3 font-medium text-right">Add to cart</th>
              <th className="py-2 px-3 font-medium text-right opacity-60">rate</th>
              <th className="py-2 px-3 font-medium text-right">Checkout</th>
              <th className="py-2 px-3 font-medium text-right opacity-60">rate</th>
              <th className="py-2 px-3 font-medium text-right">Purchased</th>
              <th className="py-2 px-3 font-medium text-right">CVR</th>
              <th className="py-2 px-3 font-medium text-right">Total sales</th>
              <th className="py-2 px-3 font-medium text-right">Per visitor</th>
              <th className="py-2 pl-3 font-medium text-right opacity-60">AOV</th>
            </tr>
          </thead>
          <tbody>
            <VersionRows versions={versions} />
            <tr className="border-t border-black/20 dark:border-white/25 font-medium">
              <td className="py-3 pr-4">All three</td>
              <td className="py-3 px-3 text-right tabular-nums">{num(totals.visitors)}</td>
              <td className="py-3 px-3 text-right tabular-nums">{num(totals.addToCart)}</td>
              <td className="py-3 px-3 text-right tabular-nums opacity-60 text-xs">
                {pct(rate(totals.addToCart, totals.visitors))}
              </td>
              <td className="py-3 px-3 text-right tabular-nums">{num(totals.checkout)}</td>
              <td className="py-3 px-3 text-right tabular-nums opacity-60 text-xs">
                {pct(rate(totals.checkout, totals.visitors))}
              </td>
              <td className="py-3 px-3 text-right tabular-nums">{num(totals.purchases)}</td>
              <td className="py-3 px-3 text-right tabular-nums">
                {pct(rate(totals.purchases, totals.visitors))}
              </td>
              <td className="py-3 px-3 text-right tabular-nums">{money(totals.revenue)}</td>
              <td className="py-3 px-3 text-right tabular-nums">
                {money2(rate(totals.revenue, totals.visitors))}
              </td>
              <td className="py-3 pl-3 text-right tabular-nums opacity-60 text-xs">
                {totals.purchases > 0 ? money(totals.revenue / totals.purchases) : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer className="mt-10 max-w-3xl text-xs opacity-60 leading-relaxed space-y-3">
        <p>
          <strong>How to read it.</strong> The three rows are not an experiment. Each campaign
          points at the page it is selling, so volume is a media-buying decision and the rate
          columns are the ones that compare — and even those compare two audiences as well as
          two pages. A page running to warm retargeting will out-convert one running to cold
          prospecting whatever is on it.
        </p>
        <p>
          <strong>Traffic</strong> is distinct visitors who landed on one of a model&apos;s
          pages, counted once each for the life of their cookie, which is why a returning
          shopper does not add to it. <strong>Add to cart</strong> and{" "}
          <strong>checkout</strong> are also once per visitor, so each rate is the share of
          arrivals that got that far rather than a count of clicks.
        </p>
        <p>
          <strong>Purchased</strong> and <strong>total sales</strong> do not come from the
          browser. They are reconciled hourly from Shopify: first from the{" "}
          <code>ab_{report.key}</code> attribute the cart carries to the order, and where that
          is missing, from the product the order actually contains — each model sells its own
          product, so an order names its page even when the cookie was lost.
        </p>
        <p>
          <strong>First touch wins.</strong> A visitor belongs to the model whose page she
          landed on and stays there, so an order is credited to the page that acquired her.
          Crossover above is how often somebody then saw a second model — the number to watch
          if these columns ever start sharing shoppers.
        </p>
      </footer>
    </main>
  );
}
