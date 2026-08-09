// oracle/cases/array_new_generic_types.pine: `array.new<T>(...)`에서 T가 5종 원시 타입
// (float/int/bool/string/color) 밖인 참조형(사용자 UDT 타입명 또는 label/chart.point 같은
// built-in 특수 타입)일 때의 무타입 단일 생성자(C230, new_generic — parser.ts가 attr을 이
// 이름으로 재작성). 원소(UDT 인스턴스/label 핸들/chart.point dict) 자체는 pine2py enc()가
// Python repr 문자열/dict로 낮춰 수치 비교가 무의미하므로 제외하고, array.size()로 관측되는
// 누적 개수(push가 바마다 크래시 없이 정확히 반영되는지)만 비교한다 — corpus 871ab3edddcd.pine의
// `count := array.size(entries)` 관측 관례와 동일.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_new_generic_types";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_entries_size", "var:__obs_labels_size", "var:__obs_pts_size"];

describe("oracle: array_new_generic_types", () => {
  it("matches the pine2py golden bar-by-bar for array.size() channels (UDT/label/chart.point generic constructors)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the size channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_entries_size", "__obs_labels_size", "__obs_pts_size"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
