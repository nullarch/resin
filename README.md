<p align="center">
  <img src="docs/logo.svg" width="96" alt="Resin logo — an amber droplet with a candlestick chart preserved inside">
</p>

<h1 align="center">Resin</h1>

<p align="center"><strong>Run TradingView Pine Script outside TradingView.</strong></p>

<p align="center">
  <a href="https://github.com/nullarch/resin/actions/workflows/ci.yml"><img src="https://github.com/nullarch/resin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Pine_Script-v5%20%2F%20v6-1a7f37" alt="Pine Script v5 / v6">
  <img src="https://img.shields.io/badge/dependencies-none-success" alt="Zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="API.md">Library API</a> ·
  <a href="https://www.wavealgo.com/leaderboard">See it in production: the wavealgo leaderboard ↗</a>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="docs/hero.svg" width="640" alt="Terminal session: a Pine Script indicator is compiled to JavaScript with resin build and executed with resin run">
</p>

Resin compiles Pine Script v5/v6 to a plain JavaScript module and runs it —
same indicators, same series semantics, your own machine. TradingView will not
let a script leave the platform; this is how you get it out.

- **95.1%** of 10,618 real-world scripts compile ([measured, method below](#coverage-and-where-the-number-comes-from))
- **9,877 tests**, plus a differential oracle matched to an independent
  implementation at 1e-9
- **Zero runtime dependencies** — the CLI runs straight from a clone, no
  install step, no build step
- **Running in production** — every score on the
  [wavealgo leaderboard](https://www.wavealgo.com/leaderboard) is computed by
  this engine

## Quick start

Requires Node 22.18+ (it executes the TypeScript source directly). Nothing to
install:

```bash
git clone https://github.com/nullarch/resin.git
cd resin

# run an indicator and print the last bar's plot values
node bin/resin.mjs run examples/rsi-cross.pine --bars 300
```

```text
RSI                      57.66239695569333
Smoothed                 54.056462491106444
```

```bash
# compile it to a JavaScript module you can read
node bin/resin.mjs build examples/rsi-cross.pine -o rsi-cross.js

# point it at a folder of your scripts and find out how much of it compiles
node bin/resin.mjs check ./my-scripts

# optional: get `resin` on your PATH instead of typing node bin/resin.mjs
npm install -g .
```

`run` synthesizes deterministic bars by default; pass `--data bars.json` to use
your own OHLCV data. Not on npm yet — clone it for now.

## Why

Pine is a good language for expressing a trading idea and a bad place to keep
one. You cannot run a Pine script in CI, cannot backtest a thousand of them in
an afternoon, cannot embed one in a bot, and cannot take the indicator you spent
a weekend tuning and put it in your own application. Every one of those needs
the script to run somewhere else.

Resin is a compiler and a runtime, not a charting product. It gives you the
values; what you do with them is yours.

## In production: the wavealgo leaderboard

The clearest demonstration of "run Pine outside TradingView" is a site that
does it at scale. [wavealgo.com/leaderboard](https://www.wavealgo.com/leaderboard)
— built by the same team — grades Pine strategies the way a single chart
never can: each script is compiled by this engine and backtested across
**6 markets × 3 timeframes, 18 cells per script**, with TradingView's
next-bar-open fill rule and per-side fees, then given a verdict and an alpha
score. Every number on that page came out of this compiler; the
[methodology](https://www.wavealgo.com/methodology) is public.

If you want to see what Resin's output looks like before cloning anything,
start there.

## Coverage, and where the number comes from

Against a snapshot of **12,424** public Pine v5/v6 scripts collected from GitHub:

| | scripts | |
|---|---:|---|
| Snapshot | 12,424 | v5/v6, deduplicated |
| — TradingView rejects them too | −1,085 | verified against TradingView's own compiler |
| — import a private library we cannot resolve | −719 | out of scope |
| **Denominator** | **10,618** | |
| **Compiles** | **10,100** | **95.1%** |

The 1,085 exclusions are not our judgment. Every failing script was submitted to
TradingView's own compiler and recorded; those are the ones TradingView also
refuses. An earlier version of this project made that call by inference instead
and came close to discarding about 1,200 perfectly valid scripts.

**The corpus is not in this repository.** It is thousands of third-party scripts
under mixed and often absent licenses, and redistributing it is not ours to do.
So you cannot reproduce that specific number here — you can only reproduce the
method, by running `resin check` over scripts you already have.

The `corpus/` directory you will find here is a different set, not that survey:
Pine fixtures taken from the reference implementation's own test suite, which the
differential replay below runs against its golden output. Source comments that
cite `corpus/wild/...` do mean the survey, and those paths do not resolve here.

## How it is verified

Three independent checks, because a compiler that is merely self-consistent is
not worth much:

1. **Differential against a reference implementation.** A separate Python
   implementation of the same language runs the same script over the same bars
   and the outputs are compared bar by bar — 263 scripts in `oracle/`, matched
   to 1e-9. The two disagree in a handful of places on purpose, because the
   reference is the one that is wrong there; each of those is argued at the
   call site rather than silently waived.
2. **TradingView's own compiler**, as the arbiter of what is even valid Pine.
   This is what turns "we fail on this script" into either "our gap" or "not
   valid Pine" without anyone guessing.
3. **The test suite**, which is where the semantics actually live.

## What works

Pine's semantics are unusual and most of the work is there rather than in the
syntax. Every value is a time series, `var` and `varip` have their own
initialization rules, `na` is not `NaN` in every context, technical-analysis
functions carry hidden per-call state that has to be allocated at compile time,
and a conditionally-executed `ta.*` call still has to advance its state on bars
where the branch is not taken. Those are the parts that are implemented and
tested.

68 `ta.*` functions, the strategy engine (entries, exits, pyramiding,
`strategy.*` state), user-defined types and methods, arrays, maps, matrices,
`request.security` with higher-timeframe aggregation, drawing objects, and the
`input.*` family.

## Using it as a library

```js
import { transpile, compile, Context } from '@nullarch/resin';

const result = transpile(source, { chartTf: 'D' });
if (!result.ok) throw new Error(result.errors.join('\n'));

const ctx = new Context(
  data, result.varSlots.length, result.taSlotCount, result.fnVarSlotCount,
  result.historySlotCount, result.taScratchSize, {},
  result.plotTitles.length, result.securityTfs, result.refHistorySlotCount,
  result.condCallHistorySlotCount, result.condCallRefHistorySlotCount,
);
const bar = compile(result.code)(ctx);
for (let i = 0; i < ctx.barCount; i++) { ctx.advance(); bar(); }

console.log(ctx.plots[0].toArray());
```

`run()` does the same thing in one call when you do not need to observe state as
it goes. The supported surface is exactly what `src/index.ts` exports and
nothing else — everything under `src/` beyond that is internal and will change.
See [API.md](API.md).

## What this does not do

- **No charts.** Resin computes plot series. Drawing them is your problem.
- **Visualization-only calls compile to no-ops.** `plotshape`, `plotchar`,
  `bgcolor`, `barcolor`, `hline`, `alertcondition`, `alert` and friends mark up
  a chart that does not exist here, so they are dropped at compile time —
  `plot()` calls nested in their arguments still record. If you need a shape's
  condition as data, `plot()` it.
- **Order fills follow TradingView's documented rule — market orders at the next
  bar's open — but that has not been confirmed against TradingView itself.** The
  rule is implemented from the specification, not from a side-by-side run. If
  you are relying on backtest numbers rather than indicator values, treat them
  as provisional.
- **Intrabar fills cannot be confirmed from bar data at all.** A stop, a limit or
  a trailing exit fills somewhere inside a bar and OHLC does not record where.
  Any engine, this one included, is guessing a path. TradingView has the same
  limitation and says so.
- **`request.security` is aggregated from the bars you supply**, not fetched. If
  you feed daily bars and the script asks for weekly, Resin builds the weekly
  series by calendar aggregation.
- **No `v4` or earlier.** v5 is the floor.
- **Some semantics are reasoned, not confirmed.** TradingView does not document
  everything — what `dayofweek` returns at a week boundary, how `na` propagates
  through a particular builtin. Where the behaviour had to be inferred, the
  reasoning and its evidence sit in a comment at the call site, marked as a
  hypothesis rather than a measurement.
- **Known gaps are recorded where they bite.** The long tail is things like
  history access on a user-defined-type field through a multi-hop function
  parameter, or `request.security` given an expression built from a loop
  variable. Each is commented at the point where it is refused, with a
  workaround when one exists.

## How this was built

Resin was developed by an autonomous agent loop over 800-odd iterations, each
one a single commit against a fixed set of state files. That is worth knowing
because it explains the shape of the thing: the verification apparatus above is
not decoration, it is what made the loop safe to leave running. The differential
oracle, the external arbiter for validity, and a standing rule that no claim
counts until it has been re-measured are the reasons a machine could write this
without quietly breaking it.

One consequence is visible immediately, and you should know about it before you
run anything:

- **Compiler error messages are still in Korean** — 378 of them. If your script
  fails to compile, the reason will come back in a language you may not read.
  This is the first thing being fixed, ahead of everything else on this list,
  because it is the only one that affects using the tool rather than reading it.
- **About a third of the comments in `src/` are in Korean**, roughly 14,000
  lines. Skipping them is not really an option — much of the reasoning behind an
  odd-looking branch lives there — so they are being translated rather than
  stripped.
- Code, identifiers, README and API docs are English throughout.

Translation happens upstream in the development repository and lands here by
re-snapshot, so it arrives in batches rather than a trickle.

## Notice on PineTS

[PineTS](https://github.com/alaa-eddine/PineTS) is an existing AGPL-3.0
Pine-to-JavaScript project. Resin shares no code with it. It was consulted as a
black-box behavioural reference for TradingView semantics that are otherwise
undocumented — the value of `dayofweek`, which plot styles exist, that sort of
thing — and every place that happened is cited in a source comment so the
provenance is auditable rather than asserted. Facts about a third-party product
are not copyrightable; its implementation was not read into this one.

## License

Apache-2.0. See [LICENSE](LICENSE).

Pine Script and TradingView are trademarks of TradingView, Inc. This project is
not affiliated with or endorsed by TradingView.
