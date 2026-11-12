#!/usr/bin/env node
// Release gate: the TradingView-conformance evidence is produced OUTSIDE this repository (the
// resin-harness compares resin with TradingView's own exports), so nothing in the suite can notice
// when it goes stale. This script makes it a hard dependency of a release: `release-evidence.json`
// must exist, must certify exactly this tree, and must show full conformance with TradingView.
// Schema, byte layout of the hash and the release order are documented in docs/EVIDENCE.md.
//
//   node scripts/verify-evidence.mjs                      verify ./release-evidence.json (exit 1 on any problem)
//   node scripts/verify-evidence.mjs --previous prev.json also fail if a scenario that matched in prev.json does not now
//   node scripts/verify-evidence.mjs --evidence f.json    verify another file than <repo>/release-evidence.json
//   node scripts/verify-evidence.mjs --print-hash         print the content hash of the current tree
//   node scripts/verify-evidence.mjs --init               print a template (valid JSON, fails verification until filled in)
//   node scripts/verify-evidence.mjs --self-test          check this script's own logic
//
// Zero dependencies; reads files and runs `git ls-files`, writes nothing, needs no network.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The evidence file itself. Left out of the hash, so committing it does not change what it certifies. */
export const EVIDENCE_FILE = 'release-evidence.json';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// --- the content hash -----------------------------------------------------------------------

