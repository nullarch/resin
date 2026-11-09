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

## Type exports

| Name | Module | Role |
|---|---|---|
| `AnalyzeOptions` | `src/transpiler/analyzer` | options for `transpile()` (`chartTf?: string`; `syminfo?: { mintick?, pricescale?, minmove?, mincontract?, pointvalue?, timezone?, type?, opening_hours?, session_starts?, session_ends?, prefix?, ticker? }` — the chart symbol's tick and lot grids, default 0.01 / 100 / 1 / 1, `mintick` must equal `minmove / pricescale`; its point value, default 1; its exchange calendar: timezone (IANA name or `"UTC±h"`, default `"UTC"`; read by `timestamp(year, month, day, …)` without a timezone argument, which is a time of the exchange timezone), market type (default `"stock"`) and weekly session schedule (`opening_hours: [{ day, start, end }]`, `session_starts: [{ day, time }]`, `session_ends: [{ day, time }]`, day 0 = Monday, `"HH:MM[:SS]"` exchange time; default open around the clock, 00:00 to 23:59:59), read by `syminfo.timezone`/`syminfo.type`, `timeframe.change`, `session.*` and `str.format_time`'s default timezone (`hour`, `dayofweek` and the other time builtins still read UTC); its identity: exchange `prefix` and `ticker`, default `""`, read by `syminfo.prefix`/`syminfo.ticker` and `syminfo.tickerid` (`"PREFIX:TICKER"`), which names the chart symbol's own `request.security` feeds; `strategy?: { initial_capital?, default_qty_type?, default_qty_value?, pyramiding?, commission_type?, commission_value?, slippage?, process_orders_on_close?, calc_on_order_fills?, use_bar_magnifier?, margin_long?, margin_short? }` — TradingView's strategy Properties tab: each given key replaces the script's `strategy()` argument or its default, validated like it (a bad value or an unknown key is a transpile error); constants by name (`default_qty_type: "percent_of_equity"`, `commission_type: "cash_per_order"`); ignored for a script that is not a strategy) |
| `BarSnapshot` | `src/runtime/engine` | `Record<string, number>`, keyed `var:<name>` |
| `LogEntry` | `src/runtime/log` | what `opts.onLog` receives per `log.info`/`log.warning`/`log.error` call: `{ level: "info" \| "warning" \| "error", message: string, bar: number, time: number \| undefined }` (see "Logs") |
| `OHLCVData` | `src/runtime/context` | `Context` input: `open/high/low/close/volume: ArrayLike<number>`, optional `time` |
| `PlotResult` | `src/runtime/engine` | `{ title, values }` |
| `RunResult` | `src/runtime/engine` | `run()` return: `bars` / `finalVarState` / `plots`, plus `viz` (plot styles and per-bar colors, markers, bgcolor/barcolor, hlines, fills, drawing creations) on the object form |
| `Series` | `src/runtime/series` | read type for `ctx.close.get(0)` and friends; never constructed by a caller |
| `StrategyState` | `src/runtime/strategy` | read type for `ctx.strategy.posSize` and friends |
| `TranspileErr` | `src/transpiler/pipeline` | `ok: false` plus `errors: string[]` |
| `TranspileOk` | `src/transpiler/pipeline` | `ok: true` plus `code`, the ten slot-metadata fields `Context` needs, `securitySymbols` and `calendar` (what `Context.from` pairs other symbols' feeds with), `isStrategy`, and `viz` (overlay, plots, bgcolors, barcolors, hlines, fills, shapes, chars, arrows, candles, plotbars) |
| `TranspileResult` | `src/transpiler/pipeline` | discriminated union of the two above |

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

## Logs

`log.info`, `log.warning` and `log.error` are no-ops unless the caller passes a
sink: `run(result, data, { onLog })` or `Context.from(result, data, { onLog })`.
`onLog(entry)` is called once per executed log statement, in execution order,
with a `LogEntry`:

| Field | Meaning |
|---|---|
| `level` | `"info"`, `"warning"` or `"error"` |
| `message` | the text TradingView's Pine Logs pane shows: `str.format(formatString, ...args)`, so a number of 1000 or more is grouped (`log.info("{0}", 18189.894)` is `"18,189.894"`); a na format string is `""` |
| `bar` | the zero-based bar index the statement ran on |
| `time` | that bar's open time in unix milliseconds; `undefined` when the data has no `time` channel |

A statement inside a function or loop reports each execution; under
`calc_on_order_fills` the re-executions of a bar report too. The sink is read
when `compile(code)(ctx)` instantiates the module, so a hand-built `Context`
must have `ctx.onLog` set before that call (`Context.from` does it). A
`request.security` expression evaluated in its requested context never logs.
Without `onLog` nothing changes: the calls are no-ops, and results never depend
on whether a sink is present. `resin run file.pine --logs` prints every entry to
stderr as `[level] bar N: message`, leaving the plot lines on stdout alone.
`runtime.warning` stays a no-op; `runtime.error` still halts the script
(`PineRuntimeHaltError`).

## Rough edges, recorded rather than fixed

- **The positional forms take 13 and 12 hand-copied `TranspileOk` fields.** That
  is how `refHistorySlotCount` and the two `condCall*` counts arrived: every new
  slot kind meant editing every call site. The object forms above exist so this
  stops compounding; the positional forms stay supported but frozen — new
  capabilities land on the object forms only.
- **`parse()` returns the AST root, but AST node types are not public.**
  `src/transpiler/ast` is internal, so walking the returned tree structurally is
  unsupported. The only supported use is checking whether parsing succeeded.
