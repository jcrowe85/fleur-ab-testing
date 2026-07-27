/**
 * Two-proportion significance testing.
 *
 * Everything here answers one question: could the difference between the arms
 * plausibly be the coin landing differently, rather than the page working
 * better? That is the only question an A/B result can actually settle, and the
 * dashboard is careful not to imply it has settled more than it has.
 */

/** Normal CDF via Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7, far past what a p-value needs. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface Arm {
  /** successes — visitors who converted */
  x: number;
  /** trials — visitors exposed */
  n: number;
}

export interface Comparison {
  rateA: number;
  rateB: number;
  /** rateB - rateA, in percentage points */
  absoluteDiff: number;
  /** (rateB - rateA) / rateA — the "20% better" number, null when A converted nobody */
  relativeLift: number | null;
  z: number | null;
  pValue: number | null;
  /** 95% CI on the absolute difference, as proportions */
  ciLow: number | null;
  ciHigh: number | null;
  significant: boolean;
  /** Too little data for the normal approximation to mean anything. */
  underpowered: boolean;
}

/**
 * Pooled two-proportion z-test, plus an unpooled CI on the difference.
 *
 * Pooled variance for the test (the null hypothesis says both arms share one
 * rate); unpooled for the interval (which describes the difference we actually
 * observed). Using one for both is a common slip and makes the CI and the
 * p-value disagree at the margin.
 */
export function compareProportions(a: Arm, b: Arm): Comparison {
  const rateA = a.n > 0 ? a.x / a.n : 0;
  const rateB = b.n > 0 ? b.x / b.n : 0;
  const absoluteDiff = rateB - rateA;
  const relativeLift = rateA > 0 ? absoluteDiff / rateA : null;

  // The normal approximation needs a handful of successes and failures in each
  // arm. Below that the maths still returns a number, and that number lies.
  const underpowered =
    a.n < 30 || b.n < 30 || Math.min(a.x, b.x, a.n - a.x, b.n - b.x) < 5;

  if (a.n === 0 || b.n === 0) {
    return {
      rateA, rateB, absoluteDiff, relativeLift,
      z: null, pValue: null, ciLow: null, ciHigh: null,
      significant: false, underpowered: true,
    };
  }

  const pooled = (a.x + b.x) / (a.n + b.n);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  const z = sePooled > 0 ? absoluteDiff / sePooled : null;
  const pValue = z === null ? null : 2 * (1 - normalCdf(Math.abs(z)));

  const seUnpooled = Math.sqrt(
    (rateA * (1 - rateA)) / a.n + (rateB * (1 - rateB)) / b.n
  );
  const margin = 1.959964 * seUnpooled;

  return {
    rateA, rateB, absoluteDiff, relativeLift, z, pValue,
    ciLow: absoluteDiff - margin,
    ciHigh: absoluteDiff + margin,
    significant: pValue !== null && pValue < 0.05 && !underpowered,
    underpowered,
  };
}

/**
 * Visitors per arm needed to detect a given relative lift, at 80% power and
 * a 5% two-sided significance level.
 *
 * Shown next to the live counts so "not significant yet" can be read as
 * "we are 30% of the way there" rather than as a verdict.
 */
export function requiredSamplePerArm(
  baselineRate: number,
  minDetectableRelativeLift: number
): number | null {
  if (baselineRate <= 0 || baselineRate >= 1) return null;
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + minDetectableRelativeLift);
  if (p2 <= 0 || p2 >= 1) return null;

  const zAlpha = 1.959964; // two-sided 5%
  const zBeta = 0.8416212; // 80% power
  const pBar = (p1 + p2) / 2;

  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator / (p2 - p1)) ** 2);
}
