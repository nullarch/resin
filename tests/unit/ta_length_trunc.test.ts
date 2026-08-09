// C569 (배치27 STEP(2), exec 클러스터 "Invalid array length" 15건 소거): length(또는 occurrence/
// left/right)는 TV에서 항상 'int' 타입이지만, analyzer.ts의 int/int idiv 판별(idivBinOps, C201
// 잔여 범위)이 UDF 매개변수·삼항 체인처럼 top-level 리터럴 밖의 int 값을 못 잡으면 codegen이 그
// 자리에 float division(rt.pineDiv)을 내려 실제로는 정수인 length가 정수가 아닌 값으로 여기
// 도달할 수 있다(wild HMA(_src,_length)=>ta.wma(2*ta.wma(_src,_length/2)-...,...) 관용구, 21/2=10.5
// 류). 고정폭 버퍼를 최초 1회 할당하는 ta.* 함수들은 `new Array(length)`가 그대로 RangeError를
// 던졌다 — 각 함수 진입부에서 length를 Math.trunc로 되돌려 정수 length로 호출했을 때와 바이트
// 동일한 결과를 내는지(그리고 더 이상 throw하지 않는지) 확인한다.

import { describe, expect, it } from "vitest";
import {
  sma,
  wma,
  alma,
  vwma,
  cmo,
  cci,
  change,
  roc,
  variance,
  stdev,
  highest,
  lowest,
  mfi,
  correlation,
  median,
  mode,
  percentrank,
  percentileNearestRank,
  percentileLinearInterpolation,
  dev,
  rci,
  sum,
  valuewhen,
  pivothigh,
  pivotlow,
} from "../../src/runtime/ta";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const BARS = [10, 12, 11, 15, 14, 9, 20, 18, 13, 16];

type Step = (value: number) => number;

const CASES: Array<{ name: string; makeStep: (state: object, length: number) => Step }> = [
  { name: "sma", makeStep: (s, len) => (v) => sma(s as never, v, len) },
  { name: "wma", makeStep: (s, len) => (v) => wma(s as never, v, len) },
  { name: "alma", makeStep: (s, len) => (v) => alma(s as never, v, len, 0.85, 6) },
  { name: "vwma", makeStep: (s, len) => (v) => vwma(s as never, v, 1, len) },
  { name: "cmo", makeStep: (s, len) => (v) => cmo(s as never, v, len) },
  { name: "cci", makeStep: (s, len) => (v) => cci(s as never, v, len) },
  { name: "change", makeStep: (s, len) => (v) => change(s as never, v, len) },
  { name: "roc", makeStep: (s, len) => (v) => roc(s as never, v, len) },
  { name: "variance", makeStep: (s, len) => (v) => variance(s as never, v, len) },
  { name: "stdev", makeStep: (s, len) => (v) => stdev(s as never, v, len) },
  { name: "highest", makeStep: (s, len) => (v) => highest(s as never, v, len) },
  { name: "lowest", makeStep: (s, len) => (v) => lowest(s as never, v, len) },
  { name: "mfi", makeStep: (s, len) => (v) => mfi(s as never, v, 1000, len) },
  { name: "correlation", makeStep: (s, len) => (v) => correlation(s as never, v, v * 2 - 1, len) },
  { name: "median", makeStep: (s, len) => (v) => median(s as never, v, len) },
  { name: "mode", makeStep: (s, len) => (v) => mode(s as never, v, len) },
  { name: "percentrank", makeStep: (s, len) => (v) => percentrank(s as never, v, len) },
  { name: "percentileNearestRank", makeStep: (s, len) => (v) => percentileNearestRank(s as never, v, len) },
  { name: "percentileLinearInterpolation", makeStep: (s, len) => (v) => percentileLinearInterpolation(s as never, v, len) },
  { name: "dev", makeStep: (s, len) => (v) => dev(s as never, v, len) },
  { name: "rci", makeStep: (s, len) => (v) => rci(s as never, v, len) },
  { name: "sum", makeStep: (s, len) => (v) => sum(s as never, v, len) },
];

describe("ta.* fixed-buffer length truncation (C569)", () => {
  for (const { name, makeStep } of CASES) {
    it(`${name}(..., 7.5) doesn't throw and matches ${name}(..., 7)`, () => {
      const fracStep = makeStep({}, 7.5);
      const fracResults = BARS.map((v) => fracStep(v));

      const intStep = makeStep({}, 7);
      const intResults = BARS.map((v) => intStep(v));

      expect(fracResults).toEqual(intResults);
    });
  }
});

describe("ta.valuewhen occurrence truncation (C569)", () => {
  it("valuewhen(..., 3.7) doesn't throw and matches valuewhen(..., 3)", () => {
    const conditions = [true, false, true, true, false, true, false, true];
    const values = [1, 2, 3, 4, 5, 6, 7, 8];

    const fracState = {};
    const fracResults = conditions.map((c, i) => valuewhen(fracState, c, values[i]!, 3.7));

    const intState = {};
    const intResults = conditions.map((c, i) => valuewhen(intState, c, values[i]!, 3));

    expect(fracResults).toEqual(intResults);
  });
});

describe("ta.pivothigh/pivotlow left/right truncation (C569)", () => {
  it("pivothigh(..., 2.5, 1.5) doesn't throw and matches pivothigh(..., 2, 1)", () => {
    const src = [1, 2, 5, 3, 2, 1, 4, 6, 2, 1, 3];

    const fracState = {};
    const fracResults = src.map((v) => pivothigh(fracState, v, 2.5, 1.5));

    const intState = {};
    const intResults = src.map((v) => pivothigh(intState, v, 2, 1));

    expect(fracResults).toEqual(intResults);
  });

  it("pivotlow(..., 2.5, 1.5) doesn't throw and matches pivotlow(..., 2, 1)", () => {
    const src = [5, 4, 1, 3, 4, 5, 2, 0, 4, 5, 3];

    const fracState = {};
    const fracResults = src.map((v) => pivotlow(fracState, v, 2.5, 1.5));

    const intState = {};
    const intResults = src.map((v) => pivotlow(intState, v, 2, 1));

    expect(fracResults).toEqual(intResults);
  });
});

describe("full pipeline repro: UDF param '/' feeding ta.wma length (C569, wild Hull Suite idiom)", () => {
  it("transpile+execute does not throw for hull(src, len) => ta.wma(2*ta.wma(src, len/2) - ta.wma(src, len), ...)", () => {
    const src = [
      "hull(src, len) =>",
      "    ta.wma(2 * ta.wma(src, len / 2) - ta.wma(src, len), math.round(math.sqrt(len)))",
      "var float __obs_a = na",
      "__obs_a := hull(close, 21)",
    ].join("\n");
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const data: OHLCVData = { open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1) };
    expect(() => runPipeline(src, data)).not.toThrow();
  });
});
