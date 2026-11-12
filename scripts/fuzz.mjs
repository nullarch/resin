#!/usr/bin/env node
// Fuzzer for the Pine -> JavaScript compiler: seeded mutants of the repo's own scripts, each run in
// a child process under a hard timeout, checked against four invariants:
//
//   (i)   transpile() returns a result and never throws (an `internal` failure other than a
//         stack overflow counts as a bug too);
//   (ii)  ok:true code parses as `new Function("$", "rt", code)`;
//   (iii) running an ok:true mutant on 120 seeded bars, with maxStepsPerBar 200,000 and
//         maxCollectionLength 100,000, throws at most PineRuntimeHaltError or ResinLimitError
//         (a plain Error with one of the engine's deliberate "unsupported ..." messages is
//         reported on its own row, `refusal`; --strict-errors makes it a failure), and a run that
//         completes returns one snapshot per bar and one value per bar in every plot;
//   (iv)  the child neither dies on a signal nor misses the timeout.
//
//   node scripts/fuzz.mjs --count 3000 --seed 1 [--timeout 5] [--jobs 4] [--out DIR]
//   node scripts/fuzz.mjs --seed 1 --only 1234      run one mutant, print its source and outcome
//   node scripts/fuzz.mjs --seed 1 --print 1234     print mutant 1234's source only
//   node scripts/fuzz.mjs --check file.pine         run one file through the same child
//
// Every failure signature is minimized (delta-debugging by lines, then tokens, keeping the same
// signature) and written to DIR as <kind>-<hash>.min.pine next to the original and a .json.
// Exit status 1 when any invariant failed. Mutants are a pure function of (seed, index), so
// `--seed S --only I` reproduces any line of a failure report. The in-process cousin of this tool
// is tests/robustness/fuzz_smoke.test.ts; both share tests/robustness/fuzzlib.ts.

import { register } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/ is TypeScript with extensionless imports; the hook lets plain node load it (see bin/resin.mjs).
register("./ts-esm-loader-hook.mjs", import.meta.url);

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const lib = await import("../tests/robustness/fuzzlib.ts");
const { checkSource, mutantAt, loadSeedScripts, minimizeSource, fnv1a, isFailure, knownDefectOf, OUTCOME_ORDER } = lib;

// ---------------------------------------------------------------------------------------------
// Child: reads {id, src} lines on stdin, answers with {id, stage} and {id, outcome} lines.

function writeLine(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off);
    } catch (e) {
      if (e && e.code === "EAGAIN") continue; // the pipe is full: the parent is about to read it
      throw e;
    }
  }
}

// --selftest only: a script starting with //SELFTEST:<what> makes the child misbehave the way a bad
// mutant would, so the parent's hang, abort and exit handling is exercised for real.
function selftestMisbehave(source, id) {
  const what = /^\/\/SELFTEST:(\w+)/.exec(source)?.[1];
  if (what === undefined) return;
  writeLine({ id, stage: "run" });
  if (what === "hang") for (;;);
  if (what === "abort") process.abort();
  if (what === "exit") process.exit(3);
  if (what === "oom") {
    const keep = [];
    for (;;) keep.push(new Array(1 << 20).fill(keep.length));
  }
}

