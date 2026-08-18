# Test 01 — PDP redesign: original vs Seed/Absorption rebuild

| | |
|---|---|
| **Test key** | `pdp_redesign_2607` |
| **Ran** | 2026-07-27 11:28 UTC → 2026-08-17 11:28 UTC (21 days, full planned window) |
| **Surface** | `tryfleur.com/products/bloom-hair-scalp-serum-longform` |
| **Primary metric** | Add to cart |
| **Result** | **B wins the primary metric.** Ship-forward to a follow-up test, not to production as-is. |

## Hypothesis

The rebuilt longform PDP (short 4:3 mobile gallery with peek, Absorption-style running order, single-plan pricing) converts browsers to add-to-cart at a higher rate than the pre-redesign layout.

Nav, page background and the sticky add-to-cart bar were held constant across both arms, so the test measures the page rather than the whole rebuild.

## What actually differed between the arms

This matters for reading everything below, and it is wider than "a redesign":

- **Arm A (original)** — three offers on the page: 1-month $48, 3-month $132, 6-month $240.
- **Arm B (rebuild)** — a single offer on the page: 1-month $48.

Multi-month SKUs remained reachable in arm B through the **Shop tab**, so B is not a pure single-offer arm — it is "single offer *on the PDP*." B took 26 orders at $132 during the run, confirming that path is live.

The treatment is therefore *fewer options*, which is design and offer structure inseparably. The test cannot attribute the result to the visual redesign alone, and was never intended to.

## Results

Sample: **A = 20,320** visitors, **B = 20,232** visitors. Requirement for a 10% relative lift on the primary metric at 80% power was **11,398/arm** — cleared by 1.8×, giving an achieved MDE of 7.5%.

| Metric | A | B | Relative lift | 95% CI | p |
|---|---|---|---|---|---|
| **Add to cart** | 2,551 (12.55%) | 2,727 (13.48%) | **+7.36%** | +2.1% … +12.6% | **0.0057** |
| **Initiate checkout** | 893 (4.39%) | 1,019 (5.04%) | **+14.61%** | +5.2% … +24.0% | **0.0023** |
| Purchase | 489 (2.41%) | 533 (2.63%) | +9.47% | −3.2% … +22.2% | 0.143 |
| Revenue / visitor | $1.8888 | $1.6966 | −10.18% | −23.6% … +3.2% | 0.137 |

Revenue detail:

| | A | B |
|---|---|---|
| Total revenue | $38,379.63 | $34,324.73 |
| Orders | 489 | 533 |
| AOV | $78.49 | $64.40 |
| Orders ≥ $100 | 137 (28.0%) | 68 (12.8%) |
| Share of revenue from orders ≥ $100 | 52.1% | 28.1% |

Order mix by price point (top 6):

- **A** — $48 × 180, $58 × 65, **$132 × 57**, $40.80 × 28, $112.20 × 19, $64 × 12
- **B** — $48 × 254, $58 × 69, $40.80 × 34, $64 × 29, **$132 × 26**, $116 × 9

## Conclusions

### Confirmed

**Reducing the number of options on the PDP increases conversion, at every step of the funnel.** Add-to-cart +7.4% (p=0.006), checkout initiation +14.6% (p=0.002), purchase +9.5% (directionally consistent). Three consecutive funnel steps moving the same direction is mechanism evidence, not a single lucky metric. The primary metric's confidence interval excludes zero comfortably (+2.1% to +12.6%).

### Not confirmed

**That arm B makes more money.** It did not. Revenue per visitor came in 10.2% *below* A — a gap of **$4,055 over 21 days, roughly $68k/year** at this traffic level.

That difference is not statistically significant (p=0.137, CI spans −23.6% to +3.2%), and it cannot be made significant at this traffic level: detecting a 10% revenue-per-visitor change requires ~74,700 visitors/arm, versus the ~20,200 we collected. Order values range $30–$385, so the variance is far too high for a 21-day window to resolve.

