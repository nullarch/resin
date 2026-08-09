// oracle/cases/type_cast_basic.pine: int()/float()/bool()/string() 명시적 타입캐스트 bare 콜
// 신규 구현(C207, LIMITATIONS.md 잔여 스코프 (3) "int() 타입캐스트 함수 자체 구현" 채택). pine2py
// wavealgo.core.pine_int/pine_float/pine_bool/pine_str가 na 인자를 크래시 없이 그대로 na로
// 통과시키는 것을 그대로 재현 -- string(x)는 str.tostring(x)(format_str 생략)와 완전히 동일한
// 값(python 직접 실행으로 확인). Infinity 인자(pine2py가 크래시하는 latent 버그)는 오라클 밖,
// codegen.test.ts에서 hand-verified로 별도 검증(DIVERGENCES.md #88).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "type_cast_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_int_pos",
  "var:__obs_int_neg",
  "var:__obs_int_zero_half",
  "var:__obs_int_na",
  "var:__obs_int_bool",
  "var:__obs_float_int",
  "var:__obs_float_bool",
  "var:__obs_float_na",
  "var:__obs_bool_zero",
  "var:__obs_bool_nonzero",
  "var:__obs_bool_na",
  "var:__obs_bool_true",
];

const STRING_CHANNELS = [
  "var:__obs_string_int",
  "var:__obs_string_float",
  "var:__obs_string_bool",
  "var:__obs_string_na",
  "var:__obs_string_loop",
];

describe("oracle: type_cast_basic", () => {
  it("matches the pine2py golden bar-by-bar for int/float/bool numeric+boolean channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for string() channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("renders the exact values pine2py produces (truncation direction, na pass-through, bool coercion, string() === str.tostring())", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_int_pos).toBe(5);
    expect(v.__obs_int_neg).toBe(-2);
    expect(v.__obs_int_zero_half).toBe(0);
    expect(Object.is(v.__obs_int_zero_half, -0)).toBe(false); // C45류 -0 정규화 확인
    expect(v.__obs_int_na).toBeNaN();
    expect(v.__obs_int_bool).toBe(1);

    expect(v.__obs_float_int).toBe(5);
    expect(v.__obs_float_bool).toBe(0);
    expect(v.__obs_float_na).toBeNaN();

    expect(v.__obs_bool_zero).toBe(false);
    expect(v.__obs_bool_nonzero).toBe(true);
    expect(v.__obs_bool_na).toBe(false);
    expect(v.__obs_bool_true).toBe(true);

    expect(v.__obs_string_int).toBe("5");
    expect(v.__obs_string_float).toBe("5.7");
    expect(v.__obs_string_bool).toBe("True");
    expect(v.__obs_string_na).toBe("NaN");
    expect(v.__obs_string_loop).toBe("2");
  });
});