async function serve() {
  const src = await import("../src/index.ts");
  const { makeSyntheticOHLCV } = await import("../tests/helpers/synthetic.ts");
  const deps = {
    transpile: src.transpile,
    run: src.run,
    PineRuntimeHaltError: src.PineRuntimeHaltError,
    ResinLimitError: src.ResinLimitError,
    data: makeSyntheticOHLCV(lib.FUZZ_BARS, 1234),
  };
  writeLine({ ready: true });
  // Split on "\n" by hand: readline also splits on U+2028/U+2029, which a mutant may contain.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      const { id, src: source } = JSON.parse(line);
      if (process.env.RESIN_FUZZ_SELFTEST === "1") selftestMisbehave(source, id);
      const outcome = checkSource(source, deps, (stage) => writeLine({ id, stage }));
      if (outcome.stack !== undefined) outcome.stack = outcome.stack.slice(0, 1500);
      writeLine({ id, outcome });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// ---------------------------------------------------------------------------------------------
// Parent: one persistent child per job, restarted after a hang or a death.

function fatalLine(stderr) {
  const m = /(FATAL ERROR|Fatal process out of memory|Aborted|SIGSEGV|segmentation)[^\n]*/i.exec(stderr);
  return m ? m[0].replace(/0x[0-9a-f]+/gi, "0x").replace(/\d+/g, "N").slice(0, 90) : "";
}

class Executor {
  constructor({ timeoutMs, heapMb, selftest = false }) {
    this.timeoutMs = timeoutMs;
    this.heapMb = heapMb;
    this.selftest = selftest;
    this.child = null;
    this.seq = 0;
    this.pending = null;
    this.stage = "startup";
    this.restarts = 0;
  }

  start() {
    const child = spawn(process.execPath, [`--max-old-space-size=${this.heapMb}`, "--no-warnings", SELF, "--child"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      env: this.selftest ? { ...process.env, RESIN_FUZZ_SELFTEST: "1" } : process.env,
    });
    this.child = child;
    this.stderr = "";
    this.stage = "startup";
    let buf = "";
    this.readyP = new Promise((res, rej) => {
      this.readyRes = res;
      this.readyRej = rej;
    });
    this.readyP.catch(() => {}); // surfaced by eval(); no unhandled-rejection noise otherwise
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (child !== this.child || line === "") continue;
        const msg = JSON.parse(line);
        if (msg.ready) this.readyRes();
        else if (msg.stage) this.stage = msg.stage;
        else if (msg.outcome) this.finish(msg.outcome);
      }
    });
    child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (child !== this.child) return; // killed on purpose after a timeout
      this.child = null;
      if (this.pending === null) {
        this.readyRej(new Error(`fuzz child exited during startup (code ${code}, signal ${signal})\n${this.stderr}`));
        return;
      }
      const how = signal ?? `exit${code}`;
      this.finish({
        kind: "F_crash",
        sig: `crash|${this.stage}|${how}|${fatalLine(this.stderr)}`,
        message: `child ${signal ? `killed by ${signal}` : `exited with code ${code}`} during ${this.stage}: ${this.stderr.trim().split("\n").slice(0, 3).join(" / ").slice(0, 300)}`,
      });
    });
  }

  finish(outcome) {
    if (this.pending === null) return;
    clearTimeout(this.timer);
    const p = this.pending;
    this.pending = null;
    p(outcome);
  }

  async eval(src, timeoutMs = this.timeoutMs) {
    if (this.child === null) {
      this.start();
      this.restarts++;
    }
    await this.readyP;
    const child = this.child;
    return new Promise((res) => {
      this.pending = res;
      this.stage = "transpile";
      this.timer = setTimeout(() => {
        const stage = this.stage;
        this.child = null;
        child.kill("SIGKILL");
        this.finish({ kind: "F_hang", sig: `hang|${stage}`, message: `no answer within ${timeoutMs} ms (during ${stage})` });
      }, timeoutMs);
      child.stdin.write(JSON.stringify({ id: ++this.seq, src }) + "\n");
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.stdin.end();
      child.kill("SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    count: 3000, seed: 1, timeout: 5, jobs: 4, out: join(tmpdir(), "resin-fuzz"), heap: 1024,
    minBudget: 90, maxSigs: 40, minimize: true, strictErrors: false, knownOk: false, selftest: false, full: false, only: null, print: null, check: null,
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--count": o.count = num(next(), "count"); break;
      case "--seed": o.seed = num(next(), "seed"); break;
      case "--timeout": o.timeout = num(next(), "timeout"); break;
      case "--jobs": o.jobs = Math.max(1, num(next(), "jobs")); break;
      case "--out": o.out = resolve(next()); break;
      case "--heap": o.heap = num(next(), "heap"); break;
      case "--min-budget": o.minBudget = num(next(), "min-budget"); break;
      case "--max-sigs": o.maxSigs = num(next(), "max-sigs"); break;
      case "--no-minimize": o.minimize = false; break;
      case "--strict-errors": o.strictErrors = true; break;
      case "--known-ok": o.knownOk = true; break;
      case "--selftest": o.selftest = true; break;
      case "--full": o.full = true; break;
      case "--only": o.only = num(next(), "only"); break;
      case "--print": o.print = num(next(), "print"); break;
      case "--check": o.check = next(); break;
      case "--child": break;
      case "-h":
      case "--help": o.help = true; break;
      default: throw new Error(`unknown argument ${a} (try --help)`);
    }
  }
  return o;
}

const HELP = `node scripts/fuzz.mjs --count N --seed S [--timeout 5] [--jobs 4] [--out DIR]
  --count N        mutants to generate (default 3000; duplicates are skipped and reported)
  --seed S         run seed; mutant i of seed S is always the same script (default 1)
  --timeout SEC    hard limit per mutant, transpile plus 120 bars (default 5)
  --jobs N         child processes in parallel (default 4)
  --out DIR        where minimized repros and summary.json go (default: <tmpdir>/resin-fuzz)
  --heap MB        --max-old-space-size of each child (default 1024)
  --min-budget SEC minimization wall time per failure signature (default 90; hangs get 3x)
  --max-sigs N     minimize at most N distinct signatures (default 40)
  --no-minimize    report signatures without minimizing
  --strict-errors  count the engine's plain-Error refusals as failures too
  --known-ok       exit 0 when every failure matches a known defect (tests/robustness/fuzzlib.ts KNOWN_DEFECTS)
  --selftest       check the harness itself: a hanging and an aborting child must be reported and survived
                   (--full adds an exiting and an out-of-memory child, a couple of seconds more)
  --only I | --print I | --check FILE   reproduce a single script (see the file header)`;

const pad = (s, n) => String(s).padEnd(n);

function applyStrict(outcome, strict) {
  if (strict && outcome.kind === "refusal") return { ...outcome, kind: "F_run_throw" };
  return outcome;
}

// The harness has to see what the engine no longer does: a hang, an abort, an out-of-memory, a
// plain exit. Each is forced in the child, and the next script after it must still be answered.
async function selfTest(opts) {
  // Only the deliberate hang gets the short timeout: the steps that must answer get the full one,
  // so a loaded machine cannot turn a restarting child into a false "hang".
  const hangMs = Math.round(opts.timeout * 1000);
  const ex = new Executor({ timeoutMs: Math.max(hangMs, 10_000), heapMb: Math.min(opts.heap, 96), selftest: true });
  const normal = "//@version=6\nindicator(\"ok\")\nplot(close)\n";
  const steps = [
    ["normal", normal, (o) => o.kind === "ran"],
    ["hang", "//SELFTEST:hang", (o) => o.kind === "F_hang" && o.sig === "hang|run", hangMs],
    ["normal after hang", normal, (o) => o.kind === "ran"],
    ["abort", "//SELFTEST:abort", (o) => o.kind === "F_crash" && /SIGABRT/.test(o.sig)],
    ["normal after abort", normal, (o) => o.kind === "ran"],
  ];
  if (opts.full) {
    steps.push(["exit", "//SELFTEST:exit", (o) => o.kind === "F_crash" && /exit3/.test(o.sig)]);
    steps.push(["normal after exit", normal, (o) => o.kind === "ran"]);
    steps.push(["oom", "//SELFTEST:oom", (o) => o.kind === "F_crash" && /(SIGABRT|SIGTRAP|exit)/.test(o.sig)]);
    steps.push(["normal after oom", normal, (o) => o.kind === "ran"]);
  }
  let bad = 0;
  for (const [name, src, ok, ms] of steps) {
    const o = await ex.eval(src, ms);
    const pass = ok(o);
    if (!pass) bad++;
    console.log(`${pass ? "ok  " : "FAIL"} ${pad(name, 20)} ${o.kind} ${o.sig ?? ""}`);
  }
  ex.close();
  return bad === 0 ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.selftest) return selfTest(opts);
  const seeds = loadSeedScripts(ROOT);
  const timeoutMs = Math.round(opts.timeout * 1000);

  if (opts.print !== null) {
    process.stdout.write(mutantAt(seeds, opts.seed, opts.print).src);
    return 0;
  }
  if (opts.only !== null || opts.check !== null) {
    let source;
    if (opts.only !== null) {
      const m = mutantAt(seeds, opts.seed, opts.only);
      console.log(`mutant ${opts.only} of seed ${opts.seed}: from ${m.seedName}, mutations ${m.kinds.join("+")}\n-----\n${m.src}\n-----`);
      source = m.src;
    } else {
      source = readFileSync(opts.check, "utf8");
    }
    const ex = new Executor({ timeoutMs, heapMb: opts.heap });
    const out = applyStrict(await ex.eval(source), opts.strictErrors);
    ex.close();
    console.log(JSON.stringify(out, null, 2));
    return isFailure(out.kind) ? 1 : 0;
  }

  mkdirSync(opts.out, { recursive: true });
  const t0 = Date.now();
  const counts = Object.fromEntries(OUTCOME_ORDER.map((k) => [k, 0]));
  const failures = new Map(); // sig -> { kind, sig, count, examples[] }
  const refusals = new Map(); // message -> count
  const slowest = [];
  const seen = new Set();
  let next = 0;
  let unique = 0;
  let duplicates = 0;
  let restarts = 0;

  const worker = async () => {
    const ex = new Executor({ timeoutMs, heapMb: opts.heap });
    for (;;) {
      const i = next++;
      if (i >= opts.count) break;
      const m = mutantAt(seeds, opts.seed, i);
      const key = `${m.src.length}:${fnv1a(m.src)}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      unique++;
      const out = applyStrict(await ex.eval(m.src), opts.strictErrors);
      counts[out.kind]++;
      if (out.kind === "refusal") refusals.set(out.message, (refusals.get(out.message) ?? 0) + 1);
      if (out.ms !== undefined && (slowest.length < 5 || out.ms > slowest[slowest.length - 1].ms)) {
        slowest.push({ index: i, ms: Math.round(out.ms), kind: out.kind });
        slowest.sort((a, b) => b.ms - a.ms);
        slowest.length = Math.min(slowest.length, 5);
      }
      if (isFailure(out.kind)) {
        let f = failures.get(out.sig);
        if (f === undefined) failures.set(out.sig, (f = { kind: out.kind, sig: out.sig, count: 0, examples: [], message: out.message, stack: out.stack }));
        f.count++;
        f.examples.push({ index: i, seedName: m.seedName, kinds: m.kinds, src: m.src });
        f.examples.sort((a, b) => a.src.length - b.src.length);
        f.examples.length = Math.min(f.examples.length, 6);
      }
      if (unique % 1000 === 0) console.error(`  ${unique} mutants, ${[...failures.values()].reduce((s, f) => s + f.count, 0)} failing, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    restarts += ex.restarts;
    ex.close();
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.count) }, worker));
  const runMs = Date.now() - t0;

  // Minimize one example per distinct signature.
  const report = [];
  const list = [...failures.values()].sort((a, b) => b.count - a.count);
  const toMinimize = opts.minimize ? list.slice(0, opts.maxSigs) : [];
  let cursor = 0;
  const minimizers = Array.from({ length: Math.min(opts.jobs, toMinimize.length) }, async () => {
    const ex = new Executor({ timeoutMs, heapMb: opts.heap });
    for (;;) {
      const f = toMinimize[cursor++];
      if (f === undefined) break;
      const original = f.examples[0];
      const stillFails = async (candidate) => {
        const out = applyStrict(await ex.eval(candidate), opts.strictErrors);
        return isFailure(out.kind) && out.sig === f.sig;
      };
      const budgetMs = opts.minBudget * 1000 * (f.kind === "F_hang" || f.kind === "F_crash" ? 3 : 1);
      if (await stillFails(original.src)) {
        const r = await minimizeSource(original.src, stillFails, { maxEvals: 1500, deadline: Date.now() + budgetMs });
        f.minimized = r.src;
        f.evals = r.evals;
      } else {
        f.minimized = null; // not reproducible in a fresh child run
      }
    }
    ex.close();
  });
  await Promise.all(minimizers);

  for (const f of list) {
    const id = `${f.kind}-${fnv1a(f.sig)}`;
    const original = f.examples[0];
    writeFileSync(join(opts.out, `${id}.orig.pine`), original.src);
    if (typeof f.minimized === "string") writeFileSync(join(opts.out, `${id}.min.pine`), f.minimized);
    const rec = {
      id, kind: f.kind, sig: f.sig, count: f.count, message: f.message, stack: f.stack, known: knownDefectOf(f.sig, f.minimized ?? f.examples[0].src)?.id ?? null,
      reproduce: `node scripts/fuzz.mjs --seed ${opts.seed} --only ${original.index}`,
      examples: f.examples.map((e) => ({ index: e.index, seedName: e.seedName, mutations: e.kinds.join("+"), length: e.src.length })),
      minimizedLength: typeof f.minimized === "string" ? f.minimized.length : null,
      minimizeEvals: f.evals ?? null,
      reproducible: f.minimized !== null || !opts.minimize ? true : false,
    };
    writeFileSync(join(opts.out, `${id}.json`), JSON.stringify(rec, null, 2));
    report.push({ ...rec, minimized: f.minimized });
  }

  const failing = list.reduce((s, f) => s + f.count, 0);
  const summary = {
    seed: opts.seed, count: opts.count, unique, duplicates, jobs: opts.jobs, timeoutSec: opts.timeout,
    outcomes: counts, okRate: +((counts.ran + counts.halt + counts.limit + counts.refusal + counts.F_run_throw + counts.F_bad_result + counts.F_hang + counts.F_crash) / Math.max(1, unique)).toFixed(3),
    failingMutants: failing, distinctSignatures: list.length, childRestarts: restarts, slowest,
    runSeconds: +(runMs / 1000).toFixed(1), totalSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    refusals: Object.fromEntries([...refusals].sort((a, b) => b[1] - a[1])),
    failures: report.map(({ id, kind, sig, count, known, reproduce, minimizedLength }) => ({ id, kind, sig, count, known, reproduce, minimizedLength })),
  };
  writeFileSync(join(opts.out, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\nresin fuzz: seed ${opts.seed}, ${unique} unique mutants (${duplicates} duplicates skipped), ${opts.jobs} jobs, ${opts.timeout} s timeout, ${summary.runSeconds} s`);
  console.log("outcome".padEnd(20) + "count");
  for (const k of OUTCOME_ORDER) console.log(pad(k, 20) + counts[k]);
  console.log(`reached ok:true (ran, halt, limit, refusal or a run failure): ${(summary.okRate * 100).toFixed(1)} %`);
  console.log(`slowest: ${slowest.map((s) => `#${s.index} ${s.ms} ms`).join(", ")}`);
  if (refusals.size > 0) {
    console.log(`\nplain-Error refusals (not failures; ${[...refusals.values()].reduce((a, b) => a + b, 0)} total):`);
    for (const [msg, n] of [...refusals].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${pad(n, 5)} ${msg.slice(0, 110)}`);
  }
  if (list.length === 0) {
    console.log("\nall invariants held");
    return 0;
  }
  const unknown = report.filter((f) => f.known === null);
  console.log(`\n${failing} failing mutants, ${list.length} distinct signatures, ${unknown.length} of them not matching a known defect (repros in ${opts.out}):`);
  for (const f of report) {
    console.log(`\n[${f.kind}] x${f.count}  ${f.known ? `(known: ${f.known})  ` : ""}${f.sig}`);
    console.log(`  message: ${String(f.message).slice(0, 200)}`);
    console.log(`  reproduce: ${f.reproduce}`);
    if (typeof f.minimized === "string") {
      console.log(`  minimized (${f.minimizedLength} chars, ${f.minimizeEvals} evals):\n${f.minimized.replace(/^/gm, "    | ")}`);
    } else if (opts.minimize) {
      console.log("  minimized: (did not reproduce in a fresh child)");
    }
  }
  return opts.knownOk && unknown.length === 0 ? 0 : 1;
}

if (process.argv.includes("--child")) {
  await serve();
} else {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(2);
    },
  );
}
