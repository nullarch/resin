# Property / reference test tier

Evidence that does not depend on any golden. The differential suites run on 10 near-degenerate bars
and a count floor, and resin's own tests are largely self-referential; this tier adds three kinds of
check on 500 (indicators) or 300 (strategies) seeded float bars:

- **reference**: brute-force implementations written in the test, plain loops;
- **metamorphic**: the same script under related conditions must give related results;
- **accounting identities**: strategy quantities recomputed from the primitives the accessors expose.

Every `describe` is labelled `self-consistency` or `reference (independent implementation in this
test)`. **Nothing here is TradingView conformance, and nothing here proves it.** A reference written
from the repo's own documented rules (CHANGELOG 0.3.0 "Behaviour changes", comments in
`src/runtime/ta.ts`) can only show that resin implements those rules.

## Files

| file | what it proves | what it does NOT prove |
|---|---|---|
| `reference_ta.test.ts` | 26 reference specs (`ta.*` / `math.sum` functions, some in two variants) equal a brute-force reference on every bar of 3 clean seeds and 6 data variants (na gaps in `close`, whole na bars, a 120-bar flat stretch, zero volume, close recentred on 0, a 3e-11 near-tie grid), at fixed lengths 1..501; 14 functions with a series-length machine again at constant-series, changing, growing and shrinking lengths. | That the *rules* are right: for na handling, flat stretches and warm-up the reference encodes the documented rules, so agreement there means "consistent with the documentation" and nothing more. Only the clean-data rows rest on the textbook definition alone. |
| `invariants.test.ts` | (a) prefix invariance (no lookahead), indicators and strategies; (b) determinism across runs / a fresh `Context`; (c) formatting invariance (CRLF, blank lines, trailing spaces and comments, own-line comments, tabs, BOM, the `//@version` line); (d) power-of-two scale, bit for bit; (e) shift; (f) literal vs series length agree; (g) same call in a UDF / `if` block / loop body; (h) `f(x[1]) == f(x)[1]`. | That any value is correct. A function can be consistently wrong. |
| `strategy_accounting.test.ts` | Per bar: `equity = initial + net + open`, `net = gross profit - gross loss`, `net = sum(closedtrades.profit) - sum(opentrades.commission)`, open size / average price / open profit from the open trades, closed-trade counters from the records; per trade: profit from prices, size and commission, fill prices inside the fill bar's `[low, high]` widened by the slippage, fee schedule from the fill prices; commission additivity (`net(2c) - net(c) = net(c) - net(0)`, same trades); mirror symmetry M1 (swap long/short on the same data: exactly opposite) and M2 (mirror the prices and swap: equal net, mirrored prices); three fee types against a hand-computed run. | Anything about slippage direction, margin (explicitly 0 here), `use_bar_magnifier`, OCA groups, `strategy.risk.*`. A bug that moves price inside the bar (e.g. slippage the wrong way) is invisible to the range check. `equity = initial + net + open` and `net = gp - gl` are near-tautologies of the implementation; the recomputations are the evidence. |

Mutation check done while writing, against the final revision of these tests (scratch copy of the repo,
nothing committed): 36 deliberate bugs in `ta.ts`, `strategy.ts`, `lexer.ts`, `codegen.ts` (accessor
mapping) and the series-length paths, 34 caught (five of them only after a test was added for the survivor);
the other two are equivalent mutants (the `|cov| <= 1e-10` branch of `ta.correlation` cannot be observed on any
non-degenerate window, and degenerate ones are masked; a lookahead mutation that never triggers on
price data).

## Running

```
npx vitest run tests/property                       # default: about 3 s of test time, 150+ tests
RESIN_PROP_RUNS=20 npx vitest run tests/property    # nightly: 20x the seeds / cases (about 35 s)
RESIN_PROP_REPORT=1 npx vitest run tests/property --reporter=verbose   # also prints the tables
```

`RESIN_PROP_RUNS` (integer, default 1, read once in `tests/helpers/prop_util.ts`) multiplies the number
of **seeds / generated cases**; the bar counts never change. Seeds are `base + i`, so RUNS=1 is a prefix
of RUNS=20 and a failure at RUNS=20 reproduces at the seed it names. Everything is `mulberry32`-seeded
and deterministic. Failure messages carry the seed, the script text, the variant, the bar and both values.
`RESIN_PROP_REPORT=1` prints the per-function table (bars compared, na matched, masked, worst |diff|,
worst |diff| / allowed) and the invariants counters; nothing is written to disk.

## Tolerance model (reference_ta)

