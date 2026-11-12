# API

The supported surface is exactly what `src/index.ts` re-exports, and nothing
else. Everything else under `src/` — the runtime helpers (`ta`, `numeric`,
`str`, `drawing`, `color`, `array`, `matrix`, …), the transpiler stages
(`lexer`, `analyzer`, `codegen`, `passes`), and `Context`'s slot channels — is
internal and changes without notice. Unit tests import those symbols directly;
that is white-box testing, not a contract.

`tests/unit/public_api_surface.test.ts` keeps this file, `src/index.ts`, and the
shipped consumer in `bin/` consistent with each other. Change one without the
others and it goes red.

## Value exports

| Name | Signature | Module |
|---|---|---|
| `Context` | `class` (12 constructor arguments, optional from the 4th; or `Context.from(transpileOk, data, opts?)`) | `src/runtime/context` |
| `ParseError` | `class extends Error` | `src/transpiler/parser` |
| `PineRuntimeHaltError` | `class extends Error` | `src/runtime/log` |
| `ResinLimitError` | `class extends Error` (`.limit`: `"steps" \| "size" \| "deadline"`) | `src/runtime/limits` |
| `VERSION` | `string` | `src/index` |
| `compile` | `(code: string) => (ctx: Context) => () => void` | `src/runtime/engine` |
| `parse` | `(source: string) => Script` (throws `ParseError`) | `src/transpiler/parser` |
| `rt` | runtime namespace passed to generated code | `src/runtime/rt` |
| `run` | `(transpileOk, data, opts?) => RunResult`, or positional `(code, varSlots, taSlotCount, data, …9 optional)` | `src/runtime/engine` |
| `transpile` | `(source: string, options?: AnalyzeOptions) => TranspileResult` | `src/transpiler/pipeline` |

`parse()` is the lower entry point, useful only for telling a parse failure
apart from an analysis failure; `transpile()` catches both and returns a
`TranspileErr`. `PineRuntimeHaltError` is what a script throws when it calls
`runtime.error()` — catching it separately is how a caller distinguishes "the
script stopped itself on purpose" from "the engine broke".

`ResinLimitError` is what a run throws when it hits a host limit (below). It is
deliberately not a `PineRuntimeHaltError`: that class means the script chose to
stop, and a script that ran out of budget did not.

## Type exports

