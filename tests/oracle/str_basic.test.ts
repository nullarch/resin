// oracle/cases/str_basic.pine: str.length/contains/startswith/endswith/pos — 순수 문자열 함수
// 검증. 전부 문자열 리터럴 인자(na 없음)라 바 데이터와 무관하게 매 바 동일값(math_const.pine과
// 동일 패턴) — na 전파(source/target=na) 경로는 pine2py가 크래시해 오라클로 검증 불가하므로
// runtime.test.ts에서 hand-verified로 대체(LIMITATIONS.md 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_len0",
  "var:__obs_len1",
  "var:__obs_contains0",
  "var:__obs_contains1",
  "var:__obs_contains2",
  "var:__obs_sw0",
  "var:__obs_sw1",
  "var:__obs_ew0",
  "var:__obs_ew1",
  "var:__obs_pos0",
  "var:__obs_pos1",
  "var:__obs_pos2",
];

describe("oracle: str_basic", () => {
  it("matches the pine2py golden bar-by-bar for all twelve channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all twelve channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_len0", "__obs_len1", "__obs_contains0", "__obs_contains1", "__obs_contains2", "__obs_sw0", "__obs_sw1", "__obs_ew0", "__obs_ew1", "__obs_pos0", "__obs_pos1", "__obs_pos2"]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
