#!/usr/bin/env node
// Mutation ratchet: does the test suite notice a one-line change in the code that decides numbers?
//
//   node scripts/mutate.mjs [--only id,id] [--list] [--jobs N] [--workdir DIR] [--timeout SECONDS]
//                           [--update-survivors] [--bail] [--keep] [--workers N] [--report FILE]
//                           [--mutants FILE] [--survivors FILE] [--no-ratchet] [--exclude GLOB]...
//
// mutation/mutants.json lists single-line behaviour changes ({ id, file, find, replace, why }). Each
// is applied to its own COPY of the working tree (this checkout is never written to) and the whole
// vitest suite runs against it: a non-zero exit is KILLED, a pass is SURVIVED. mutation/survivors.json
// is the ledger of known survivors; the run fails when a mutant survives that is not listed, when a
// listed survivor is now killed (remove it), or when the clean baseline does not pass, so the list
// can only shrink. See mutation/README.md.
//
// Node builtins only.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MUTANTS_DEFAULT = path.join(ROOT, "mutation", "mutants.json");
const SURVIVORS_DEFAULT = path.join(ROOT, "mutation", "survivors.json");
const NOT_EXPLAINED = "TODO: explain why the suite does not see this";

// Never copied into a run directory. node_modules is rebuilt as per-entry symlinks (a single
// directory symlink would let vite write its cache into the real node_modules).
const COPY_SKIP = new Set(["node_modules", ".git", "coverage"]);
// Dropped from the node_modules link farm: caches the test run writes.
const NODE_MODULES_SKIP = new Set([".vite", ".cache"]);

// ---------------------------------------------------------------------------------------------
// arguments

