#!/usr/bin/env node
//
// Resin CLI.
//
//   resin build <file.pine> [-o out.js]     compile to a JavaScript module
//   resin run   <file.pine> [--data f.json] execute it and print the plots
//   resin check <file|dir>                  compile-check, report what failed
//
// The commands are deliberately thin. Everything they do is available from the
// library surface in src/index.ts, and this file is also what
// tests/unit/public_api_surface.test.ts scans to confirm that surface has a
// real consumer rather than a documented one.

import { register } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// src/ is TypeScript with extensionless relative imports (tsconfig "Bundler"
// resolution). The hook lets plain `node` resolve them without a build step,
// so the CLI runs straight from a clone.
register('../scripts/ts-esm-loader-hook.mjs', import.meta.url);

const { transpile } = await import('../src/transpiler/pipeline.ts');
const { compile, run } = await import('../src/runtime/engine.ts');
const { Context } = await import('../src/runtime/context.ts');
const { PineRuntimeHaltError } = await import('../src/runtime/log.ts');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1]) return rest[i + 1];
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};
const positional = rest.filter((a, i) =>
  !a.startsWith('-') && !(rest[i - 1]?.startsWith('--') && !rest[i - 1].includes('=')));

const USAGE = `resin — run TradingView Pine Script outside TradingView

  resin build <file.pine> [-o out.js]      compile to a JavaScript module
  resin run   <file.pine> [--data f.json]  execute and print the plot output
                          [--bars N]       synthesize N bars instead (default 100)
                          [--viz out.json] also dump the visualization data (viz S5)
  resin check <file|dir>                   compile-check; report what failed

  --chart-tf <tf>   chart timeframe the script should compile against ("D", "60", …)
`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function compileOrDie(file) {
  const src = readFileSync(file, 'utf-8');
  const result = transpile(src, { chartTf: flag('chart-tf', 'D') });
  if (!result.ok) {
    fail(`${basename(file)}: ${result.errors.join('\n  ')}`);
  }
  return result;
}

/** A deterministic random walk, so `run` works with no data file to hand. */
function syntheticBars(n) {
  const d = { open: [], high: [], low: [], close: [], volume: [], time: [] };
  let price = 100;
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = price;
    price *= 1 + (next() - 0.5) * 0.04;
    const c = price;
    d.open.push(o);
    d.close.push(c);
    d.high.push(Math.max(o, c) * (1 + next() * 0.01));
    d.low.push(Math.min(o, c) * (1 - next() * 0.01));
    d.volume.push(Math.round(1000 + next() * 9000));
    d.time.push(start + i * 86400000);
  }
  return d;
}

function loadBars(path, bars) {
  if (!path) return syntheticBars(bars);
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const n = raw.close.length;
  return {
    open: raw.open, high: raw.high, low: raw.low,
    close: raw.close, volume: raw.volume ?? new Array(n).fill(0),
    // time is optional in the oracle fixtures; synthesize daily stamps so
    // calendar-aware builtins still have something coherent to read.
    time: raw.time ?? Array.from({ length: n }, (_, i) => Date.UTC(2020, 0, 1) + i * 86400000),
  };
}

function execute(result, data) {
  const ctx = new Context(
    data, result.varSlots.length, result.taSlotCount, result.fnVarSlotCount,
    result.historySlotCount, result.taScratchSize, {},
    result.plotTitles.length, result.securityTfs, result.refHistorySlotCount,
    result.condCallHistorySlotCount, result.condCallRefHistorySlotCount,
  );
  const barFn = compile(result.code)(ctx);
  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    barFn();
  }
  return ctx;
}

function pineFilesUnder(target) {
  if (statSync(target).isFile()) return [target];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (extname(entry.name) === '.pine') out.push(p);
    }
  };
  walk(target);
  return out.sort();
}

switch (cmd) {
  case 'build': {
    const file = positional[0] ?? fail(USAGE);
    const result = compileOrDie(file);
    const oIdx = rest.indexOf('-o');
    const out = flag('o') ?? (oIdx >= 0 ? rest[oIdx + 1] : null);
    if (out && out !== '-o') {
      writeFileSync(out, result.code);
      console.error(`wrote ${out} (${result.code.length} bytes)`);
    } else {
      process.stdout.write(result.code);
    }
    break;
  }

  case 'run': {
    const file = positional[0] ?? fail(USAGE);
    const result = compileOrDie(file);
    const data = loadBars(flag('data'), +flag('bars', '100'));
    let ctx;
    try {
      ctx = execute(result, data);
    } catch (e) {
      if (e instanceof PineRuntimeHaltError) {
        fail(`script halted itself: ${e.message}`);
      }
      throw e;
    }
    const plots = result.plotTitles.map((title, i) => ({
      title, values: ctx.plots[i].toArray(),
    }));
    if (!plots.length) {
      console.error('script produced no plots');
    }
    // Last bar only — the whole series is what the library is for.
    for (const p of plots) {
      const v = p.values[p.values.length - 1];
      console.log(`${p.title.padEnd(24)} ${Number.isFinite(v) ? v : 'na'}`);
    }
    if (result.isStrategy) {
      const s = ctx.strategy;
      console.log(`${'closed trades'.padEnd(24)} ${s.closedTrades}`);
      console.log(`${'net profit'.padEnd(24)} ${s.realizedPnl.toFixed(2)}`);
    }
    const vizOut = flag('viz');
    if (vizOut) {
      // viz S5 — 오브젝트 폼 run()으로 한 번 더 실행해 viz를 뽑는다. 엔진은 결정론적이라
      // 위 스트리밍 실행과 결과가 동일하고, CLI 용도에서 이중 실행 비용은 무시 가능하다.
      // JSON.stringify가 NaN을 null로 낮추므로 na 값은 JSON에서 null로 나간다.
      const { viz } = run(result, data);
      writeFileSync(vizOut, JSON.stringify(viz, null, 1));
      console.error(`wrote ${vizOut}`);
    }
    break;
  }

  case 'check': {
    const target = positional[0] ?? fail(USAGE);
    const files = pineFilesUnder(target);
    const failures = [];
    for (const f of files) {
      let r;
      try {
        r = transpile(readFileSync(f, 'utf-8'), { chartTf: flag('chart-tf', 'D') });
      } catch (e) {
        failures.push([f, `crashed: ${e?.message ?? e}`]);
        continue;
      }
      if (!r.ok) failures.push([f, r.errors[0] ?? 'unknown']);
    }
    const ok = files.length - failures.length;
    for (const [f, why] of failures.slice(0, 40)) {
      console.log(`FAIL ${basename(f)}  ${why}`);
    }
    if (failures.length > 40) console.log(`… and ${failures.length - 40} more`);
    console.log(`\n${ok}/${files.length} compiled` +
      (files.length ? ` (${((ok / files.length) * 100).toFixed(1)}%)` : ''));
    process.exit(failures.length ? 1 : 0);
  }

  default:
    console.error(USAGE);
    process.exit(cmd ? 1 : 0);
}
