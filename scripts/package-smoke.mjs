#!/usr/bin/env node
// Package smoke test: pack the repo exactly as `npm publish` would, install the tarball into a
// fresh project and use it the way a consumer does. The suite runs against a clone; this runs
// against what ships. The regression it exists for: "the CLI worked from a clone and died after
// npm install" (Node refuses to strip types under node_modules; scripts/ts-esm-loader-hook.mjs is
// what makes the installed package work).
//
//   node scripts/package-smoke.mjs [--workdir DIR] [--keep] [--list] [--install SPEC]
//
//   --workdir DIR   create the temp directory inside DIR (default: os.tmpdir())
//   --keep          leave the temp directory in place and print its path
//   --list          print the packed file list (to regenerate scripts/package-files.allow) and exit
//   --install SPEC  AFTER a manual publish: run everything below against what the registry serves
//                   (`--install @nullarch/resin@0.3.0`, or `@latest`) instead of the local tarball.
//                   The one step that needs the network; the installed files must also be
//                   byte-identical to the local pack of this checkout, so "published" provably means
//                   "this commit", and a `latest` that is behind the repo fails loudly.
//
// What it asserts, in order:
//   1. the tarball's file list matches scripts/package-files.allow (every packed file is allowed,
//      every allowed entry is still packed), nothing from FORBIDDEN ships, and the files that
//      package.json's bin/exports point at are in the tarball;
//   2. packed size <= MAX_PACKED_BYTES and unpacked size <= MAX_UNPACKED_BYTES;
//   3. `npm install <tgz>` into a fresh `npm init -y` project works offline, and the installed
//      tree is exactly the packed file list;
//   4. the CLI from node_modules/.bin: `run` (output identical to the clone's and to the block the
//      README prints), `build -o`, `check` (pass and fail exit codes);
//   5. the library: importing the package WITHOUT the register hook fails with
//      ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING (the failure the hook header and README
//      "node --import @nullarch/resin/register" exist for), WITH the hook it works and VERSION
//      equals package.json's, and src/ internals are not importable through the exports map.
//
// Offline by default, zero dependencies, publishes nothing: `npm pack` and `npm install <local tgz>`
// only (`--install SPEC` is a read-only registry install).
// Exit 0 when every assertion held, 1 otherwise (one line per failed assertion).

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Budgets. 0.3.0 packs to 978,523 bytes (59 files) and unpacks to 3,225,853. The caps leave ~50%
// headroom: crossing one means something big started shipping (or the source more than doubled)
// and should be a decision, not an accident.
export const MAX_PACKED_BYTES = 1_500_000;
export const MAX_UNPACKED_BYTES = 5_000_000;

// Things that must never be in the tarball, whatever the allowlist says. A second line of defence
// against someone widening the allowlist with a careless pattern.
export const FORBIDDEN = [
  /^tests?\//, /^corpus\//, /^oracle\//, /^coverage\//, /(^|\/)node_modules\//,
  /^\.git(hub)?(\/|$)/, /(^|\/)\.env/, /\.tgz$/, /^docs\//, /^examples\//,
  /\.test\.[cm]?[jt]sx?$/, /\.map$/, /^release-evidence\.json$/,
];

// --- allowlist ------------------------------------------------------------------------------

