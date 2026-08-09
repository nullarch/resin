// oracle/cases/request_security_bare_ta_multi_return.pine: request.security bare 다중 반환 ta.*
// 콜 expression(C433, wild bareTaMultiReturn 서브클러스터, next_hint(C432)) —
// `[a,b,c] = request.security(sym, tf, ta.macd(...))`. pine2py wavealgo/security.py
// ._resolve_expression은 Series가 아닌 값(튜플 포함)을 그대로 통과시켜 HTF 재계산이 아예 없다
// (C432 bareUdfCall과 동일 오라클 근거) — pine2js는 이 시맨틱을 literal port(HTF 프리패스/캐시
// 없이 ta.* 콜을 그 자리에서 직접 호출, request.security 바깥 노드는 codegen이 아예 안 봄)했으므로
// 진짜 오라클 골든 대조가 가능하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_bare_ta_multi_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: request_security_bare_ta_multi_return", () => {
  it("matches the pine2py golden bar-by-bar for macd/signal/hist", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });

  it("sanity: matches a direct (unwrapped) ta.macd(close, 2, 3, 2) bar-by-bar (proves this is the eager-passthrough oracle behavior, not a real HTF fetch)", () => {
    const data = loadOracleData(CASE_NAME);
    const wrapped = loadCaseSource(CASE_NAME);
    const direct = `//@version=5
indicator("t")
[macdLine, signalLine, histLine] = ta.macd(close, 2, 3, 2)
var float __obs_macd = na
var float __obs_signal = na
var float __obs_hist = na
__obs_macd := macdLine
__obs_signal := signalLine
__obs_hist := histLine
`;
    const wrappedResult = runPipeline(wrapped, data);
    const directResult = runPipeline(direct, data);
    expect(wrappedResult.bars).toEqual(directResult.bars);
  });
});
