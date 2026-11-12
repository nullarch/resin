# Robustness tier

What happens to resin when the input is hostile, malformed, extreme or merely odd: a fuzzer, a table
of hostile scripts, a data-shape matrix and a string-injection sweep. It exists to keep permanent
what a one-off audit found (process aborts from huge size constants, hangs from nested loops,
garbage accepted silently) and to catch the next class of it.

The tier's contract: every input ends in a **result**, a **refusal** (`ok: false` with a message, or
the one documented `TypeError` for unequal OHLCV lengths), a **typed host-limit error**
(`ResinLimitError`), or the script's own halt (`PineRuntimeHaltError`). Never a process death, a hang,
a thrown `transpile()`, JavaScript that does not parse, or a raw `TypeError`/`RangeError`/
`ReferenceError`/`SyntaxError` out of the runtime.

## Files

| File | What it covers | Where it runs |
|---|---|---|
| `fuzzlib.ts` | the mutator, the invariants (`checkSource`), failure signatures, the delta-debugging minimizer, the `KNOWN_DEFECTS` table | imported by both below |
| `../../scripts/fuzz.mjs` | the fuzzer proper: seeded mutants of `oracle/cases/*.pine` + `corpus/scripts/*.pine`, each in a child process under a hard timeout; minimizes every failure | CLI, not in `npm test` |
| `fuzz_smoke.test.ts` | the same invariants in-process over 150 mutants; the hostile-input table; one `it.fails` per known defect | `npm test` |
| `fuzz_cli.test.ts` | `fuzz.mjs` itself (a small run, its own hang/abort detection) and the two hangs that cannot run in-process | `npm test` |
| `data_edge.test.ts` | data shape matrix (30 shapes x 5 scripts), unequal lengths, 20,000-bar timings | `npm test` |
| `string_inject.test.ts` | text that is code to JavaScript/HTML/format strings/replacement patterns, in every place a script lets text in | `npm test` |

## Running it

```sh
npm test                                              # the default tier: 150 mutants, 49 hostile rows, 150 data cells
RESIN_PROP_RUNS=20 npx vitest run tests/robustness    # nightly: 3,000 mutants, 5x longer series
RESIN_ROBUSTNESS_TIMINGS=1 npx vitest run tests/robustness/data_edge.test.ts   # print the 20,000-bar timings

node scripts/fuzz.mjs --count 20000 --seed 1 --out /some/dir [--timeout 5] [--jobs 4]
node scripts/fuzz.mjs --seed 1 --only 12503           # one mutant: its source and its outcome
node scripts/fuzz.mjs --seed 1 --print 12503          # its source only
node scripts/fuzz.mjs --check some.pine               # any file through the same child and invariants
node scripts/fuzz.mjs --count 20000 --known-ok        # exit 0 if every failure is a KNOWN_DEFECTS entry
node scripts/fuzz.mjs --selftest [--full]             # prove the harness sees a hang, an abort, an OOM
```

`RESIN_PROP_RUNS` is an integer multiplier (default 1). It scales the in-process mutant count
(75 per seed per unit, two seeds) up to 60x, which is the range that was run through `fuzz.mjs`
before the in-process loop was allowed to trust it (mutants 0..4,499 of both seeds: no hang, no
abort). Past that, hunt with the script, not with vitest: an in-process hang takes the worker with it. The
"verified" claim holds for today's `oracle/cases` and `corpus/scripts` only: the index-to-script map is
the sorted directory listing, so when either directory gains or loses a file, re-run
`node scripts/fuzz.mjs --seed 6221057 --count 4500` and `--seed 6221058 --count 4500` and check for hangs
(`F_hang`, `F_crash`) before trusting the range again.
The long-series test scales its bars by the same multiplier, up to 5x.

## What it costs

