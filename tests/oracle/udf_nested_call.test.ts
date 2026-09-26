// oracle/cases/udf_nested_call.pine: UDF-in-UDF 중첩 호출(C267[part2], corpus "UDF 안에서 다른
// UDF를 호출하는 것은 아직 지원하지 않음" 클러스터 18건 실측) — analyzeUserFuncCall의 blanket
// scope.func!==null 거부를 걷어내고 기존 콜사이트별(AST 노드 키) slotBase 배정 메커니즘을 그대로
// 재사용했다(codegen 변경 0줄). 채널: 3단 체인(outer -> mid -> leaf, ta.sma + var 누산 상태)과
// 실제 corpus 동형 패턴(getNormRSI -> getRSI/normalize, ta.rsi + ta.lowest/highest) 양쪽 다 함수당
// 콜사이트 1개(다중 콜사이트 독립성은 오라클 무효 — tests/unit/codegen.test.ts가 담당, 이 파일
// 상단 주석 참조).
//
// __obs_result (ta.sma + var) is read from the pine2py golden. __obs_normed is not: pine2py's
// ta.rsi counted the first bar (no x[1]) toward the rma seed, so its rsi(close, 5) started on bar 4.
// ref_v6_ta_math.txt "ta.rsi" seeds on the first `length` changes (first value on bar 5; tier 1
// resin-harness suites/indicators/tv/ta_211_mfi_rsi_stoch), and the PyneCore oracle on the straight-
// line twin of getNormRSI(5, 5) gives the values in ORACLE_NORMED. On bars 6..8 the 5-bar
// lowest/highest window still holds warm-up na values, which the oracle skips ("`na` values in the
// `source` series are ignored", ref_v6_ta_math.txt ta.lowest/ta.highest) and resin does not yet
// (harness cluster tv/ta_141_highest_lowest); those bars are held to the straight-line program run
// by resin instead, which is what this case is about: nesting must not change the result.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_nested_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json: r = ta.rsi(close, 5), lo/hi = ta.lowest/ta.highest(r, 5),
// hi > lo ? (r - lo) / (hi - lo) * 100 : 50.
const ORACLE_NORMED: readonly number[] = [50, 50, 50, 50, 50, 50, 100, 0, 58.4275184275184, 79.6547281628446];
// Bars whose lowest/highest window reads na (see the header).
const NA_WINDOW_BARS = new Set([6, 7, 8]);

const STRAIGHT_LINE = [
  "//@version=5",
  'indicator("udf_nested_call straight line")',
  "r = ta.rsi(close, 5)",
  "lo = ta.lowest(r, 5)",
  "hi = ta.highest(r, 5)",
  "var float __obs_normed = na",
  "__obs_normed := hi > lo ? (r - lo) / (hi - lo) * 100.0 : 50.0",
].join("\n");

describe("oracle: udf_nested_call", () => {
  it("matches the pine2py golden bar-by-bar on the ta.sma + var chain (outer -> mid -> leaf)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_result"]);
    expect(result.finalVarState["__obs_result"]).toBeCloseTo(golden.finalVarState["__obs_result"] as number, 6);
  });

  it("getNormRSI nested in UDFs reads what the straight-line program reads, and the oracle where the window holds no na", () => {
    const data = loadOracleData(CASE_NAME);
    const nested = runPipeline(loadCaseSource(CASE_NAME), data);
    const inline = runPipeline(STRAIGHT_LINE, data);

    expect(nested.bars).toHaveLength(ORACLE_NORMED.length);
    for (let i = 0; i < ORACLE_NORMED.length; i++) {
      const actual = nested.bars[i]!["var:__obs_normed"]!;
      expect(nearlyEqual(actual, inline.bars[i]!["var:__obs_normed"]!), `bar ${i}: nested=${actual} inline`).toBe(true);
      if (NA_WINDOW_BARS.has(i)) continue;
      expect(nearlyEqual(actual, ORACLE_NORMED[i]!), `bar ${i}: actual=${actual} oracle=${ORACLE_NORMED[i]}`).toBe(true);
    }
    expect(nested.finalVarState["__obs_normed"]).toBeCloseTo(ORACLE_NORMED[9]!, 9);
  });
});
