#!/usr/bin/env node
// Re-measure resin on a corpus of Pine scripts you have. The README's real-world figures (how many
// of a body of public scripts transpile, how many then run) came from a corpus that is not in this
// repository; this is the tool to produce the same kind of numbers on yours, and to prove that two
// runs looked at the same files.
//
//   node scripts/corpus-manifest.mjs build <dir> -o manifest.json [--force]
//       Walk <dir> for *.pine and record id (path relative to <dir>, so the file name for a flat
//       directory), sha256 and byte size of each. Refuses to overwrite an existing file without --force.
//
//   node scripts/corpus-manifest.mjs check <dir> [--manifest manifest.json] [options]
//       1. with --manifest: verify <dir> against it (missing / extra / changed files). Any difference
//          stops the run (exit 1): numbers measured on different files are not comparable. Without
//          --manifest this step is skipped and the run measures whatever <dir> holds.
//       2. transpile every script, then run each one that transpiled on seeded synthetic bars, in a
//          pool of worker threads with a hard per-script timeout (a worker that exceeds it is
//          terminated, which also stops a synchronous infinite loop).
//       3. print the transpile rate, the run rate, and a histogram of the first error message of every
//          script that failed, per stage.
//
//   options for check:
//     --bars N          synthetic bars per script (default 300)
//     --seed S          seed of the bar generator (default 1234, the repo's tests/helpers/synthetic.ts default)
//     --tf T            chart timeframe the scripts compile against and the bars are spaced by
//                       ("60" = hourly, the default and the README's method; "D", "W", or minutes)
//     --timeout-ms N    per-script limit for transpile + run (default 20000)
//     --jobs N          worker threads (default: cores - 1, at most 8)
//     --limit N         only the first N scripts in id order
//     --top N           histogram rows per stage (default 25)
//     --out results.json  also write one record per script
//     --min-transpile P / --min-run P   exit 1 when a rate (percent of ALL scripts) is below P
//     --ignore-manifest-mismatch        go on measuring although the directory differs from the manifest
//
// A run rate counts a script as failed when it throws, when it halts itself with runtime.error()
// (PineRuntimeHaltError, as the README counts them), when a resin limit stops it, or when it times out.
// This measures that scripts get through, not that their values are right. Note that 300 bars on this
// repository's corpus/scripts will not reproduce the README's 99.7% / 99.5%: that was 1,500 bars on a
// different corpus.
//
// Zero dependencies. Loads resin from ../src through the repo's own loader hook, as bin/resin.mjs does.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const SELF = fileURLToPath(import.meta.url);
const MANIFEST_FORMAT = 'resin-corpus-manifest/1';
const RECYCLE_AFTER = 1000; // scripts per worker before it is replaced, to bound memory growth

// --- shared helpers -------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function pineFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
      else if (e.name.endsWith('.pine')) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function buildManifest(dir) {
  const files = {};
  let totalBytes = 0;
  for (const id of pineFilesUnder(dir)) {
    const buf = readFileSync(join(dir, id));
    files[id] = { sha256: sha256(buf), bytes: buf.length };
    totalBytes += buf.length;
  }
  return { format: MANIFEST_FORMAT, count: Object.keys(files).length, totalBytes, files };
}

/** Differences between a directory and a manifest: { missing, extra, changed } (arrays of ids). */
export function diffAgainstManifest(dir, manifest) {
  const actual = buildManifest(dir).files;
  const want = manifest.files;
  const missing = Object.keys(want).filter((id) => !(id in actual));
  const extra = Object.keys(actual).filter((id) => !(id in want));
  const changed = Object.keys(want).filter((id) => id in actual && (actual[id].sha256 !== want[id].sha256 || actual[id].bytes !== want[id].bytes));
  return { missing, extra, changed };
}

// mulberry32 and the random walk are the ones in tests/helpers/synthetic.ts, so a script sees the
// same bars here as in the repo's own corpus tests (for the same seed and bar count).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Milliseconds per bar of a chart timeframe string ("60", "15", "D", "W"), or null if not understood. */
export function tfToMs(tf) {
  if (/^\d+$/.test(tf)) return Number(tf) * 60_000;
  const m = /^(\d*)([DWM])$/.exec(tf);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  return n * { D: 86_400_000, W: 7 * 86_400_000, M: 30 * 86_400_000 }[m[2]];
}

