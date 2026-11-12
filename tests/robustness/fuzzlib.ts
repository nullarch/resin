// Shared core of the robustness tier: the mutator, the invariants, failure signatures and the
// minimizer. Both scripts/fuzz.mjs (child processes, hard timeouts) and fuzz_smoke.test.ts
// (in-process, bounded) import this file, so "what counts as a failure" is defined once.
//
// Written as plain erasable TypeScript with no value imports from src/: the fuzz children load it
// through the repo's type-stripping hook (register.mjs), which strips types but does not resolve
// anything beyond what the module itself imports. The caller injects the resin entry points
// (`Deps`), so this file never decides which copy of src/ it tests.
//
// A mutant is a pure function of (seed, index): `mutantAt(seeds, seed, index)` gives the same
// source on every machine, which is what makes `node scripts/fuzz.mjs --seed S --only I`
// reproduce a failure from the two numbers printed with it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type * as Src from "../../src/index";

// ---------------------------------------------------------------------------------------------
// PRNG

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x7f4a7c15, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------
// Seed scripts

export interface SeedScript {
  name: string;
  src: string;
}

export interface SeedSet {
  oracle: SeedScript[];
  corpus: SeedScript[];
}

// oracle/cases/*.pine and corpus/scripts/*.pine, name-sorted so the list is the same everywhere.
export function loadSeedScripts(root: string, maxBytes = 12_000): SeedSet {
  const read = (dir: string): SeedScript[] =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".pine"))
      .sort()
      .filter((f) => statSync(join(root, dir, f)).size <= maxBytes)
      .map((f) => ({ name: `${dir}/${f}`, src: readFileSync(join(root, dir, f), "utf8") }));
  return { oracle: read("oracle/cases"), corpus: read("corpus/scripts") };
}

// ---------------------------------------------------------------------------------------------
// Tokens

const TOKEN_RE =
  /\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|\n|[ \t]+|==|!=|<=|>=|=>|\+=|-=|\*=|\/=|%=|:=|\?\?|[\s\S]/g;

export function tokenize(src: string): string[] {
  return src.match(TOKEN_RE) ?? [];
}

const isSpace = (t: string): boolean => t === "\n" || /^[ \t]+$/.test(t);
const isComment = (t: string): boolean => t.startsWith("//");
const isReal = (t: string): boolean => !isSpace(t) && !isComment(t);
const isIdent = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t);
const isNumber = (t: string): boolean => /^(\d|\.\d)/.test(t);
const isBracket = (t: string): boolean => t.length === 1 && "()[]{}".includes(t);

// Names a mutant may borrow when "another identifier in scope" is not enough variety: the
// namespaces and constants a script can legitimately reach.
const BUILTIN_POOL = [
  "close", "open", "high", "low", "volume", "time", "hl2", "hlc3", "bar_index", "na", "true", "false",
  "ta.sma", "ta.ema", "ta.rsi", "ta.atr", "ta.highest", "ta.lowest", "ta.crossover", "ta.change", "ta.tr",
  "math.abs", "math.max", "math.pow", "math.sqrt", "math.round", "math.random", "nz", "na", "int", "float",
  "str.tostring", "str.format", "str.repeat", "str.length", "str.split", "array.new_float", "array.new<float>",
  "array.push", "array.get", "array.size", "array.from", "matrix.new<float>", "matrix.get", "map.new<string, float>",
  "strategy.long", "strategy.short", "strategy.entry", "strategy.exit", "strategy.close", "strategy.cash",
  "plot", "plotshape", "label.new", "line.new", "box.new", "table.new", "request.security", "timeframe.change",
  "syminfo.tickerid", "input.int", "input.float", "input.string", "color.red", "color.new", "barstate.islast",
];

const HUGE_NUMBERS = [
  "0", "-1", "1e9", "1e-9", "2147483648", "4294967296", "0.5", "1000000", "9007199254740993", "1e999",
  "1e308", "(0/0)", "(1/0)", "-0", "0.0", "999999999999", "100000000000000000000", "1e10", "3", "1",
];

const STRAY = [
  "`", "$", "@", "#", "\\", "~", "^", "?", "!", "|", ";", ":", "'", '"', "{", "}", "\u0000", " ",
  "é", "😀", "\r", " ", "﻿", "${", "\\u", "/*", "*/", "<", ">", ",", ".",
];

// ---------------------------------------------------------------------------------------------
// Mutations