function usage(code) {
  const text = `usage: node scripts/mutate.mjs [options]
  --only id,id         run only these mutants (ratchet checks only the ids that ran)
  --list               verify every anchor against the source, print the mutants, exit
  --jobs N             mutants run in parallel (default 4)
  --workers N          vitest workers per run (default: floor(cpus / jobs), at least 2)
  --workdir DIR        where the temporary copies go (default: the OS temp directory)
  --timeout SECONDS    per-run limit; a mutant that hangs counts as KILLED by timeout (default 300)
  --bail               pass --bail 1 to vitest (faster, but the failing-file list is partial)
  --keep               keep the run directory (copies, vitest JSON) for inspection
  --report FILE        write the full per-mutant results as JSON
  --mutants FILE       mutant list (default mutation/mutants.json)
  --survivors FILE     survivor ledger (default mutation/survivors.json)
  --exclude GLOB       leave test files out of every run, baseline included (repeatable), e.g. tests that
                       are red on the clean tree; vitest --exclude semantics
  --no-ratchet         report only: skip the survivors.json comparison
  --update-survivors   rewrite mutation/survivors.json from this run (full runs only)`;
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    only: null, list: false, jobs: 4, workers: null, workdir: os.tmpdir(), timeout: 300,
    bail: false, keep: false, report: null, mutants: MUTANTS_DEFAULT, survivors: SURVIVORS_DEFAULT, ratchet: true, updateSurvivors: false, exclude: [],
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) { console.error(`${name} needs a value`); usage(2); }
    return argv[i + 1];
  };
  const posInt = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) { console.error(`${name} must be a positive integer, got ${v}`); usage(2); }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--only": opts.only = need(i, a).split(",").map((s) => s.trim()).filter(Boolean); i++; break;
      case "--list": opts.list = true; break;
      case "--jobs": opts.jobs = posInt(need(i, a), a); i++; break;
      case "--workers": opts.workers = posInt(need(i, a), a); i++; break;
      case "--workdir": opts.workdir = path.resolve(need(i, a)); i++; break;
      case "--timeout": opts.timeout = posInt(need(i, a), a); i++; break;
      case "--bail": opts.bail = true; break;
      case "--keep": opts.keep = true; break;
      case "--report": opts.report = path.resolve(need(i, a)); i++; break;
      case "--mutants": opts.mutants = path.resolve(need(i, a)); i++; break;
      case "--survivors": opts.survivors = path.resolve(need(i, a)); i++; break;
      case "--exclude": opts.exclude.push(need(i, a)); i++; break;
      case "--no-ratchet": opts.ratchet = false; break;
      case "--update-survivors": opts.updateSurvivors = true; break;
      case "-h": case "--help": usage(0); break;
      default: console.error(`unknown argument ${a}`); usage(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// helpers

const sha256 = (bufOrString) => createHash("sha256").update(bufOrString).digest("hex");
const readText = (p) => fs.readFileSync(p, "utf8");
const secs = (ms) => (ms / 1000).toFixed(1);

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

// A path is safe to delete only when it is strictly inside the run directory.
function guardedRm(runDir, target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(runDir + path.sep)) throw new Error(`refusing to delete ${resolved}: outside ${runDir}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

// Mutated text by slicing at a known index: String.replace would read `$&`, `$'` and `$$` in the
// replacement, and generated-code anchors are full of `$.`.
function applyAt(content, index, find, replace) {
  return content.slice(0, index) + replace + content.slice(index + find.length);
}

// The mutated file must still parse. Only a syntax error is detectable this way (types are erased,
// not checked), which is exactly the class of mutant the ratchet must not count as a kill.
function makeSyntaxChecker() {
  if (typeof module.stripTypeScriptTypes !== "function") return null;
  process.emitWarning = () => {}; // stripTypeScriptTypes is flagged experimental
  return (code) => {
    try { module.stripTypeScriptTypes(code, { mode: "strip" }); return null; } catch (e) { return String(e.message).split("\n")[0]; }
  };
}

// ---------------------------------------------------------------------------------------------
// mutant list: load and verify

function loadMutants(file) {
  let raw;
  try { raw = JSON.parse(readText(file)); } catch (e) { fail(2, `cannot read ${file}: ${e.message}`); }
  if (!Array.isArray(raw)) fail(2, `${file}: expected an array of mutants`);
  const seen = new Set();
  const errors = [];
  raw.forEach((m, i) => {
    const where = `mutant #${i}${m && typeof m.id === "string" ? ` (${m.id})` : ""}`;
    for (const key of ["id", "file", "find", "replace", "why"]) {
      if (typeof m?.[key] !== "string") errors.push(`${where}: "${key}" must be a string`);
    }
    if (typeof m?.id !== "string") return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) errors.push(`${where}: id must be lowercase letters, digits and dashes`);
    if (seen.has(m.id)) errors.push(`${where}: duplicate id`);
    seen.add(m.id);
    if (typeof m.find === "string" && m.find === "") errors.push(`${where}: "find" is empty`);
    if (m.find === m.replace) errors.push(`${where}: "replace" equals "find"`);
    if (typeof m.file === "string") {
      const abs = path.resolve(ROOT, m.file);
      if (path.isAbsolute(m.file) || !abs.startsWith(path.join(ROOT, "src") + path.sep)) {
        errors.push(`${where}: "file" must be a path inside src/`);
      }
    }
  });
  if (errors.length > 0) fail(2, `${file}:\n  ${errors.join("\n  ")}`);
  return raw;
}

// Checks every anchor against the tree under `rootDir` (read-only): the checkout for --list, the clean
// snapshot for a run. Returns the file texts and hashes seen.
function verifyAnchors(mutants, rootDir, checkSyntax) {
  const errors = [];
  const files = new Map(); // file -> { text, sha }
  for (const m of mutants) {
    if (!files.has(m.file)) {
      const abs = path.join(rootDir, m.file);
      if (!fs.existsSync(abs)) { errors.push(`${m.id}: ${m.file} does not exist`); continue; }
      const buf = fs.readFileSync(abs);
      files.set(m.file, { text: buf.toString("utf8"), sha: sha256(buf), parses: undefined });
    }
    const f = files.get(m.file);
    const first = f.text.indexOf(m.find);
    if (first < 0) { errors.push(`${m.id}: anchor not found in ${m.file}: ${JSON.stringify(m.find.slice(0, 80))}`); continue; }
    if (f.text.indexOf(m.find, first + 1) >= 0) {
      errors.push(`${m.id}: anchor occurs more than once in ${m.file} (lengthen it): ${JSON.stringify(m.find.slice(0, 80))}`);
      continue;
    }
    // The part of the file the mutant changes must be code. This source quotes code in comments, and
    // a unique match whose changed part sits in a comment would be a mutant that changes nothing.
    let pre = 0;
    while (pre < m.find.length && pre < m.replace.length && m.find[pre] === m.replace[pre]) pre++;
    let suf = 0;
    while (suf < m.find.length - pre && suf < m.replace.length - pre && m.find[m.find.length - 1 - suf] === m.replace[m.replace.length - 1 - suf]) suf++;
    const changedFrom = first + pre;
    const changedTo = first + m.find.length - suf;
    const lineStart = f.text.lastIndexOf("\n", changedFrom - 1) + 1;
    const changedLines = f.text.slice(lineStart, changedTo).split("\n");
    const isCommentLine = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);
    if (changedLines.some(isCommentLine) || changedLines[0].slice(0, changedFrom - lineStart).includes("//")) {
      errors.push(`${m.id}: the changed part of the anchor is in a comment in ${m.file}`);
      continue;
    }
    if (checkSyntax !== null) {
      if (f.parses === undefined) f.parses = checkSyntax(f.text) === null;
      if (f.parses) {
        const err = checkSyntax(applyAt(f.text, first, m.find, m.replace));
        if (err !== null) errors.push(`${m.id}: the mutated ${m.file} does not parse (${err})`);
      }
    }
  }
  return { files, errors };
}