export function makeBars(count, seed, barMs) {
  const rand = mulberry32(seed);
  const d = { open: [], high: [], low: [], close: [], volume: [], time: [] };
  const start = Date.UTC(2020, 0, 1);
  let prevClose = 100;
  for (let i = 0; i < count; i++) {
    const o = prevClose;
    const c = o * (1 + (rand() - 0.5) * 0.02);
    d.open.push(o);
    d.high.push(Math.max(o, c) * (1 + rand() * 0.005));
    d.low.push(Math.min(o, c) * (1 - rand() * 0.005));
    d.close.push(c);
    d.volume.push(1000 + Math.floor(rand() * 9000));
    d.time.push(start + i * barMs);
    prevClose = c;
  }
  return d;
}

/**
 * A message reduced to its shape so thousands of scripts fall into a few buckets: first line only,
 * quoted strings and numbers blanked. `details` are the quoted strings that were blanked.
 */
export function normalizeMessage(msg) {
  const first = String(msg ?? '').split('\n')[0].trim();
  const details = [];
  let s = first.replace(/'([^']*)'|"([^"]*)"|`([^`]*)`/g, (q, a, b, c) => { details.push(a ?? b ?? c); return `${q[0]}…${q[q.length - 1]}`; });
  s = s.replace(/\d+(?:\.\d+)?/g, 'N').replace(/\s+/g, ' ');
  if (s.length > 140) s = `${s.slice(0, 137)}...`;
  return { shape: s || '(empty message)', detail: details.join(' | ') };
}

// --- worker side ----------------------------------------------------------------------------

async function workerMain() {
  // src/ is TypeScript with extensionless imports; the hook lets plain node load it (see bin/resin.mjs).
  register('./ts-esm-loader-hook.mjs', import.meta.url);
  const { transpile, run, PineRuntimeHaltError, ResinLimitError } = await import('../src/index.ts');
  const { bars, seed, tf } = workerData;
  const barMs = tfToMs(tf);
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', ({ idx, path }) => {
    const rec = { type: 'result', idx, transpiled: false, ran: false, stage: 'transpile', error: null, ms: 0 };
    const t0 = performance.now();
    try {
      const src = readFileSync(path, 'utf-8');
      let result;
      try {
        result = transpile(src, { chartTf: tf });
      } catch (e) {
        rec.error = `crashed: ${e?.message ?? e}`;
        return;
      }
      if (!result.ok) { rec.error = result.errors?.[0] ?? 'unknown'; return; }
      rec.transpiled = true;
      rec.stage = 'run';
      parentPort.postMessage({ type: 'stage', idx, stage: 'run' });
      try {
        run(result, makeBars(bars, seed, barMs));
        rec.ran = true;
        rec.stage = null;
      } catch (e) {
        const kind = e instanceof PineRuntimeHaltError ? 'halt: ' : e instanceof ResinLimitError ? 'limit: ' : '';
        rec.error = `${kind}${e?.message ?? e}`;
      }
    } catch (e) {
      rec.error = `worker: ${e?.message ?? e}`;
    } finally {
      rec.ms = performance.now() - t0;
      parentPort.postMessage(rec);
    }
  });
}

// --- main thread: the pool ------------------------------------------------------------------

