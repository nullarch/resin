// oracle/cases/input_extra.pine: input.* 세 번째 슬라이스(C133) — color/source/symbol/
// timeframe/session/price/text_area/time + bare input() 검증. pine2py의 대응 함수는 전부
// defval을 그대로 반환하는 순수 스텁이라(input_basic.pine과 동일 이유) 이 골든도 "오버라이드
// 없음" 경로만 검증한다. source 채널은 `close + 0.0`으로 강제 스칼라화해 pine2py의 Series-leak
// 클래스(DIVERGENCES.md #29/#53 계열)를 회피한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "input_extra";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = [
  "var:__obs_col",
  "var:__obs_sym",
  "var:__obs_tf",
  "var:__obs_sess",
  "var:__obs_pr",
  "var:__obs_txt",
  "var:__obs_t",
  "var:__obs_src",
  "var:__obs_any",
];

describe("oracle: input_extra", () => {
  it("matches the pine2py golden bar-by-bar (no override -> defval)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state (no override -> defval)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const prefixed of OBS_KEYS) {
      const key = prefixed.slice("var:".length);
      const expected = golden.finalVarState[key];
      if (expected === undefined) continue;
      const actual = result.finalVarState[key];
      if (typeof expected === "number" && typeof actual === "number") {
        expect(actual).toBeCloseTo(expected, 6);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