function loadSurvivors(file, allIds) {
  if (!fs.existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readText(file)); } catch (e) { fail(2, `cannot read ${file}: ${e.message}`); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) fail(2, `${file}: expected an object { id: reason }`);
  const unknown = Object.keys(data).filter((id) => !allIds.has(id));
  if (unknown.length > 0) fail(2, `${file} lists ids that are not in the mutant list: ${unknown.join(", ")}`);
  for (const [id, reason] of Object.entries(data)) {
    if (typeof reason !== "string" || reason.trim() === "") fail(2, `${file}: "${id}" needs a one-line reason`);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// copies and vitest runs

function snapshotTree(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(ROOT)) {
    if (COPY_SKIP.has(entry)) continue;
    fs.cpSync(path.join(ROOT, entry), path.join(dest, entry), {
      recursive: true,
      errorOnExist: false,
      mode: fs.constants.COPYFILE_FICLONE, // a clone where the filesystem has them, a copy otherwise
    });
  }
}

function cloneWithModules(base, dest) {
  snapshotTreeFrom(base, dest);
  const nm = path.join(dest, "node_modules");
  fs.mkdirSync(nm);
  const realNm = path.join(ROOT, "node_modules");
  for (const entry of fs.readdirSync(realNm)) {
    if (NODE_MODULES_SKIP.has(entry)) continue;
    fs.symlinkSync(path.join(realNm, entry), path.join(nm, entry));
  }
}

function snapshotTreeFrom(base, dest) {
  fs.cpSync(base, dest, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
}

const activeChildren = new Set();
let interrupted = false;

function killGroup(child, signal = "SIGKILL") {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

// Runs the whole suite in `dir`. Resolves to the outcome; never rejects.
function runSuite(dir, tmpDir, opts, workers) {
  return new Promise((resolve) => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const jsonOut = path.join(tmpDir, "vitest.json");
    const args = [
      path.join(dir, "node_modules", "vitest", "vitest.mjs"), "run",
      "--reporter=json", `--outputFile=${jsonOut}`, `--maxWorkers=${workers}`,
    ];
    if (opts.bail) args.push("--bail=1");
    for (const glob of opts.exclude) args.push(`--exclude=${glob}`);
    // UPDATE_CORPUS_LEDGER=1 makes corpus_diff rewrite its ledger to match the mutated output, which
    // would turn every mutant it could have caught into a survivor.
    const env = { ...process.env, TMPDIR: tmpDir, NO_COLOR: "1" };
    delete env.UPDATE_CORPUS_LEDGER;
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let tail = "";
    const keepTail = (chunk) => { tail = (tail + chunk.toString("utf8")).slice(-4000); };
    child.stdout.on("data", keepTail);
    child.stderr.on("data", keepTail);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, opts.timeout * 1000);
    const done = (code, signal) => {
      clearTimeout(timer);
      killGroup(child); // reap any worker that outlived the runner
      activeChildren.delete(child);
      resolve({ code, signal, timedOut, ms: Date.now() - started, jsonOut, tail });
    };
    child.on("error", (e) => { tail += `\nspawn error: ${e.message}`; done(-1, null); });
    child.on("close", done);
  });
}