/** Tracked files of the repository at `root` (what `git ls-files` lists; untracked files do not count). */
export function listTrackedFiles(root = ROOT) {
  // -z: without it git quotes and escapes non-ASCII paths.
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/**
 * sha256 over the tracked files, working-tree content, in plain code-unit order of the path (not
 * localeCompare), excluding the root-level EVIDENCE_FILE. The hashed byte string is, for each file
 * in that order:
 *     <path as UTF-8> 0x00 <lowercase hex sha256 of the file's bytes> 0x0A
 * Tracked-but-deleted files and directories (submodule entries) are skipped.
 */
export function computeContentHash(root = ROOT, paths = listTrackedFiles(root)) {
  const entries = [...new Set(paths)].filter((p) => p !== EVIDENCE_FILE).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  let count = 0;
  for (const p of entries) {
    const abs = join(root, p);
    let content;
    try {
      if (statSync(abs).isDirectory()) continue;
      content = readFileSync(abs);
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    h.update(Buffer.concat([Buffer.from(p, 'utf-8'), Buffer.from([0]), Buffer.from(sha256(content), 'ascii'), Buffer.from([10])]));
    count++;
  }
  return { hash: h.digest('hex'), files: count };
}

/** Tracked files whose working-tree state differs from HEAD (the hash certifies the working tree, not HEAD). */
function dirtyTrackedFiles(root = ROOT) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf-8' })
      .split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// --- validation -----------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

function checkRatio(problems, name, v, fields) {
  const [matchedKey, totalKey] = fields;
  if (!isObj(v)) { problems.push(`${name}: missing or not an object`); return; }
  if (!isCount(v[matchedKey]) || !isCount(v[totalKey])) { problems.push(`${name}: ${matchedKey} and ${totalKey} must be non-negative integers`); return; }
  if (v[totalKey] === 0) problems.push(`${name}: ${totalKey} is 0 — nothing was compared, so nothing is certified`);
  else if (v[matchedKey] > v[totalKey]) problems.push(`${name}: ${matchedKey} (${v[matchedKey]}) exceeds ${totalKey} (${v[totalKey]})`);
}

/**
 * Everything wrong with an evidence document. `currentHash` is the hash of the tree being released;
 * `previous` is the previous release's evidence (optional, enables the regression check);
 * `now` is injectable for tests. Returns an array of problem strings; empty means the gate is open.
 */
export function validateEvidence(ev, { currentHash, previous, now = Date.now() } = {}) {
  const problems = [];
  if (!isObj(ev)) return ['the evidence is not a JSON object'];

  if (typeof ev.resinContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(ev.resinContentHash)) {
    problems.push('resinContentHash: must be a 64-character lowercase hex sha256');
  } else if (currentHash !== undefined && ev.resinContentHash !== currentHash) {
    problems.push(
      `resinContentHash does not match this tree: the evidence certifies ${ev.resinContentHash.slice(0, 12)}…, ` +
      `the tree is ${currentHash.slice(0, 12)}… — resin changed after the harness ran (re-run the harness on this exact tree)`,
    );
  }

  if (!isObj(ev.harness) || typeof ev.harness.repo !== 'string' || !ev.harness.repo.trim()) problems.push('harness.repo: must be a non-empty string');
  if (!isObj(ev.harness) || typeof ev.harness.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(ev.harness.commit)) problems.push('harness.commit: must be a git commit id (7-64 hex digits)');

  if (typeof ev.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(ev.generatedAt) || Number.isNaN(Date.parse(ev.generatedAt))) {
    problems.push('generatedAt: must be an ISO 8601 timestamp');
  } else if (Date.parse(ev.generatedAt) > now + 24 * 3600 * 1000) {
    problems.push(`generatedAt ${ev.generatedAt} is in the future`);
  }

  // Full conformance with TradingView's own exports: no tolerance here.
  for (const name of ['tvStrategy', 'tvIndicator']) {
    const before = problems.length;
    checkRatio(problems, name, ev[name], ['matched', 'total']);
    if (problems.length === before && ev[name].matched < ev[name].total) {
      problems.push(`${name}: ${ev[name].matched}/${ev[name].total} match TradingView — a release needs ${ev[name].total}/${ev[name].total}`);
    }
  }

  // The generated scenarios compared with the reference engine have known, documented divergences
  // (CHANGELOG "Known issues"), so only sanity is required here; regressions are caught per scenario.
  checkRatio(problems, 'fuzz', ev.fuzz, ['matched', 'scenarios']);
  if (isObj(ev.fuzz) && !(typeof ev.fuzz.seed === 'number' || (typeof ev.fuzz.seed === 'string' && ev.fuzz.seed))) {
    problems.push('fuzz.seed: must be a number or a non-empty string');
  }

  if (!isObj(ev.scenarios) || !Object.keys(ev.scenarios).length) {
    problems.push('scenarios: must be a non-empty object of scenario id -> "match" | "diverge"');
  } else {
    for (const [id, v] of Object.entries(ev.scenarios)) {
      if (v !== 'match' && v !== 'diverge') problems.push(`scenarios["${id}"]: must be "match" or "diverge", got ${JSON.stringify(v)}`);
    }
  }

  if (previous !== undefined) {
    const prevProblems = [];
    if (!isObj(previous) || !isObj(previous.scenarios)) prevProblems.push('--previous: not an evidence document (no scenarios object)');
    else {
      for (const id of Object.keys(previous.scenarios).sort()) {
        if (previous.scenarios[id] !== 'match') continue;
        const now = isObj(ev.scenarios) ? ev.scenarios[id] : undefined;
        if (now === undefined) prevProblems.push(`regression: scenario "${id}" matched in the previous release and is absent now`);
        else if (now !== 'match') prevProblems.push(`regression: scenario "${id}" matched in the previous release and now ${JSON.stringify(now)}`);
      }
      const pf = previous.fuzz;
      if (isObj(pf) && isObj(ev.fuzz) && pf.seed === ev.fuzz.seed && pf.scenarios === ev.fuzz.scenarios
        && isCount(pf.matched) && isCount(ev.fuzz.matched) && ev.fuzz.matched < pf.matched) {
        prevProblems.push(`regression: fuzz seed ${ev.fuzz.seed} matched ${pf.matched}/${pf.scenarios} in the previous release and ${ev.fuzz.matched} now`);
      }
    }
    problems.push(...prevProblems);
  }
  return problems;
}

/** One-line description of a valid document, for the success message. */
export function summarize(ev) {
  const n = Object.keys(ev.scenarios).length;
  const matching = Object.values(ev.scenarios).filter((v) => v === 'match').length;
  return [
    `tvStrategy ${ev.tvStrategy.matched}/${ev.tvStrategy.total}`,
    `tvIndicator ${ev.tvIndicator.matched}/${ev.tvIndicator.total}`,
    `fuzz ${ev.fuzz.matched}/${ev.fuzz.scenarios} (seed ${ev.fuzz.seed})`,
    `${matching}/${n} recorded scenarios match`,
    `harness ${ev.harness.repo}@${String(ev.harness.commit).slice(0, 10)}`,
    `generated ${ev.generatedAt}`,
  ].join(', ');
}

export function template(hash, now = new Date()) {
  return {
    resinContentHash: hash,
    harness: { repo: '', commit: '' },
    generatedAt: now.toISOString(),
    tvStrategy: { matched: 0, total: 0 },
    tvIndicator: { matched: 0, total: 0 },
    fuzz: { seed: 0, scenarios: 0, matched: 0 },
    scenarios: {},
  };
}

// --- self-test ------------------------------------------------------------------------------

function selfTest() {
  let failed = 0;
  const t = (name, cond, detail = '') => {
    if (cond) console.log(`  ok   ${name}`);
    else { failed++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
  };
  const throwsNothing = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  // A document shaped like the 0.3.0 release's own numbers: it must pass, or the gate rejects the
  // very release it exists to bless.
  const HASH = 'a'.repeat(64);
  const good = () => ({
    resinContentHash: HASH,
    harness: { repo: 'nullarch/resin-harness', commit: '0123abc' },
    generatedAt: '2026-09-28T00:00:00Z',
    tvStrategy: { matched: 19, total: 19 },
    tvIndicator: { matched: 72, total: 72 },
    fuzz: { seed: 1234, scenarios: 5000, matched: 4937 },
    scenarios: { 'tv/strategy/a': 'match', 'tv/indicator/b': 'match', 'fuzz/1': 'match', 'fuzz/2': 'diverge' },
  });
  const opts = { currentHash: HASH, now: Date.parse('2026-10-30T00:00:00Z') };
  const has = (problems, re) => problems.some((p) => re.test(p));
  const edit = (fn) => { const d = good(); fn(d); return d; };

  console.log('validateEvidence');
  t('0.3.0-shaped evidence (known fuzz divergences) passes', validateEvidence(good(), opts).length === 0, validateEvidence(good(), opts).join('; '));
  t('hash mismatch fails', has(validateEvidence(good(), { ...opts, currentHash: 'b'.repeat(64) }), /does not match this tree/));
  t('malformed hash fails', has(validateEvidence(edit((d) => { d.resinContentHash = 'xyz'; }), opts), /resinContentHash/));
  t('tvStrategy total 0 fails', has(validateEvidence(edit((d) => { d.tvStrategy = { matched: 0, total: 0 }; }), opts), /tvStrategy.*total is 0/));
  t('tvIndicator total 0 fails', has(validateEvidence(edit((d) => { d.tvIndicator = { matched: 0, total: 0 }; }), opts), /tvIndicator.*total is 0/));
  t('tvStrategy matched < total fails', has(validateEvidence(edit((d) => { d.tvStrategy.matched = 18; }), opts), /18\/19 match TradingView/));
  t('tvIndicator matched < total fails', has(validateEvidence(edit((d) => { d.tvIndicator.matched = 71; }), opts), /71\/72/));
  t('matched > total fails', has(validateEvidence(edit((d) => { d.tvIndicator.matched = 73; }), opts), /exceeds/));
  t('non-integer counts fail', has(validateEvidence(edit((d) => { d.tvStrategy.total = '19'; }), opts), /non-negative integers/));
  t('fuzz scenarios 0 fails', has(validateEvidence(edit((d) => { d.fuzz = { seed: 1, scenarios: 0, matched: 0 }; }), opts), /fuzz.*scenarios is 0/));
  t('fuzz matched > scenarios fails', has(validateEvidence(edit((d) => { d.fuzz.matched = 5001; }), opts), /fuzz.*exceeds/));
  t('fuzz matched < scenarios is allowed', validateEvidence(edit((d) => { d.fuzz.matched = 100; }), opts).length === 0);
  t('missing fuzz fails', has(validateEvidence(edit((d) => { delete d.fuzz; }), opts), /fuzz/));
  t('empty scenarios map fails', has(validateEvidence(edit((d) => { d.scenarios = {}; }), opts), /scenarios: must be a non-empty/));
  t('a scenario status other than match/diverge fails', has(validateEvidence(edit((d) => { d.scenarios.x = 'ok'; }), opts), /"match" or "diverge"/));
  t('bad harness commit fails', has(validateEvidence(edit((d) => { d.harness.commit = 'main'; }), opts), /harness.commit/));
  t('empty harness repo fails', has(validateEvidence(edit((d) => { d.harness.repo = ' '; }), opts), /harness.repo/));
  t('bad generatedAt fails', has(validateEvidence(edit((d) => { d.generatedAt = 'yesterday'; }), opts), /generatedAt/));
  t('future generatedAt fails', has(validateEvidence(edit((d) => { d.generatedAt = '2027-01-01T00:00:00Z'; }), opts), /future/));
  t('a non-object fails', validateEvidence([], opts).length === 1);
  t('the template fails until filled in', validateEvidence(template(HASH), opts).length >= 4);

  console.log('--previous');
  const prev = good();
  t('same scenarios: no regression', validateEvidence(good(), { ...opts, previous: prev }).length === 0);
  t('match -> diverge is a regression', has(validateEvidence(edit((d) => { d.scenarios['fuzz/1'] = 'diverge'; }), { ...opts, previous: prev }), /regression: scenario "fuzz\/1" matched.*"diverge"/));
  t('match -> absent is a regression', has(validateEvidence(edit((d) => { delete d.scenarios['fuzz/1']; }), { ...opts, previous: prev }), /absent now/));
  t('diverge -> match is progress, a new scenario is fine',
    validateEvidence(edit((d) => { d.scenarios['fuzz/2'] = 'match'; d.scenarios['new'] = 'diverge'; }), { ...opts, previous: prev }).length === 0);
  t('fuzz.matched dropping on the same seed is a regression', has(validateEvidence(edit((d) => { d.fuzz.matched = 4936; }), { ...opts, previous: prev }), /regression: fuzz seed 1234/));
  t('fuzz.matched on another seed is not compared', validateEvidence(edit((d) => { d.fuzz = { seed: 7, scenarios: 5000, matched: 10 }; }), { ...opts, previous: prev }).length === 0);
  t('a previous file without scenarios fails', has(validateEvidence(good(), { ...opts, previous: {} }), /--previous/));

  console.log('computeContentHash (temporary git repository)');
  const dir = mkdtempSync(join(tmpdir(), 'resin-evidence-selftest-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    const put = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
    put('a.txt', 'A\n');
    put('B.txt', 'upper-case sorts before lower-case in code-unit order');
    put('sub/c.txt', 'C');
    put('é.txt', 'non-ascii path');
    git('add', '-A');
    const base = computeContentHash(dir);

    // The byte layout, written out independently of computeContentHash.
    const expected = createHash('sha256');
    for (const p of ['B.txt', 'a.txt', 'sub/c.txt', 'é.txt']) {
      expected.update(`${p}\0${sha256(readFileSync(join(dir, p)))}\n`);
    }
    t('byte layout: sha256 of "path NUL sha256(content) LF", code-unit order, git ls-files -z', base.hash === expected.digest('hex') && base.files === 4, `${base.files} files`);
    t('known answer (pins the layout the harness relies on)', base.hash === KNOWN_ANSWER, base.hash);
    t('independent of the order the paths are given in', computeContentHash(dir, ['sub/c.txt', 'é.txt', 'a.txt', 'B.txt']).hash === base.hash);

    put(EVIDENCE_FILE, '{"anything":1}'); git('add', EVIDENCE_FILE);
    const withEvidence = computeContentHash(dir).hash;
    put(EVIDENCE_FILE, '{"something":"else entirely"}');
    t('release-evidence.json is excluded: adding or changing it keeps the hash', withEvidence === base.hash && computeContentHash(dir).hash === base.hash);
    put('sub/release-evidence.json', '{}'); git('add', 'sub/release-evidence.json');
    t('only the root-level evidence file is excluded', computeContentHash(dir).hash !== base.hash);
    git('rm', '-q', '--cached', 'sub/release-evidence.json'); unlinkSync(join(dir, 'sub/release-evidence.json'));

    put('untracked.txt', 'never added');
    t('an untracked file does not change the hash', computeContentHash(dir).hash === base.hash);
    put('a.txt', 'A!\n');
    t('editing a tracked file changes the hash (working tree, committed or not)', computeContentHash(dir).hash !== base.hash);
    put('a.txt', 'A\n');
    t('restoring it restores the hash', computeContentHash(dir).hash === base.hash);
    put('new.txt', 'x'); git('add', 'new.txt');
    t('a newly tracked file changes the hash', computeContentHash(dir).hash !== base.hash);
    unlinkSync(join(dir, 'new.txt'));
    t('a tracked-but-deleted file is skipped, not an error', throwsNothing(() => computeContentHash(dir)) === null && computeContentHash(dir).hash === base.hash);
  } catch (e) {
    failed++;
    console.error(`  FAIL temporary git repository: ${e?.message ?? e} (git is required for the self-test)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? `\nself-test: ${failed} FAILED` : '\nself-test: all passed');
  return failed === 0;
}

// sha256 of the layout over {B.txt, a.txt, sub/c.txt, é.txt} as built in selfTest(); see docs/EVIDENCE.md.
const KNOWN_ANSWER = '260c72798833cb75ef8890c1874261401d1f2b7d6d19a76b8209afc041a1533b';

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

// --- CLI ------------------------------------------------------------------------------------

function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes(`--${n}`);

  if (has('self-test')) process.exit(selfTest() ? 0 : 1);

  const { hash, files } = computeContentHash(ROOT);
  const dirty = dirtyTrackedFiles(ROOT);
  const warnDirty = () => {
    if (dirty.length) console.error(`note: ${dirty.length} tracked file(s) differ from HEAD; the hash covers the working tree, so commit before running the harness`);
  };

  if (has('print-hash')) { warnDirty(); console.log(hash); return; }
  if (has('init')) { warnDirty(); console.log(JSON.stringify(template(hash), null, 2)); return; }

  const file = resolve(flag('evidence') ?? join(ROOT, EVIDENCE_FILE));
  const die = (msg) => { console.error(`verify-evidence: FAILED\n  - ${msg}`); process.exit(1); };
  if (!existsSync(file)) {
    die(`${file} does not exist. A release needs the harness's evidence for this exact tree (hash ${hash.slice(0, 12)}…).\n` +
      '    Run the resin-harness on this tree, commit release-evidence.json, then tag. See docs/EVIDENCE.md.');
  }
  const readJson = (f, what) => {
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch (e) { return die(`${what} ${f} is not valid JSON: ${e.message}`); }
  };
  const ev = readJson(file, 'evidence');
  const prevFile = flag('previous');
  const previous = prevFile ? readJson(resolve(prevFile), 'previous evidence') : undefined;

  const problems = validateEvidence(ev, { currentHash: hash, previous });
  if (problems.length) {
    console.error(`verify-evidence: FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  warnDirty();
  console.log(`verify-evidence: OK — certifies tree ${hash.slice(0, 12)}… (${files} files)${previous ? ', no regression against the previous release' : ''}`);
  console.log(`  ${summarize(ev)}`);
}

if (isEntryPoint()) {
  main(process.argv.slice(2));
}