export const MUTATION_KINDS = [
  "tok_delete", "tok_dup", "tok_swap", "line_delete", "line_dup", "line_swap", "truncate",
  "bracket_unbalance", "indent", "num_replace", "ident_replace", "ident_swap", "stray_char",
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

// Weighted toward the kinds that tend to leave the script parseable (replace, duplicate, a number
// change): a mutant that fails to lex only exercises the front door.
const KIND_WEIGHTS: [MutationKind, number][] = [
  ["tok_delete", 6], ["tok_dup", 4], ["tok_swap", 4], ["line_delete", 7], ["line_dup", 8], ["line_swap", 5],
  ["truncate", 2], ["bracket_unbalance", 4], ["indent", 4], ["num_replace", 14], ["ident_replace", 18],
  ["ident_swap", 6], ["stray_char", 4],
];
const WEIGHT_SUM = KIND_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function pickKind(rnd: () => number): MutationKind {
  let x = rnd() * WEIGHT_SUM;
  for (const [k, w] of KIND_WEIGHTS) {
    x -= w;
    if (x < 0) return k;
  }
  return "ident_replace";
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

function indexesOf(toks: string[], pred: (t: string) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < toks.length; i++) if (pred(toks[i]!)) out.push(i);
  return out;
}

// Applies one mutation. Returns null when the script has nothing for that kind to act on.
export function applyMutation(src: string, kind: MutationKind, rnd: () => number): string | null {
  const toks = tokenize(src);
  const real = indexesOf(toks, isReal);
  const join = (): string => toks.join("");
  switch (kind) {
    case "tok_delete": {
      if (real.length === 0) return null;
      toks.splice(pick(rnd, real), 1);
      return join();
    }
    case "tok_dup": {
      if (real.length === 0) return null;
      const i = pick(rnd, real);
      toks.splice(i, 0, toks[i]!, " ");
      return join();
    }
    case "tok_swap": {
      if (real.length < 2) return null;
      const k = Math.floor(rnd() * (real.length - 1));
      const a = real[k]!;
      const b = real[k + 1]!;
      [toks[a], toks[b]] = [toks[b]!, toks[a]!];
      return join();
    }
    case "ident_replace": {
      const ids = indexesOf(toks, isIdent);
      if (ids.length === 0) return null;
      const at = pick(rnd, ids);
      const pool = rnd() < 0.7 ? ids.map((i) => toks[i]!) : BUILTIN_POOL;
      const next = pick(rnd, pool);
      if (next === toks[at]) return null;
      toks[at] = next;
      return join();
    }
    case "ident_swap": {
      const ids = indexesOf(toks, isIdent);
      if (ids.length < 2) return null;
      const a = pick(rnd, ids);
      const b = pick(rnd, ids);
      if (toks[a] === toks[b]) return null;
      [toks[a], toks[b]] = [toks[b]!, toks[a]!];
      return join();
    }
    case "num_replace": {
      const ns = indexesOf(toks, isNumber);
      if (ns.length === 0) return null;
      const at = pick(rnd, ns);
      const next = pick(rnd, HUGE_NUMBERS);
      if (next === toks[at]) return null;
      toks[at] = next;
      return join();
    }
    case "line_delete":
    case "line_dup":
    case "line_swap": {
      const lines = src.split("\n");
      if (lines.length < 3) return null;
      const i = Math.floor(rnd() * lines.length);
      if (kind === "line_delete") lines.splice(i, 1);
      else if (kind === "line_dup") lines.splice(i, 0, lines[i]!);
      else {
        const j = rnd() < 0.5 ? Math.min(lines.length - 1, i + 1) : Math.floor(rnd() * lines.length);
        [lines[i], lines[j]] = [lines[j]!, lines[i]!];
      }
      return lines.join("\n");
    }
    case "truncate": {
      if (src.length < 2) return null;
      return src.slice(0, 1 + Math.floor(rnd() * (src.length - 1)));
    }
    case "bracket_unbalance": {
      const br = indexesOf(toks, isBracket);
      if (br.length > 0 && rnd() < 0.5) {
        toks.splice(pick(rnd, br), 1);
        return join();
      }
      toks.splice(Math.floor(rnd() * (toks.length + 1)), 0, pick(rnd, ["(", ")", "[", "]", "{", "}"]));
      return join();
    }
    case "indent": {
      const lines = src.split("\n");
      const i = Math.floor(rnd() * lines.length);
      const m = Math.floor(rnd() * 5);
      if (m === 0) lines[i] = " " + lines[i];
      else if (m === 1) lines[i] = "    " + lines[i];
      else if (m === 2) lines[i] = lines[i]!.replace(/^ {1,4}/, "");
      else if (m === 3) lines[i] = "\t" + lines[i];
      else lines[i] = "        " + lines[i];
      return lines.join("\n");
    }
    case "stray_char": {
      const at = Math.floor(rnd() * (src.length + 1));
      return src.slice(0, at) + pick(rnd, STRAY) + src.slice(at);
    }
  }
}

export interface Mutant {
  index: number;
  seedName: string;
  kinds: MutationKind[];
  src: string;
}

// Mutant `index` of run `seed`: pure, so any failure reproduces from the two numbers.
export function mutantAt(seeds: SeedSet, seed: number, index: number): Mutant {
  const rnd = mulberry32(mix(seed, index));
  const from = rnd() < 0.4 && seeds.oracle.length > 0 ? seeds.oracle : seeds.corpus.length > 0 ? seeds.corpus : seeds.oracle;
  const base = pick(rnd, from);
  const n = rnd() < 0.55 ? 1 : rnd() < 0.7 ? 2 : 3;
  let src = base.src;
  const kinds: MutationKind[] = [];
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 6; tries++) {
      const kind = pickKind(rnd);
      const next = applyMutation(src, kind, rnd);
      if (next !== null && next !== src) {
        src = next;
        kinds.push(kind);
        break;
      }
    }
  }
  return { index, seedName: base.name, kinds, src };
}