`allowed = 1e-9 + 1e-9 * |reference| + cond`, with `cond = K * EPS * (magnitude from the reference's own
intermediates)`, `K = 64`, only for the three places where resin's documented algorithm cancels
(variance/stdev moment form, cci's division by a mean deviation, correlation's moment form). `K` was first
16 (one-window analysis) and was raised to 64 after a flat window's dust reached 17.5 EPS E[x^2] and, at
RUNS=20, two correlation bars were 1.2x past 16: resin's sums are *rolling* compensated sums, so their error
accumulates over the bars; 64 is that allowance (about 3 sqrt(500)); it was chosen **after** those failures, with the
rolling-sum structure as the argument. RUNS=40 passes with it; seeds 21..40 had not been seen when it was set,
which is the only out-of-sample check it has had. For a length that changes from bar to bar the variance/stdev bound is also scaled by
`max(1, Lmax / len)` (rolling sums keep the dust of the largest window they summed; a second refinement,
found at RUNS=20 on the shrinking length). Windows the reference itself finds constant are **masked** (counted and reported), and for a
constant window the standard deviation must be na or <= 1e-6 of the level. Non-finite values are na on both
sides ("`na()` reads +inf, -inf and NaN as na", `ta.ts` at `ta.iii`).

## Skipped / unclassified TA functions

- **Not pooled** (`invariants.test.ts`, `SKIPPED`): `pivot_point_levels`, which returns an array handle
  consumed through `array.*` and a calendar anchor, not a plottable scalar series.
- Every other `TA_REGISTRY` key is pooled with a hand-written argument template (73 templates over 72
  names; `vwap` has a one-argument and a three-argument form). A registry key that nobody has classified is
  **reported** (`RESIN_PROP_REPORT=1`, "registry keys not classified") and not failed: at the time of
  writing there are none.
- **No brute-force reference** (covered only by the metamorphic properties): `hma`, `dema`, `alma`,
  `linreg`, `cmo`, `cog`, `mode`, `rci`, `range`, `tsi`, `mfi`, `stoch`, `wpr`, `bb`/`bbw`, `kc`/`kcw`,
  `macd`, `dmi`, `supertrend`, `sar`, `vwap`, `pivothigh`/`pivotlow`, `percentile_*`, `cross*`,
  `rising`/`falling`, `cum`, `max`/`min`, `barssince`, `valuewhen`, `fixnan`, `accdist`, `pvt`, `wad`,
  `nvi`, `pvi`, `wvad`, `iii`, `ao`, `random`, `timeframe.change`.
- **No scale claim** (`degrees` left undefined in the pool): `cross`, `rising`, `falling` (absolute 1e-10
  tolerance) and `mfi` (its absolute 1e-10 cut of rolling money-flow sums that keep rounding dust; found at
  RUNS=20, see below).
- **Excluded from the series-length reference**: `ta.roc` on na gaps (finding below); `ta.median` with a
  length that moves on an na bar (its documented stale window, `medianVarLen`).

## Documented behaviour these tests had to model (not defects)

- A bar with an na source returns the *standing* value for `sma`, `math.sum`, `variance`, `stdev`,
  `median` once warm; `ema`/`rma`/`rsi` return na and keep state; `wma` carries the last value forward;
  `highest`/`lowest` reset the window; `dev`/`cci` are na if any of the last `length` bars is na;
  `correlation` runs five independent na-skipping sums.
- `ta.stdev` of a constant window is rounding dust, up to about 6.7e-6 at price 97, not 0
  (naSkipSum comment, CHANGELOG 80b12eb); `cci`, `correlation` and `vwma` over a constant or zero-volume
  window divide dust by dust.
- `ta.mfi` can be `100.00000000000001` (a lower side of -2e-10 dust is not zeroed).
- A builtin quotient with a zero denominator leaves `+-Infinity` in `RunResult.plots[].values`
  (`ta.stoch`, `ta.wpr`, `ta.vwma`), where a script-level `x / 0` plots `NaN`; both are "na" by the
  documented rule, and the comparisons here treat them so.
- Two opposite orders that fill at the same moment book their closed trade long side first (CHANGELOG
  78f3320): the sign of the size and the ids of a zero-length, zero-profit record are not mirror images.
- A commission is rounded to 10 significant digits per order and shared over the legs; a small trade closed
  next to a big one carries an absolute error of the big order's rounding unit (about 1e-7 on a fee of 0.8
  next to a fee of 1000). Linearity in the commission therefore holds to `1e-8 * (fees booked)`.
- With `process_orders_on_close` an order fills at the bar's close, after the body ran, so the body of that
  bar cannot count the trade (the per-bar `closedtrades` check allows exactly that).

## Findings

1. **`ta.roc` with a series length disagrees with itself across an na gap** (suspected defect).
   `plot(ta.roc(close, 2))` and `plot(ta.roc(close, 2 + bar_index * 0))` on `close = [10, 11, na, 13, ...]`
   give 18.1818 and 27.2727 on bar 3; `100 * ta.change(close, 2) / close[2]` (the manual's definition) gives
   18.1818. `rocVarLen` takes the numerator over the non-na bars only (its comment: "as the oracle runs it").
   Asserted by an `it.fails` in `reference_ta.test.ts` and in `invariants.test.ts` (each confirmed to fail
   on the claimed comparison, not on a typo).
2. Observations, not defects: the `+-Infinity` leak above; `ta.mfi` above 100 by 1e-14; `ta.stdev` dust.
