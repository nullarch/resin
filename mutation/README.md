# Mutation ratchet

Does the test suite notice a one-line change in the code that decides numbers?

`mutants.json` lists 130 single-site behaviour changes ("mutants") to `src/`: a `<` made `<=`, a
term dropped from `ta.tr`, a slippage sign flipped. `scripts/mutate.mjs` applies each one to its own copy
of the working tree and runs the whole vitest suite against it. A suite that fails is said to have
**killed** the mutant; a suite that stays green has a blind spot exactly there, and the mutant
**survived**. `survivors.json` is the ledger of the known blind spots, and the run fails when it grows.

Why it exists: an audit found that dropping the `|low - prevClose|` term of `ta.tr` flipped no golden,
and that a regression of a TradingView-confirmed rule made the `corpus_diff` count go up instead of
failing. Goldens and counts answer "did the output move"; a mutation run answers "would the suite notice
if this line were wrong".

## Usage

```
node scripts/mutate.mjs [--only id,id] [--list] [--jobs N] [--workdir DIR] [--timeout SECONDS]
                        [--update-survivors] [--bail] [--keep] [--workers N] [--report FILE]
                        [--mutants FILE] [--survivors FILE] [--no-ratchet] [--exclude GLOB]...
```

| Option | Meaning |
|---|---|
| `--list` | Verify every anchor against the source (read-only) and print the mutants. Fast; run it after editing `mutants.json` or `src/`. |
| `--only a,b` | Run just these ids. The ratchet is checked for the ids that ran. |
| `--jobs N` | Mutants in parallel, default 4. Each job is a separate vitest with `floor(cpus / jobs)` workers (min 2; `--workers` overrides). |
| `--workdir DIR` | Where the temporary copies go; default the OS temp directory. Must be outside the checkout. |
| `--timeout S` | Per-run limit, default 300. A mutant that hangs the suite is KILLED by timeout and reported separately. |
| `--bail` | Pass `--bail 1` to vitest: each run stops at its first failing test, so kills finish sooner, but the list of failing test files is then partial. Off by default so the killer statistics are complete. |
| `--exclude GLOB` | Leave test files out of every run, baseline included (repeatable). For tests that are red on the clean tree. |
| `--report FILE` | Write every mutant's verdict, failing files and seconds as JSON. |
| `--keep` | Keep the run directory (the copies and vitest's JSON) for inspection. |
| `--update-survivors` | Rewrite `survivors.json` from this (full) run. Prints a warning: the change must be justified in the commit message. |
| `--mutants FILE`, `--survivors FILE` | Use another mutant list or survivor ledger (the defaults are the files next to this one). `--update-survivors` needs the default list. |
| `--no-ratchet` | Report only; skip the `survivors.json` comparison. |

One line per mutant: id, `KILLED`/`SURVIVED`/`INVALID`, the first failing test file (alphabetical, with
`(+N)` for the others), seconds. Then the kill rate, the number killed by timeout, the number killed only
by corpus tests, and which test files do the killing.

Exit codes: `0` ratchet holds; `1` ratchet violated or an INVALID mutant; `2` bad arguments or a mutant
whose anchor rotted; `3` the clean baseline failed.

## What a run does

1. Snapshots the working tree (everything except `node_modules`, `.git`, `coverage`) into the run
   directory, then checks every anchor **on that clean copy**: it must occur exactly once, outside a
   comment, and the mutated file must still parse (Node's `stripTypeScriptTypes`). A mutant that has rotted
   aborts the run before a test runs.
2. Baseline: `jobs` clean copies run the whole suite *concurrently*, with the same worker cap the mutants
   get. All must pass. Running them together matters: the corpus scans run several times slower under
   parallel load (see the `testTimeout` note in `vitest.config.ts`), and a suite that only fails under load
   would otherwise show up as kills.
3. Each mutant gets a fresh copy (cloned from the snapshot), the one edit is applied by slicing at the
   anchor (never `String.replace`, which would read `$&` and `$'` in generated-code snippets), and vitest
   runs with `--reporter=json`. The copy is deleted afterwards (guarded: only paths inside the run
   directory are ever removed).
4. Verdict from the exit code and the JSON: **KILLED** (some test failed), **SURVIVED** (all passed),
   **KILLED by timeout**, or **INVALID** (see below).

Things this deliberately does:

- `node_modules` is rebuilt in each copy as one symlink per entry. A single directory symlink would let
  vite write its cache into the real `node_modules`. `node_modules/.vite` is not linked.
- It runs `node node_modules/vitest/vitest.mjs run`, which is what `npx vitest run` resolves to, without
  the `npx` start-up and without a lookup that could leave the copy.
- `TMPDIR` is pointed inside the run directory (some tests write temp files), and `UPDATE_CORPUS_LEDGER`
  is removed from the environment: with it set, `corpus_diff` rewrites its ledger to match the mutated
  output and every mutant it could have caught would survive.
- vitest runs in its own process group, which is killed on timeout and after exit, so a hung mutant leaves
  no orphan workers behind to skew later runs.
- The checkout is never written to (the only file the script ever writes there is `survivors.json`, on
  `--update-survivors`). It prints a note if a mutated source file changed in the checkout during the run;
  the results then describe the snapshot taken at the start.

**INVALID** means the mutant, not the suite, is at fault, and the run fails: more than half of the test
files could not load, a load failure mentions a syntax error, or vitest died without writing a report (it
is retried once first). A mutant must change behaviour, not stop the suite from starting.

## The ratchet

`survivors.json` maps mutant id to a one-line reason the suite does not see it. A run fails (exit 1) when

- **(a)** a mutant survives that is not listed: a new blind spot, or a test that was weakened;
- **(b)** a listed survivor is now killed: *stale, remove it* — somebody added the missing test, and the
  list must shrink to show it;
- **(c)** the clean baseline fails (exit 3).

Also an error: an id in `survivors.json` that is not in `mutants.json`. With `--only`, (a) and (b) are
checked for the ids that ran, and `--update-survivors` refuses to run (it would erase the survivors of the
mutants it skipped). `--update-survivors` keeps the reason of an id that still survives and writes
`TODO: explain why the suite does not see this` for a new one: filling that in is the point.

The right response to (a) is a test that kills the mutant. Listing a survivor is for a mutant that is
truly equivalent (then delete the mutant and add it below) or a gap the maintainer chooses to carry.

## Adding a mutant

Append to `mutants.json`:

```json
{ "id": "ta-foo-bar", "file": "src/runtime/ta.ts",
  "find": "const alpha = 2 / (length + 1);", "replace": "const alpha = 2 / length;",
  "why": "ta.ema smoothing factor 2 / length instead of 2 / (length + 1)" }
```

- `find` must occur **exactly once** in `file`: anchor on code text, never on a line number. Use several
  lines (with `\n`) if the line repeats; `ta.ts` has fixed-length and `*VarLen` twins of most machines.
- The part that changes must be code, not a comment (the source quotes code in comments).
- One behavioural change per mutant, realistic (operator flip, off-by-one, dropped term, swapped
  argument), not an equivalent one, and valid syntax. The mutated text may not break loading the module.
- `node scripts/mutate.mjs --list` verifies all of that. Then `--only ta-foo-bar` runs it. If it
  survives, either write the test that kills it, or put it in `survivors.json` with the reason.
- When `src/` changes so that an anchor no longer matches, the run aborts and names the mutant; re-anchor
  it on the new code. The point is that mutants cannot rot silently.

Controls, which **must** die (if one survives the harness is broken, not the suite): `ta-sma-divisor`,
`security-lookahead-off`, `strategy-slippage-direction`, `numeric-mod-floor`, `codegen-le-emits-lt`.

## Cost

Measured on an 18-core machine, Node 24, vitest 4:

| What | Time |
|---|---|
| The whole suite once, alone, all cores (`vitest run`) | about 11-13 s (328 files at the start of the work, 335 with the new test tiers) |
| 4 clean copies at once, 4 workers each (the baseline) | 36-38 s each, 48 s wall |
| One mutant, 4 jobs running | median 40 s |
| Snapshot of the tree, plus a clone per mutant | 1.4-2.8 s once; negligible per mutant |
| **All 130 mutants, `--jobs 4`** | **25.8 min** (baseline 48 s + mutants 1497 s, run on the current tree); the first run, on the tree as it was an hour earlier, took 28.0 min |
| 2 mutants, `--jobs 2 --workers 8` | about 50 s with the baseline |

The suite is CPU-bound; `--jobs 4` with 4 workers each kept about half of the 18 cores busy (the corpus
scans are uneven). At most `jobs` copies of the tree (about 65 MB each, cloned where the filesystem can)
exist at a time. `--bail` was not measured.

A full run is a nightly or pre-release gate, not a per-commit one. For a quick look while writing tests,
`--only` with `--bail` runs a few mutants in about a minute.

## Equivalent mutants considered (not in `mutants.json`)

Single-line changes that cannot change an output, found while reading the code; including them would only
make permanent "survivors":

- `ta.highest`/`ta.lowest`: dropping the `Math.max(len, 0)` clamp. The source states it: "Clamping to 0
  changes no output".
- `slipped()`: `this.slippage > 0` to `>= 0` only adds `side * 0`.
- `extremeRing` rescan `s > extreme` to `s >= extreme` when `checkEq` is false: the `else if
  (!checkEq && s === extreme)` right after it sets the same index. (The `checkEq` case, the pivots, is not
  equivalent and is `ta-extreme-rescan-pivot`.)
- `security.resolveHtfIndex`: `rawHtfIdx <= 0` to `< 0`. A raw index of 0 gives `htfIdx = -1`, which the
  caller turns into na anyway.
- `str.roundDecimal`: `next > 5` to `>= 5`. The `if (next === 5)` block that follows reassigns `up`.
- `str.repeat`: `c <= 0` to `c < 0`. `c = 0` joins zero copies, which is `""` too.
- `checkDeadline`: `Date.now() > deadlineMs` to `>=`. Wall-clock equality, not a testable input.
- Exact-boundary flips at the 1e-10 tolerance (`<=` to `<` on `avgLoss`/`avgGain` in `ta.rsi`, on
  `Math.abs(upper)` in `ta.mfi`, `d <= CMP_EPS` in `pineEq`, `CMP_EPS < a - b` in `pineGt`): visible only
  at a difference of *exactly* 1e-10, which arithmetic on real prices does not produce. (Changing the
  tolerance's *magnitude* is not equivalent: `ta-eps-magnitude`, `ta-cross-eps-magnitude`,
  `numeric-cmp-eps-magnitude`.)
- `math.round`: `Math.floor(magnitude + 0.5)` to `Math.round(magnitude)`. They differ for the single
  double 0.49999999999999994.
- `Math.trunc(length)` to `Math.floor(length)` where the code has already required `length >= 1`.

## Survivors, and what they say

Two full runs were made. The first (115/130 killed, 15 survivors) was on the tree as it stood at the
start, with `tests/property` excluded because it was red on the clean tree at that moment (another
session was writing it). The second, on the tree an hour later with the whole suite (the property,
robustness and negative tiers had landed and were green), is the recorded one: **130 mutants, 118 killed,
12 survived: kill rate 90.8%**, no mutant killed by timeout, none INVALID. Three first-run survivors
(`ta-extreme-na-reset`, `ta-eps-magnitude`, `strategy-exit-profit-snap`) were killed by the new
`tests/property` tier in between, which is a useful check on the method: the survivor list is a list of
real gaps, and the ratchet is what notices when one closes. (In the first run three mutants came back
with no vitest report at all and were counted as kills; they are now INVALID plus one retry, and all
three were killed on every later run.)

**The 12 survivors.** None is equivalent: each is separated from the original by a short script, named in
its `survivors.json` reason, and run through the public API against both versions. Only one is never
executed by any test (checked by planting a marker at each anchor and running the suite once); the other
eleven are executed, and no input in the suite tells them apart.

| Class | Mutants | What the suite lacks |
|---|---|---|
| Value exactly at an edge | `array-set-bound`, `array-remove-bound` (index == size), `strategy-stop-touch-long` (high == stop), `strategy-walk-gap-stop` (open == stop level), `limits-resolve-minimum` (limit == 1) | the boundary case itself; the cases on both sides are tested |
| A tolerance's size, not its presence | `ta-cross-tolerance`, `ta-cross-eps-magnitude`, `numeric-round-tie-tolerance` | steps between 1e-10 and 1e-9 for `ta.cross` (the tier-1 probes use 1e-12 and 1e-8), and a value just under a rounding tie (`math.round(1.005, 2)` must be 1.01) |
| Option never combined | `security-feed-opened` (a feed with `lookahead_on`, contiguous bars: the mutant reads the **next** feed bar, a look-ahead leak), `str-pyfloat-exponent` (a number in 1e15..1e16), `series-nan-offset` (a history offset that is itself na) | the combination |
| Never executed | `security-offset-direction` (`getFieldHtfOffset`, a UDF-parameter offset on a requested series, reached when the call's argument is a loop counter) | any test of the path; flipping its direction reads the future row |

**How the kills are distributed.**

- 45 of the 118 killed mutants are killed by exactly one test file, and 71 by one or two:
  `runtime.test.ts` alone 15, `strategy.test.ts` alone 15, `float_tolerance_rolling_sum.test.ts` alone
  5. Delete one of those files' cases and the mutants it holds come back.
- 46 kills come from `tests/unit` only; only 49 are seen by at least one `tests/oracle` golden. The
  audit's example holds: `ta-tr-low-prevclose` (drop `|low - prevClose|` from `ta.tr`) is not seen by
  any golden or by `ta_atr_tr`; before `tests/property/reference_ta.test.ts` existed, the one test file
  that killed it was the hand-written `tests/unit/runtime.test.ts`.
- `corpus_diff.test.ts` kills 36 mutants but never alone: no mutant is killed only by the corpus tests,
  which is the case where the pine2py golden would be the only thing standing between a regression and
  a release.
- 122 test files kill at least one mutant; the biggest single killers are `runtime.test.ts` (63),
  `corpus_diff.test.ts` (36), `strategy.test.ts` (31), `reference_ta.test.ts` (29) and `codegen.test.ts`
  (20).
- By source file (mutants / killed): `ta.ts` 50/48, `strategy.ts` 28/26, `numeric.ts` 15/14, `array.ts` 9/7,
  `security.ts` 7/5, `str.ts` 7/6, `limits.ts` 4/3, `codegen.ts` 3/3, `analyzer.ts` + `arg-dup.ts` 3/3,
  `series.ts` 1/0, `lexer.ts`, `context.ts`, `calendar.ts` 1/1 each.

**What this does not say.** A killed mutant means a test fails, not that the test checks the number
against TradingView: most goldens are pine2py's, and the property tier's references are written in the
repo. A survivor is a statement about the suite, not a bug in `src/`. And the mutants are single-site
changes chosen by reading the code; a suite that kills all of them can still miss a combination.
