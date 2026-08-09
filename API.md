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
| `Context` | `class` (12 constructor arguments, optional from the 4th) | `src/runtime/context` |
| `ParseError` | `class extends Error` | `src/transpiler/parser` |
| `PineRuntimeHaltError` | `class extends Error` | `src/runtime/log` |
| `VERSION` | `string` | `src/index` |
| `compile` | `(code: string) => (ctx: Context) => () => void` | `src/runtime/engine` |
| `parse` | `(source: string) => Script` (throws `ParseError`) | `src/transpiler/parser` |
| `rt` | runtime namespace passed to generated code | `src/runtime/rt` |
| `run` | `(code, varSlots, taSlotCount, data, …9 optional) => RunResult` | `src/runtime/engine` |
| `transpile` | `(source: string, options?: AnalyzeOptions) => TranspileResult` | `src/transpiler/pipeline` |

`parse()` is the lower entry point, useful only for telling a parse failure
apart from an analysis failure; `transpile()` catches both and returns a
`TranspileErr`. `PineRuntimeHaltError` is what a script throws when it calls
`runtime.error()` — catching it separately is how a caller distinguishes "the
script stopped itself on purpose" from "the engine broke".

## Type exports

| Name | Module | Role |
|---|---|---|
| `AnalyzeOptions` | `src/transpiler/analyzer` | options for `transpile()` (`chartTf?: string`) |
| `BarSnapshot` | `src/runtime/engine` | `Record<string, number>`, keyed `var:<name>` |
| `OHLCVData` | `src/runtime/context` | `Context` input: `open/high/low/close/volume: ArrayLike<number>`, optional `time` |
| `PlotResult` | `src/runtime/engine` | `{ title, values }` |
| `RunResult` | `src/runtime/engine` | `run()` return: `bars` / `finalVarState` / `plots` |
| `Series` | `src/runtime/series` | read type for `ctx.close.get(0)` and friends; never constructed by a caller |
| `StrategyState` | `src/runtime/strategy` | read type for `ctx.strategy.posSize` and friends |
| `TranspileErr` | `src/transpiler/pipeline` | `ok: false` plus `errors: string[]` |
| `TranspileOk` | `src/transpiler/pipeline` | `ok: true` plus `code`, the ten slot-metadata fields `Context` needs, and `isStrategy` |
| `TranspileResult` | `src/transpiler/pipeline` | discriminated union of the two above |

## Two ways to run

**One shot.** `run()` compiles, executes every bar, and hands back per-bar
variable snapshots and the finished plot series. Use it when you only want the
result.

**Streaming.** `compile()` gives you a per-bar function and `new Context(...)`
holds the state; you drive the loop yourself and can read `ctx.strategy` or any
series between bars. Use it when you need to observe execution as it happens —
equity curves, position sizes, anything that is not a plot.

Both are supported. The README has a worked example of the streaming form.

## Rough edges, recorded rather than fixed

- **`run()` takes 13 positional arguments and `Context` takes 12.** Both are
  hand-copied fields of `TranspileOk`, so every new slot kind means editing
  every call site — which is exactly how `refHistorySlotCount` and the two
  `condCall*` counts arrived. An overload taking `TranspileOk` whole would be
  the obvious improvement, and it is a breaking change, so it waits for a major
  version rather than sneaking in.
- **`parse()` returns the AST root, but AST node types are not public.**
  `src/transpiler/ast` is internal, so walking the returned tree structurally is
  unsupported. The only supported use is checking whether parsing succeeded.
