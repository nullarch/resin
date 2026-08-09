// oracle/cases/input_basic.pine: input.int/float/bool/string (첫 슬라이스, C131) 검증. pine2py의
// 대응 함수는 Context.inputs가 어디서도 read/write 안 되는 죽은 스텁이라 항상 defval을 그대로
// 반환한다 — 이 골든은 "오버라이드 없음" 경로만 검증한다(오버라이드 경로는 pine2py에 대응이
// 없어 오라클 비교 불가, tests/unit/codegen.test.ts의 hand-verified e2e로 대체).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "input_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_len", "var:__obs_mult", "var:__obs_useFilter", "var:__obs_label"];

describe("oracle: input_basic", () => {
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