/** One entry per line; `#` starts a comment. `*` matches within a path segment, `**` across segments. */
export function parseAllowlist(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Compare a packed file list with the allowlist; returns the problems found (empty = fine). */
export function compareFileList(packed, allow) {
  const problems = [];
  const patterns = allow.map((entry) => ({ entry, re: globToRegExp(entry), hits: 0 }));
  for (const path of packed) {
    const hit = patterns.filter((p) => p.re.test(path));
    for (const p of hit) p.hits++;
    if (!hit.length) problems.push(`packed but not in scripts/package-files.allow: ${path}`);
    const bad = FORBIDDEN.find((f) => f.test(path));
    if (bad) problems.push(`forbidden path in the tarball (${bad}): ${path}`);
  }
  for (const p of patterns) {
    if (!p.hits) problems.push(`allowlist entry matches nothing in the tarball (stale, or a file stopped shipping): ${p.entry}`);
  }
  return problems;
}

// --- plumbing -------------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const failures = [];
const timings = [];
const fail = (msg) => { failures.push(msg); console.error(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);
const check = (cond, okMsg, failMsg) => { if (cond) ok(okMsg); else fail(failMsg ?? okMsg); return !!cond; };

async function phase(name, fn) {
  const t0 = performance.now();
  console.log(`\n[${name}]`);
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - t0);
    timings.push([name, ms]);
    console.log(`  (${ms} ms)`);
  }
}

/** Env for child processes: nothing the surrounding `npm run` / CI set may steer the nested npm. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', ...extra };
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? (r.signal ? 128 : 1), out: r.stdout ?? '', err: r.stderr ?? '', error: r.error };
}

const listFilesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
};

/** The `name  value` lines `resin run` prints, as [name, value] pairs. */
const plotLines = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => {
  const m = /^(\S.*?)\s{2,}(\S+)$/.exec(l);
  return m ? [m[1], m[2]] : [l, ''];
});