// ---------------------------------------------------------------------------------------------
// Invariants

export const FUZZ_BARS = 120;
export const FUZZ_LIMITS = { maxStepsPerBar: 200_000, maxCollectionLength: 100_000 } as const;
export const FUZZ_TRANSPILE_OPTIONS = { chartTf: "60" } as const;

export interface Deps {
  transpile: typeof Src.transpile;
  run: typeof Src.run;
  PineRuntimeHaltError: typeof Src.PineRuntimeHaltError;
  ResinLimitError: typeof Src.ResinLimitError;
  // FUZZ_BARS bars of OHLCV for the run; hourly when the transpile options are FUZZ_TRANSPILE_OPTIONS.
  data: Src.OHLCVData;
}

export type OutcomeKind =
  | "rejected" //          ok:false: the script was refused with an error message
  | "rejected_deep" //     ok:false, internal:true because the stack ran out (a script too deep; documented)
  | "ran" //               ok:true and every bar ran
  | "halt" //              PineRuntimeHaltError (runtime.error())
  | "limit" //             ResinLimitError
  | "refusal" //           a plain Error with one of the engine's deliberate "unsupported ..." messages
  | "F_transpile_throw" // (i)   transpile() threw
  | "F_internal" //        (i)   ok:false with internal:true that is not a stack overflow: a resin bug
  | "F_invalid_js" //      (ii)  ok:true but new Function("$","rt",code) does not parse
  | "F_run_throw" //       (iii) run() threw something other than a halt or a limit
  | "F_bad_result" //      (iii) run() returned, but the result is not one value per bar
  | "F_hang" //           (iv)  no answer inside the timeout
  | "F_crash"; //          (iv)  the process died (signal or abort)

export const OUTCOME_ORDER: OutcomeKind[] = [
  "rejected", "rejected_deep", "ran", "halt", "limit", "refusal",
  "F_transpile_throw", "F_internal", "F_invalid_js", "F_run_throw", "F_bad_result", "F_hang", "F_crash",
];

export const isFailure = (k: OutcomeKind): boolean => k.startsWith("F_");

export interface Outcome {
  kind: OutcomeKind;
  // Stable across mutants that fail the same way (digits and quoted names removed); absent for non-failures.
  sig?: string;
  message?: string;
  stack?: string;
  ms?: number;
}

// Deliberate refusals the runtime raises as plain Errors, one pattern per throw site (grep
// "throw new Error" in src/runtime). They are not in API.md; the report lists them as their own
// outcome instead of counting them clean.
const REFUSAL_PATTERNS: RegExp[] = [
  /^strategy[\w.()]*: unsupported /,
  /^request\.security: /,
  /^invalid timeframe: /,
  /^unknown timezone: /,
  /^tick timeframes are not supported/,
  /: invalid (time of day|day) /,
];

const STACK_MESSAGE = /Maximum call stack size exceeded|too much recursion/;

