// oracle/cases/history_basic.pine: 히스토리 참조([]) 검증 — bar series(close[1])와 top-level
// var(acc[1], acc[2]) 두 경로 모두 pine2py 골든과 대조한다. `acc := acc + close`가 매 바 항상
// 히스토리 읽기(`acc[1]`/`acc[2]`)보다 먼저 오도록 소스를 구성했다 — pine2py의 ctx.param()은
// 읽는 시점의 Python 변수 값을 그대로 push하는 방식이라, 읽기가 그 바의 마지막 재대입보다
// 먼저 오면 갱신 전 값이 히스토리에 박힐 수 있다(MEMORY.md에 등재할 만한 latent 함정이나, 이
// 케이스는 그 순서를 피해 pine2py 골든이 실제로 올바른 값을 낸다 — 손으로 트레이스한 기대값과도
// 정확히 일치 확인함, analyzer.ts의 analyzeIndexAccess 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "history_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: history_basic", () => {
  it("matches the pine2py golden bar-by-bar for close[1] and a top-level var's [1]/[2] history", () => {
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
