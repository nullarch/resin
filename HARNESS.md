# Verification harness

What stands between a change to resin and a wrong number, a silent success or a hung host — and, as
important, what does not.

**"Problem-free" cannot be proven.** TradingView is closed, so conformance can only be bounded: by
recorded scenarios, by facts that hold whatever TradingView does, and by refusing loudly outside what
is enumerated. This document says which layer gives which kind of evidence, so a green run is read
for what it shows.

## Three kinds of evidence

| Kind | Meaning | Example |
|---|---|---|
| **(a) self-consistency** | resin agrees with itself or with expectations someone wrote by hand | most of `tests/unit`, the invariants in `tests/property` |
| **(b) independent reference** | resin agrees with something that was not derived from resin | TradingView exports, a brute-force implementation written in a test, an arithmetic identity |
| **(c) acceptance** | the script transpiles and runs | the corpus rates, the fuzz tier |

Only (b) is conformance, and nothing in this repository compares resin to TradingView. The README's
TradingView figures (15,989 trades, 46,482 indicator records) come from a harness outside this
repository; `scripts/verify-evidence.mjs` makes a release depend on them (below).

## Layers

### L0 — no silent success
`src/transpiler/surface.ts` registers every name that compiles but is not faithful (`stub`,
`passthrough`, `approximated`, `hypothesis`, `noop`), plus `strategy()` parameters that are accepted and
never read. `transpile()` lists each use in `TranspileOk.warnings`; `strict: true` refuses the stub and
pass-through ones (and ignored options, and a `//@version` outside 5–6). `resin run` prints the warnings
and `resin check` counts them. Run-time counterpart: `RunResult.warnings` — bars that do not match the
compiled `chartTf`, `time` in seconds or out of order, an `inputs` override that matched no input, a
`request.security` symbol with no feed. Tests: `tests/unit/surface.test.ts` (also fails when a runtime
module that holds stubs gains an export nobody classified), `tests/unit/run_diagnostics.test.ts`.
Built-in calls are checked against one signature table (`src/transpiler/builtins/signatures.ts`, 444
functions, generated from the oracle's library by `scripts/gen-builtin-signatures.py`): a keyword the
function does not have, too many arguments or a required one left out is a `signature` warning, an
error under `strict`. `tests/unit/builtin_call_check.test.ts` pins the calls resin's own cases make
that the table does not allow (13 kinds, taken over from pine2py; the list may only shrink) and the
one place resin's keyword names differ from the oracle's. On 2,987 valid real-world scripts the check
reports nothing (resin-harness, 2026-11-12).
A type record (`src/transpiler/types/infer.ts`) gives every expression its evident type: literals,
built-in variables, operators, built-in calls with a plain return in the signature table, and variables
the script introduces once; everything else is unknown and never judged. The type check on it
(`types/check.ts`) reports a string where the language takes a number or a bool (and the reverse), a
declared type against its initializer, `:=` changing a variable's type, a built-in argument of the other
kind. A `type` warning, an error under `strict`. It sees 16 of the 19 `static-type` false accepts; the
other three need signatures the table does not have (`plot`, `input.int`) or a parameter the oracle
leaves untyped. The analyzer's own inference is not on the record yet (docs/design/typed-ir.md, step 2). Both checkers are held to one gate
outside this repository: resin-harness fails its scoreboard when an accepted real-world script carries
a `signature` or `type` warning (`realworld.checker_clean`).
A name that is wrong and unregistered still compiles silently: an empty `warnings` is not a certificate.

### L1 — ground truth, and how much of it this repository holds
- `corpus/diff/status.json` — per-script ledger of the differential replay against pine2py goldens. Any
  script that changes status fails `tests/unit/corpus_diff.test.ts`, in either direction. pine2py (the
  sibling implementation resin was first built against) is **not ground truth**: a script going
  `matched → mismatch` can be resin getting closer to TradingView. Read why, then
  `UPDATE_CORPUS_LEDGER=1 npx vitest run tests/unit/corpus_diff.test.ts`. `matched_vacuous` counts matches in
  which no compared channel ever varies (558 of 2,289 today). `node scripts/corpus-ledger.mjs --summary`.
- `oracle/golden/PROVENANCE.json` — which of the 263 goldens were corrected by hand after the 0.1.0
  import (25). `node scripts/golden-provenance.mjs` regenerates it from git history.
- Both replays use 10 near-integer bars, so a window of 10 or more bars is NaN on both sides. The
  reference tier (L2) exists because of that.
- TradingView exports are **not in this repository**. `docs/EVIDENCE.md` defines the file
  (`release-evidence.json`) that carries their result in, and `scripts/verify-evidence.mjs` fails a release
  when it is missing, stale for the tree, or shows a scenario that used to match no longer matching.

### L2 — facts that need no oracle (`tests/property/`, see its README)
Brute-force reference implementations for 26 ta/math specs on 500 seeded bars with na gaps, flat
stretches, zero volume and near-tie grids; series-length versus literal-length agreement; no-lookahead,
determinism, formatting, power-of-two scale and shift invariants over a 73-template generator; strategy
accounting identities and mirror symmetry. `RESIN_PROP_RUNS=20` is the nightly size.

### L3 — hostile input and the host
- `src/runtime/limits.ts`, `tests/unit/limits.test.ts` — one shared loop budget per bar, allocation size,
  deadline. The limits bound one bar's steps and one allocation, **not the sum**; a host that needs a hard
  bound on time or memory runs the engine in a worker it can terminate.
- `tests/unit/lexer.test.ts`, `parser.test.ts`, and **`tests/negative/`** — 411 scripts that must be
  refused (message pinned), 81 valid near-misses that must not be, and `false_accepts.json`: 68 invalid
  scripts resin still accepts, each an `it.fails`.
- `tests/unit/identifier_hygiene.test.ts` — renaming a variable never changes the numbers; the reserved
  set is checked against the globals the generated code actually reads.
- **`tests/robustness/`, `scripts/fuzz.mjs`** — seeded mutation fuzz (a child process per mutant with a
  hard timeout for what can hang or abort), data shapes, string injection. `node scripts/fuzz.mjs --count
  60000 --seed 1`. Its defects are in `tests/robustness/README.md`.

### L4 — known gaps (`known-gaps.json`)
25 entries. An `it.fails` repro asserts the *correct* behaviour, so closing the gap turns its test red
until the entry is deleted. Other entries are pinned as reported (`warned`), as refused (`pinned`), as a
count of the false accepts above (`negative`), or in the suite that owns the repro (`external`). Each
entry says which document mentions it; that phrase is checked. The number of `hypothesis` marker lines in
`src/` can only go down.

### Mutation ratchet (`scripts/mutate.mjs`, `mutation/`)
130 single-line mutants of the code that decides numbers, each run against the whole suite on a copy of
the tree. 118 are killed; the 12 survivors are listed in `mutation/survivors.json` with the input that
tells them from the original — each one is untested behaviour. The list can only shrink. A full run is
about 26 minutes at `--jobs 4`: nightly or before a release, not per push.

## Tiers

| Tier | When | What |
|---|---|---|
| per change | push / PR (`.github/workflows/ci.yml`) | `npm test` on Node 22.18 and 24 (ubuntu) and 24 (macOS), typecheck, the README quick start, `resin check oracle/cases`, a clean-tree check after the tests, and `package-smoke` (pack, allowlist, install the tarball, run the CLI and the library from it) on both Node versions |
| nightly | schedule (`nightly.yml`) | `RESIN_PROP_RUNS=20` over `tests/property` and `tests/robustness`, `scripts/mutate.mjs`, the corpus manifest check when a `CORPUS_DIR` is configured, a drift check of npm against the repo |
| release | tag `v*` (`release.yml`) | everything above on the tagged tree, version consistency, tarball install, `verify-evidence`. **Does not publish.** |

## Decisions left to the owner

- **Publishing.** npm `latest` is 0.2.2 while the repository and the `v0.3.0` tag are 0.3.0, so the README's
  `npm install` gets code that behaves differently from this CHANGELOG. `release.yml` only verifies; the
  nightly drift job stays red until 0.3.0 is published by hand. A `prepublishOnly` guard
  (`node scripts/package-smoke.mjs && node scripts/verify-evidence.mjs`) would make `npm publish` refuse
  until the package and the evidence are in order; it was **not** added because it changes the publish
  flow and blocks it until `release-evidence.json` exists.
- **Evidence.** Who produces `release-evidence.json` (the harness that measures resin against the
  TradingView exports) and when: it must run last, because it certifies a hash of every tracked file.
- **Defaults.** `strict` is off and the limits are generous (10,000,000 steps per bar, 10,000,000
  elements); a service that runs scripts it did not write should turn `strict` on and lower the limits.
- **`known-gaps.json` candidates** (`ta.bbw` ×100, `ta.correlation` at small prices, `ta.roc` with a
  series length across na, `hour()` in the exchange timezone, `timestamp("America/New_York", y, m, d)`
  ignoring its zone although the manual says the zone sets the calendar values, `matrix.pinv` on an
  ill-conditioned non-square matrix still squaring the condition number) are unresolved until someone
  checks them against TradingView. None is asserted as a defect.

## What this does not cover

- TradingView conformance beyond the recorded scenarios, v5-only rules (README "What is not verified"),
  drawings, `viz`, anything realtime.
- A static type checker. Ill-typed scripts compile and fail at run time with a raw error
  (`KG-NO-TYPECHECK`, 19 scripts in `false_accepts.json`). A checker has to be validated against the Pine
  reference before it may refuse real scripts; building it from memory would refuse valid ones.
- The real-world corpus numbers (99.7% / 99.5%): the scripts are not redistributable.
  `scripts/corpus-manifest.mjs` lets anyone re-measure them on a corpus they hold.
- Regular-expression time: `str.match` runs the script's pattern as a JavaScript `RegExp`
  (`KG-REGEX-HANG`). Strategy margin, the bar magnifier, OCA groups and `strategy.risk.*` have no
  independent reference here.