/** The ```text block that follows the README's quick-start `run` command: what it says `run` prints. */
export function readmeRunOutput(readme) {
  const start = readme.indexOf('## Quick start');
  if (start < 0) return null;
  const from = readme.indexOf('bin/resin.mjs run', start);
  if (from < 0) return null;
  const m = /```text\n([\s\S]*?)```/.exec(readme.slice(from));
  return m ? m[1].trimEnd() : null;
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

// --- main -----------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const keep = args.includes('--keep');
  // --list: stdout carries only the file list, so it can be redirected into the allowlist.
  if (args.includes('--list')) console.log = (...a) => console.error(...a);
  const base = flag('workdir') ?? tmpdir();
  mkdirSync(base, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const work = mkdtempSync(join(base, 'resin-package-smoke-'));
  const env = cleanEnv({ npm_config_cache: join(work, 'npm-cache') });
  const t0 = performance.now();
  console.log(`package-smoke: ${pkg.name}@${pkg.version}  node ${process.version}  npm ${sh('npm', ['--version'], { env }).out.trim()}`);
  console.log(`work dir: ${work}`);

  try {
    // 1 + 2 ------------------------------------------------------------------------------------
    const packDir = join(work, 'pack');
    mkdirSync(packDir);
    const info = await phase('pack', () => {
      // --pack-destination: without it the tarball lands in the repo and dirties the tree.
      const r = sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: ROOT, env });
      if (r.code !== 0) { console.error(r.err); throw new Error(`npm pack failed (exit ${r.code})`); }
      let parsed;
      try { parsed = JSON.parse(r.out)[0]; } catch { console.error(r.out); throw new Error('npm pack --json printed something that is not JSON'); }
      return parsed;
    });
    const packed = info.files.map((f) => f.path).sort();
    if (args.includes('--list')) { process.stdout.write(packed.join('\n') + '\n'); return; }

    await phase('tarball contents', () => {
      console.log(`  ${info.filename}: ${packed.length} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked`);
      const allowFile = join(ROOT, 'scripts', 'package-files.allow');
      if (!existsSync(allowFile)) { fail('scripts/package-files.allow is missing'); return; }
      const problems = compareFileList(packed, parseAllowlist(readFileSync(allowFile, 'utf-8')));
      check(problems.length === 0, `file list matches scripts/package-files.allow (${packed.length} files)`);
      for (const p of problems) fail(p);
      check(info.size <= MAX_PACKED_BYTES, `packed size ${info.size} <= budget ${MAX_PACKED_BYTES}`,
        `packed size ${info.size} exceeds the ${MAX_PACKED_BYTES}-byte budget (MAX_PACKED_BYTES in scripts/package-smoke.mjs)`);
      check(info.unpackedSize <= MAX_UNPACKED_BYTES, `unpacked size ${info.unpackedSize} <= budget ${MAX_UNPACKED_BYTES}`,
        `unpacked size ${info.unpackedSize} exceeds the ${MAX_UNPACKED_BYTES}-byte budget (MAX_UNPACKED_BYTES in scripts/package-smoke.mjs)`);
      check(info.version === pkg.version, `tarball version ${info.version} = package.json`, `tarball version ${info.version} != package.json ${pkg.version}`);

      // Everything package.json points at must be in the tarball.
      const targets = [];
      for (const [k, v] of Object.entries(pkg.bin ?? {})) targets.push([`bin.${k}`, v]);
      for (const [k, v] of Object.entries(pkg.exports ?? {})) if (typeof v === 'string') targets.push([`exports["${k}"]`, v]);
      for (const [what, target] of targets) {
        const p = target.replace(/^\.\//, '');
        check(packed.includes(p), `${what} -> ${p} ships`, `${what} points at ${p}, which is not in the tarball`);
      }
    });

    // 3 ----------------------------------------------------------------------------------------
    const proj = join(work, 'proj');
    mkdirSync(proj);
    const tgz = join(packDir, info.filename);
    const installSpec = flag('install');
    const pkgDirOf = (project) => join(project, 'node_modules', ...pkg.name.split('/'));
    await phase(installSpec ? `install ${installSpec} from the registry` : 'install into a fresh project', () => {
      let r = sh('npm', ['init', '-y'], { cwd: proj, env });
      if (r.code !== 0) { console.error(r.err); throw new Error('npm init -y failed'); }
      // The tarball, not the directory: a directory install symlinks the repo and would hide the
      // node_modules type-stripping failure this whole file is about.
      const common = ['--no-audit', '--no-fund', '--ignore-scripts'];
      r = installSpec
        ? sh('npm', ['install', installSpec, ...common], { cwd: proj, env })
        : sh('npm', ['install', tgz, '--offline', ...common], { cwd: proj, env });
      if (r.code !== 0) { console.error(r.out, r.err); throw new Error(`npm install ${installSpec ?? '<tgz> --offline'} failed (exit ${r.code})`); }
      ok(installSpec ? `npm install ${installSpec} succeeded` : 'npm install <tgz> --offline succeeded');
      const pkgDir = pkgDirOf(proj);
      const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
      check(installed.version === pkg.version, `installed package.json version ${installed.version} = repo ${pkg.version}`,
        `installed ${pkg.name} is ${installed.version}, but this checkout is ${pkg.version}${installSpec ? ' (is the registry behind the repo? was it published?)' : ''}`);
      const onDisk = listFilesUnder(pkgDir);
      const missing = packed.filter((f) => !onDisk.includes(f));
      const extra = onDisk.filter((f) => !packed.includes(f));
      check(!missing.length && !extra.length, `installed tree equals the packed list (${onDisk.length} files)`,
        `installed tree differs from the packed list: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
      if (installSpec) {
        // Published == this commit: every file byte-identical to a local install of this checkout's pack.
        const ref = join(work, 'proj-local');
        mkdirSync(ref);
        sh('npm', ['init', '-y'], { cwd: ref, env });
        const l = sh('npm', ['install', tgz, '--offline', ...common], { cwd: ref, env });
        if (l.code !== 0) throw new Error(`local reference install failed: ${l.err.trim()}`);
        const differ = onDisk.filter((f) => existsSync(join(pkgDirOf(ref), f))
          && sha256(readFileSync(join(pkgDir, f))) !== sha256(readFileSync(join(pkgDirOf(ref), f))));
        check(!differ.length, 'every published file is byte-identical to this checkout\'s pack',
          `published files differ from this checkout's pack: ${differ.slice(0, 10).join(', ')}${differ.length > 10 ? ` … (${differ.length})` : ''}`);
      }
    });

    const bin = join(proj, 'node_modules', '.bin', 'resin');
    const examples = join(proj, 'pine');
    mkdirSync(examples);
    // The real example, not a retyped copy: the README quick start runs this very file.
    copyFileSync(join(ROOT, 'examples', 'rsi-cross.pine'), join(examples, 'rsi-cross.pine'));
    const cli = (cmdArgs, o = {}) => sh(bin, cmdArgs, { cwd: proj, env, ...o });

    // 4 ----------------------------------------------------------------------------------------
    await phase('CLI from node_modules/.bin/resin', () => {
      if (!check(existsSync(bin), 'node_modules/.bin/resin exists', 'npm did not link node_modules/.bin/resin (package.json "bin")')) return;

      const run = cli(['run', 'pine/rsi-cross.pine', '--bars', '300']);
      check(run.code === 0, 'resin run pine/rsi-cross.pine --bars 300 exits 0', `resin run exited ${run.code}: ${run.err.trim().split('\n')[0] ?? ''}`);
      const clone = sh(process.execPath, [join(ROOT, 'bin', 'resin.mjs'), 'run', join(ROOT, 'examples', 'rsi-cross.pine'), '--bars', '300'], { cwd: ROOT, env });
      check(clone.code === 0 && run.out === clone.out, 'installed `run` output is byte-identical to the clone\'s',
        `installed run output differs from the clone's:\n--- installed\n${run.out}--- clone (exit ${clone.code})\n${clone.out}${clone.err}`);
      const readme = readmeRunOutput(readFileSync(join(ROOT, 'README.md'), 'utf-8'));
      if (readme === null) fail('README.md: could not find the ```text block after the quick-start `run` command');
      else {
        const want = JSON.stringify(plotLines(readme));
        const got = JSON.stringify(plotLines(run.out));
        check(want === got, 'installed `run` output equals the block the README prints',
          `README quick-start output is stale:\n--- README\n${readme}\n--- actual\n${run.out.trimEnd()}`);
      }

      const out = join(proj, 'out.js');
      const build = cli(['build', 'pine/rsi-cross.pine', '-o', 'out.js']);
      check(build.code === 0 && existsSync(out) && readFileSync(out, 'utf-8').includes('return function'),
        'resin build -o writes a compiled module', `resin build -o failed (exit ${build.code}): ${build.err.trim()}`);
      check(readFileSync(join(examples, 'rsi-cross.pine'), 'utf-8') === readFileSync(join(ROOT, 'examples', 'rsi-cross.pine'), 'utf-8'),
        'resin build left the source file alone');

      const good = cli(['check', 'pine']);
      check(good.code === 0 && /1\/1 compiled/.test(good.out), 'resin check pine -> 1/1 compiled, exit 0',
        `resin check pine: exit ${good.code}, stdout ${JSON.stringify(good.out.trim())}`);
      writeFileSync(join(examples, 'bad.pine'), '//@version=5\nindicator("bad")\nplot(close,\n');
      const bad = cli(['check', 'pine']);
      check(bad.code === 1 && /1\/2 compiled/.test(bad.out), 'resin check on a broken script -> FAIL line, exit 1',
        `resin check on a broken script: exit ${bad.code}, stdout ${JSON.stringify(bad.out.trim())}`);
      rmSync(join(examples, 'bad.pine'));

      // The CLI has no --version flag today (an unknown command prints the usage, exit 1). If one
      // is added, hold it to the package version.
      const ver = cli(['--version']);
      if (ver.code === 0 && ver.out.trim()) {
        check(ver.out.includes(pkg.version), `resin --version prints ${pkg.version}`, `resin --version printed ${JSON.stringify(ver.out.trim())}, expected ${pkg.version}`);
      } else {
        console.log(`  note CLI has no --version flag (exit ${ver.code}, prints the usage); version asserted via package.json and VERSION instead`);
      }
    });

    // 5 ----------------------------------------------------------------------------------------
    await phase('library import', () => {
      writeFileSync(join(proj, 'no-hook.mjs'), `import { VERSION } from '${pkg.name}';\nconsole.log(VERSION);\n`);
      const noHook = sh(process.execPath, ['no-hook.mjs'], { cwd: proj, env });
      const code = 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING';
      check(noHook.code !== 0 && noHook.err.includes(code),
        `import without the register hook fails with ${code}`,
        noHook.code === 0
          ? `import without the register hook SUCCEEDED (printed ${JSON.stringify(noHook.out.trim())}): README / hook header say it must fail with ${code}; Node ${process.version} behaves differently`
          : `import without the register hook failed, but not with ${code}; stderr: ${noHook.err.trim().split('\n').slice(0, 4).join(' | ')}`);
      if (noHook.code !== 0) console.log(`  note Node ${process.version} said: ${(noHook.err.match(/(?:Error|TypeError)[^\n]*/) ?? [''])[0]}`);

      writeFileSync(join(proj, 'with-hook.mjs'), [
        `import { VERSION, transpile, run } from '${pkg.name}';`,
        `const r = transpile('//@version=6\\nindicator("smoke")\\nplot(close * 2, "twice")\\n');`,
        `if (!r.ok) throw new Error(r.errors.join('; '));`,
        `const n = 5, up = (k) => Array.from({ length: n }, (_, i) => 100 + i + k);`,
        `const res = run(r, { open: up(0), high: up(1), low: up(-1), close: up(0.5), volume: up(0) });`,
        `console.log(JSON.stringify({ version: VERSION, plots: res.plots }));`,
      ].join('\n') + '\n');
      const hooked = sh(process.execPath, ['--import', `${pkg.name}/register`, 'with-hook.mjs'], { cwd: proj, env });
      if (!check(hooked.code === 0, 'import with `--import @nullarch/resin/register` works',
        `import with the register hook failed (exit ${hooked.code}): ${hooked.err.trim().split('\n').slice(0, 6).join(' | ')}`)) return;
      let got;
      try { got = JSON.parse(hooked.out.trim().split('\n').pop()); } catch { fail(`with-hook.mjs printed something that is not JSON: ${hooked.out.trim()}`); return; }
      check(got.version === pkg.version, `exported VERSION ${got.version} = package.json ${pkg.version}`, `exported VERSION ${got.version} != package.json ${pkg.version}`);
      const values = got.plots?.[0]?.values;
      check(Array.isArray(values) && values.length === 5 && values[4] === 2 * 104.5,
        'transpile() + run() through the installed package compute the right plot', `unexpected plot values: ${JSON.stringify(got.plots)}`);

      writeFileSync(join(proj, 'deep.mjs'), `await import('${pkg.name}/src/runtime/ta.ts');\n`);
      const deep = sh(process.execPath, ['--import', `${pkg.name}/register`, 'deep.mjs'], { cwd: proj, env });
      check(deep.code !== 0 && deep.err.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'),
        'src/ internals are not importable through the exports map (ERR_PACKAGE_PATH_NOT_EXPORTED)',
        `a deep import of src/runtime/ta.ts was not refused with ERR_PACKAGE_PATH_NOT_EXPORTED (exit ${deep.code}): ${deep.err.trim().split('\n')[0] ?? ''}`);
    });
  } catch (e) {
    fail(`aborted: ${e?.message ?? e}`);
  } finally {
    if (keep) console.log(`\nkept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }

  const total = Math.round(performance.now() - t0);
  console.log(`\ntimings: ${timings.map(([n, ms]) => `${n} ${ms}ms`).join(', ')}, total ${total}ms`);
  if (failures.length) {
    console.error(`\npackage-smoke: ${failures.length} assertion(s) FAILED`);
    for (const f of failures) console.error(`  - ${f.split('\n')[0]}`);
    process.exit(1);
  }
  console.log('\npackage-smoke: all assertions held');
}

// Importable for tests of the helpers; the run itself happens only as a script.
if (isEntryPoint()) {
  await main();
}