| Name | Module | Role |
|---|---|---|
| `AnalyzeOptions` | `src/transpiler/analyzer` | options for `transpile()` (`chartTf?: string`; `libraries?` — see "Libraries"; `syminfo?: { mintick?, pricescale?, minmove?, mincontract?, pointvalue?, timezone?, type?, opening_hours?, session_starts?, session_ends?, prefix?, ticker? }` — the chart symbol's tick and lot grids, default 0.01 / 100 / 1 / 1, `mintick` must equal `minmove / pricescale`; its point value, default 1; its exchange calendar: timezone (IANA name or `"UTC±h"`, default `"UTC"`), market type (default `"stock"`) and weekly session schedule (`opening_hours: [{ day, start, end }]`, `session_starts: [{ day, time }]`, `session_ends: [{ day, time }]`, day 0 = Monday, `"HH:MM[:SS]"` exchange time; default open around the clock, 00:00 to 23:59:59), read by `syminfo.timezone`/`syminfo.type`, `timeframe.change`, `session.*` and `str.format_time`'s default timezone (`hour`, `dayofweek` and the other time builtins still read UTC); its identity: exchange `prefix` and `ticker`, default `""`, read by `syminfo.prefix`/`syminfo.ticker` and `syminfo.tickerid` (`"PREFIX:TICKER"`), which names the chart symbol's own `request.security` feeds; `strategy?: { initial_capital?, default_qty_type?, default_qty_value?, pyramiding?, commission_type?, commission_value?, slippage?, process_orders_on_close?, calc_on_order_fills?, use_bar_magnifier?, margin_long?, margin_short? }` — TradingView's strategy Properties tab: each given key replaces the script's `strategy()` argument or its default, validated like it (a bad value or an unknown key is a transpile error); constants by name (`default_qty_type: "percent_of_equity"`, `commission_type: "cash_per_order"`); ignored for a script that is not a strategy; `strict?: boolean` — refuse instead of warn, see "Warnings and strict mode"; `maxSourceBytes?: number` — source longer than this many characters is refused unparsed, default 1,000,000) |
| `BarSnapshot` | `src/runtime/engine` | `Record<string, number>`, keyed `var:<name>` |
| `OHLCVData` | `src/runtime/context` | `Context` input: `open/high/low/close/volume: ArrayLike<number>`, optional `time` |
| `PlotResult` | `src/runtime/engine` | `{ title, values }` |
| `RunLimits` | `src/runtime/limits` | `ContextOptions.limits` / `run()` option: `{ maxStepsPerBar?, maxCollectionLength?, deadlineMs? }` — see "Limits" |
| `RunResult` | `src/runtime/engine` | `run()` return: `bars` / `finalVarState` / `plots` / `warnings`, plus `viz` (plot styles and per-bar colors, markers, bgcolor/barcolor, hlines, fills, drawing creations) on the object form |
| `Series` | `src/runtime/series` | read type for `ctx.close.get(0)` and friends; never constructed by a caller |
| `StrategyState` | `src/runtime/strategy` | read type for `ctx.strategy.posSize` and friends |
| `TranspileErr` | `src/transpiler/pipeline` | `ok: false` plus `errors: string[]`, and `internal: true` when the failure is a bug in resin (or a script too deep for the stack) rather than a problem with the script — `transpile()` never throws |
| `TranspileOk` | `src/transpiler/pipeline` | `ok: true` plus `code`, the ten slot-metadata fields `Context` needs, `securitySymbols` and `calendar` (what `Context.from` pairs other symbols' feeds with), `isStrategy`, `warnings`, and `viz` (overlay, plots, bgcolors, barcolors, hlines, fills, shapes, chars, arrows, candles, plotbars) |
| `TranspileResult` | `src/transpiler/pipeline` | discriminated union of the two above |
| `TranspileWarning` | `src/transpiler/surface` | `{ kind, name, line, message }` — one entry of `TranspileOk.warnings` |

## Two ways to run

**One shot.** `run(transpileOk, data, opts?)` compiles, executes every bar, and
hands back per-bar variable snapshots and the finished plot series. Use it when
you only want the result. `opts.inputs` overrides `input.*` defaults.
`opts.magnifier` (an `OHLCVData` with `time`, as is the chart data's) is the bar
magnifier's lower-timeframe feed: a chart bar owns the sub-bars opening from its
time up to the next bar's, and a `strategy(use_bar_magnifier=true)` fills its
orders on them; other scripts ignore it. `opts.security` maps symbol strings (or
`"SYMBOL:TF"`, read first, for one symbol at several timeframes) to other symbols' feeds (each an `OHLCVData` with `time`, plus the bars' optional
`timeframe`, default the requested one, and the symbol's optional `syminfo`
calendar in the `transpile()` option's shape, default open around the clock in
UTC): a `request.security` call whose symbol folds to one of those strings at
compile time (`TranspileOk.securitySymbols`) runs its expression on that feed,
grouped to the requested timeframe on the symbol's calendar, and each chart bar
reads the last feed bar whose scheduled close is at or before its own; other
calls read the chart's bars. A `request.security` call another one's expression
depends on (a nested request) runs in that call's context, each of its bars
reading the nested request the same way. All three options work the same on `Context.from`.

**Streaming.** `compile()` gives you a per-bar function and
`Context.from(transpileOk, data, opts?)` holds the state; you drive the loop
yourself and can read `ctx.strategy` or any series between bars. Use it when you
need to observe execution as it happens — equity curves, position sizes,
anything that is not a plot.

Both are supported, and both also accept the original positional spellings —
`run(code, varSlots, taSlotCount, data, …)` with 13 arguments and
`new Context(...)` with 12 — which remain exactly as they were. The README has
a worked example of the streaming form.

## Libraries

`import user/name/version as alias` links that library into the script when you hand over its source.
resin reads no network and no disk for it.

```js
transpile(source, {
  libraries: { 'jdehorty/MLExtensions/2': mlSource, 'jdehorty/KernelFunctions/2': kernelSource },
  // or a function: (path) => string | undefined
});
```

`resin run` and `resin check` take `--libs <dir>`, which reads `<dir>/user/name/version.pine`.

- A library's exported functions, methods, types and enums can be used as Pine allows, and a library may
  import another. Its other global code does not come over: its `plot()` calls are not the script's plots.
- Each library stays in its own namespace, except methods: the same method name on the same receiver type
  in two units is refused, because resin keeps one method namespace.
- A script and a library on different sides of v6 are refused. resin compiles one program under one
  version's rules.
- With no source, an import nothing reads still compiles. A name read through it is an error that names the
  library, unless the alias is also a builtin namespace (`import TradingView/ta/7`): then `ta.*` keeps reading
  resin's builtins and `TranspileOk.warnings` carries an `import` warning, which `strict` refuses.
- Errors and warnings from library code say `library user/name/version L12`.

## Warnings and strict mode

Resin refuses a name it does not know (`unsupported call`). A few names it
*does* accept are not faithful: they compile and run and return a placeholder,
hand their input back unchanged, approximate TradingView, or are reasoned
rather than measured. `TranspileOk.warnings` lists every use of one, in source
order, as `{ kind, name, line, message }`:

| `kind` | Meaning | Example |
|---|---|---|
| `stub` | returns a placeholder (a constant, na) instead of data resin does not have | `request.dividends` returns 0 on every bar |
| `passthrough` | returns its input unchanged | `ticker.heikinashi` returns its symbol, so `request.security` on it reads ordinary candles |
| `approximated` | computes a value known to differ from TradingView in a stated way | `request.security` without a feed in `opts.security` |
| `hypothesis` | behaviour reasoned from the manual or the name, never measured | `strategy.risk.*` |
| `noop` | ignored; the script's values do not depend on it | `alert`, `alertcondition`, `polyline.*`, `linefill.*` |
| `option` | a `transpile()` option key resin does not read, ignored | a typo such as `chartTF`, or `syminfo.currency` |
| `version` | a `//@version` below 5 or above 6 | `//@version=4` |

`transpile(source, { strict: true })` turns `stub`, `passthrough`, `import`, `option` and
`version` warnings into errors, so a service that must not score a script on
made-up numbers can refuse it up front. The registry is
`src/transpiler/surface.ts`; a name that is wrong in a way nobody has noticed is
not in it, so an empty `warnings` is not a certificate.

## Run warnings

`RunResult.warnings` (and `ctx.diagnostics.messages` for a caller driving the
loop) lists what the data and options did that did not stop the run but changes
what it means, each message once:

- the bars are not the timeframe the script was compiled for (hourly bars on the
  default `chartTf: "D"`), `time` looks like seconds rather than milliseconds,
  is not strictly increasing, or a bar has `high < low`;
- a key of `opts.inputs` matched no `input.*` title (they are keyed by title, so
  a misspelling silently leaves the default), or has the wrong type;
- `request.security` names a symbol that `opts.security` has no feed for, so the
  chart's own bars are read instead;
- an `opts` key resin does not read.

The OHLCV arrays differing in length is the one data problem refused outright
(a `TypeError`): the run would read past the shorter series.

## Limits

A script is untrusted input once a service runs scripts it did not write.
`run(transpileOk, data, { limits })` and `Context.from(…, { limits })` take:

| Key | Default | Stops |
|---|---|---|
| `maxStepsPerBar` | 10,000,000 | loop iterations (`for`, `while`, `for … in`) one bar may take in total, across every loop and nesting level |
| `maxCollectionLength` | 10,000,000 | the size of one allocation: `array.new_*`, `matrix.new` (rows × columns), `str.repeat`, a `ta.*` window |
| `deadlineMs` | none | the run, at the next bar boundary, once `Date.now()` passes it |

Each throws a `ResinLimitError`. In 0.3.0 and earlier a loop longer than 10,000
iterations was cut short with no error and the result looked normal, nested
loops multiplied that cap into a hang, and an oversized allocation aborted the
process. The limits bound one bar's loop steps and one allocation, not their
sum: a host that needs a hard bound on time or memory runs the engine in a
worker it can terminate.

## Rough edges, recorded rather than fixed

- **The positional forms take 13 and 12 hand-copied `TranspileOk` fields.** That
  is how `refHistorySlotCount` and the two `condCall*` counts arrived: every new
  slot kind meant editing every call site. The object forms above exist so this
  stops compounding; the positional forms stay supported but frozen — new
  capabilities land on the object forms only.
- **`parse()` returns the AST root, but AST node types are not public.**
  `src/transpiler/ast` is internal, so walking the returned tree structurally is
  unsupported. The only supported use is checking whether parsing succeeded.
