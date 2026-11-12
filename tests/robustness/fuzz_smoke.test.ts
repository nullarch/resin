// The in-process half of the robustness tier: a few hundred seeded mutants of the repo's own
// scripts through the same invariants scripts/fuzz.mjs checks in child processes, a table of
// hostile inputs that must end in a refusal or a typed limit error, and one `it.fails` per known
// defect the fuzzer has found (tests/robustness/README.md lists them).
//
// Everything here terminates in-process by construction: runs carry maxStepsPerBar 200,000 and
// maxCollectionLength 100,000, and anything that could still hang or abort the process (the OS-level
// kind) lives in scripts/fuzz.mjs. RESIN_PROP_RUNS=20 multiplies the mutant count.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PineRuntimeHaltError, ResinLimitError, run, transpile, type AnalyzeOptions } from "../../src/index";
import { makeSyntheticOHLCV } from "../helpers/synthetic";
import {
  FUZZ_BARS,
  FUZZ_LIMITS,
  FUZZ_TRANSPILE_OPTIONS,
  KNOWN_DEFECTS,
  PINE_HEADER,
  applyMutation,
  checkSource,
  isFailure,
  isInProcessUnsafe,
  knownDefectOf,
  loadSeedScripts,
  mulberry32,
  mutantAt,
  tokenize,
  type Deps,
  type MutationKind,
  type Outcome,
} from "./fuzzlib";

const RUNS = Math.max(1, Math.floor(Number(process.env.RESIN_PROP_RUNS ?? 1)) || 1);
// Mutants 0..4499 of both smoke seeds were run through scripts/fuzz.mjs (child processes, 5 s timeout)
// before this file trusted them in-process: no hang, no abort. Past that range nothing vouches for a
// mutant, so the multiplier stops counting there; hunt further with the script, not with vitest.
const FUZZ_RUNS = Math.min(RUNS, 60);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const deps: Deps = { transpile, run, PineRuntimeHaltError, ResinLimitError, data: makeSyntheticOHLCV(FUZZ_BARS, 1234) };
const seeds = loadSeedScripts(ROOT);

// ---------------------------------------------------------------------------------------------
// Mutation fuzzing

