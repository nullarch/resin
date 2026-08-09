// oracle/cases/ta_dmi.pine: ta.dmi(3, 2) 검증(ROADMAP P2 "ta.* 44종"). sample10.json 10바 전 구간
// 관측 — diLength=3/adxSmoothing=2로 data_len<diLength+1 게이트(runtime/ta.ts dmi() 주석 참조)가
// 바3에서 열리고, 바3은 smoothTr 단일값 시드만(NaN), 바4는 plusDi/minusDi만 유효(adx는 dx 1개뿐이라
// 워밍업 중), 바5부터 3채널 전부 유효 — 게이트/시드/DI-only/DI+ADX 네 구간을 전부 골든과 대조.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_dmi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_dmi", () => {
  it("matches the pine2py golden bar-by-bar for ta.dmi", () => {
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