But the point estimate drifted monotonically against B across every interim look (+1.9% → −6.6% → −8.9% → −10.2%). That consistency of direction carries more weight than any single p-value, and it should be treated as a real risk rather than noise.

### Net read

B wins the mechanism test and currently loses on money. The conversion lift is real; it does not pay for the lost multi-month attach rate. **B is not shippable on its own.**

## Target for Test 02

Test 02 reintroduces a simplified 3/6-month promotion onto the B page. The bar it has to clear:

| | Current (B) | Target (B+) |
|---|---|---|
| AOV | $64.40 | **~$71.69** (+11.3%) |
| Orders ≥ $100 | 12.8% | **~21%** |
| Revenue gap to close | — | **$3,889** per 21 days |

B+ does not need to match A's ladder — it needs to close roughly half the attach gap, because the conversion lift already pays for the rest.

**Success metric for Test 02 is AOV / multi-month attach rate, not conversion.** The conversion battle is already won; the goal is to raise basket value without giving it back. Add-to-cart should be tracked as a *guardrail* — if it regresses to A's level, the simplification benefit has been undone.

## Methodology notes

Worth carrying into the next test.

### Interim looks nearly caused two wrong calls

| Look | Day | n/arm | ATC lift | p | RPV |
|---|---|---|---|---|---|
| 1 | 1 | ~1,250 | +42.3% | 0.043 | — |
| 2 | 8 | ~10,200 | +7.4% | 0.087 | +1.9% |
| 3 | 11.5 | ~13,521 | +6.8% | **0.0496** | −6.6% |
| 4 | 19.5 | ~19,518 | +7.4% | 0.0062 | −8.9% |
| **Final** | **21** | **20,232** | **+7.36%** | **0.0057** | **−10.18%** |

- The day-1 reading (+42%, p=0.043) was pure noise at 3% of the planned sample. Stopping there would have shipped a wildly overstated lift.
- The day-11.5 reading sat at p=0.0496 with a CI lower bound of exactly 0.00pp — the most fragile possible place to stop, and it arrived precisely when the sample target appeared to have been met. Running the full window moved it to p=0.0057.
- **Rule for next time: write the stopping rule down before the first look, and stop on the calendar boundary, not on a p-value crossing.**

### The sample-size target is a moving goalpost

The dashboard recomputes `requiredPerArm` from the *observed* baseline rate, so it moves as that rate settles. Over this run it read 38,000 → 15,145 → 12,825 → 11,398. On day 11.5 it briefly looked as though the requirement had been "exceeded" when in fact the bar had dropped to meet us. Pre-register the target from a baseline measured *before* the test starts.

### Conversion lag deflates early rates

Exposure is stamped on arrival; add-to-cart can land days later and still counts against that visitor. Early in a run the denominator is fully aged and the numerator is not, so conversion rates read artificially low and climb as the run matures — the primary metric's baseline moved 4.18% → 9.77% → 12.55% for this reason alone, with no underlying change. Do not compare rates across calendar slices of a live run.

### Weekday composition

The run started on a Monday and covered three full weeks, so day-of-week composition is balanced. At day 11.5 it was not — only one Saturday and one Sunday against two of every weekday, with weekends being the low-traffic days. Any future early stop should land on a whole number of weeks.

### Known measurement caveats

- **Per-visitor dedupe is lifetime-of-cookie.** Exposure rows are written once per visitor for the life of the cookie, so daily figures are *new* visitors and necessarily decay. Straight-line projections are an optimistic ceiling, not an expectation.
- **Pre-start events are excluded** from all figures above (filtered to the declared run window). A visitor first exposed before `startedAt` is permanently numerator-only. Measured impact on this test: **1 affected add-to-cart**. Negligible.
- **`totalPrice` is the whole order**, not just the test product, so AOV includes anything else in the basket.