// Reads the JSON reporter's file into { failedFiles, loadFailures, totalFiles, ... }.
function readReport(jsonOut, dir) {
  let report;
  try { report = JSON.parse(readText(jsonOut)); } catch { return null; }
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const rel = (name) => path.relative(dir, name);
  const failed = results.filter((r) => r.status === "failed");
  // A file with a failure and not one assertion could not be loaded at all.
  const loadFailures = failed.filter((r) => !Array.isArray(r.assertionResults) || r.assertionResults.length === 0);
  return {
    totalFiles: results.length,
    failedFiles: failed.map((r) => rel(r.name)).sort(),
    loadFailures: loadFailures.map((r) => ({ file: rel(r.name), message: String(r.message ?? "") })),
    numFailedTests: report.numFailedTests ?? 0,
    numTotalTests: report.numTotalTests ?? 0,
    success: report.success === true,
  };
}

const PARSE_ERROR_RE = /SyntaxError|Transform failed|Failed to parse|Unexpected token|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/;

function classify(run, report) {
  if (run.timedOut) return { status: "KILLED", how: "timeout", files: [] };
  if (run.code === 0) {
    if (report === null || report.success) return { status: "SURVIVED", how: "", files: [] };
  }
  // A non-zero exit with no report is vitest itself dying (out of memory, a signal, a full disk), not
  // a test failing: it says nothing about the mutant.
  if (report === null) return { status: "INVALID", how: "vitest exited without a report", files: [], detail: run.tail.split("\n").filter(Boolean).slice(-1)[0] ?? "" };
  // The mutant broke module loading wholesale (or does not parse): that is a bad mutant, not a kill.
  const broke = report.loadFailures.filter((f) => PARSE_ERROR_RE.test(f.message));
  if (broke.length > 0 || (report.totalFiles > 0 && report.loadFailures.length * 2 >= report.totalFiles)) {
    return { status: "INVALID", how: `${report.loadFailures.length}/${report.totalFiles} test files failed to load`, files: report.failedFiles, detail: report.loadFailures[0]?.message.split("\n")[0] ?? "" };
  }
  if (report.failedFiles.length === 0) return { status: "KILLED", how: "unhandled-error", files: [] };
  return { status: "KILLED", how: "", files: report.failedFiles };
}

async function pool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async (_, lane) => {
    while (!interrupted) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], lane);
    }
  });
  await Promise.all(lanes);
}