Measured on a machine at a load average of 33-36 (so, an upper bound), `npx vitest run tests/robustness`
takes 5.6 s wall clock and 10.8 s of user + system CPU for the four files, most of it vitest and
Node starting four workers and loading `src/` (`transform` + `import` is about two thirds of the sum).
The tests themselves: `fuzz_smoke` 1.2-2.6 s (the 100,000-line script alone is 0.75 s idle),
`fuzz_cli` about 2 s wall (five short child processes, run concurrently), `data_edge` 0.6-1.1 s,
`string_inject` 0.3-0.4 s. Inside the full suite (23 s wall on the same box) the tier runs in parallel
with the corpus-scanning files and is within noise of the suite's wall time. `RESIN_PROP_RUNS=20`
adds about 2 s.

## The fuzzer

A mutant is a pure function of `(seed, index)`: `mutantAt(seeds, seed, index)` picks a seed script
(40 % from `oracle/cases`, 60 % from `corpus/scripts`) and applies one to three of: token delete /
duplicate / swap, line delete / duplicate / swap, truncation at an offset, bracket removal or
insertion, an indentation change, a number replaced by a huge, negative, fractional or non-finite
one, an identifier replaced by (or swapped with) another identifier from the same script or the
builtin pool, and a stray character (backtick, `${`, NUL, U+2028, `\r`, emoji, ...). About 30 % of
mutants still compile, which is where the interesting failures come from.

Invariants, per mutant:

1. `transpile()` returns a value and never throws. An `ok: false, internal: true` result counts as a
   failure unless the message is a stack overflow (a script too deep, documented in `API.md`).
2. `ok: true` implies `new Function("$", "rt", code)` parses.
3. Running on 120 seeded bars with `{ maxStepsPerBar: 200_000, maxCollectionLength: 100_000 }` throws
   at most `PineRuntimeHaltError` or `ResinLimitError`, and a completed run returns one snapshot and
   one value per bar in every plot. A plain `Error` with one of the engine's deliberate "unsupported
   ..." messages (`strategy.entry: unsupported direction`, `invalid timeframe`, ...) is reported on its
   own row, `refusal`, not as a failure (`--strict-errors` makes it one): those are thrown as plain
   `Error`s from `strategy.ts`, `calendar.ts`, `security.ts` and are not in `API.md`.
4. The child neither dies on a signal nor misses the timeout. Hangs are `SIGKILL`ed, the job restarts
   its child after the culprit; `--selftest` forces a hang, an `abort()`, an exit and (with `--full`)
   an out-of-memory in the child and checks they are reported and survived.

Each distinct failure signature (`phase|class|normalized message|first src/ frame`) is minimized:
delta-debugging by lines, then by tokens, then lines again, keeping the same signature, within an
evaluation and wall-clock budget (hangs get three times the wall clock and the same timeout, so a
repro cannot drift to "merely slow"). The minimized source, the original and a JSON record go to
`--out`.

## Known defects

`KNOWN_DEFECTS` in `fuzzlib.ts` is the table of failures the fuzzer found in the engine as it stands.
The smoke loop tolerates a failure only if it matches one entry's anchored signature pattern; any
other signature fails the test with the seed, index and a `--only` command. The tolerance is by
**family**, not by single signature: KD1 matches every `TypeError` raised in `array.ts`, `map.ts`,
`matrix.ts`, `color.ts`, `str.ts`, `time.ts` or `security.ts`, and KD2 every `TypeError` raised in
generated code. A *new* `TypeError` from one of those places is therefore invisible to `npm test`
(`node scripts/fuzz.mjs` prints every signature, known or not, so it is not invisible there). Fixing
KD1 or KD2 and deleting the entries is what makes the smoke loop strict again. Each entry has an
`it.fails` per minimal repro (in `fuzz_smoke.test.ts`; the two hangs in `fuzz_cli.test.ts`; the data
and string ones in their own files): it passes while the defect exists and turns red the day the
defect is fixed, which is the cue to delete the entry, its repros and its tolerance.

Ordered by consequence. "Found by" names the tool; the repros are the clean ones in `KNOWN_DEFECTS` /
the test files, not the minimizer's output.

