// C821 (ROADMAP 배치49 (4-a)) — 공개 API 표면 동결 가드.
//
// 이 파일이 지키는 3자 정합: src/index.ts(코드) <-> API.md(문서) <-> scripts/*.mjs(실제 소비자).
// 셋 중 하나만 바뀌면 레드가 난다. 특히 (c) 그룹은 scripts/의 import를 **매번 재스캔**하므로,
// 미래 사이클이 소비자에서 새 내부 심볼을 꺼내 쓰면 "공개면에 넣을지" 결정을 강제한다
// (MEMORY.md: 문서 서술을 읽고 믿지 말고 실행/실측으로 대조하라 — 여기서는 소스가 근거).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as api from "../../src/index";
import { Context } from "../../src/runtime/context";
import { compile, run } from "../../src/runtime/engine";
import { PineRuntimeHaltError } from "../../src/runtime/log";
import { rt } from "../../src/runtime/rt";
import { ParseError, parse } from "../../src/transpiler/parser";
import { transpile } from "../../src/transpiler/pipeline";
import type { AnalyzeOptions } from "../../src/transpiler/analyzer";
import type { BarSnapshot, PlotResult, RunResult } from "../../src/runtime/engine";
import type { OHLCVData } from "../../src/runtime/context";
import type { Series } from "../../src/runtime/series";
import type { StrategyState } from "../../src/runtime/strategy";
import type { TranspileErr, TranspileOk, TranspileResult } from "../../src/transpiler/pipeline";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_MD = readFileSync(join(REPO_ROOT, "API.md"), "utf-8");
const INDEX_TS = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf-8");

// C821 실측(node로 src/index.ts를 로드해 Object.keys)으로 확정한 동결 목록.
const FROZEN_VALUE_EXPORTS = [
  "Context",
  "ParseError",
  "PineRuntimeHaltError",
  "VERSION",
  "compile",
  "parse",
  "rt",
  "run",
  "transpile",
];

const FROZEN_TYPE_EXPORTS = [
  "AnalyzeOptions",
  "BarSnapshot",
  "OHLCVData",
  "PlotResult",
  "RunResult",
  "Series",
  "StrategyState",
  "TranspileErr",
  "TranspileOk",
  "TranspileResult",
];

// Pull the backticked names out of the first column of an API.md table
// (from the section heading to the next '## ').
function namesFromApiSection(headingPrefix: string): string[] {
  const lines = API_MD.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  expect(start, `API.md has no '${headingPrefix}' section`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) break;
    const m = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out.sort();
}

// Symbols the shipped consumer (bin/*.mjs) pulls out of src/ via
// `const { a, b } = await import("../src/x.ts")`.
function consumedFromScripts(): { symbol: string; module: string; file: string }[] {
  const dir = join(REPO_ROOT, "bin");
  const out: { symbol: string; module: string; file: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(dir, file), "utf-8");
    const re = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;
    for (const m of text.matchAll(re)) {
      const mod = m[2]!;
      if (!/(^|\/)\.\.\/src\//.test(mod) && !mod.includes("/src/")) continue;
      for (const raw of m[1]!.split(",")) {
        const symbol = raw.trim().split(/\s*:\s*/)[0]!.trim();
        if (symbol) out.push({ symbol, module: mod, file });
      }
    }
  }
  return out;
}

const SAMPLE_SOURCE = `//@version=5
indicator("api surface")
var float acc = na
acc := nz(acc) + close
plot(acc, "acc")
`;

const DATA: OHLCVData = {
  open: [1, 2, 3, 4],
  high: [2, 3, 4, 5],
  low: [0.5, 1.5, 2.5, 3.5],
  close: [1.5, 2.5, 3.5, 4.5],
  volume: [10, 20, 30, 40],
};

function transpileOk(source: string): TranspileOk {
  const r: TranspileResult = transpile(source);
  if (!r.ok) throw new Error(`transpile 실패: ${(r as TranspileErr).errors.join("; ")}`);
  return r;
}

