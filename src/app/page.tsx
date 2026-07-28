import {
  getTestReport,
  listTests,
  type MetricRow,
  type Pacing,
  type TestReport,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num = (v: number) => v.toLocaleString("en-US");
const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

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
 * Progress toward the sample the primary metric was powered for.
 *
 * A meter, not a chart: one ratio against a limit. The solid fill is what has
 * arrived, the wash is where the current rate lands by the end of the window,
 * and the full track is the target — so a run that will finish short shows a
 * visible gap at the right-hand end.
 */
function PacingMeter({ pacing, endsAt }: { pacing: Pacing; endsAt: Date | null }) {
  const { requiredPerArm, perArmNow, perArmPerDay, projectedPerArm, daily } = pacing;

  if (!requiredPerArm) {
    return (
      <p className="text-sm opacity-60">
        No sample target yet — it is powered off the control&apos;s observed rate, which needs
        a few conversions first.
      </p>
    );
  }

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  // A sliver of fill still has to be visible on day one, or the meter reads as empty.
  const nowPct = Math.max(clamp((perArmNow / requiredPerArm) * 100), 0.6);
  const projPct = projectedPerArm === null ? nowPct : clamp((projectedPerArm / requiredPerArm) * 100);

  const ratio = projectedPerArm === null ? null : projectedPerArm / requiredPerArm;
  const state =
    ratio === null
      ? { dot: "#898781", text: "too early to project" }
      : ratio >= 1
        ? { dot: "#0ca30c", text: "on track" }
        : ratio >= 0.8
          ? { dot: "#fab219", text: "borderline" }
          : { dot: "#d03b3b", text: "will finish short" };

  const maxDay = Math.max(1, ...daily.map((d) => d.perArm));

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Sample pacing</h2>
        <span className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: state.dot }}
          />
          {state.text}
        </span>
      </div>

      <div className="mt-3 relative h-2.5 rounded-full bg-[#cde2fb] dark:bg-[#184f95]">
        {/* Projection, offset by a 2px surface gap so it never touches the solid fill. */}
        {projPct > nowPct ? (
          <div
            className="absolute inset-y-0 rounded-r-full bg-[#2a78d6]/30 dark:bg-[#3987e5]/35"
            style={{ left: `calc(${nowPct}% + 2px)`, width: `calc(${projPct - nowPct}% - 2px)` }}
          />
        ) : null}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[#2a78d6] dark:bg-[#3987e5]"
          style={{ width: `${nowPct}%` }}
        />
      </div>

      <div className="mt-2.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
        <span className="tabular-nums">
          <strong className="font-semibold">{num(perArmNow)}</strong>
          <span className="opacity-60"> visitors per arm so far</span>
        </span>
        <span className="tabular-nums opacity-70">
          target ~{num(requiredPerArm)} per arm
        </span>
      </div>

      <p className="mt-3 text-xs opacity-70 leading-relaxed">
        {projectedPerArm !== null && perArmPerDay !== null ? (
          <>
            Arriving at ~{num(Math.round(perArmPerDay))} new visitors per arm per day, which
            reaches <strong className="font-semibold tabular-nums">~{num(projectedPerArm)}</strong>{" "}
            by {endsAt ? endsAt.toISOString().slice(0, 10) : "the end of the window"}.{" "}
          </>
        ) : (
          <>Too little of the window has elapsed to estimate a daily rate. </>
        )}
        Read the projection as a ceiling: a visitor is counted once for the life of their
        cookie, so as the audience is used up, fewer of each day&apos;s visitors are new.
      </p>

      {daily.length >= 3 ? (
        <div className="mt-4">
          <div className="flex items-end gap-[2px] h-12" role="img" aria-label="New visitors per arm, by day">
            {daily.map((d) => (
              <div
                key={d.day}
                title={`${d.day} · ${num(d.perArm)} per arm`}
                className="flex-1 max-w-6 rounded-t-[4px] bg-[#2a78d6] dark:bg-[#3987e5]"
                style={{ height: `${Math.max(2, (d.perArm / maxDay) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] opacity-60 tabular-nums">
            <span>{daily[0].day}</span>
            <span>
              {daily[daily.length - 1].day} · {num(daily[daily.length - 1].perArm)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The verdict cell. Deliberately verbose — a bare p-value invites over-reading. */
function Verdict({
  row,
  isPrimary,
  windowComplete,
}: {
  row: MetricRow;
  isPrimary: boolean;
  windowComplete: boolean;
}) {
  const c = row.comparison;

  if (c.underpowered) {
    return (
      <span className="text-amber-700 dark:text-amber-400">
        Not enough data
        {row.requiredPerArm ? (
          <span className="opacity-70"> · need ~{num(row.requiredPerArm)}/arm for a 10% lift</span>
        ) : null}
      </span>
    );
  }

  if (!c.significant) {
    return (
      <span className="opacity-70">
        No difference detected
        {c.pValue !== null ? <span className="tabular-nums"> · p={c.pValue.toFixed(3)}</span> : null}
      </span>
    );
  }

  // Significant. If the planned window is not over, say so plainly: stopping
  // the moment a threshold is crossed is what turns a 5% false-positive rate
  // into 20-30%, and it is the easiest way to be fooled by this page.
  const dir = c.absoluteDiff > 0 ? "B ahead" : "A ahead";
  return (
    <span
      className={
        c.absoluteDiff > 0
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-rose-700 dark:text-rose-400"
      }
    >
      {dir}
      <span className="tabular-nums"> · p={c.pValue!.toFixed(3)}</span>
      {isPrimary && !windowComplete ? (
        <span className="opacity-70"> · interim, run the full window</span>
      ) : null}
    </span>
  );
}

function FunnelTable({ report }: { report: TestReport }) {
  const { totals, rows, test, windowComplete } = report;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse min-w-[860px]">
        <thead>
          <tr className="text-left border-b border-black/15 dark:border-white/20">
            <th className="py-2 pr-4 font-medium">Metric</th>
            <th className="py-2 px-3 font-medium text-right">A — original</th>
            <th className="py-2 px-3 font-medium text-right">B — redesign</th>
            <th className="py-2 px-3 font-medium text-right">Lift</th>
            <th className="py-2 px-3 font-medium text-right">95% CI (abs.)</th>
            <th className="py-2 pl-3 font-medium">Reading</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-black/5 dark:border-white/10">
            <td className="py-2.5 pr-4 opacity-70">Visitors exposed</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{num(totals.a.exposures)}</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{num(totals.b.exposures)}</td>
            <td className="py-2.5 px-3 text-right opacity-40">—</td>
            <td className="py-2.5 px-3 text-right opacity-40">—</td>
            <td className="py-2.5 pl-3 opacity-60">Denominator for every rate below</td>
          </tr>

          {rows.map((row) => {
            const isPrimary = row.key === test.primaryMetric;
            const c = row.comparison;
            return (
              <tr key={row.key} className="border-b border-black/5 dark:border-white/10 align-top">
                <td className="py-2.5 pr-4">
                  {row.label}
                  {isPrimary ? (
                    <span className="ml-2 rounded bg-black/8 dark:bg-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      primary
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {num(row.a)}
                  <div className="text-xs opacity-60">{pct(c.rateA)}</div>
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {num(row.b)}
                  <div className="text-xs opacity-60">{pct(c.rateB)}</div>
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {c.relativeLift === null ? "—" : signedPct(c.relativeLift)}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums text-xs opacity-70">
                  {c.ciLow === null ? "—" : `${signedPct(c.ciLow)} … ${signedPct(c.ciHigh!)}`}
                </td>
                <td className="py-2.5 pl-3 text-xs">
                  <Verdict row={row} isPrimary={isPrimary} windowComplete={windowComplete} />
                </td>
              </tr>
            );
          })}

          <tr>
            <td className="py-2.5 pr-4 opacity-70">Revenue</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{money(totals.a.revenue)}</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{money(totals.b.revenue)}</td>
            <td className="py-2.5 px-3 text-right opacity-40">—</td>
            <td className="py-2.5 px-3 text-right opacity-40">—</td>
            <td className="py-2.5 pl-3 text-xs opacity-60">
              Not tested — revenue per visitor is heavy-tailed, so a proportion test does not apply
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ test?: string }>;
}) {
  const { test: requested } = await searchParams;
  const tests = await listTests();
  const testKey = requested ?? tests[0]?.key ?? "pdp_redesign_2607";
  const report = await getTestReport(testKey);

  if (!report) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-xl font-semibold">No such test</h1>
        <p className="mt-2 opacity-70 text-sm">
          Nothing is declared under <code>{testKey}</code>. Run{" "}
          <code>node scripts/declare-test.mjs</code> first.
        </p>
      </main>
    );
  }

  const { test, totals, daysElapsed, daysPlanned, windowComplete, excludedPreStart, pacing } =
    report;
  const split = totals.a.exposures + totals.b.exposures;
  const splitPct = split > 0 ? totals.b.exposures / split : 0;

  return (
    <main className="mx-auto max-w-6xl p-6 sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{test.name}</h1>
          <p className="mt-1 text-sm opacity-60 font-mono">{test.key}</p>
        </div>
        {tests.length > 1 ? (
          <nav className="flex flex-wrap gap-2 text-xs">
            {tests.map((t) => (
              <a
                key={t.key}
                href={`/?test=${encodeURIComponent(t.key)}`}
                className={`rounded border px-2 py-1 ${
                  t.key === test.key
                    ? "border-black/40 dark:border-white/50"
                    : "border-black/15 dark:border-white/20 opacity-70"
                }`}
              >
                {t.key}
              </a>
            ))}
          </nav>
        ) : null}
      </header>

      {!test.startedAt ? (
        <p className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <strong>Declared but not started.</strong> Ingest is live so the theme can be
          exercised end to end, and {num(excludedPreStart)} event
          {excludedPreStart === 1 ? " has" : "s have"} been recorded — none of it counts.
          Run <code>node scripts/declare-test.mjs --start</code> once both arms are deployed.
        </p>
      ) : null}

      {test.startedAt && !windowComplete ? (
        <p className="mt-6 rounded-lg border border-black/15 dark:border-white/20 p-4 text-sm">
          <strong>
            Day {daysElapsed} of {daysPlanned}.
          </strong>{" "}
          The run length was fixed in advance and powered for{" "}
          <code>{test.primaryMetric}</code>. Reading the result now and stopping on it is
          what turns a 5% false-positive rate into 20–30% — the numbers below are for
          checking that data is arriving, not for calling a winner.
        </p>
      ) : null}

      <section className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="Visitors"
          value={num(split)}
          sub={`${num(totals.a.exposures)} A · ${num(totals.b.exposures)} B`}
        />
        <Stat
          label="Split"
          value={split > 0 ? pct(splitPct) : "—"}
          sub={
            split === 0
              ? "no traffic yet"
              : Math.abs(splitPct - 0.5) > 0.02
                ? "skewed — check assignment"
                : "balanced, as expected"
          }
        />
        <Stat
          label="Orders"
          value={num(totals.a.purchase + totals.b.purchase)}
          sub="from Shopify, via cart attribute"
        />
        <Stat
          label="Window"
          value={test.startedAt ? `${daysElapsed}/${daysPlanned}d` : "not started"}
          sub={
            test.stoppedAt
              ? "stopped"
              : test.endsAt
                ? `ends ${test.endsAt.toISOString().slice(0, 10)}`
                : "—"
          }
        />
      </section>

      {pacing && !windowComplete ? (
        <section className="mt-6">
          <PacingMeter pacing={pacing} endsAt={test.endsAt} />
        </section>
      ) : null}

      <section className="mt-8">
        <FunnelTable report={report} />
      </section>

      {test.hypothesis ? (
        <section className="mt-8 text-sm">
          <h2 className="font-medium">Hypothesis</h2>
          <p className="mt-1 opacity-70 leading-relaxed max-w-3xl">{test.hypothesis}</p>
        </section>
      ) : null}

      <footer className="mt-10 text-xs opacity-50 leading-relaxed max-w-3xl">
        Add to cart and initiate checkout are counted once per visitor from the storefront.
        Purchase is not — it is reconciled from Shopify orders through the{" "}
        <code>ab_{test.key}</code> cart attribute, because a browser-side purchase event
        misses anything that completes on the checkout domain.
      </footer>
    </main>
  );
}