export function normalizeMessage(m: string): string {
  return m
    .replace(/(['"`])(?:(?!\1).){0,60}\1/g, (q) => (/^'(get|set|length|push|slice|map|call|apply|at|values|size)'$/.test(q) ? q : "<q>"))
    .replace(/[\w$.]+(?= is not (defined|a function|iterable|a constructor))/g, "<id>")
    .replace(/Cannot access <q> before initialization/, "Cannot access <id> before initialization")
    .replace(/\d+(\.\d+)?(e[+-]?\d+)?/gi, "N")
    .slice(0, 110);
}

// The first stack line inside resin's src/, as `function@file` without line numbers: which code
// threw, stable under edits to the file.
export function srcFrame(stack: string | undefined): string {
  if (stack === undefined) return "";
  for (const line of stack.split("\n")) {
    const m = /at (?:(?:async )?([^\s(]+) )?\(?(?:eval at \w+ \()?(?:file:\/\/)?[^\s)]*\/src\/([^\s:)]+)/.exec(line);
    if (m !== null) return `${m[1] ?? "?"}@${m[2]}`;
  }
  return "";
}

export function throwSignature(phase: string, e: unknown): { sig: string; message: string; stack: string } {
  const err = e instanceof Error ? e : new Error(String(e));
  const message = err.message;
  const frame = STACK_MESSAGE.test(message) ? "" : srcFrame(err.stack);
  return { sig: `${phase}|${err.constructor?.name ?? err.name}|${normalizeMessage(message)}|${frame}`, message, stack: err.stack ?? "" };
}

// A completed run holds one snapshot per bar and one value per bar in every plot.
function resultShapeProblem(r: Src.RunResult, bars: number, plotCount: number): string | null {
  if (r.bars.length !== bars) return `bars.length is ${r.bars.length}, the data has ${bars}`;
  if (r.plots.length !== plotCount) return `${r.plots.length} plots for ${plotCount} plot() sites`;
  for (const p of r.plots) if (p.values.length !== bars) return `plot '${p.title}' has ${p.values.length} values for ${bars} bars`;
  if (!Array.isArray(r.warnings)) return "warnings is not an array";
  return null;
}

// Invariants (i)-(iii) for one source. (iv), hangs and process deaths, cannot be observed from
// inside the process: scripts/fuzz.mjs does that from the outside.
export function checkSource(src: string, deps: Deps, onStage?: (stage: "transpile" | "run") => void): Outcome {
  const t0 = performance.now();
  const done = (o: Outcome): Outcome => ({ ...o, ms: performance.now() - t0 });
  onStage?.("transpile");
  let t;
  try {
    t = deps.transpile(src, { ...FUZZ_TRANSPILE_OPTIONS });
  } catch (e) {
    return done({ kind: "F_transpile_throw", ...throwSignature("transpile", e) });
  }
  if (typeof t !== "object" || t === null || typeof t.ok !== "boolean") {
    return done({ kind: "F_transpile_throw", sig: "transpile|returned-non-result", message: `transpile returned ${typeof t}` });
  }
  if (!t.ok) {
    if (t.internal === true) {
      const msg = t.errors.join("; ");
      if (STACK_MESSAGE.test(msg)) return done({ kind: "rejected_deep", message: msg });
      return done({ kind: "F_internal", sig: `internal|${normalizeMessage(msg)}`, message: msg });
    }
    return done({ kind: "rejected", message: t.errors[0] ?? "" });
  }
  try {
    new Function("$", "rt", t.code);
  } catch (e) {
    return done({ kind: "F_invalid_js", ...throwSignature("invalid-js", e) });
  }
  onStage?.("run");
  try {
    const r = deps.run(t, deps.data, { limits: { ...FUZZ_LIMITS } });
    const shape = resultShapeProblem(r, deps.data.close.length, t.plotTitles.length);
    if (shape !== null) return done({ kind: "F_bad_result", sig: `result|${shape}`, message: shape });
    return done({ kind: "ran" });
  } catch (e) {
    if (e instanceof deps.PineRuntimeHaltError) return done({ kind: "halt", message: e.message });
    if (e instanceof deps.ResinLimitError) return done({ kind: "limit", message: e.message });
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.constructor === Error && REFUSAL_PATTERNS.some((p) => p.test(msg))) {
      return done({ kind: "refusal", sig: `refusal|${normalizeMessage(msg)}`, message: msg });
    }
    return done({ kind: "F_run_throw", ...throwSignature("run", e) });
  }
}

// ---------------------------------------------------------------------------------------------
// Known defects: signatures the fuzzer finds in the current engine, each with minimal repros. The
// smoke test tolerates a failure only when it matches one of these, and fuzz_smoke.test.ts holds an
// `it.fails` per repro so the entry flips red (and gets deleted) the day the defect is fixed.

export interface KnownDefect {
  id: string;
  summary: string;
  match: RegExp; // against Outcome.sig
  repros: string[]; // Pine bodies (a header is prepended); each must end in a failure matching `match`
  // The repro cannot run in-process (it hangs): the smoke test checks the limit it should have hit
  // instead, and `unsafeSource` names the scripts the in-process loop must not run at all.
  inProcessUnsafe?: boolean;
  unsafeSource?: RegExp;
}

export const KNOWN_DEFECTS: KnownDefect[] = [
  {
    id: "KD1-wrong-typed-handle",
    summary:
      "a builtin that takes an array, map or matrix (or a timeframe, session, color string) is handed a number, series or bool: a raw TypeError from the runtime helper, where Pine refuses the script at compile time",
    match: /^run\|TypeError\|[^|]*\|[^|]*@runtime\/(array|map|matrix|color|str|time|security)\.ts$/,
    repros: [
      "array.push(close, 5)\nplot(1)",
      'map.put(volume, "k", 1.0)\nplot(1)',
      "x = matrix.rank(close)\nplot(1)",
      'plot(time(true, "Show MA"))',
      "x = array.size(x)\nplot(1)", // the same cause as KD2, surfacing inside the runtime helper
    ],
  },
  {
    id: "KD2-self-referencing-initializer",
    summary:
      "a name used in its own initializer is not refused (Pine: undeclared identifier): ReferenceError (temporal dead zone) or undefined flowing into a builtin",
    match: /^run\|(ReferenceError\|Cannot access <id> before initialization\||TypeError\|(?!Assignment to constant|Cannot set properties of null)[^|]*\|[^|]*@runtime\/engine\.ts$)/,
    repros: ["for i = 0 to 4\n    wt = wt\nplot(1)", "c = color.new(c, 80)\nplot(1)"],
  },
  {
    id: "KD3-generated-code-typeerror",
    summary:
      "assigning to a for-in iteration variable, or writing a field of an na object, is a raw TypeError thrown by the generated code (a const, a null)",
    match: /^run\|TypeError\|(Assignment to constant variable\.|Cannot set properties of null \(setting <q>\))\|/,
    repros: [
      'm = map.new<string, float>()\nmap.put(m, "a", 1.0)\nfor [k, v] in m\n    v := 2.0\nplot(1)',
      "type Pt\n    float v\nvar Pt obj = na\nobj.v := close\nplot(1)",
    ],
  },
  {
    id: "KD4-format-time-out-of-range",
    summary: "str.format_time with a timestamp outside JavaScript's Date range throws RangeError: Invalid time value (Pine: na or a clean error)",
    match: /^run\|RangeError\|Invalid time value\|/,
    repros: ['plot(na(str.format_time(9007199254740993, "yyyy", "UTC")) ? 0 : 1)'],
  },
  {
    id: "KD5-internal-generated-code-does-not-parse",
    summary:
      "the generated JavaScript does not parse (caught as ok:false, internal:true): a name declared twice in one value-position block, a duplicated for-in destructure name, a keyword as a function parameter, a call with more arguments than JavaScript allows",
    match: /^internal\|internal error: generated code does not parse/,
    repros: [
      "x = for i = 1 to 3\n    z = 1\n    z = 2\n    z\nplot(x)",
      'm = map.new<string, float>()\nfor [k, k] in m\n    x = 1\nplot(1)',
      "f(x, for) =>\n    x\nplot(f(1, 2))",
      `plot(math.max(${Array(70_000).fill("close").join(", ")}))`,
    ],
  },
  {
    id: "KD7-string-growth-unbounded",
    summary:
      "a string that doubles every bar is not bounded by maxCollectionLength: past V8's maximum string length the run dies with a raw RangeError: Invalid string length",
    match: /^run\|RangeError\|Invalid string length\|/,
    repros: ['var s = "xxxxxxxx"\ns := s + s\nplot(str.length(s))'],
  },
  {
    id: "KD11-str-match-backtracking",
    summary:
      "str.match compiles the script's pattern with new RegExp and runs it unbounded: a pattern with nested quantifiers on a short string never returns, and no host limit covers it (API.md: a host that needs a hard bound runs the engine in a worker it can terminate)",
    match: /^hang\|run$/,
    repros: ['plot(str.length(str.match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")))'],
    inProcessUnsafe: true,
    unsafeSource: /str\.match/,
  },
];

// A hang has one signature whatever hangs, so `src` (when the caller has it) says which defect it is.
export function knownDefectOf(sig: string | undefined, src?: string): KnownDefect | undefined {
  if (sig === undefined) return undefined;
  const hits = KNOWN_DEFECTS.filter((k) => k.match.test(sig));
  if (hits.length > 1 && src !== undefined) return hits.find((k) => k.unsafeSource?.test(src)) ?? hits[0];
  return hits[0];
}

// True for a script a known defect would make hang: the in-process loop skips it (scripts/fuzz.mjs runs it).
export function isInProcessUnsafe(src: string): boolean {
  return KNOWN_DEFECTS.some((k) => k.unsafeSource !== undefined && k.unsafeSource.test(src));
}

export const PINE_HEADER = "//@version=6\nindicator(\"repro\")\n";

// ---------------------------------------------------------------------------------------------
// Minimizer: delta-debugging by lines, then by tokens, keeping the failure signature.

export interface MinimizeBudget {
  maxEvals: number;
  deadline: number; // Date.now() ms
}

// Zeller's ddmin over an array of items. `test(subset)` is true when the subset still fails the
// same way. Returns a 1-minimal-ish subset within the budget.
export async function ddmin<T>(items: T[], test: (subset: T[]) => Promise<boolean>, budget: MinimizeBudget, spent: { evals: number }): Promise<T[]> {
  let cur = items;
  let n = 2;
  const exhausted = (): boolean => spent.evals >= budget.maxEvals || Date.now() > budget.deadline;
  while (cur.length >= 2 && !exhausted()) {
    const size = Math.ceil(cur.length / n);
    const chunks: T[][] = [];
    for (let i = 0; i < cur.length; i += size) chunks.push(cur.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (exhausted()) break;
      spent.evals++;
      if (chunk.length < cur.length && (await test(chunk))) {
        cur = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    for (let i = 0; i < chunks.length; i++) {
      if (exhausted()) break;
      const complement = chunks.filter((_, j) => j !== i).flat();
      if (complement.length === 0 || complement.length === cur.length) continue;
      spent.evals++;
      if (await test(complement)) {
        cur = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (n >= cur.length) break;
    n = Math.min(cur.length, n * 2);
  }
  // A last single-item pass: ddmin can stop one item short of 1-minimal when the budget ends a round.
  for (let i = 0; i < cur.length && cur.length > 1 && !exhausted(); ) {
    const without = cur.slice(0, i).concat(cur.slice(i + 1));
    spent.evals++;
    if (await test(without)) cur = without;
    else i++;
  }
  return cur;
}

// Shrinks `src` while `stillFails(candidate)` holds. Lines first, then non-space tokens (every
// space/newline/comment token stays, so removed tokens leave their indentation behind), then
// blank-line and trailing-space cleanup.
export async function minimizeSource(
  src: string,
  stillFails: (candidate: string) => Promise<boolean>,
  budget: MinimizeBudget,
): Promise<{ src: string; evals: number }> {
  const spent = { evals: 0 };
  const cache = new Map<string, boolean>();
  const test = async (candidate: string): Promise<boolean> => {
    const hit = cache.get(candidate);
    if (hit !== undefined) return hit;
    const r = await stillFails(candidate);
    cache.set(candidate, r);
    return r;
  };

  const byLines = async (text: string): Promise<string> => {
    const lines = text.split("\n");
    const kept = await ddmin(lines.map((_, i) => i), (idx) => test(idx.map((i) => lines[i]!).join("\n")), budget, spent);
    return kept.map((i) => lines[i]!).join("\n");
  };
  const byTokens = async (text: string): Promise<string> => {
    const toks = tokenize(text);
    const realIdx = indexesOf(toks, isReal);
    const render = (keep: number[]): string => {
      const keepSet = new Set(keep);
      return toks.map((t, i) => (isReal(t) && !keepSet.has(i) ? "" : t)).join("");
    };
    const kept = await ddmin(realIdx, (keep) => test(render(keep)), budget, spent);
    return render(kept);
  };

  let cur = src;
  cur = await byLines(cur);
  cur = await byTokens(cur);
  cur = await byLines(cur);
  const tidy = cur.replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n");
  if (tidy !== cur && (await test(tidy))) cur = tidy;
  return { src: cur, evals: spent.evals };
}