describe("(a) the set of public value exports is frozen", () => {
  it("src/index.ts의 런타임 export 이름이 동결 목록과 정확히 일치한다", () => {
    expect(Object.keys(api).sort()).toEqual(FROZEN_VALUE_EXPORTS);
  });

  it("각 공개 값이 원 모듈의 그것과 동일 객체다(재구현/래핑 아님)", () => {
    expect(api.transpile).toBe(transpile);
    expect(api.parse).toBe(parse);
    expect(api.ParseError).toBe(ParseError);
    expect(api.compile).toBe(compile);
    expect(api.run).toBe(run);
    expect(api.Context).toBe(Context);
    expect(api.rt).toBe(rt);
    expect(api.PineRuntimeHaltError).toBe(PineRuntimeHaltError);
  });

  it("공개 값의 종류(typeof)가 API.md 표의 서술과 일치한다", () => {
    const kinds = Object.fromEntries(Object.keys(api).sort().map((k) => [k, typeof (api as Record<string, unknown>)[k]]));
    expect(kinds).toEqual({
      Context: "function",
      ParseError: "function",
      PineRuntimeHaltError: "function",
      VERSION: "string",
      compile: "function",
      parse: "function",
      rt: "object",
      run: "function",
      transpile: "function",
    });
  });

  it("타입 전용 export는 런타임 키에 새지 않는다", () => {
    for (const t of FROZEN_TYPE_EXPORTS) {
      expect(Object.keys(api), `${t}는 type-only여야 한다`).not.toContain(t);
    }
  });

  it("index.ts가 타입 export를 `export type`으로만 내보낸다(값 승격 금지)", () => {
    for (const t of FROZEN_TYPE_EXPORTS) {
      const valueExport = new RegExp(`^export \\{[^}]*\\b${t}\\b`, "m").test(INDEX_TS);
      expect(valueExport, `${t}가 값 export 절에 있음`).toBe(false);
      expect(new RegExp(`^export type \\{[^}]*\\b${t}\\b`, "m").test(INDEX_TS), `${t} type export 누락`).toBe(true);
    }
  });
});

describe("(b) API.md agrees with the code", () => {
  it("API.md 값 export 표의 이름 집합이 실제 런타임 export와 같다", () => {
    expect(namesFromApiSection("## Value exports")).toEqual(FROZEN_VALUE_EXPORTS);
  });

  it("API.md 타입 export 표의 이름 집합이 동결 타입 목록과 같다", () => {
    expect(namesFromApiSection("## Type exports")).toEqual(FROZEN_TYPE_EXPORTS);
  });

  it("API.md가 '내부 채널'로 못박은 Context 필드가 실제로 인스턴스에 존재한다", () => {
    const r = transpileOk(SAMPLE_SOURCE);
    const ctx = new Context(DATA, r.varSlots.length, r.taSlotCount, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles.length, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount);
    const internal = ["vars", "taSlots", "taScratch", "fnVars", "histSlots", "refHistSlots",
      "condCallHistSlots", "condCallRefHistSlots", "securityCache", "securityExprCache"];
    for (const f of internal) {
      expect(f in ctx, `API.md가 내부 채널로 적은 ${f}가 Context에 없음`).toBe(true);
    }
  });

  it("API.md가 '소비자용 채널'로 적은 것이 실제로 읽힌다", () => {
    const r = transpileOk(SAMPLE_SOURCE);
    const ctx = new Context(DATA, r.varSlots.length, r.taSlotCount, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles.length, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount);
    ctx.advance();
    expect(ctx.barCount).toBe(4);
    expect(ctx.idx).toBe(0);
    const close: Series = ctx.close;
    expect(close.get(0)).toBe(1.5);
    const st: StrategyState = ctx.strategy;
    expect(st.posSize).toBe(0);
    expect(Array.isArray(ctx.plots)).toBe(true);
    expect(ctx.inputs).toEqual({});
  });

  it("the arity API.md claims matches the real signatures", () => {
    expect(run.length).toBe(4); // 4 required; the other 9 have defaults, which Function.length ignores
    expect(Context.length).toBe(3); // 3 required, 9 defaulted
    expect(API_MD).toContain("`run()` takes 13 positional arguments and `Context` takes 12");
  });
});

