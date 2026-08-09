// oracle/cases/map_basic.pine: map.new/put/get/remove/contains/keys/values/size/clear/copy/
// put_all(C89, map.* 11종 전체) — var 맵의 바-간 지속 + put이 직전 값을 반환하는 시맨틱을 실제
// bar 데이터(sample10.json)로 검증. `close + 0.0`으로 강제 스칼라 변환한 이유는
// oracle/cases/map_basic.pine 상단 주석 참조(pine2py map_funcs.py의 `_scalar()` 가드 누락
// latent 버그 우회 — DIVERGENCES.md 참조, pine2js는 GOAL.md 아키텍처상 이 버그를 구조적으로
//재현할 수 없다). bool 반환(contains)은 array_new_typed.pine(C84)과 동일하게 JS가 산술
// 컨텍스트에서 boolean을 강제 변환해 숫자 전용 compareToGolden으로 그대로 비교 가능 — keys가
// 반환하는 string 원소만 compareStringToGolden(C77)이 필요하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "map_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_put_prev",
  "var:__obs_get_close",
  "var:__obs_size_single",
  "var:__obs_size_multi",
  "var:__obs_removed",
  "var:__obs_size_after_remove",
  "var:__obs_contains_x",
  "var:__obs_contains_y",
  "var:__obs_keys_size",
  "var:__obs_values_first",
  "var:__obs_copy_independent",
  "var:__obs_copy_value",
  "var:__obs_clear_size",
  "var:__obs_putall_size",
  "var:__obs_putall_b",
  "var:__obs_get_missing",
];

const STRING_CHANNELS = ["var:__obs_keys_first"];

describe("oracle: map_basic", () => {
  it("matches the pine2py golden bar-by-bar for numeric/bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for string channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state for the observed channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMERIC_CHANNELS) {
      const name = key.slice("var:".length);
      const expected = decodeSentinel(golden.finalVarState[name]!);
      const actual = result.finalVarState[name];
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
    for (const key of STRING_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBe(golden.finalVarState[name]);
    }
  });
});