describe("mutation fuzz, in-process", () => {
  it("has seed scripts to mutate", () => {
    expect(seeds.oracle.length).toBeGreaterThan(100);
    expect(seeds.corpus.length).toBeGreaterThan(1000);
  });

  it("a mutant is a pure function of (seed, index)", () => {
    const a = mutantAt(seeds, 42, 7);
    const b = mutantAt(seeds, 42, 7);
    expect(b).toEqual(a);
    expect(mutantAt(seeds, 42, 8).src === a.src && mutantAt(seeds, 43, 7).src === a.src).toBe(false);
    expect(a.kinds.length).toBeGreaterThan(0);
  });

  it("every mutation kind changes a script it applies to", () => {
    const src = "//@version=6\nindicator(\"t\")\nx = ta.sma(close, 14)\ny = x * 2.5 + (close - open)\nplot(y, \"y\")\nplot(x)\n";
    const kinds: MutationKind[] = [
      "tok_delete", "tok_dup", "tok_swap", "line_delete", "line_dup", "line_swap", "truncate",
      "bracket_unbalance", "indent", "num_replace", "ident_replace", "ident_swap", "stray_char",
    ];
    const rnd = mulberry32(5);
    for (const kind of kinds) {
      let changed = false;
      for (let i = 0; i < 20 && !changed; i++) {
        const out = applyMutation(src, kind, rnd);
        changed = out !== null && out !== src;
      }
      expect(changed, `mutation ${kind} never changed the script`).toBe(true);
    }
    expect(tokenize(src).join("")).toBe(src);
  });

  const perSeed = 75 * FUZZ_RUNS;
  const runSeeds = [0x5eed01, 0x5eed02];

  it(`holds invariants (i)-(iii) over ${perSeed * runSeeds.length} mutants`, () => {
    const counts: Record<string, number> = {};
    const tolerated: Record<string, number> = {};
    const unexpected: string[] = [];
    let slowest = { ms: 0, label: "" };
    let total = 0;
    let skipped = 0;
    for (const seed of runSeeds) {
      for (let i = 0; i < perSeed; i++) {
        const m = mutantAt(seeds, seed, i);
        if (isInProcessUnsafe(m.src)) {
          skipped++; // a known hang (KD11): scripts/fuzz.mjs runs these in a child
          continue;
        }
        const out: Outcome = checkSource(m.src, deps);
        total++;
        counts[out.kind] = (counts[out.kind] ?? 0) + 1;
        const label = `seed ${seed} index ${i} (${m.seedName}, ${m.kinds.join("+")})`;
        if ((out.ms ?? 0) > slowest.ms) slowest = { ms: out.ms ?? 0, label };
        if (!isFailure(out.kind)) continue;
        const known = knownDefectOf(out.sig);
        if (known !== undefined) {
          tolerated[known.id] = (tolerated[known.id] ?? 0) + 1;
          continue;
        }
        unexpected.push(`${label}: ${out.kind} ${out.sig}\n    ${String(out.message).slice(0, 160)}\n    node scripts/fuzz.mjs --seed ${seed} --only ${i}`);
      }
    }
    expect(unexpected, `new failure signatures (tolerated known defects: ${JSON.stringify(tolerated)}, skipped as known hangs: ${skipped})`).toEqual([]);
    expect(skipped).toBeLessThan(perSeed * runSeeds.length * 0.05);
    // The run is not vacuous: most mutants die at the front door, but a real share reaches run().
    expect(counts.rejected ?? 0, JSON.stringify(counts)).toBeGreaterThan(total * 0.2);
    expect(counts.ran ?? 0, JSON.stringify(counts)).toBeGreaterThan(total * 0.15);
    // A single mutant that takes seconds in-process is a hang waiting for a slower machine.
    expect(slowest.ms, `slowest mutant: ${slowest.label}`).toBeLessThan(8_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Known defects: each is a real failure the fuzzer found. `it.fails` passes while the defect is
// there and turns red when it is fixed, which is the cue to delete the entry (and its KNOWN_DEFECTS
// tolerance in fuzzlib.ts).

describe("known defects (it.fails: red the day one is fixed)", () => {
  for (const kd of KNOWN_DEFECTS) {
    if (kd.inProcessUnsafe) continue;
    kd.repros.forEach((body, n) => {
      it.fails(`${kd.id} #${n + 1}: ${body.replace(/\s+/g, " ").slice(0, 70)}`, () => {
        const out = checkSource(PINE_HEADER + body + "\n", deps);
        // The defect is gone when this repro no longer fails with the family's signature.
        expect(isFailure(out.kind) && kd.match.test(out.sig ?? ""), `${out.kind} ${out.sig ?? ""}`).toBe(false);
      });
    });
  }

  // KD6 (fixed): ta.percentile_* used to ignore maxCollectionLength and top its window up one entry at
  // a time, so a length of 1e10 never returned and 1e6 took minutes. API.md says maxCollectionLength
  // bounds "a ta.* window".
  it("ta.percentile_* honours maxCollectionLength", () => {
    const t = transpile(PINE_HEADER + "plot(ta.percentile_nearest_rank(close, 5000, 50))\n", { ...FUZZ_TRANSPILE_OPTIONS });
    if (!t.ok) throw new Error(t.errors.join("; "));
    expect(() => run(t, makeSyntheticOHLCV(8, 1), { limits: { maxStepsPerBar: 200_000, maxCollectionLength: 1_000 } })).toThrow(ResinLimitError);
  });

  it("ta.percentile_* with a window of a million entries returns promptly", () => {
    const t = transpile(PINE_HEADER + "plot(ta.percentile_nearest_rank(close, 1000000, 50))\n", { ...FUZZ_TRANSPILE_OPTIONS });
    if (!t.ok) throw new Error(t.errors.join("; "));
    const started = Date.now();
    const out = run(t, makeSyntheticOHLCV(20, 1), { limits: { maxCollectionLength: 2_000_000 } });
    expect(out.plots[0]!.values.length).toBe(20);
    expect(Date.now() - started, "the top-up used to be quadratic").toBeLessThan(5_000);
  });

  it("every KNOWN_DEFECTS signature pattern is anchored (cannot swallow other failures)", () => {
    for (const kd of KNOWN_DEFECTS) expect(kd.match.source.startsWith("^"), kd.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile inputs

type Expect =
  | { kind: "refuse"; message: RegExp; notMessage?: RegExp }
  | { kind: "deep" } //                       ok:false; internal only as a stack overflow
  | { kind: "accept" } //                     ok:true and every bar runs
  | { kind: "accept-or-deep" } //             either of the two
  | { kind: "limit"; limit: "steps" | "size" | "deadline" };

interface Hostile {
  name: string;
  src: () => string;
  expect: Expect;
  options?: AnalyzeOptions;
  maxMs?: number;
}

const H = '//@version=6\nindicator("t")\n';
const rep = (s: string, n: number): string => s.repeat(n);

function garbage(chars: number): string {
  const pool = "(){}[]<>=+-*/%!?:,.;@#$^&|~`'\"\\\u0000 é😀 \t\n";
  const rnd = mulberry32(99);
  const out: string[] = [];
  for (let i = 0; i < chars; i++) out.push(pool[Math.floor(rnd() * pool.length)]!);
  return out.join("");
}

function nestedIfs(depth: number, indent: string): string {
  let s = H + "x = 0.0\n";
  for (let d = 0; d < depth; d++) s += rep(indent, d) + "if close > 0\n";
  return s + rep(indent, depth) + "x := 1.0\nplot(x)\n";
}

const HOSTILE: Hostile[] = [
  // Unterminated constructs
  { name: "unterminated string", src: () => H + 'x = "abc\nplot(close)\n', expect: { kind: "refuse", message: /unterminated string/ } },
  { name: "unterminated string at end of file", src: () => H + 'plot(close, title="abc', expect: { kind: "refuse", message: /unterminated string/ } },
  { name: "backslash at end of file inside a string", src: () => H + 'plot(close, title="abc\\', expect: { kind: "refuse", message: /unterminated string/ } },
  { name: "unterminated block comment", src: () => H + "plot(close)\n/* never closed\nplot(open)\n", expect: { kind: "refuse", message: /unterminated block comment/ } },
  { name: "block comment opener at end of file", src: () => H + "plot(close)\n/*", expect: { kind: "refuse", message: /unterminated block comment/ } },
  { name: "line comment with no final newline", src: () => H + "plot(close)\n// last line", expect: { kind: "accept" } },

  // Depth bombs: the stack runs out, and that has to come back as ok:false
  { name: "200,000 open parentheses", src: () => H + "x = " + rep("(", 200_000), expect: { kind: "deep" } },
  { name: "100,000 balanced parentheses", src: () => H + `x = ${rep("(", 100_000)}close${rep(")", 100_000)}\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "20,000 nested calls", src: () => H + `x = ${rep("math.abs(", 20_000)}close${rep(")", 20_000)}\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "100,000 unary minus signs", src: () => H + `x = ${rep("- ", 100_000)}close\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "100,000 chained not", src: () => H + `x = ${rep("not ", 100_000)}(close > open)\nplot(x ? 1 : 0)\n`, expect: { kind: "deep" } },
  { name: "100,000-term sum", src: () => H + `x = ${Array(100_000).fill("close").join(" + ")}\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "50,000 chained ternaries", src: () => H + `c = close > open\nx = ${rep("c ? 1.0 : ", 50_000)}0.0\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "5,000 chained subscripts", src: () => H + `x = close${rep("[0]", 5_000)}\nplot(x)\n`, expect: { kind: "deep" } },
  { name: "100,000 concatenated string literals", src: () => H + `s = ${Array(100_000).fill('"a"').join(" + ")}\nplot(str.length(s))\n`, expect: { kind: "deep" } },
  { name: "1,000 nested ifs, tab-indented", src: () => nestedIfs(1_000, "\t"), expect: { kind: "accept-or-deep" } },
  { name: "200 nested ifs, 4-space-indented", src: () => nestedIfs(200, "    "), expect: { kind: "accept" } },
  { name: "1,000 nested ifs, 4-space-indented (the size gate fires first)", src: () => nestedIfs(1_000, "    "), expect: { kind: "refuse", message: /maxSourceBytes/ } },

  // Size
  { name: "1,000,000 characters of garbage (just under the gate)", src: () => garbage(1_000_000), expect: { kind: "refuse", message: /./, notMessage: /maxSourceBytes/ } },
  {
    name: "2,000,000 characters of garbage with maxSourceBytes raised",
    src: () => garbage(2_000_000),
    options: { maxSourceBytes: 3_000_000 },
    expect: { kind: "refuse", message: /./, notMessage: /maxSourceBytes/ },
  },
  { name: "1,048,576 characters (over the gate)", src: () => rep("x", 1_048_576), expect: { kind: "refuse", message: /maxSourceBytes/ } },
  { name: "100,000 lines, 100,000 names", src: () => H + Array.from({ length: 100_000 }, (_, i) => `a${i}=1`).join("\n") + "\nplot(a1)\n", expect: { kind: "accept-or-deep" }, maxMs: 15_000 },

  // Literals
  { name: "1e999", src: () => H + "plot(1e999)\n", expect: { kind: "accept" } },
  { name: "-1e999", src: () => H + "plot(-1e999)\n", expect: { kind: "accept" } },
  { name: "1e-999", src: () => H + "plot(1e-999)\n", expect: { kind: "accept" } },
  { name: "1e99999999999", src: () => H + "plot(1e99999999999)\n", expect: { kind: "accept" } },
  { name: "a 27-digit integer", src: () => H + "plot(99999999999999999999999999)\n", expect: { kind: "accept" } },
  { name: "a 100,000-digit integer", src: () => H + `plot(${rep("9", 100_000)})\n`, expect: { kind: "accept" } },
  { name: "0x7fffffff (Pine has no hex literals)", src: () => H + "plot(0x7fffffff)\n", expect: { kind: "refuse", message: /./ } },
  { name: "a 24-digit hex literal", src: () => H + "plot(0xffffffffffffffffffffffff)\n", expect: { kind: "refuse", message: /./ } },
  { name: "a lone dot", src: () => H + "plot(.)\n", expect: { kind: "refuse", message: /./ } },
  { name: "history offset 2^31", src: () => H + "plot(close[2147483648])\n", expect: { kind: "accept" } },
  { name: "history offset 1e15", src: () => H + "plot(close[1e15])\n", expect: { kind: "accept" } },

  // Wide calls and odd bytes
  { name: "5,000-argument math.max", src: () => H + `plot(math.max(${Array(5_000).fill("close").join(", ")}))\n`, expect: { kind: "accept" } },
  { name: "5,000-element array.from", src: () => H + `a = array.from(${Array(5_000).fill("1.0").join(", ")})\nplot(array.size(a))\n`, expect: { kind: "accept" } },
  { name: "NUL bytes", src: () => H + "plot(close)\u0000\u0000\n", expect: { kind: "refuse", message: /unrecognized character/ } },
  { name: "byte order mark", src: () => "﻿" + H + "plot(close)\n", expect: { kind: "accept" } },
  { name: "carriage-return-only line ends", src: () => (H + 'plot(close, "A")\nplot(open, "B")\n').replace(/\n/g, "\r"), expect: { kind: "accept" } },
  { name: "only whitespace", src: () => "   \n\t\n  ", expect: { kind: "accept" } },
  { name: "empty script", src: () => "", expect: { kind: "accept" } },
  { name: "a recursive function", src: () => H + "f(n) =>\n    n <= 0 ? 0 : 1 + f(n - 1)\nplot(f(10))\n", expect: { kind: "refuse", message: /recursive/ } },

  // The audit's original aborts and hangs, now typed limit errors
  { name: "three nested while true", src: () => H + "n = 0\nwhile true\n    while true\n        while true\n            n += 1\nplot(n)\n", expect: { kind: "limit", limit: "steps" } },
  { name: "for 0 to 1e18", src: () => H + "s = 0\nfor i = 0 to 1e18\n    s += 1\nplot(s)\n", expect: { kind: "limit", limit: "steps" } },
  { name: "for by 0", src: () => H + "s = 0\nfor i = 0 to 10 by 0\n    s += 1\nplot(s)\n", expect: { kind: "limit", limit: "steps" } },
  { name: "for by 1e-300", src: () => H + "s = 0\nfor i = 0 to 10 by 1e-300\n    s += 1\nplot(s)\n", expect: { kind: "limit", limit: "steps" } },
  { name: "array.new<float>(2e9)", src: () => H + "a = array.new<float>(2000000000, 1.0)\nplot(array.size(a))\n", expect: { kind: "limit", limit: "size" } },
  { name: "matrix.new 1e5 x 1e5", src: () => H + "m = matrix.new<float>(100000, 100000, 0.0)\nplot(matrix.rows(m))\n", expect: { kind: "limit", limit: "size" } },
  { name: "str.repeat 2e9", src: () => H + 'plot(str.length(str.repeat("ab", 2000000000)))\n', expect: { kind: "limit", limit: "size" } },
  { name: "ta.sma window 1e8", src: () => H + "plot(ta.sma(close, 100000000))\n", expect: { kind: "limit", limit: "size" } },
  // A series length reads the per-bar history (one slot per bar of the run), so a length far past
  // the data allocates nothing of its own size: the run completes.
  { name: "ta.highest window that grows with bar_index", src: () => H + "plot(ta.highest(close, bar_index * 100000000))\n", expect: { kind: "accept" } },
];

const STACK = /Maximum call stack size exceeded/;

describe("hostile inputs: a refusal or a typed limit error, never a throw or a hang", () => {
  for (const row of HOSTILE) {
    it(row.name, () => {
      const src = row.src();
      const t0 = performance.now();
      const t = transpile(src, row.options ?? { ...FUZZ_TRANSPILE_OPTIONS });
      const transpileMs = performance.now() - t0;
      const e = row.expect;

      if (!t.ok) {
        const why = t.errors.join("; ");
        if (e.kind === "refuse") {
          expect(t.internal, why).toBeUndefined();
          expect(why).toMatch(e.message);
          if (e.notMessage !== undefined) expect(why).not.toMatch(e.notMessage);
        } else if (e.kind === "deep" || e.kind === "accept-or-deep") {
          if (t.internal === true) expect(why, "an internal failure is allowed only as a stack overflow").toMatch(STACK);
        } else {
          expect.unreachable(`expected ${e.kind}, but transpile refused: ${why.slice(0, 200)}`);
        }
      } else {
        expect(e.kind === "refuse" || e.kind === "deep", `transpile accepted a script the table says must be refused (${e.kind})`).toBe(false);
        let thrown: unknown = null;
        try {
          const r = run(t, makeSyntheticOHLCV(3, 7), { limits: { ...FUZZ_LIMITS } });
          expect(r.bars.length).toBe(3);
          for (const p of r.plots) expect(p.values.length).toBe(3);
        } catch (err) {
          thrown = err;
        }
        if (e.kind === "limit") {
          expect(thrown, "the run should have hit a host limit").toBeInstanceOf(ResinLimitError);
          expect((thrown as ResinLimitError).limit).toBe(e.limit);
        } else {
          expect(thrown, thrown instanceof Error ? thrown.message : "").toBeNull();
        }
      }
      expect(performance.now() - t0, `took ${Math.round(transpileMs)} ms to transpile`).toBeLessThan(row.maxMs ?? 5_000);
    });
  }

  it("a 5,000-argument math.max still computes the maximum", () => {
    const t = transpile(H + `plot(math.max(${Array(5_000).fill("close").join(", ")}))\n`, { ...FUZZ_TRANSPILE_OPTIONS });
    if (!t.ok) throw new Error(t.errors.join("; "));
    const data = makeSyntheticOHLCV(5, 3);
    const r = run(t, data, { limits: { ...FUZZ_LIMITS } });
    expect(Array.from(r.plots[0]!.values)).toEqual(Array.from(data.close));
  });

  it("a stack overflow does not leave the engine unusable for the next script", () => {
    const deep = transpile(H + `x = ${rep("(", 100_000)}`, { ...FUZZ_TRANSPILE_OPTIONS });
    expect(deep.ok).toBe(false);
    const fine = transpile(H + "plot(close)\n", { ...FUZZ_TRANSPILE_OPTIONS });
    expect(fine.ok).toBe(true);
  });
});
