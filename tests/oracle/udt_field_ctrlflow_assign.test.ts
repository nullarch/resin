// oracle/cases/udt_field_ctrlflow_assign.pine: UDT 필드 제어문-식 대입(`obj.field := if/switch
// ...`, C265 신규) -- corpus 실측 3건의 `p.state := switch cond => "X" ... => "Y"` 패턴 해소.
// var:p(UDT 인스턴스 자체)는 udt_basic.test.ts와 동일한 이유로 비교 불가 영역 -- __obs_* 미러
// 채널만 비교한다. 데이터는 if 양쪽 분기(에너지 누적/감산)와 switch 3분기(HOT/NEUTRAL/COLD)를
// 전부 실측으로 지나가도록 설계됨(oracle/data/udt_field_ctrlflow_assign.json 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_field_ctrlflow_assign";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_energy", "var:__obs_state"];

describe("oracle: udt_field_ctrlflow_assign", () => {
  it("matches the pine2py golden bar-by-bar (UDT field := if/switch control-flow-expr, __obs_* mirrors only)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state for the __obs_* mirrors", () => {
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