| Id | What breaks | Minimal repro | Found by |
|---|---|---|---|
| KD10 | **fixed.** `str.replace` / `str.replace_all` handed the replacement to `String.prototype.replace`, which reads `$&`, `$$`, `` $` `` and `$'`, so `str.replace_all("a-b", "-", "$&")` gave `"a-b"` while the occurrence form, which slices, gave `"a$&b"`. Both forms now insert the replacement literally (`string_inject.test.ts` pins it). | | `string_inject.test.ts` sweep |
| KD9 | a valid-looking data hole stops a strategy run: percent commission plus a non-finite fill value (one NaN `open` on the bar an order fills; or 1e-300 prices with `percent_of_equity` sizing) throws `SyntaxError: Cannot convert NaN to a BigInt` / `RangeError: The number Infinity cannot be converted to a BigInt` from `bookCommission` | `strategy("s", commission_type=strategy.commission.percent, commission_value=0.1)`, `if bar_index == 3` / `    strategy.entry("L", strategy.long)`, one NaN `open` on bar 4 | `data_edge.test.ts` matrix |
| KD8 | one bar `time` that is NaN, Infinity or beyond +-8.64e15 ms makes every script that reads the exchange calendar throw a raw `RangeError` (`timeframe.change`, `ta.vwap`, `session.*`, `str.format_time`); `API.md` says unequal lengths are the one refused data problem and promises a warning for bad time. (`dayofweek`, `hour`, `time` itself survive.) | `plot(timeframe.change("D") ? 1 : 0)` with one NaN time | `data_edge.test.ts`; also the old audit's `time_nan` |
| KD6 | **fixed.** `ta.percentile_*` ignored `maxCollectionLength` and topped its window up one `unshift` + `splice` at a time, so a length of 1e10 never returned and 1e6 took minutes. The length is now checked against the limit, and the top-up is linear in the window (its output is bit-identical to the old machine on 768 generated runs, series lengths and na gaps included). | | `fuzz.mjs` (14 of 118k mutants) |
| KD11 | **hang.** `str.match` runs the script's pattern as an unbounded JavaScript regular expression; nested quantifiers on a 45-character string never return, and no host limit covers it (inherent to using `RegExp`; `API.md` already says a host that needs a hard bound runs the engine in a worker) | `str.match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")` | by reading `src/runtime/str.ts` (the only `new RegExp`), confirmed with `fuzz.mjs --check` |
| KD7 | a string that doubles every bar is not bounded by `maxCollectionLength`: raw `RangeError: Invalid string length` | `var s = "xxxxxxxx"` / `s := s + s` | the old audit's repro list, run through `fuzz.mjs --check` |
| KD4 | `str.format_time` with a timestamp outside JavaScript's Date range: raw `RangeError: Invalid time value` | `str.format_time(9007199254740993, "yyyy", "UTC")` | `fuzz.mjs` |
| KD1 | a builtin that takes an array, map, matrix, timeframe, session or color string is handed a number, series or bool: raw `TypeError` from `array.ts`/`map.ts`/`matrix.ts`/`time.ts`/`security.ts`/... (my reading is that Pine refuses these at compile time and resin has no type check) | `array.push(close, 5)` | `fuzz.mjs` (186 of 118k mutants, 38 distinct signatures) |
| KD2 | a name used in its own initializer is not refused (Pine: undeclared identifier, in my reading): `ReferenceError` (temporal dead zone) or `undefined` flowing into a builtin | `for i = 0 to 4` / `    wt = wt`; `c = color.new(c, 80)` | `fuzz.mjs` |
| KD3 | assigning a for-in iteration variable (emitted as a `const`) or writing a field of an na object: raw `TypeError` from the generated code | `for [k, v] in m` / `    v := 2.0` (non-empty map); `var Pt obj = na` / `obj.v := close` | `fuzz.mjs` |
| KD5 | the generated JavaScript does not parse. Caught (`ok: false, internal: true`), so no crash, but the user is told "internal error" for a script that is just wrong: a name declared twice in one value-position block, a duplicated for-in destructure name, a keyword as a function parameter, a call with more arguments than JavaScript allows | `x = for i = 1 to 3` / `    z = 1` / `    z = 2` / `    z`; `for [k, k] in m`; `f(x, for) =>`; `math.max(` + 70,000 args | `fuzz.mjs`; the 70,000-argument one from the hostile-input sizing |

