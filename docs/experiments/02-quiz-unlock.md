# Test 02 — PDP quiz unlock: standing discount vs price earned through the quiz

| | |
|---|---|
| **Test key** | `pdp_quiz_unlock_2310` (fourth run: `_2608` → `_2708` → `_1010` → `_2310`) |
| **Running** | 2026-10-23 08:30 UTC → 2026-11-20 08:30 UTC (28 days planned) |
| **Surface** | `tryfleur.com/products/bloom-hair-scalp-serum-longform` |
| **Primary metric** | Purchase (order completion) |
| **Status** | Running. The three earlier runs are all stopped and **none of them can be read** — see the run history below. |

## Run history — why this is the fourth attempt

| key | ran | why it cannot be read |
|---|---|---|
| `pdp_quiz_unlock_2608` | 08-26 → 08-27 | Superseded after a day. |
| `pdp_quiz_unlock_2708` | 08-27 → 10-10 | Treatment changed mid-flight on 08-29 (below). Then ~1,800 shoppers were pinned into arm B by a creator ad carrying `ab3=b`, giving a sample-ratio mismatch. Then the page under test took 74 commits, mostly improving how the discount is sold — the thing arm B hides until the quiz is passed. Arm A's add-to-cart rose 51% across the run against arm B's 8%; the arms stopped being a comparison on about 09-07. |
| `pdp_quiz_unlock_1010` | 10-10 → 10-23 | **Arm B was broken the whole time.** Appstle patches `window.fetch` and rewrote `selling_plan` on the quiz's own add-to-cart, so a shopper who completed the quiz in a session where Appstle's hidden widget sat on one-time — a clean browser, an incognito window — was charged **$68 for a one-time bottle instead of the $48 subscription she had just earned**, and her cart showed no discount at all. Arm B's conversion was measured against an arm B that only sometimes delivered its own offer. Also present through the whole of `_2708`. |

The `_1010` and `_2708` runs are **not pooled into `_2310`** and should not be
pooled with each other. Their rows are kept for the record, not for analysis.

The defect was fixed in the theme on 2026-10-23 (`fleur-gifting-timline`
`ef0a64e`): plan-carrying adds now go out through a clean-realm iframe `fetch`
that Appstle never patched. Verified live across 1-, 3- and 6-month plans,
accepted and declined second bottle, before `_2310` was declared.

### Known measurement gap carried into this run

Arm B's `add_to_cart` is **under-counted by roughly a third**. The fetch wrapper
in `assets/ab-track.js` cannot see the quiz's clean-realm add, which is now the
main subscribe path in arm B. Fix that before reading add-to-cart, or read only
`exposure`, `initiate_checkout` and `purchase` — purchase comes from the order
sync and is unaffected.

### TOF landers are no longer measured

`tof_lander_donny_1010` was stopped on 2026-10-23. Seven landers all reported
under one key named after the first of them, so it could never tell them apart —
`LANDER_VARIANTS.md` always said to compare them by URL. The lander surfaces now
publish no `window.__ab`, so `ab-track.js` returns at its first line: no events
and no `ab_` cart attribute, so lander orders carry no arm either. They still
render arm A's prices; nothing about their pricing changed.

## Treatment change, 2026-08-29 (applies to `_2708`)

A summary of the shopper's answers was added to the quiz results screen, above
the offer: a one-or-two-sentence teaser with a "read full analysis" expander.
It is generated per answer-shape by a model (`claude-opus-5`) server-side, with
the theme's existing hand-written `buildDiagnosis` copy as the fallback.

**It is gated to arm B** (`window.__ab.bucket === 'b'`), which is where the quiz
results screen is part of the treatment. Arm A takes the quiz from the home page
and is unaffected.

### This contaminates the run, and that was a considered call

Arm B's numbers from 2026-08-29 onward are a different treatment from arm B's
numbers before it. The arm was not re-randomised and the test was not restarted,
so any arm-level figure spanning the changeover is a blend of two pages.

Read it as two segments split on 2026-08-29, not as one 21-day run. Neither
segment will be adequately powered on its own — see below, where the whole run
was already short.

The alternative was stopping and restarting, which was declined: the ~2 days of
data collected to that point were underpowered anyway, and the change was wanted
in front of shoppers sooner than a clean restart would allow.

### Why the change was made

From 144 quiz completions (2026-08-26 → 2026-08-29, 142 unique visitors):

| Persona | Share of takers | CVR | Rev/taker |
|---|---|---|---|
| Telogen (stress shed) | 20.1% | 41.4% | $36.70 |
| Hereditary | 11.8% | 35.3% | $24.24 |
| General | 16.7% | 33.3% | $26.98 |
| **Menopause** | **40.3%** | **19.6%** | **$11.90** |
| Medical | 8.3% | 0% (0/12) | $0 |

The largest segment is the worst monetiser. Menopause takers report "moderate"
commitment at 51.7% against 26.7% for everyone else — the barrier reads as
belief, not price, and this test's treatment is entirely a price mechanism.
Cross-cut with colour-treated hair (74% of menopause takers vs 31% of the rest),
the cell is 30% of all takers and converts at 16.3% against 35.6% for takers who
are neither.

The quiz asks thirteen questions, several about menopause stage and medications,
and answers with a discount. The summary gives those answers somewhere to land.

**These are 3-day figures on cells of 12–58. Directional, not significant.**

## Powering — read before drawing any conclusion

At the observed purchase baseline of 1.17%, detecting a 30% relative move at 80%
power needs **~15,400 visitors/arm**. At the run's pace (~662/arm/day) the full
21 days delivers **~13,900/arm**.

The run is therefore powered for roughly a 30–35% relative swing on its primary
metric, not the 10% test 01 was built for. Splitting it at the changeover makes
each segment materially weaker again. If a subtler effect is expected, this test
cannot resolve it — extend it, or power on revenue/visitor instead.

## Results at 2026-08-29 (pre-change, ~2 days)

A = 1,341 visitors, B = 1,306.

| Metric | A | B | Rel. | p |
|---|---|---|---|---|
| Add to cart | 9.77% | 10.26% | +5.0% | 0.674 |
| Initiate checkout | 3.36% | 2.76% | −17.9% | 0.371 |
| **Purchase** | 1.19% | 1.15% | −3.7% | 0.915 |
| AOV | $75.65 | $82.15 | +8.6% | — |
| Rev/visitor | $0.9026 | $0.9436 | +4.5% | — |

Nothing significant. Directionally consistent with the hypothesis — B level on
purchase while carrying a higher AOV, i.e. the mix shift onto longer plans — but
on 15 and 16 orders that is noise-shaped.

## The mechanism to watch

Arm B's economics run through the quiz take rate. 56 of 1,306 exposed arm B
visitors completed the quiz (4.29%), and those 56 produced 13 of arm B's 15
orders. 4.29% take rate × 23.2% taker CVR ≈ 1.0%, plus almost nothing from the
other 95.7%, which is how B lands level with A.

Take rate is the lever. At 8% and the same taker CVR, arm B lands near 2.0%.

## Known gap: no abandonment data

There are no quiz start or per-step events anywhere in the schema, only
completions. Every persona figure above is therefore conditioned on survival: if
menopause takers abandon mid-quiz at a higher rate, their 40% share is
understated *and* their 19.6% CVR is measured on the subset who tolerated the
questionnaire.

This is the highest-value thing to instrument next, and it should be read before
any further conclusion is drawn from the persona split.