describe("(c) the shipped consumer stays inside the public surface", () => {
  const consumed = consumedFromScripts();

  it("the scanner actually finds imports (an empty result must not pass)", () => {
    expect(consumed.length).toBeGreaterThanOrEqual(3);
    expect(consumed.map((c) => c.symbol)).toContain("transpile");
  });

  it("every symbol bin/ pulls from src/ is on the public surface", () => {
    // This is the direction worth guarding. The reverse — demanding that every
    // exported symbol have an in-repo caller — made sense while the surface was
    // being derived from internal callsites, but a published library's surface
    // is a contract with outside callers, so `run`, `parse` and `rt` are
    // exported for them and need no consumer here.
    const offenders = consumed.filter((c) => !FROZEN_VALUE_EXPORTS.includes(c.symbol));
    expect(offenders.map((o) => `${o.file}: ${o.symbol} <- ${o.module}`)).toEqual([]);
  });
});

describe("(d) both execution paths work through the public surface alone", () => {
  it("경로1: transpile -> run 이 바별 var 스냅샷과 plot을 낸다", () => {
    const r = transpileOk(SAMPLE_SOURCE);
    const res: RunResult = run(r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount,
      r.historySlotCount, r.taScratchSize, {}, r.plotTitles, r.securityTfs,
      r.refHistorySlotCount, r.condCallHistorySlotCount, r.condCallRefHistorySlotCount);
    expect(res.bars.length).toBe(4);
    const last: BarSnapshot = res.bars[3]!;
    expect(last["var:acc"]).toBeCloseTo(1.5 + 2.5 + 3.5 + 4.5, 12);
    const plot: PlotResult = res.plots[0]!;
    expect(plot.title).toBe("acc");
    expect(plot.values.length).toBe(4);
  });

  it("경로2: compile + Context 스트리밍이 경로1과 같은 값을 낸다", () => {
    const r = transpileOk(SAMPLE_SOURCE);
    const ctx = new Context(DATA, r.varSlots.length, r.taSlotCount, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles.length, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount);
    const barFn = compile(r.code)(ctx);
    const seen: number[] = [];
    for (let i = 0; i < ctx.barCount; i++) {
      ctx.advance();
      barFn();
      seen.push(ctx.vars[r.varSlots.indexOf("acc")] as number);
    }
    const res = run(r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount);
    expect(seen).toEqual(res.bars.map((b) => b["var:acc"]));
  });

  it("transpile()의 options(AnalyzeOptions)가 공개면 타입으로 그대로 전달된다", () => {
    const opts: AnalyzeOptions = { chartTf: "60" };
    const r = transpile(SAMPLE_SOURCE, opts);
    expect(r.ok).toBe(true);
  });
});

describe("C821 (e) 경계를 넘는 에러 타입 계약", () => {
  it("parse()는 ParseError를 던지고, transpile()은 그것을 TranspileErr로 바꾼다", () => {
    const bad = "//@version=5\nindicator(\n";
    expect(() => parse(bad)).toThrow(ParseError);
    const r = transpile(bad);
    expect(r.ok).toBe(false);
    expect((r as TranspileErr).errors.length).toBeGreaterThan(0);
  });

  it("runtime.error()는 PineRuntimeHaltError로 올라온다(스크립트 자기중단 판별)", () => {
    const r = transpileOk(`//@version=5
indicator("halt")
if bar_index == 2
    runtime.error("stop here")
`);
    expect(() =>
      run(r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount, r.historySlotCount,
        r.taScratchSize, {}, r.plotTitles, r.securityTfs, r.refHistorySlotCount,
        r.condCallHistorySlotCount, r.condCallRefHistorySlotCount),
    ).toThrow(PineRuntimeHaltError);
  });

  it("PineRuntimeHaltError는 일반 Error와 구분 가능한 서브클래스다", () => {
    const e = new PineRuntimeHaltError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PineRuntimeHaltError);
    expect(new Error("x")).not.toBeInstanceOf(PineRuntimeHaltError);
  });
});