KD11 cannot run in-process: `fuzz_cli.test.ts` checks it through `fuzz.mjs --check` with a
0.6 s timeout, and the smoke loop skips any mutant whose source mentions
`str.match`.

## Observations that are not defects (recorded, not asserted)

- Nesting limits are low and come back as `ok: false, internal: true` ("Maximum call stack size
  exceeded"): 300 nested calls (`math.abs(math.abs(...))`), 5,000 nested parentheses, a 5,000-term
  sum, 1,000 nested `if`s. 200 nested calls and 500 nested `if`s are fine.
- The emitted module contains the script's strings verbatim as JavaScript literals, including raw
  `</script>`, `<!--` and U+2028/U+2029. That is valid JavaScript and safe under `new Function`; a host
  that pastes `code` inside an HTML `<script>` element would need to escape it.
- `transpile(src, { chartTf: "garbage" })` returns `ok: true`; `run()` then throws a plain
  `Error("invalid timeframe: ...")`. `syminfo.timezone` and the `strategy` options are validated at
  transpile time.
- A raw CR inside a string literal is read as a line end, so the title `"a<CR>b"` comes back as `"a\nb"`.
- `RunResult.warnings` has no entry for NaN or Infinity prices, negative volume or zero prices; the
  matrix only requires that those runs finish with one value per bar.
- Assigning the counter of a `for i = ...` loop is accepted (`i := 5` runs); the iteration variable of a
  `for [k, v] in map` is a `const` and throws (KD3).

## Real run: the failure-signature table

Seeds 1 and 2, 60,000 mutants requested each (59183 and 59148 unique after dropping duplicate sources), `--jobs 6 --timeout 5`, run on a heavily loaded machine (load average about 35); each run took about 22 s to generate and check, and about 55 s with minimization.
Mutants that reached `ok: true`: 31.0 % and 31.0 %.

| outcome | seed 1 | seed 2 |
|---|---:|---:|
| rejected | 40849 | 40825 |
| rejected_deep | 0 | 0 |
| ran | 17436 | 17381 |
| halt | 6 | 5 |
| limit | 764 | 799 |
| refusal | 9 | 18 |
| F_transpile_throw | 0 | 0 |
| F_internal | 2 | 3 |
| F_invalid_js | 0 | 0 |
| F_run_throw | 110 | 110 |
| F_bad_result | 0 | 0 |
| F_hang | 7 | 7 |
| F_crash | 0 | 0 |
| unique mutants | 59183 | 59148 |

Failures by known defect (mutants / distinct signatures):

| defect | seed 1 | seed 2 |
|---|---:|---:|
| KD1-wrong-typed-handle | 93 / 24 | 93 / 27 |
| KD2-self-referencing-initializer | 10 / 2 | 15 / 3 |
| KD3-generated-code-typeerror | 2 / 1 | 0 / 0 |
| KD4-format-time-out-of-range | 5 / 1 | 2 / 1 |
| KD5-internal-generated-code-does-not-parse | 2 / 1 | 3 / 1 |
| failures matching no known defect | 0 | 0 |

All 45 distinct signatures (`phase|class|normalized message|first src frame`), mutants in seed 1 + seed 2:

| signature | n | defect |
|---|---:|---|
| `run\|TypeError\|<id> is not a function\|Module.push@runtime/array.ts` | 29 + 33 | KD1 |
| `run\|TypeError\|<id> is not a function\|Object.put@runtime/map.ts` | 15 + 18 | KD1 |
| `run\|ReferenceError\|Cannot access <id> before initialization\|?@runtime/engine.ts` | 8 + 11 | KD2 |
| `hang\|run` | 7 + 7 | was KD6 (fixed); a re-run of `fuzz.mjs` shows what is left (KD11) |
| `run\|TypeError\|<id> is not a function\|parseTfMinutes@runtime/security.ts` | 7 + 3 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.shift@runtime/array.ts` | 6 + 4 | KD1 |
| `run\|TypeError\|<id> is not a function\|Object.get@runtime/map.ts` | 4 + 6 | KD1 |
| `run\|RangeError\|Invalid time value\|zonedWallClockMs@runtime/datetime.ts` | 5 + 2 | KD4 |
| `run\|TypeError\|<id> is not a function\|validNums@runtime/array.ts` | 4 + 2 | KD1 |
| `run\|TypeError\|<id> is not iterable\|Module.avg@runtime/array.ts` | 3 + 2 | KD1 |
| `run\|TypeError\|<id> is not a function\|parseSession@runtime/time.ts` | 2 + 3 | KD1 |
| `internal\|internal error: generated code does not parse (Identifier <q> has already been declared)` | 2 + 3 | KD5 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|?@runtime/engine.ts` | 2 + 2 | KD2 |
| `run\|TypeError\|<id> is not iterable\|Module.sum@runtime/array.ts` | 3 + 0 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.sort@runtime/array.ts` | 2 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Module.get@runtime/array.ts` | 2 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|validNums@runtime/array.ts` | 2 + 1 | KD1 |
| `run\|TypeError\|<id> is not iterable\|Module.max@runtime/array.ts` | 2 + 1 | KD1 |
| `run\|TypeError\|<id> is not iterable\|Module.min@runtime/array.ts` | 1 + 2 | KD1 |
| `run\|TypeError\|Assignment to constant variable.\|?@runtime/engine.ts` | 2 + 0 | KD3 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'push')\|Module.push@runtime/array.ts` | 2 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|?@runtime/engine.ts` | 0 + 2 | KD2 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Object.transpose@runtime/matrix.ts` | 0 + 2 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Module.size@runtime/array.ts` | 0 + 2 | KD1 |
| `run\|TypeError\|Cannot assign to read only property <q> of string <q>\|Module.set@runtime/array.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Module.remove@runtime/array.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|parseFloatLoose@runtime/str.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot create property 'length' on number <q>\|Module.clear@runtime/array.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|<id> is not iterable\|flatValid@runtime/matrix.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|columns@runtime/matrix.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|<id> is not a function\|parseHex@runtime/color.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|Object.get@runtime/map.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Object.mult@runtime/matrix.ts` | 1 + 0 | KD1 |
| `run\|TypeError\|<id> is not iterable\|Module.some@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.pop@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.concat@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Object.contains@runtime/map.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'length')\|Module.covariance@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|Object.put@runtime/map.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.slice@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Object.rank@runtime/matrix.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Object.values@runtime/map.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading <q>)\|Object.contains@runtime/map.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|<id> is not a function\|Module.includes@runtime/array.ts` | 0 + 1 | KD1 |
| `run\|TypeError\|Cannot read properties of undefined (reading 'slice')\|Module.copy@runtime/array.ts` | 0 + 1 | KD1 |

Plain-`Error` refusals seen (not failures): `strategy.entry: unsupported direction '<a non-direction value>'` (a mutated `strategy.long`) and `invalid timeframe: '<some string>'` (a string where a timeframe goes), 27 mutants in total.

## Adding to the tier

- A new defect class the fuzzer finds: add a `KNOWN_DEFECTS` entry (anchored `match`, one or more
  `repros`) and the `it.fails` appears automatically in `fuzz_smoke.test.ts`.
- A fixed defect: its `it.fails` goes red with "Expect test to fail". Delete the entry (or the
  `knownFail` cell in `data_edge.test.ts`, or the `it.fails` in `string_inject.test.ts`) and run
  `node scripts/fuzz.mjs --count 20000` to confirm nothing new hides behind it.
- A new mutation kind: add it to `MUTATION_KINDS`, `applyMutation` and `KIND_WEIGHTS`. Existing seeds
  then produce different mutants; re-run `fuzz.mjs` over mutants 0..4,499 of seeds `0x5eed01` and
  `0x5eed02` (6221057, 6221058) before raising the in-process range.
