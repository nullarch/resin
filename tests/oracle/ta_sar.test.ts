// oracle/cases/ta_sar.pine: ta.sar(0.02, 0.02, 0.2) 검증(ROADMAP P2 "ta.* 44종"). sample10.json
// 10바 전 구간(2바 워밍업 delay 포함) 관측 — sar는 다른 ta.*와 달리 이미 구현된 TA를 재사용하지
// 않는 자체 상태 머신(runtime/ta.ts sar() 주석 참조). 이 짧은 10바 샘플은 완만한 등락만 있어
// 재역전/2바 전 침투클램프(prevHigh2/prevLow2) 분기는 발동하지 않는다 — 그 분기는
// tests/unit/runtime.test.ts hand-verified 테스트로 별도 검증됨.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_sar";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_sar", () => {
  it("matches the pine2py golden bar-by-bar for ta.sar", () => {
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
