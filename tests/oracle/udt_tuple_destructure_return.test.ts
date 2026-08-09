// oracle/cases/udt_tuple_destructure_return.pine: UDF가 튜플로 반환한 UDT 원소(내부 var Swing
// top/btm을 조건부 갱신 후 그대로 [top, btm] 튜플 반환하는 wild `swings()` 관용구, C387)를 받는
// top-level 튜플 디스트럭처 대상의 필드 읽기/쓰기 지원을 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_tuple_destructure_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = [
  "var:__obs_top_y",
  "var:__obs_top_x",
  "var:__obs_top_crossed",
  "var:__obs_btm_y",
  "var:__obs_btm_x",
];

describe("oracle: udt_tuple_destructure_return", () => {
  it("matches the pine2py golden bar-by-bar (UDF tuple-returned UDT field read/write)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state", () => {
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