function runPool({ dir, ids, jobs, timeoutMs, bars, seed, tf, onProgress }) {
  const results = new Array(ids.length);
  return new Promise((resolveAll, rejectAll) => {
    let next = 0;
    let finished = 0;
    let startupFailures = 0;
    const slots = [];

    const settle = (slot, rec) => {
      clearTimeout(slot.timer);
      const job = slot.job;
      slot.job = null;
      results[job.idx] = { id: ids[job.idx], transpiled: !!rec.transpiled, ran: !!rec.ran, stage: rec.stage ?? null, error: rec.error ?? null, ms: Math.round(rec.ms ?? performance.now() - job.started) };
      finished++;
      onProgress?.(finished, ids.length);
      if (finished === ids.length) { for (const s of slots) retire(s); resolveAll(results); }
    };

    const retire = (slot) => {
      slot.worker.retired = true;
      clearTimeout(slot.timer);
      slot.worker.terminate().catch(() => {});
    };

    const spawn = (slot) => {
      const worker = new Worker(SELF, { workerData: { bars, seed, tf }, resourceLimits: { maxOldGenerationSizeMb: 2048 }, stdout: false, stderr: false });
      worker.retired = false;
      slot.worker = worker;
      slot.jobsDone = 0;
      slot.ready = false;
      const fatal = (why) => {
        if (worker.retired) return;
        worker.retired = true;
        clearTimeout(slot.timer);
        worker.terminate().catch(() => {});
        if (slot.job) settle(slot, { transpiled: slot.job.stage === 'run', stage: slot.job.stage, error: why });
        else if (!slot.ready && ++startupFailures >= 3) return rejectAll(new Error(`workers cannot start: ${why}`));
        if (finished < ids.length) spawn(slot);
      };
      worker.on('message', (m) => {
        if (worker.retired) return;
        if (m.type === 'ready') { slot.ready = true; startupFailures = 0; dispatch(slot); }
        else if (m.type === 'stage') { if (slot.job) slot.job.stage = m.stage; }
        else if (m.type === 'result') {
          settle(slot, m);
          if (++slot.jobsDone >= RECYCLE_AFTER) { retire(slot); spawn(slot); } else dispatch(slot);
        }
      });
      worker.on('error', (e) => fatal(`worker crashed: ${e?.message ?? e}`));
      worker.on('exit', (code) => fatal(`worker exited with code ${code}`));
    };

    const dispatch = (slot) => {
      if (next >= ids.length) return;
      const idx = next++;
      slot.job = { idx, stage: 'transpile', started: performance.now() };
      slot.worker.postMessage({ idx, path: join(dir, ids[idx]) });
      slot.timer = setTimeout(() => {
        const job = slot.job;
        if (!job) return;
        slot.worker.retired = true;
        slot.worker.terminate().catch(() => {});
        settle(slot, { transpiled: job.stage === 'run', stage: job.stage, error: `timeout after ${timeoutMs} ms`, ms: timeoutMs });
        if (finished < ids.length) spawn(slot);
      }, timeoutMs);
    };

    if (!ids.length) return resolveAll(results);
    for (let i = 0; i < Math.min(jobs, ids.length); i++) { const slot = { job: null, timer: null }; slots.push(slot); spawn(slot); }
  });
}

// --- reporting ------------------------------------------------------------------------------

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a');

export function histogram(records, stage) {
  const buckets = new Map();
  for (const r of records) {
    if (r.stage !== stage || !r.error) continue;
    const { shape, detail } = normalizeMessage(r.error);
    let b = buckets.get(shape);
    if (!b) buckets.set(shape, (b = { shape, count: 0, example: r.id, details: new Map() }));
    b.count++;
    if (detail) b.details.set(detail, (b.details.get(detail) ?? 0) + 1);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count || (a.shape < b.shape ? -1 : 1));
}

function printHistogram(title, rows, top) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('  (none)'); return; }
  for (const b of rows.slice(0, top)) {
    console.log(`  ${String(b.count).padStart(5)}  ${b.shape}    e.g. ${b.example}`);
    const details = [...b.details.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
    if (details.length > 1 || (details.length === 1 && b.count > 1)) {
      console.log(`         ${details.map(([d, n]) => `${d} x${n}`).join('   ')}`);
    }
  }
  if (rows.length > top) console.log(`  … ${rows.length - top} more distinct messages (${rows.slice(top).reduce((s, b) => s + b.count, 0)} scripts)`);
}

// --- commands -------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  const boolean = new Set(['force', 'ignore-manifest-mismatch', 'self-test']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opts.o = argv[++i];
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v !== undefined ? v : boolean.has(k) ? true : argv[++i];
    } else pos.push(a);
  }
  return { opts, pos };
}

const usage = () => {
  console.error('usage:\n  corpus-manifest.mjs build <dir> -o manifest.json [--force]\n  corpus-manifest.mjs check <dir> [--manifest m.json] [--bars 300] [--seed 1234] [--tf 60] [--timeout-ms 20000]\n' +
    '                       [--jobs N] [--limit N] [--top 25] [--out results.json] [--min-transpile P] [--min-run P] [--ignore-manifest-mismatch]\n  corpus-manifest.mjs --self-test');
  process.exit(2);
};

