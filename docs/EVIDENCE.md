# Release evidence

resin's claim is that it computes what TradingView computes. That claim is measured by a
separate project, the resin-harness, which compares resin with TradingView's own exports and
with a certified reference engine. Nothing in this repository can run that comparison, so
nothing in this repository used to notice when its result went stale: a source change after the
last harness run left every test green and the README numbers unchanged.

`release-evidence.json` fixes that. It is a file the harness writes, committed at the root of this
repository, that says "I compared exactly this tree and here is what I found".
`scripts/verify-evidence.mjs` refuses a release unless the file exists, certifies the tree being
released, and shows full conformance with TradingView. `.github/workflows/release.yml` runs it on
every `v*` tag.

## The release order

The hash covers the whole tracked tree (see below), so the evidence has to be produced after the
last change to it.

1. Finish the release: code, CHANGELOG, version bump (`package.json`, `src/index.ts`), READMEs.
   `npm test`, `npm run typecheck` and `node scripts/package-smoke.mjs` pass.
2. Commit it. The harness certifies the working tree, but a certified commit is easier to point
   at; `--print-hash` warns when tracked files differ from `HEAD`.
3. Run the harness against this checkout. It calls `node scripts/verify-evidence.mjs --print-hash`
   (do not reimplement the hash) and writes `release-evidence.json` at the repository root.
4. Commit `release-evidence.json` alone. It is excluded from the hash, so this commit does not
   invalidate it. Any other change from here on does: the gate fails and the harness has to run again.
5. Tag `vX.Y.Z` and push the tag. `release.yml` verifies (tests, typecheck, version consistency,
   package smoke, tag = version, evidence). It does not publish.
6. The owner publishes to npm by hand, with 2FA, and checks the published package
   (`node scripts/package-smoke.mjs --install @nullarch/resin@X.Y.Z`).

Locally, before step 3 or 5: `node scripts/verify-evidence.mjs` (verify), `--print-hash`, `--init`
(print a template with the current hash), `--previous <file>` (regression check), `--evidence <file>`
(verify another file), `--self-test`.

## The file

```json
{
  "resinContentHash": "<64 hex digits: the output of node scripts/verify-evidence.mjs --print-hash>",
  "harness": { "repo": "nullarch/resin-harness", "commit": "0123abcdef" },
  "generatedAt": "2026-09-28T09:00:00Z",
  "tvStrategy":  { "matched": 19, "total": 19 },
  "tvIndicator": { "matched": 72, "total": 72 },
  "fuzz": { "seed": 1234, "scenarios": 5000, "matched": 4937 },
  "scenarios": {
    "tv/strategy/<id>": "match",
    "tv/indicator/<id>": "match",
    "fuzz/<id>": "diverge"
  }
}
```

| field | meaning | the gate fails when |
|---|---|---|
| `resinContentHash` | sha256 of the tree this evidence certifies (below) | not 64 lowercase hex digits, or different from the tree being released |
| `harness.repo`, `harness.commit` | which harness at which commit produced it | repo empty; commit not 7-64 hex digits |
| `generatedAt` | ISO 8601 timestamp | unparseable, or more than a day in the future |
| `tvStrategy` | scenarios checked against TradingView's own strategy exports | `total` is 0, `matched` is not an integer in `0..total`, or `matched < total` |
| `tvIndicator` | the same for indicator exports | same |
| `fuzz.seed`, `fuzz.scenarios`, `fuzz.matched` | generated scenarios compared with the reference engine | `scenarios` is 0, or `matched` is not an integer in `0..scenarios` |
| `scenarios` | every scenario the harness ran, by id, with the outcome | empty, or a value other than `"match"` or `"diverge"` |

Counts are scenarios, the unit the 0.3.0 CHANGELOG uses (19 of 19 strategy, 72 of 72 indicator);
record counts and similar detail may be added as extra fields, the verifier ignores fields it
does not know. Scenario ids are the harness's own, stable between releases (that is what makes
`--previous` work); namespacing them (`tv/strategy/…`) keeps them readable.

**Why full conformance for TradingView but not for the fuzz.** `tvStrategy` and `tvIndicator` are
measured against TradingView itself: a release does not ship with a known disagreement there.
The fuzz compares resin with a reference engine that is not TradingView, and the CHANGELOG lists
its known divergences (737 of 800 indicator scenarios, 4,937 of 5,000 overall at 0.3.0). A gate
that refused the release it was written for would be worthless, so the fuzz only has to be
non-empty and self-consistent. What the fuzz must not do is get worse, which is what `--previous`
checks.

## The hash

`resinContentHash` is a sha256 over every file `git ls-files` lists (tracked files only; untracked
files do not count, so a new file enters the hash when it is `git add`ed; a tracked file deleted from the working tree is skipped), except the
root-level `release-evidence.json`, hashed from the working tree. The hashed bytes are, for each
file in plain code-unit order of its path (not locale order):

```text
<path as UTF-8> 0x00 <lowercase hex sha256 of the file's bytes> 0x0A
```

The paths come from `git ls-files -z`, so non-ASCII names are not quoted. A known answer is pinned
in `node scripts/verify-evidence.mjs --self-test`.

Because it covers the whole tracked tree, including the READMEs, the workflows and this file, any
change after the harness ran fails the gate, a typo fix in a README included. That is deliberate:
the evidence certifies a tree, not "roughly this code". The cost is that the harness runs last, as
the order above says. Line endings are part of the content; check out with LF.

## Regression check: `--previous`

```sh
git show v0.3.0:release-evidence.json > /tmp/previous-evidence.json
node scripts/verify-evidence.mjs --previous /tmp/previous-evidence.json
```

Fails when a scenario that was `"match"` in the previous release is `"diverge"` now, or is gone (a
removed scenario is a lost check, not a pass), and when `fuzz.matched` drops for the same seed and
scenario count. New scenarios, and scenarios that went from `"diverge"` to `"match"`, are fine.
`release.yml` does this automatically when the previous release tag carries an evidence file; the
first release with evidence has nothing to compare with and skips it.

## What this does not prove

The file is written by a program in another repository and committed by a person. The gate checks
that it is well-formed, current for this tree, and says what a release needs it to say. It cannot
check that the harness is honest or was really run; that is what `harness.commit` and the harness
repository's history are for. It is a gate against forgetting and against staleness, which is the
failure that happens, not against forgery.
