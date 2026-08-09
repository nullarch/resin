// oracle/cases/udt_typed_local_no_var.pine: 명시 타입힌트가 붙은 non-var '=' 로컬(`Type x = expr`,
// var 키워드 없음) UDT 인스턴스 추적(C386) -- C224(udt_local_var.pine)는 생성자 콜을 직접 대입받는
// '=' 로컬만 커버했으므로, 여기서는 RHS가 생성자 콜이 아니라 다른 UDT 인스턴스의 필드 접근인 경우
// (명시 타입힌트만으로 UDT 타입이 확정되는 wild corpus 관용구)를 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_typed_local_no_var";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_p_x", "var:__obs_p_n"];

describe("oracle: udt_typed_local_no_var", () => {
  it("matches the pine2py golden bar-by-bar (non-var typed '=' local, RHS is a field access not a constructor call)", () => {
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
