# Changelog

All notable changes to resin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/) — before 1.0, a minor version may change
what a script computes. Versions before 0.3.0 were not recorded in this file; see the
git history.

Every entry below names the commit that made it. Each of those commit messages states
the rule, quotes its evidence (a TradingView export, the certified reference engine,
or the Pine manual) and lists what moved.

## [Unreleased]

Two bodies of work, merged: a verification pass over the converter, and fixes measured against the
TradingView exports of a head-to-head harness.

### Verification pass

A verification pass over the converter: what it accepts, what it silently changes, and what it
does to the host that runs it. Outside "Fixed", nothing here changes a value a valid, in-limits script
computes (the 10,189-script snapshot of `corpus/` and `oracle/` is identical before and after). Commit
hashes are added when this is committed.

#### Added

- `import` links a library: `transpile(source, { libraries })`, `resin run|check --libs <dir>`. It used to
  be discarded by the parser, so every name read through an alias was an "unsupported call". See
  [API.md](API.md#libraries). With no source, the error now names the library.
- A function that returns a matrix is a matrix receiver and initializer (`kernel_matrix(a, b).sum(s)`),
  as a function returning an array or a map already was.

#### Fixed

- `timestamp(dateString)` returned na for `GMT+10`, `UTC-5`, a month written first, a day with no space
  after it, and a leading zone, with no warning. A date window built on one was never open, so the script
  ran to the end doing nothing. Of the 887 date literals in the 4,167 scripts measured, 57 are newly read,
  none already read changed, and all 821 that `Date.parse` reads as well agree with it. A string that still
  cannot be read gives a run warning.
- `matrix.pinv` of an invertible square matrix is its inverse. The previous formula squared the condition
  number: on a regularized kernel matrix (cond ~ 6e5) it was off by up to 4e-4 in the result, where the
  inverse agrees with an independent solve to 1e-11. The `matrix_pinv` golden's square channels moved to
  values 5e-13 from the exact rational inverse (they were 1.2e-8 from it). **TradingView's own value has not
  been compared.**

#### Behaviour changes

- A character outside Pine's alphabet, a string or `/* */` comment that is never closed, and a
  token left on a statement's line after the statement ended are transpile errors. They used to be
  skipped or read as a new statement: `x = close open + 1` compiled as `x = close`, and an
  unclosed quote swallowed the rest of the file. BOM, no-break and other Unicode spaces and
  zero-width characters are still ignored, and CRLF and a lone CR are line breaks.
- An `if`/`else`/`for`/`while` header with nothing indented under it, a color literal that is not
  `#RRGGBB` or `#RRGGBBAA`, and an exponent with no digits (`1e`, `2e-`) are transpile errors. The
  first let the next line become a separate top-level statement; the last compiled to JavaScript that
  does not parse.
- `str.replace` and `str.replace_all` insert the replacement literally. `str.replace_all("a-b", "-",
  "$&")` was `"a-b"` (JavaScript's replacement patterns), and `str.replace` with an occurrence
  already gave `"a$&b"`.
- A loop no longer stops silently after 10,000 iterations. Every iteration of every loop (`for`,
  `while`, `for … in`, and their value-position forms) spends a step of one budget per bar,
  `limits.maxStepsPerBar` (default 10,000,000), and running out throws `ResinLimitError`. A
  20,000-iteration loop now sums to 20,000, and three nested loops stop instead of running 10^12
  iterations.
- Array, matrix (rows × columns), `str.repeat` and `ta.*` window sizes above
  `limits.maxCollectionLength` (default 10,000,000), and sizes that are not whole numbers, throw
  `ResinLimitError`. `array.new_float(1e9)` used to abort the process with a V8 out-of-memory.
- `transpile()` never throws: an internal failure, or a script too deep for the stack, comes back as
  `{ ok: false, internal: true }`, and `ok: true` now means the generated module parses.
- Run options with unequal OHLCV array lengths throw a `TypeError`; the other data and option
  problems below are warnings.
- A variable, parameter, loop variable or function named like a JavaScript word or global the
  generated code relies on (`let`, `static`, `Math`, `Number`, anything starting `__`) is renamed in
  the output. Before, such a name produced a crash or, for `__forLimit`, a wrong value.

#### Added

- `TranspileOk.warnings`: every use of a name that compiles but is not faithful — `stub`
  (`request.dividends`, `request.security_lower_tf`, …), `passthrough` (`ticker.heikinashi`, …),
  `approximated`, `hypothesis`, `noop` — plus ignored option keys, a `//@version` outside 5–6, and
  `strategy()` parameters that are accepted and never read. `transpile(source, { strict: true })`
  turns the stub, pass-through, option and version ones into errors. (`src/transpiler/surface.ts`)
- `RunResult.warnings`: bars that are not the compiled `chartTf` or whose `time` is in seconds, out of
  order, or has `high < low`; an `inputs` override that matched no input title or has the wrong type;
  a `request.security` symbol with no feed in `security`; an option key resin does not read.
- Run options `limits: { maxStepsPerBar, maxCollectionLength, deadlineMs }` and the exported
  `ResinLimitError` and `RunLimits`; transpile option `maxSourceBytes`.

#### Verification harness (in-repo)

`HARNESS.md` says what each layer proves and does not.

- `corpus/diff/status.json`: the `corpus_diff` gate is a per-script ledger, not a count. 562 of the
  2,303 "matches" compare nothing (every compared channel is constant or all-NaN) and are counted
  apart as `matched_vacuous`.
- `oracle/golden/PROVENANCE.json`: which goldens are raw pine2py output and which were corrected by
  hand after the 0.1.0 import (25 of 263).
- `known-gaps.json`: 26 known gaps, each with a repro; closing one fails its `it.fails` test until the
  entry is removed.
- `tests/negative/`: 411 scripts that must be refused, 81 valid near-misses, and 68 invalid scripts
  resin still accepts (each an `it.fails`).
- `tests/property/`: independent brute-force references for 26 ta/math specs on 500 bars, and
  no-lookahead, determinism, formatting, scale and strategy-accounting properties.
- `tests/robustness/` and `scripts/fuzz.mjs`: seeded mutation fuzz in child processes, data shapes and
  string injection. Its first runs found, among others, `str.replace`/`replace_all` reading `$&` in the
  replacement (fixed above) and `ta.percentile_*` ignoring the size limit (fixed; its window top-up is
  now linear, bit-identical to the old output on 768 generated runs).
- `scripts/mutate.mjs` and `mutation/`: 130 mutants of the code that decides numbers, 118 killed, the
  12 survivors listed.
- `scripts/package-smoke.mjs`, `scripts/verify-evidence.mjs`, `scripts/corpus-manifest.mjs`,
  `tests/unit/version_consistency.test.ts`, and the `nightly.yml` / `release.yml` workflows (the release
  one verifies and does not publish). `ci.yml` now covers Node 22.18 and 24, macOS, a clean-tree check
  and the package smoke test.
- `package-lock.json`'s root metadata (`pine2js 0.0.1`, `node >=20`) now matches `package.json`.
- New unit suites: `surface`, `limits`, `run_diagnostics`, `identifier_hygiene`, `known_gaps`,
  `golden_provenance`, `negative_corpus`; lexer and parser strictness cases.

### Built-in signatures

- One table of built-in signatures, `src/transpiler/builtins/signatures.ts` (444 functions), generated from the reference engine's library, and a check of every built-in call against it. A call the table does not allow (`ticker.new()`, `ta.sma(close, len=14)`, `label.set_text(l)`) is a `signature` warning and an error under `strict`. A v5 script may still pass `when=` and `transp=`. Nothing a script computes changes.
- `ta.alma` takes its first argument by the keyword `series`, as the reference and the reference engine name it (was `source`).

### Type record and type check

- `src/transpiler/types/infer.ts` records the evident type of every expression (literals, built-in variables, operators, built-in calls whose return the signature table states plainly, variables introduced once); `types/check.ts` reports what the manual forbids on it: `int x = "a"`, `x = 1` then `x := "a"`, `if "a"`, `s = str.tostring(close)` then `s * 2`, `"Price: " + close`, `ta.sma(close, "5")`. A `type` warning, an error under `strict`. Nothing a script computes changes, and an expression whose type is not evident is never judged.

### Visualization data (`RunResult.viz`), additive

- `viz.plots[].display` (`"all"` or `"none"`), a negative `offset` (it was reported as 0), the `steplinebr` style (it was reported as `line`); `viz.shapes[].values` and `viz.chars[].values`, the series of a `location.absolute` shape; `viz.hlines[].price` for a level that is not a literal (an input, with the run's overrides). No existing field changes.
- `viz.drawings` leaves out objects the script deleted (`label.delete`, `line.delete`, `box.delete`, `table.delete` were no-ops, so every object ever created was listed), and a table's state carries its cells (`cell:<column>:<row>:text`, `:text_color`, `:bgcolor`; `table.cell` was a no-op and dropped its keyword arguments).

### Measured against TradingView exports (head-to-head)

#### Added

- `array.stdev(id, biased)`, `array.variance(id, biased)` and `array.covariance(id1, id2, biased)` accept the optional `biased` argument (default `true`: divide by n; `false`: n-1), positionally, as `biased=` or as method calls; they were rejected at compile time. (c2c2be5)
- `matrix.diff(id1, id2)`, the element-wise subtraction with a matrix or a scalar `id2`; the 1-argument adjacent-row form is kept as an extension. (c2c2be5)
- `run(result, data, { onLog })` and `Context.from(result, data, { onLog })`: a sink for `log.info`/`log.warning`/`log.error`. It receives a `LogEntry` (`level`, `message`, `bar`, `time`) per executed statement; `message` is the text TradingView's Pine Logs pane shows. Without it the calls stay no-ops. New type export `LogEntry`. `resin run --logs` prints the entries to stderr. See API.md "Logs".
- Keyword arguments for `chart.point.new`/`from_index`/`from_time`/`now`/`copy` (`time=`, `index=`, `price=`, `point=`) and for the setters that take a point (`point=`); an unknown or doubled name is a transpile error. (2ef370a)

#### Behaviour changes (outputs differ from 0.3.0)

##### Arrays and matrices

- `array.stdev`/`variance`/`covariance` of one valid element or pair is 0 with the default `biased=true` (was na); unbiased it is na. (c2c2be5)
- `array.sum` of an all-na array is na (was 0); an empty array still sums to 0. (c2c2be5)
- `array.get`/`array.set`/`array.remove` take a negative index from the end of the array (-1 is the last element); `array.insert` takes -size..size. An index outside the array still reads na or does nothing. (fb5c000)
- An na index: `array.insert` appends, `array.slice` takes it as the start (`index_from`) or the size (`index_to`), `array.fill` likewise, and an na rank of `array.min`/`array.max` is 0. (was: `insert` and `fill` did nothing, `slice` was na, `min`/`max` were na) (fb5c000)
- `array.percentile_nearest_rank` and `array.percentile_linear_interpolation` keep na elements in the sort (at the end) and rank over the full length: a rank in the na tail is na, and with any na only the low clamp and an exact rank of the interpolation give a value. The interpolation reads the 1-based position `n * p / 100 + 0.5` (was `(p / 100) * (n - 1)`); an na percentage is rank 0 for the nearest rank (was 100) and na for the interpolation; the nearest rank no longer rounds the 70th percentile of ten values up to rank 8. (1231bb4)
- `array.percentrank(id, index)` ranks the element at the index, `(count at or below it - 1) * 100 / (n - 1)` (was: the share of elements below a value); an na index is index 0 and an na element is na. (1231bb4)
- `array.indexof`/`array.lastindexof`/`array.includes` compare within 1e-10 like `==`; `array.binary_search` stays exact. (1231bb4)
- `array.binary_search_leftmost` answers the first duplicate of a hit and, for a miss, the next smaller element (0 for a value below the whole array, never -1; was the insertion point); `array.binary_search_rightmost` answers the last duplicate of a hit (was the slot after it) and, for a miss, the element to the right of where the value would lie (the array size above the whole array); `array.binary_search` is the classic halving. (c2c2be5, 1231bb4)
- `array.sort_indices(id, order.descending)` is the reverse of the ascending order, so tied elements come out in reversed index order (was: original order). (c2c2be5)
- `array.concat` and `matrix.concat` append to their first argument in place and return it (were: a new array/matrix). (c2c2be5, 1231bb4)
- `array.join` and a logged `array<int>` print `10` where an `array<float>` prints `10.0`; an array counts as int when it comes from `array.new_int`, `array.new<int>`, `array.from` of statically int arguments, or a copy/slice of one. (0aea77e)
- `matrix.reshape` rebuilds its matrix in place (was: a new matrix), and `matrix.reverse` reverses the columns as well as the rows. (c2c2be5)

##### Indicators (`ta.*`)

- `ta.linreg` with a length known before the first bar (a literal, an input) runs TradingView's ring: `length + 1` slots addressed by the chart bar, written only on the bars the call runs, a never-written slot holding 0. An na source is stored like any value and a window holding one is na (it was skipped, the window being the last `length` non-na sources); a conditional call regresses over the stale values its skipped bars left; the warm-up is na while `bar_index < length - 1`. Evidence: TradingView export, h2h ta_375_linreg_windows.
- `ta.linreg`, `ta.highest`, `ta.lowest`, `ta.highestbars`, `ta.lowestbars` with a series length (a length that is an expression of the bar, even one that is always 8) read one slot per chart bar and forward-fill the bars a conditional call skipped, keeping the whole history, so a length that grows reads the true window (before: the ring, and for linreg a warm-up counter that was na again after a growth). Evidence: TradingView export, h2h ta_375_linreg_windows (m2-m4) and ta_376_window_extreme_machines (s_lo_g1, s_hi_alt, s_hb_alt, s_hna).
- The fixed-length `ta.highest`/`ta.lowest` ring holds 0, not na, in a slot no call has written; its growth keeps the slot sharing the current bar's index at the bar a ring earlier; an na call takes its length; the rescan stops at the slot an na call wrote. `ta.range`, `ta.stoch`, `ta.wpr` and the pivots, built on that ring, follow. Evidence: h2h ta_376_window_extreme_machines (c_lo_g2, c_hna, lo_na5).

##### Strategy engine

- `strategy(calc_on_order_fills=true)` walks a bar one fill at a time, as TradingView does (it re-runs the body after every fill): a pass walks only the legs after the node it stands at; the bar's first pass, and any pass whose own market orders filled at its node, walk at most the next leg; otherwise the walk stops at the end of the first leg that fills anything. A `strategy.exit()` limit/stop is judged against the price of the node the pass stands at, not the bar open: an exit marketable at the high fills at the high, one whose entry filled at the low rests until later (it filled at the open price). Evidence: TradingView export, h2h strat_140_coof_stepwise_walk (173/270 trades -> 270/270).
- `strategy.exit()` called while a `strategy.order()` of its `from_entry` id is pending places a leg that waits on the order and binds when it fills, as it does for `strategy.entry()`; the leg was dropped, so the order's trade had no exit until the next call.

##### Indicators, again: TradingView's rolling sum changed

- `math.sum`, and with it `ta.sma` and everything built on them (`ta.stdev`, `ta.variance`, `ta.bb`, `ta.bbw`, `ta.cci`, `ta.correlation`, ...), run TradingView's current rolling-sum machine: a Neumaier-compensated sum that evicts the raw value leaving the window and adds the new one, reporting `s + c`. The reference engine measured that TradingView switched to it between 2026-07-31 and 2026-10-29; resin had the previous machine (fused Kahan with a re-baseline rule). Values move in the last bits; where a window is flat, a `ta.stdev` that was rounding dust is now exactly 0 (or the reverse), which is visible through anything that divides by it.

- `ta.sar` follows the Pine manual's reference implementation, which the reference engine measured TradingView's builtin against bit for bit, warm-up included: the trend starts on bar 1 by `close > close[1]` (a tie starts short; was `high[1] > high`), the full step runs on bar 1 (was the bare start value), and the reversal and extreme-point tests use Pine's 1e-10 tolerance. First bars and near-tie reversals change.

- `ta.cog` is the reference implementation the reference engine measured TradingView against: the denominator is the rolling `math.sum`, the numerator a newest-first loop over the window (was a rolling recurrence, one ulp away on most bars). It now takes a series length, read per bar.

- `ta.roc` with a series length is the manual's formula, `100 * change(src, length) / src[length]`, with one past value in both places, as the literal-length call already was (it took the difference over non-na bars only, so the two spellings of one call disagreed across an na gap).

##### Strategy engine, again

- A limit/stop `strategy.entry` is held to the `pyramiding` limit when it is placed, not when it fills: placed while there was room, it fills whenever it triggers, even after another entry has opened the position (measured on TradingView by the reference engine, 529 of 529 cycles). A market entry is still judged again at its fill. A call the limit rejects also removes the unfilled order of the same id.

- `ta.alma` takes a series length: the reference's `pine_alma`, read with the bar's own length. Its offset, sigma and floor stay `simple`.

##### Arrays, again

- `array.slice` returns a view over its array, not a copy: writing through the slice changes the array and the other way round; a push lands at the slice's end, a pop takes its last element, clearing it cuts those elements out of the array (the Pine reference; measured on TradingView by the reference engine; tier 1 `array_002`, `array_003`).

- With `process_orders_on_close`, margin is judged at the bar's close before the on-close orders fill, so a position opened at the close is first checked at the next open (it could be liquidated on its own entry bar).

- A default-sized (`percent_of_equity` / `cash`) stop entry that the open gaps through is sized at the price it would have executed at when placed, plus slippage, not at the gapped fill; a default-sized stop-limit is sized at that placement price wherever it fills (both measured on TradingView by the reference engine).

##### Language

- `na("")` is true: the empty string is the string na (measured on TradingView by the reference engine). `str.contains(na, "a")` is false and `str.contains("abc", na)` is true (both were na).

- `%` is the truncated remainder and takes the sign of the dividend: `-7 % 3` is `-1` (was `2`), `7 % -3` is `1` (was `-2`), `-7.5 % 2` is `-1.5` (was `0.5`). Measured on TradingView by the reference engine's `test_023_pine_remainder` (`(z - 7) % 3` is -1 on CAPITALCOM:EURUSD 60); resin had read the operators manual's "rounding down the quotient" as the floored modulo. A zero divisor is still na. Only a `%` with a negative operand changes.

##### Strings and time

- `str.format` (and so every `log.*` message) groups thousands the way MessageFormat does: `{0}` and `{0,number}` print `-18,189.894` (was `-18189.894`), `{0,number,integer}` and `{0,number,percent}` print `1,340,000` and `1,250%`, and a pattern with a `,` (`#,###.##`) groups. A pattern without one (`#.##`) and `str.tostring` do not group. TradingView's log text for `ta.variance`/`ta.stdev` of a 1e-16 residual is `-18,189.894`. Evidence: h2h case ta_243_variance_stdev_exact.
- `timestamp(timezone, year, month, day, …)` reads the components as the wall clock of `timezone` (an IANA name, or `"GMT+6"`/`"UTC-5:30"`); it ignored the zone and computed UTC. A wall time that occurs twice takes its first occurrence, one that never occurs the offset in force before the change. Evidence: TradingView export base_001_time (`timestamp("GMT+6", 2016, 1, 19, 9, 30)` is 03:30 UTC).
- `timestamp(year, month, day, …)` without a timezone is a time of the exchange timezone (`transpile(src, { syminfo: { timezone } })`, default UTC, so unchanged by default). A date string without a zone stays UTC.
- `timestamp(dateString)` reads month-first dates with a month name (`"Feb 01 2020 22:10:05"`), `GMT+5`/`UTC-05:30`/RFC zone names after the time (`"04 Dec 1995 00:12:00 GMT+5"`), `"Jan 2025"`, numeric month-first dates (`"03/04/2023"`) and `"2025"`/`"2025-06"`; before, all of them were na. Evidence: base_001_time.

##### Drawings

- `chart.point.now(price)` carries the current bar's index and time (both were na), as the manual describes it. (2ef370a)
- `line.new(first_point, second_point, ...)`, `label.new(point, text, ...)` and `box.new(top_left, bottom_right, ...)` read their chart.point arguments: the drawing's coordinates are the points' index (or their time with `xloc.bar_time`) and price, and the parameters after the points (text, color, style, width, `border_color`, ...) keep their own meaning. They were read as numbers, so every coordinate was na, `label.new(p, "x")` lost its text, and keyword points (`first_point=`, `point=`, `top_left=`) were dropped. (2ef370a)
- `line.set_first_point`/`set_second_point`, `box.set_top_left_point`/`set_bottom_right_point` and `label.set_point` follow the drawing's `xloc` (the point's time on `xloc.bar_time`); `label.set_point` was a no-op. (2ef370a)

#### Documentation

- README verification claims corrected. The 0.3.0 "Verification" entry below says resin reproduces "72/72 indicator scenarios, 46,482/46,482" TradingView records and the README said "in full". Re-measured against PyneCore `0fd57d7` with a neutral harness: all 20 strategy scenarios (16,259 records; the 19 that existed at 0.3.0 reproduce the 15,989 stated) and 75 of 77 indicator and library scenarios match, 93 of the 95 TradingView-export scenarios overall. The 72/46,482 figure could not be reconstructed from PyneCore's repository, and the 0.3.0 build also failed the `array.*`, `matrix.*` and `time`/`timestamp` exports that this release fixes. The remaining misses (`array.slice` as a view) are listed in the README. The 0.3.0 entry is left as published.
- README test count 10,311 -> 10,431; the 0.3.0 entry's 10,305 does not match the 10,311 the README gave at the same release.

## [0.3.0] - 2026-09-28

0.3.0 is the first release measured against TradingView's own results instead of a
sibling implementation. It is 121 commits, one rule each, and most of them change
numbers: the same script can produce different values, trades and statistics than it
did on 0.2.x. Read "Behaviour changes" before upgrading anything whose outputs you
compare across versions. The public exports are unchanged; `transpile()`,
`run()` and `Context.from()` gain options and `TranspileOk` gains fields (see Added).

### Behaviour changes (outputs differ from 0.2.x)

#### Strategy engine

- `strategy()` without `initial_capital` starts from 1,000,000 (was 100,000). (27b1a9c)
- Commission (`commission_type`, `commission_value`) is charged on every filled order; it was parsed and ignored. The type defaults to percent. (b10e60f)
- `slippage=N` moves market and stop fills N ticks against the order; it was ignored. (3dac569)
- `process_orders_on_close=true` fills the bar's orders at its close; it was ignored. (0f4f890)
- `calc_on_order_fills=true` runs the script again after a bar's fills (at most four runs a bar, each rolled back except `varip`); it was ignored. (9d27bca)
- `margin_long`/`margin_short` are honoured and margin calls liquidate a position the account can no longer margin. Omitted, they are 100 from v6 on (0 before), so a v6 strategy can now be margin-called without setting either. (35980ab)
- An entry the account cannot margin is not placed, not filled at the open, and cancelled while it rests. (778be7e)
- Each entry fill is its own trade, and closing fills consume open trades oldest first (FIFO); a pyramided position is no longer one averaged trade. `strategy.close(id)` closes that id's open quantity (was: the whole position), and its exit id is `"Close entry(s) order <id>"`. (218c3c6)
- `strategy.exit()` binds to a pending entry order and is live from the bar that entry fills; it was dropped whenever the position was flat, so an entry + exit bracket placed on one bar had no exit. (6b2820e)
- `strategy.exit(profit=, loss=, trail_points=, trail_offset=)` are ticks (`syminfo.mintick`) from the entry's own fill price, not price points from `position_avg_price`; the levels snap to the tick grid. (c2c3673)
- `strategy.exit(limit=, stop=)` snap to the tick grid, away from the market. (603571c)
- An omitted or na `trail_offset` trails 0 ticks behind the best price (was: `trail_points`; `trail_price=` without an offset never armed). (e842ab3)
- `strategy.exit()` legs are kept per exit id and per entry, each reserving its slice of the position: a second exit id rests beside the first (was dropped), and a filled leg is not placed again while its entry is open. (0457580)
- Exit legs meet their levels in the bar's assumed path: open → nearer extreme → farther extreme → close (was always open → low → high → close, so a long's stop-loss always beat its take-profit). (8b64d22)
- On one segment of that path, levels fill in the order the path reaches them, entries and exit legs alike. (f6665af)
- At a bar's open, entries fill before exit legs whose level the open has gapped past. (9d27bca)
- In v6, a `strategy.exit()` given both levels of a pair (`limit`/`profit`, `stop`/`loss`, `trail_price`/`trail_points`) uses the one the market reaches first; v5 keeps the absolute level. (b124a55)
- An exit leg keeps the side it was placed for; placed for the other side, it closes nothing. (78a378d)
- Entry orders rest side by side, one per id (was a single pending slot that dropped a second id); pyramiding is judged when `strategy.entry()` is called; entry limit/stop levels snap to the tick grid; `strategy.cancel`/`cancel_all` also cancel a market entry placed in the same execution. (1621cd0)
- A limit/stop `strategy.entry` against an opposite position fixes its reversal size when it is placed, not when it fills. (4957300)
- Default-sized orders (`percent_of_equity`, `cash`) are sized when placed, from the close (a market order's slipped), the budget rounded to 10 significant digits and the quantity floored to whole lots of `syminfo.mincontract`; zero lots place nothing (was: fractional sizes at the fill price). (169ce9a)
- `strategy.entry`/`strategy.order` with an na `qty` use the default order size (was: no order). (c70f730)
- A bar's market orders — entries, closes and `strategy.order()` — fill in the order the script placed them (was: every close first). (df23f2d)
- Each `strategy.close()`/`strategy.close_all()` statement places its own close order (was one close slot, last call wins); `strategy.cancel`/`cancel_all` reach them; `close_all`'s exit id is `"Close position order"` (was `""`). (8c8af57)
- `strategy.close(immediately=true)`/`close_all(immediately=true)` fill at the bar's close after the script body, so `strategy.*` values read later in the body are still the pre-close ones. (0fca693)
- `strategy.close_all()` positional arguments bind to TradingView's overloads: v5 `strategy.close_all(cond)` closes only where `cond` holds (was: `cond` read as the comment, closing on every bar). (109651e)
- Two opposite orders filled at the same moment book their closed trade long side first (its entry/exit ids and the sign of its size). (78f3320)
- Strategy statistics follow TradingView's definitions: `max_drawdown`/`max_runup` run from the realized peak and the entry-fill trough to the bar's high/low marks; `grossloss` is positive and includes the open trades' entry fees; averages are na with no trade to average; `avg_losing_trade` is positive; `max_contracts_held_*` count entry fills. (836fdc1)
- Per-trade `max_drawdown`/`max_runup` are marked after the bar's fills, so a trade filled at the open is marked by its entry bar's range. (a9acee7)
- A `strategy.closedtrades.*` number with no listed trade reads 0 for amounts and na for prices, bars and times instead of throwing. (a9acee7)
- A `strategy.opentrades.*` number with no open trade reads 0/na instead of throwing, and a missing closed trade's `entry_id`/`exit_id`/comments read na instead of `""`. (4117faa)

#### Indicators (`ta.*`, `math.*`)

- `ta.supertrend`: direction is 1 in a downtrend and -1 in an uptrend (was the reverse); the first bar is (0, 1), warm-up bars (na, 1), and a flip is judged against this bar's adjusted bands. (e014447)
- `ta.rsi` seeds on the first `length` changes, so its first value lands one bar later, on bar `length`. (725ad54)
- `ta.mfi` counts the first bar in both sums, so its first value lands one bar earlier, on bar `length - 1`. (725ad54)
- `ta.dmi` is TradingView's built-in DMI: every rma seeded like `ta.rma`, true range `ta.tr(false)`, a tolerant directional-movement comparison. (100147b)
- `ta.tr` and bare `ta.tr` default `handle_na` to false: na on the first bar. (481cf09)
- `ta.kc`/`ta.kcw` smooth `ta.ema(ta.tr(false))` (or `ta.ema(high - low)`), and `ta.kcw` is a ratio (was ×100). (5dbeaa8)
- `ta.sma` and `math.sum` average/sum the last `length` non-na values (was: na for `length` bars after an na; `math.sum` counted na as 0). (2cf7ce1)
- `ta.variance`, `ta.stdev`, `ta.bb`, `ta.bbw` use the last `length` non-na values. (aaf903b)
- `ta.median` uses the last `length` non-na values. (39d7458)
- `ta.mode` uses the last `length` non-na values and is na until that many exist. (b7cb0b2)
- `ta.cog` uses the last `length` non-na values. (0132b1d)
- `ta.vwma` is `sma(source * volume) / sma(volume)`, each over its own non-na window. (ed04c08)
- `ta.wma` carries the last value forward through an na source; `ta.hma` skips na bars. (0bdfc8d)
- `ta.highest`/`lowest`/`highestbars`/`lowestbars`: an na source resets the window; a call skipped on some bars reads its own window's stale slots. (f97acf4)
- `ta.highestbars`/`lowestbars` report the oldest occurrence of a tied extreme (was the newest). (311c039)
- `ta.range` is `ta.highest - ta.lowest` on their windows: an na source is skipped, and a length below 1 is na (was -Infinity). (da7cbec)
- `ta.stoch`/`ta.wpr` with a literal length: a bar with an na input is skipped, and `ta.wpr(1)` is the close. (f1f42de)
- `ta.pivothigh`/`ta.pivotlow`: a tie on the right side breaks the pivot. (61813f5)
- `ta.pivothigh`/`ta.pivotlow`: an na source is skipped instead of blanking the window; a negative or na strength is na. (b7ea01b)
- `ta.linreg` reads its line `offset` bars back (was forward) and skips na sources. (b104f4f)
- `ta.rci` is na while `bar_index < length` and ranks ties by their average rank. (feee5f2)
- `ta.cum` of an na source is na and leaves the total alone; `ta.obv` and `ta.pvt` are na on the first bar. (b13f051)
- `ta.vwap` is na until its first anchor, and `ta.vwap(source)`/bare `ta.vwap` start over on each session's first bar (was one running sum from bar 0). (8fc9dc4)
- `ta.vwap` bands sum `source * source * volume` in TradingView's order (flat anchor bars give a zero band width). (febad20)
- Builtins defined as a quotient divide by zero as Pine does (x / 0 is ±inf, 0 / 0 is NaN, both na) instead of substituting 0, or 50 for `ta.stoch`: `ta.iii`, `ta.wvad`, `ta.accdist`'s money-flow term, `ta.cmo`, `ta.cci`, `ta.wpr`, `ta.tsi` and `ta.stoch` on a flat window or zero volume. (7dce07c)
- `ta.percentile_nearest_rank`/`percentile_linear_interpolation` run TradingView's rolling rank machine: a new interpolation position, and na elements take part in the ranking. (079e201)
- `ta.percentrank`: a past na counts toward the length but not the rank, and comparisons are tolerant. (2a3f5b5)
- `ta.cci`/`ta.dev` with a fixed length: the mean is `ta.sma`'s, the deviation is over the last `length` bars and na while one of them is na. (1bdaada)
- `ta.correlation` with a fixed length: five na-skipping sums; 0 for a constant source and for length 1 (was na). (aaf758a)
- `ta.cross` remembers the last unequal relation and is not `crossover or crossunder`; the crosses skip an na bar and return na there up to v5, false from v6. (9b13c89)
- `ta.sar` starts its trend on bar 1 from `high[1]` against `high`, and each call site keeps its own window. (7eef8ad)
- `ta.rising`/`ta.falling`/`ta.cmo` count a step only beyond Pine's 1e-10 tolerance. (7eb06fe)
- A stateful builtin called in a loop keeps one state per call site, each same-bar execution starting from the bar's starting state (was: stepped once per iteration). (3233418)
- `ta.ema`/`ta.rma` step in TradingView's floating-point order (last-bit changes in everything built on them). (d9a76c1)
- `math.sum`, `ta.sma`, `ta.variance` and what builds on them keep TradingView's compensated rolling sum (last-bit changes; flat windows keep their rounding dust). (80b12eb)
- The same compensated sum with a length that changes from bar to bar. (2baba0b)
- The same compensated sum inside a fixed-length `ta.mfi`. (0791692)
- `math.avg` of three or more terms adds with a flushed Kahan sum (last bit). (7de28a4)
- `math.random` with a seed gives `java.util.Random`'s repeatable sequence, one draw per execution (was the same value on every bar); unseeded calls stay reproducible but draw other numbers. (9665aae)
- `math.round(x, precision)` and `math.round_to_mintick` decide a tie on the exact value (`math.round(1.005, 2)` is 1.01); a negative precision rounds to an integer (was to tens). (8105cf9)

#### Language

- `%` is the floored modulo: the result takes the divisor's sign (`-1 % 100` is 99). (962e63d)
- `/` truncates only before v6 and only between two const ints: v6 always keeps the fraction, and v5 `n = -9` then `n / 100` is 0. (f34cf33)
- `?:` evaluates only the branch its condition selects; a stateful call in the other branch does not advance. (8235f56)
- v6 `and`/`or` short-circuit: the right operand runs only when the left one does not decide. (dedef84)
- A comparison with an na operand is false (was na, and `!=` was true). (2bec756)
- Float comparisons treat operands within 1e-10 of each other as equal; ints stay exact. (80b12eb)
- UDT fields declared without a default are na, false for bool (were 0 and `""`). (f7406c5)
- A local series (an if-block local, a function's local or parameter) holds its last committed value on bars its scope did not run (was na). (c288f43)
- A function called in another function's body is one instance per call of the outer function (was shared by all of them). (6ab95b7)
- A v6 `for` loop re-reads its `to` bound before every iteration. (60f1818)
- `barstate.ishistory` is true and `barstate.isrealtime` false on every bar, the last one included. (6f35cd8)
- A line starting with `+` indented by a multiple of four spaces (outside brackets) opens a statement instead of continuing the line before. (d7b75f3)
- A `=` in a nested block declares a new variable even when an outer scope has the name, and every read and assignment goes to the declaration visible where it stands (was: histories of the two mixed). (33f0634)
- A `for` counter or `for`-in item named like a `var` hides it inside the loop (was: read the `var` when it was declared in a block or a function). (1f0a746)
- A function's `var` named like another variable of the function, or like a global `var`, is a variable of its own (was: a sibling branch's read of the global read the `var`). (2f8d3a1)

#### Strings and time

- `str.tostring` and `str.format` (and so log messages) print TradingView's number text: `1` not `1.0`, `true` not `True`, `NaN` not `nan`, DecimalFormat masks and MessageFormat patterns. (8e3ab54)
- `str.format_time` renders in its timezone, by default `syminfo.timezone` (was always UTC); an na time is na. (56a2a80)
- `timeframe.in_seconds` reads the whole timeframe string (`"4D"` is 345,600), a month is 2,628,003 seconds, the default is the chart timeframe, and an invalid string is an error (were 86,400 fallbacks). (6c1b553)
- `timeframe.change` is computed on the symbol's exchange calendar (was always false). (5e949ca)
- `session.isfirstbar`, `islastbar` and `ismarket` read the symbol's session schedule (were bar 0, the last bar, and always true); with no schedule every day is one session from 00:00. (faf5d54)
- `timeframe.isdaily`/`isweekly`/`ismonthly` follow the unit whatever the multiplier (`"2D"` is daily), and `timeframe.isintraday` includes ticks. (849ee25)
- String literals are decoded when lexed, so compile-time strings (plot titles, symbols, formats) no longer keep an escape's backslash. (8fc9dc4)

#### request.security

- An expression the prepass cannot replay — a user-defined function, `var` state, a variable built with `:=` or in a block, an object — is evaluated in the requested context on the requested bars. 0.2.x evaluated some of these forms on the chart's own bars with the timeframe dropped. (cd72165, bcdaf18, 053ae7b, d5cfdd8, 3e68286)
- `timeframe.is*` inside a request's expression read the requested timeframe (was the chart's). (849ee25)

### Added

- `transpile(src, { strategy: { … } })` — TradingView's strategy Properties tab: `initial_capital`, `default_qty_type`/`default_qty_value`, `pyramiding`, `commission_type`/`commission_value`, `slippage`, `process_orders_on_close`, `calc_on_order_fills`, `use_bar_magnifier`, `margin_long`/`margin_short` replace what the script's `strategy()` declares, so many scripts can be measured under one set of rules without editing them.

#### Environment and API

- `transpile(source, { syminfo })`: the chart symbol's tick and lot grids (`mintick`, `pricescale`, `minmove`, `mincontract`). (27b1a9c)
- `syminfo.pointvalue` through the same option; every money amount taken from a price is scaled by it. (b34aef9)
- The symbol's exchange calendar through the same option: `timezone`, `type`, `opening_hours`, `session_starts`. (5e949ca)
- `session_ends` in the same option. (faf5d54)
- The symbol's identity, `prefix` and `ticker`, in the same option; `syminfo.tickerid` is `"PREFIX:TICKER"`. (54890e0)
- `run(result, data, { magnifier })` and `Context.from(result, data, { magnifier })`: the bar magnifier's lower-timeframe feed. (ec86e8c)
- `run(result, data, { security })` and `Context.from(result, data, { security })`: other symbols' feeds for `request.security`, keyed `"SYMBOL"` or `"SYMBOL:TF"`. (dda41fd, 54890e0)
- `TranspileOk.securitySymbols` and `TranspileOk.calendar`. (dda41fd)

#### Strategy engine

- `strategy(use_bar_magnifier=true)` fills orders on the magnifier feed's bars. (ec86e8c)
- OCA groups: `oca_name`/`oca_type` on `strategy.entry` and `strategy.order`, and `strategy.oca.cancel`/`reduce`/`none`. (1b3a9ae)
- `strategy.exit(oca_name=)`, a reduce group, and `alert_trailing=`. (32bc587)
- `strategy.grossprofit_percent`, `strategy.grossloss_percent`, `strategy.avg_trade`, `strategy.avg_trade_percent`, `strategy.closedtrades.first_index`. (836fdc1)
- `strategy.closedtrades/opentrades.max_drawdown_percent` and `max_runup_percent`. (a9acee7)
- `strategy.opentrades.entry_comment`. (383b05a)
- `strategy.cancel_all(when=)` (v5). (5b2190d)
- `[]` on a `strategy.opentrades.*(n)`/`strategy.closedtrades.*(n)` call. (75d8994)
- `strategy()` numeric arguments take constant expressions and constant variables. (a61fe01)
- `overlay`, `process_orders_on_close`, `use_bar_magnifier` and `calc_on_order_fills` take any const bool, and a number before v6. (344d64c)

#### Indicators

- A length that changes from bar to bar for `ta.change`, `ta.mom`, `ta.roc`, `ta.cmo`, `ta.cci`, `ta.dev`, `ta.variance`, `ta.stdev`, `ta.bb`, `ta.bbw`, `ta.mfi`, `ta.stoch`, `ta.wpr`, `ta.percentrank`, `ta.mode` and `ta.correlation`; `ta.variance(biased=)`. (bba2857)
- `ta.alma(..., floor)`. (a31a6f0)
- Keyword arguments for `ta.kc`/`ta.kcw`. (5dbeaa8)
- `syminfo.prefix(symbol)`. (4b43ad6)

#### request.security

- Another symbol's own bars, from `opts.security`. (dda41fd)
- Nested requests, run in the outer request's context. (54890e0)
- A request whose expression depends on another request reads that request as the chart computed it. (27990a9)
- A function's request may read another request of the function, and a call made through another function runs in the requested context. (3e68286)
- Expressions evaluated in the requested context: `:=`-built variables, `var` state, user-defined functions, local history. (cd72165)
- Requests inside user-defined functions, one request per call of the function. (bcdaf18)
- Strings and colors computed in the requested context. (437045d)
- Objects of user-defined types. (053ae7b)
- Timeframes known only at run time, bound on the call's first execution. (d5cfdd8)
- The same inside functions, per call. (bfae5b2)
- The same for requests built from a function's argument. (19b5805)
- A name declared by a tuple declaration reads as its element. (93e1a76)
- `timeframe.*` inside a request's expression is the requested timeframe; `timeframe.main_period` the chart's. (849ee25)

#### Language

- Same-arity function overloads, told apart by their parameter types. (c4d881d)
- Before v6, a keyword argument given twice keeps its first value. (6d4ee5a)
- Before v6, a parameter given positionally and again by keyword keeps the positional value. (15a55c0)

### Fixed

- A local declaration that shadows a variable its block already read ("Cannot access … before initialization"). (17aa4b7)
- A UDT variable declared from another variable holding one (`a = p`, then `a.x := …`). (8170578)
- `timestamp()` with later parts given by name, and `input.int`/`input.float` with an options list as the third argument. (a9f3df7)
- A user-declared method's call has the UDT its body returns. (382ad71)
- `array.from(...)` of drawings or UDT objects. (c55684f)
- An untyped parameter passed on to another function. (2a7f4d1)
- A function-body local with history that a nested block declares again. (33f0634)
- A `for` counter or `for`-in item named like a top-level `var`. (1f0a746)
- A function's `var` beside a sibling branch's `=` of the same name. (2f8d3a1)
- A `switch` case starting with `+` (`+1 => …`). (d7b75f3)
- `strategy.close_all('EOD', 'End of Day Exit', true)`. (109651e)
- `ta.mode` with an na length returns na instead of throwing. (079e201)

### Known issues

- A `request.security` on the chart's own symbol, built from the chart's bars, delivers each higher-timeframe value one chart bar later than the reference engine and the manual, and a same-timeframe request reads the previous bar. Requests handed a feed through `opts.security` pair as TradingView does.
- `hour`, `dayofweek`, `time()` and the other time builtins read UTC, not `syminfo.timezone`; only `str.format_time`, `timeframe.change` and `session.*` use the symbol's timezone.
- `ta.alma` and `ta.cog` still refuse a length that changes from bar to bar.
- 63 of the 800 generated indicator scenarios still differ from the reference engine somewhere (series-length `ta.mode`/`ta.bbw`/`ta.cci`, `ta.roc` over na bars, `hlcc4`'s last bit, …).

### Verification

Measured at this release by the separate resin-harness:

- TradingView's own exports (published by PyneSys in PyneCore's repository): 19/19 strategy scenarios, 15,989/15,989 trade and statistic records; 72/72 indicator scenarios, 46,482/46,482 plot values, log lines and measured expectations. 0.2.2 matched 2 of the 19 strategy scenarios in full.
- The certified reference engine (PyneCore, pinned; 380 of 402 published strategies trade for trade against TradingView): 3,600/3,600 generated strategy scenarios (0.2.2: 550), 737/800 indicator and 600/600 language scenarios, 117/118 hand-written probes.
- A real-world corpus (3,904 v5/v6 files from 543 GitHub repositories): 2,970 of the 2,979 valid plain scripts transpile (99.7%) and 2,964 run (99.5%). Acceptance only: their values are not checked.
- resin's own suite: 10,305 tests.
