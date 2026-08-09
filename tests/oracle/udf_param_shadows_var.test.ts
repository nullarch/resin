// oracle/cases/udf_param_shadows_var.pine: UDF 매개변수명이 top-level var와 같을 때(C414) —
// 매개변수가 함수 본문 안에서 그 이름의 바깥 var를 shadow하는 TV 정상 패턴(wild 34건 실사용).
// pine2py python 함수 매개변수가 동일 이름으로 자연히 shadow함을 python 직접 실행으로 확인해
// 오라클 대조가 가능한 축임을 확정했다 — genIdentifier/resolveAssignTarget이 funcCtx.paramNames를
// program.varIndex보다 먼저 확인하도록 우선순위를 고친 codegen 정확성 수정의 회귀 가드.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_param_shadows_var";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:dir", "var:__obs_call", "var:__obs_var"];

describe("oracle: udf_param_shadows_var", () => {
  it("matches the pine2py golden bar-by-bar (UDF param shadows a same-named top-level var)", () => {
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