// ---------------------------------------------------------------------------------------------
// main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = loadMutants(opts.mutants);
  const allIds = new Set(all.map((m) => m.id));
  const checkSyntax = makeSyntaxChecker();

  let selected = all;
  if (opts.only !== null) {
    const unknown = opts.only.filter((id) => !allIds.has(id));
    if (unknown.length > 0) fail(2, `--only: unknown mutant id(s): ${unknown.join(", ")}`);
    selected = all.filter((m) => opts.only.includes(m.id));
  }
  if (opts.updateSurvivors && opts.only !== null) fail(2, "--update-survivors needs a full run; it would erase the survivors of the mutants --only skipped");
  if (opts.updateSurvivors && opts.mutants !== MUTANTS_DEFAULT) fail(2, "--update-survivors only works with the default mutant list");

  const idWidth = Math.max(...all.map((m) => m.id.length));
  if (opts.list) {
    const { errors } = verifyAnchors(all, ROOT, checkSyntax);
    if (errors.length > 0) fail(2, `mutant verification failed:\n  ${errors.join("\n  ")}`);
    console.log(`${all.length} mutants, every anchor found exactly once in code${checkSyntax ? ", every mutated file parses" : ""}`);
    for (const m of selected) console.log(`${m.id.padEnd(idWidth)}  ${m.file}\n${" ".repeat(idWidth)}  ${m.why}`);
    return 0;
  }

  const survivorsListed = opts.ratchet || opts.updateSurvivors ? loadSurvivors(opts.survivors, allIds) : {};

  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const workers = opts.workers ?? Math.max(2, Math.floor(cpus / opts.jobs));
  fs.mkdirSync(opts.workdir, { recursive: true });
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(opts.workdir, "resin-mutate-")));
  if (runDir === ROOT || runDir.startsWith(ROOT + path.sep)) fail(2, `--workdir must be outside the checkout (${ROOT})`);

  // The run directory is deleted only if this process created it (the name check) and only here.
  const removeRunDir = () => {
    if (opts.keep) return;
    if (!path.basename(runDir).startsWith("resin-mutate-")) throw new Error(`refusing to delete ${runDir}`);
    fs.rmSync(runDir, { recursive: true, force: true });
  };
  const onSignal = (sig) => () => {
    interrupted = true;
    for (const child of activeChildren) killGroup(child);
    try { removeRunDir(); } catch { /* best effort */ }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));

  console.log(`mutation run: ${selected.length}/${all.length} mutants, ${opts.jobs} jobs x ${workers} vitest workers, timeout ${opts.timeout}s`);
  console.log(`run directory: ${runDir}${opts.keep ? " (kept)" : ""}`);
  if (opts.exclude.length > 0) console.log(`excluded test files: ${opts.exclude.join(", ")}`);

  const t0 = Date.now();
  const base = path.join(runDir, "base");
  snapshotTree(base);
  console.log(`snapshot of the working tree: ${secs(Date.now() - t0)}s`);

  // Every anchor must be found exactly once, in code, on the clean copy, and the mutated file must
  // still parse; a mutant that rots aborts the run before a single test runs.
  const { files: sourceFiles, errors: anchorErrors } = verifyAnchors(all, base, checkSyntax);
  if (anchorErrors.length > 0) {
    removeRunDir();
    fail(2, `mutant verification failed:\n  ${anchorErrors.join("\n  ")}`);
  }
  console.log(`${all.length} anchors verified (each found exactly once, in code${checkSyntax ? ", mutated file parses" : ""})`);

  // Each mutant gets its own clone of the snapshot, made just before its run and deleted after it.
  const copyIn = (name) => {
    const dest = path.join(runDir, "copies", name);
    cloneWithModules(base, dest);
    return dest;
  };
  const dropCopy = (dest) => { if (!opts.keep) guardedRm(runDir, dest); };

  // Baseline: the clean tree must pass, under the same concurrency the mutants run with (a suite
  // that only fails under load would otherwise show up as kills).
  const baselineLanes = Array.from({ length: Math.min(opts.jobs, Math.max(selected.length, 1)) }, (_, i) => i);
  const baselineResults = [];
  const tb = Date.now();
  await pool(baselineLanes, opts.jobs, async (lane) => {
    const dir = copyIn(`baseline-${lane}`);
    const run = await runSuite(dir, path.join(runDir, "tmp", `baseline-${lane}`), opts, workers);
    const report = readReport(run.jsonOut, dir);
    const ok = run.code === 0 && !run.timedOut && (report === null || report.success);
    baselineResults.push({ lane, ok, run, report });
    dropCopy(dir);
  });
  const baselineMs = Date.now() - tb;
  const badBaseline = baselineResults.filter((r) => !r.ok);
  if (badBaseline.length > 0) {
    for (const b of badBaseline) {
      console.error(`BASELINE FAILED (lane ${b.lane}, exit ${b.run.code}${b.run.timedOut ? ", timeout" : ""}): ${(b.report?.failedFiles ?? []).slice(0, 8).join(", ")}`);
      console.error(b.run.tail.split("\n").slice(-12).join("\n"));
    }
    removeRunDir();
    return 3;
  }
  console.log(`baseline: ${baselineResults.length} clean run(s) in parallel passed, ${secs(baselineMs)}s wall (${baselineResults.map((r) => secs(r.run.ms)).join("s, ")}s each)`);

  // Mutants.
  const results = new Map();
  const tm = Date.now();
  await pool(selected, opts.jobs, async (m) => {
    const dir = copyIn(`${m.id}`);
    const target = path.join(dir, m.file);
    const before = readText(target);
    const cloneSha = sha256(before);
    const index = before.indexOf(m.find);
    if (cloneSha !== sourceFiles.get(m.file).sha || index < 0 || before.indexOf(m.find, index + 1) >= 0) {
      results.set(m.id, { status: "INVALID", how: "the copy differs from the verified snapshot", files: [], ms: 0 });
      console.log(`${m.id.padEnd(idWidth)}  INVALID   the copy differs from the verified snapshot`);
      dropCopy(dir);
      return;
    }
    fs.writeFileSync(target, applyAt(before, index, m.find, m.replace));
    let run = await runSuite(dir, path.join(runDir, "tmp", `${m.id}`), opts, workers);
    let report = readReport(run.jsonOut, dir);
    let verdict = classify(run, report);
    if (verdict.status === "INVALID" && report === null && !run.timedOut) {
      // vitest died without a report: once more, in case the machine (not the mutant) was the cause
      run = await runSuite(dir, path.join(runDir, "tmp", `${m.id}-retry`), opts, workers);
      report = readReport(run.jsonOut, dir);
      verdict = classify(run, report);
    }
    const result = { ...verdict, ms: run.ms, tail: verdict.status === "INVALID" ? run.tail : undefined };
    results.set(m.id, result);
    const first = result.files[0] ?? (result.how ? `(${result.how})` : "-");
    const more = result.files.length > 1 ? ` (+${result.files.length - 1})` : "";
    const how = result.how && result.files.length > 0 ? ` [${result.how}]` : "";
    console.log(`${m.id.padEnd(idWidth)}  ${result.status.padEnd(8)}  ${first}${more}${how}  ${secs(run.ms)}s`);
    dropCopy(dir);
  });
  const mutantsMs = Date.now() - tm;

  // The checkout is never written to (every mutant lives in a copy). If a mutated file differs from
  // the snapshot now, something else edited it during the run: the results describe the snapshot.
  const moved = [];
  for (const [file, f] of sourceFiles) {
    if (sha256(fs.readFileSync(path.join(ROOT, file))) !== f.sha) moved.push(file);
  }

  removeRunDir();
  if (interrupted) return 130;

  // -----------------------------------------------------------------------------------------
  // summary
  const rows = selected.map((m) => ({ m, r: results.get(m.id) })).filter((x) => x.r !== undefined);
  const killed = rows.filter((x) => x.r.status === "KILLED");
  const survived = rows.filter((x) => x.r.status === "SURVIVED");
  const invalid = rows.filter((x) => x.r.status === "INVALID");
  const byTimeout = killed.filter((x) => x.r.how === "timeout");
  const decided = killed.length + survived.length;

  const killerCount = new Map();
  let onlyCorpusDiff = 0;
  for (const { r } of killed) {
    for (const f of r.files) killerCount.set(f, (killerCount.get(f) ?? 0) + 1);
    if (r.files.length > 0 && r.files.every((f) => /corpus/.test(f))) onlyCorpusDiff++;
  }

  console.log("");
  console.log(`mutants: ${rows.length}   killed: ${killed.length}   survived: ${survived.length}   invalid: ${invalid.length}`);
  console.log(`kill rate: ${decided === 0 ? "n/a" : `${((100 * killed.length) / decided).toFixed(1)}% (${killed.length}/${decided})`}`);
  console.log(`killed by timeout: ${byTimeout.length}   killed only by corpus tests (pine2py golden, weaker): ${onlyCorpusDiff}`);
  const top = [...killerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length > 0) console.log(`killers (test file: mutants it fails): ${top.map(([f, n]) => `${path.basename(f)} ${n}`).join(", ")}`);
  console.log(`wall time: baseline ${secs(baselineMs)}s, mutants ${secs(mutantsMs)}s (${opts.jobs} jobs)`);

  if (opts.report !== null) {
    fs.mkdirSync(path.dirname(opts.report), { recursive: true });
    const out = {
      mutants: rows.length, killed: killed.length, survived: survived.length, invalid: invalid.length,
      killRate: decided === 0 ? null : killed.length / decided,
      baselineSeconds: baselineMs / 1000, mutantSeconds: mutantsMs / 1000, jobs: opts.jobs, workers,
      results: Object.fromEntries(rows.map(({ m, r }) => [m.id, { status: r.status, how: r.how, files: r.files, seconds: r.ms / 1000, detail: r.detail, tail: r.tail }])),
    };
    fs.writeFileSync(opts.report, JSON.stringify(out, null, 1) + "\n");
  }

  if (moved.length > 0) {
    console.warn(`\nNOTE: ${moved.join(", ")} changed in the checkout while this run was going. This script writes to copies only, so another process edited it; the results above describe the snapshot taken at the start.`);
  }

  let exit = 0;
  for (const { m, r } of invalid) {
    console.error(`INVALID mutant ${m.id}: ${r.how}${r.detail ? ` (${r.detail})` : ""}; a mutant must change behaviour, not stop the suite loading`);
    exit = 1;
  }

  // -----------------------------------------------------------------------------------------
  // ratchet
  const keptReason = (id) => {
    // reasons survive an update; a missing or unreadable ledger just means no reasons yet
    try { return survivorsListed[id]; } catch { return undefined; }
  };
  if (opts.updateSurvivors) {
    if (invalid.length > 0) {
      console.error("not updating survivors.json: fix the INVALID mutants first");
      return 1;
    }
    const next = {};
    for (const { m } of survived) next[m.id] = keptReason(m.id) ?? NOT_EXPLAINED;
    fs.writeFileSync(opts.survivors, JSON.stringify(next, null, 2) + "\n");
    console.warn(`\nWARNING: rewrote ${path.relative(ROOT, opts.survivors)} with ${survived.length} survivor(s).`);
    console.warn("Growing the survivor list is a regression: justify every added or removed id in the commit message.");
    if (survived.some(({ m }) => (next[m.id] === NOT_EXPLAINED))) {
      console.warn(`Entries marked "${NOT_EXPLAINED}" need their reason written before this is committed.`);
    }
    return exit;
  }

  if (opts.ratchet) {
    const listed = new Set(Object.keys(survivorsListed));
    const unexpected = survived.filter(({ m }) => !listed.has(m.id));
    const stale = killed.filter(({ m }) => listed.has(m.id));
    if (unexpected.length > 0) {
      console.error(`\nRATCHET FAILED: ${unexpected.length} mutant(s) survived that are not in mutation/survivors.json:`);
      for (const { m } of unexpected) console.error(`  ${m.id}: ${m.why}`);
      console.error("Add a test that kills each one (preferred). Only if it is truly equivalent, say so in mutation/README.md and remove the mutant.");
      exit = 1;
    }
    if (stale.length > 0) {
      console.error(`\nRATCHET FAILED: ${stale.length} listed survivor(s) are now killed; remove them from mutation/survivors.json (the list only shrinks):`);
      for (const { m } of stale) console.error(`  ${m.id}`);
      exit = 1;
    }
    if (exit === 0) console.log(`\nratchet OK: ${survived.length} survivor(s), all listed${opts.only ? ` (checked for the ${rows.length} mutant(s) that ran)` : ""}`);
  }
  return exit;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(e); process.exit(2); },
);
