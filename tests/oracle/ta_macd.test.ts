// oracle/cases/ta_macd.pine: [macdLine, signalLine, histLine] = ta.macd(close, 2, 3, 2) 검증
// (ROADMAP P2 "ta.* 44종" — macd, 첫 다중 반환 TA). fast=2/slow=3/signal=2라 sample10.json 10바
// 안에서 전부 NaN인 워밍업(바 0~1), macd만 유효한 구간(바 2), 3값 모두 유효한 구간(바 3~9)을
// 전부 커버한다 — 다중 반환 스크래치 경로(analyzer 튜플 분기 + codegen 문장 실행 + $.taScratch
// 인덱스 읽기)가 pine2py의 튜플 반환과 바별로 일치하는지의 E2E 검증이기도 하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_macd";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_macd", () => {
  it("matches the pine2py golden bar-by-bar for ta.macd (macd/signal/hist)", () => {
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
});