function cmdBuild(dir, opts) {
  if (!dir || !opts.o) usage();
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`not a directory: ${dir}`); process.exit(2); }
  if (existsSync(opts.o) && !opts.force) { console.error(`refusing to overwrite ${opts.o} (pass --force to replace it)`); process.exit(2); }
  const manifest = buildManifest(dir);
  if (!manifest.count) { console.error(`no .pine files under ${dir}`); process.exit(2); }
  writeFileSync(opts.o, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`wrote ${opts.o}: ${manifest.count} scripts, ${manifest.totalBytes} bytes`);
}

async function cmdCheck(dir, opts) {
  if (!dir) usage();
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`not a directory: ${dir}`); process.exit(2); }
  const num = (name, dflt) => { const v = opts[name] === undefined ? dflt : Number(opts[name]); if (!Number.isFinite(v) || v <= 0) { console.error(`--${name} must be a positive number`); process.exit(2); } return v; };
  const bars = Math.floor(num('bars', 300));
  const seed = Math.floor(num('seed', 1234));
  const timeoutMs = num('timeout-ms', 20_000);
  const top = Math.floor(num('top', 25));
  const jobs = Math.floor(num('jobs', Math.max(1, Math.min(8, availableParallelism() - 1))));
  const tf = String(opts.tf ?? '60');
  if (tfToMs(tf) === null) { console.error(`--tf ${tf}: expected minutes ("60"), or D, W, M (optionally with a count, e.g. 2D)`); process.exit(2); }

  const root = resolve(dir);
  let ids = pineFilesUnder(root);
  console.log(`corpus: ${root} (${ids.length} .pine files)`);

  let manifestState = 'skipped (no --manifest: the run measures whatever the directory holds)';
  if (opts.manifest) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(opts.manifest, 'utf-8')); } catch (e) { console.error(`cannot read manifest ${opts.manifest}: ${e.message}`); process.exit(2); }
    if (manifest?.format !== MANIFEST_FORMAT || typeof manifest.files !== 'object') { console.error(`${opts.manifest} is not a ${MANIFEST_FORMAT} document`); process.exit(2); }
    const d = diffAgainstManifest(root, manifest);
    const bad = d.missing.length + d.extra.length + d.changed.length;
    if (bad) {
      console.error(`corpus differs from ${opts.manifest}: ${d.missing.length} missing, ${d.extra.length} extra, ${d.changed.length} changed`);
      for (const [label, list] of [['missing', d.missing], ['extra', d.extra], ['changed', d.changed]]) {
        for (const id of list.slice(0, 10)) console.error(`  ${label}: ${id}`);
        if (list.length > 10) console.error(`  … and ${list.length - 10} more ${label}`);
      }
      if (!opts['ignore-manifest-mismatch']) { console.error('stopping: numbers measured on different files are not comparable (--ignore-manifest-mismatch to measure anyway)'); process.exit(1); }
      manifestState = `MISMATCH ignored (${d.missing.length} missing, ${d.extra.length} extra, ${d.changed.length} changed)`;
    } else manifestState = `ok (${Object.keys(manifest.files).length} files, sha256 and size verified)`;
  }
  console.log(`manifest: ${manifestState}`);

  if (opts.limit) ids = ids.slice(0, Math.floor(num('limit', ids.length)));
  if (!ids.length) { console.error('nothing to measure'); process.exit(2); }
  console.log(`settings: ${bars} bars, seed ${seed}, tf ${tf}, timeout ${timeoutMs} ms, ${jobs} worker(s), ${ids.length} script(s)`);

  const t0 = performance.now();
  let lastTick = 0;
  const results = await runPool({
    dir: root, ids, jobs, timeoutMs, bars, seed, tf,
    onProgress: (done, total) => {
      if (process.stderr.isTTY && performance.now() - lastTick > 500) { lastTick = performance.now(); process.stderr.write(`\r  ${done}/${total}`); }
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r              \r');
  const elapsed = (performance.now() - t0) / 1000;

  const n = results.length;
  const transpiled = results.filter((r) => r.transpiled).length;
  const ran = results.filter((r) => r.ran).length;
  const timeouts = results.filter((r) => /^timeout after/.test(r.error ?? '')).length;
  console.log(`\ntranspile  ${transpiled}/${n}  ${pct(transpiled, n)}`);
  console.log(`run        ${ran}/${n}  ${pct(ran, n)} of all scripts  (${ran}/${transpiled} = ${pct(ran, transpiled)} of those that transpiled)`);
  console.log(`timeouts   ${timeouts}`);
  console.log(`elapsed    ${elapsed.toFixed(1)} s (${(n / elapsed).toFixed(0)} scripts/s)`);
  printHistogram('first error of scripts that did not transpile', histogram(results, 'transpile'), top);
  printHistogram('first error of scripts that transpiled but did not run', histogram(results, 'run'), top);

  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify({ corpus: root, bars, seed, tf, timeoutMs, transpiled, ran, total: n, results }, null, 1)}\n`);
    console.log(`\nwrote ${opts.out}`);
  }

  let exit = 0;
  for (const [name, got] of [['min-transpile', transpiled], ['min-run', ran]]) {
    if (opts[name] === undefined) continue;
    const want = Number(opts[name]);
    const rate = (got / n) * 100;
    if (rate < want) { console.error(`\nFAILED: ${name.slice(4)} rate ${rate.toFixed(2)}% is below --${name} ${want}`); exit = 1; }
  }
  process.exit(exit);
}

// --- self-test ------------------------------------------------------------------------------

function selfTest() {
  let failed = 0;
  const t = (name, cond, detail = '') => { if (cond) console.log(`  ok   ${name}`); else { failed++; console.error(`  FAIL ${name} ${detail}`); } };
  t('normalizeMessage blanks numbers and quoted names but keeps the shape',
    normalizeMessage("Undefined function 'ta.foo' at line 12\n  at stack").shape === "Undefined function '…' at line N"
    && normalizeMessage("Undefined function 'ta.foo' at line 12").detail === 'ta.foo');
  t('normalizeMessage handles empty input', normalizeMessage('').shape === '(empty message)');
  const a = makeBars(50, 7, 3_600_000);
  const b = makeBars(50, 7, 3_600_000);
  t('bars are deterministic for a seed', JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== JSON.stringify(makeBars(50, 8, 3_600_000)));
  t('bars are sane OHLC', a.close.every((c, i) => a.high[i] >= Math.max(a.open[i], c) && a.low[i] <= Math.min(a.open[i], c) && a.volume[i] > 0));
  t('hourly bars are spaced 3600000 ms apart', a.time[1] - a.time[0] === 3_600_000);
  t('tfToMs', tfToMs('60') === 3_600_000 && tfToMs('D') === 86_400_000 && tfToMs('2D') === 172_800_000 && tfToMs('x') === null);
  const dir = mkdtempSync(join(tmpdir(), 'resin-corpus-selftest-'));
  try {
    const put = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
    put('a.pine', 'plot(close)'); put('sub/b.pine', 'plot(open)'); put('readme.txt', 'not a script');
    const m = buildManifest(dir);
    t('build lists *.pine only, relative ids', JSON.stringify(Object.keys(m.files)) === JSON.stringify(['a.pine', 'sub/b.pine']) && m.count === 2);
    t('an unchanged directory has no differences', JSON.stringify(diffAgainstManifest(dir, m)) === JSON.stringify({ missing: [], extra: [], changed: [] }));
    put('a.pine', 'plot(close, "x")'); put('c.pine', 'x'); rmSync(join(dir, 'sub/b.pine'));
    const d = diffAgainstManifest(dir, m);
    t('changed, extra and missing files are found', JSON.stringify(d) === JSON.stringify({ missing: ['sub/b.pine'], extra: ['c.pine'], changed: ['a.pine'] }), JSON.stringify(d));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\nself-test: ${failed} FAILED` : '\nself-test: all passed');
  process.exit(failed ? 1 : 0);
}

/**
 * True when this file is the script node was started with. Node resolves the entry module to its
 * real path but leaves process.argv[1] as typed, so comparing them raw is false behind any symlink
 * (macOS /tmp, a symlinked checkout) and the script would exit 0 having done nothing. Compare real paths.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

// --- entry ----------------------------------------------------------------------------------

if (!isMainThread) {
  await workerMain();
} else if (isEntryPoint()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, pos } = parseArgs(cmd === '--self-test' ? [] : rest);
  if (cmd === '--self-test') selfTest();
  else if (cmd === 'build') cmdBuild(pos[0], opts);
  else if (cmd === 'check') await cmdCheck(pos[0], opts);
  else usage();
}
