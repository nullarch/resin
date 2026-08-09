// oracle/cases/library_export_import.pine: library()/export/import 파스-스루(C274) 오라클 검증 —
// pine2py도 셋 다 순수 no-op으로 처리하므로(대응 골든 값 생성 성공 자체가 파스-스루 확인) export된
// 함수가 실제로 정상 실행값을 내는지까지 대조한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "library_export_import";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMBER_CHANNELS = ["var:__obs_add", "var:__obs_scale"];

describe("oracle: library_export_import", () => {
  it("matches the pine2py golden bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMBER_CHANNELS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMBER_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBeCloseTo(golden.finalVarState[name] as number, 6);
    }
  });
});
