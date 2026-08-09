// oracle/cases/array_residual.pine: array.first/last/shift/unshift/insert/remove/clear/fill —
// array.* 잔여 슬라이스(C80, C79가 확정한 패턴의 기계적 확장). 채널 A(var 배열 매 바 unshift 성장:
// size/first/last), 채널 B(매 바 새 배열: shift 제거), 채널 C(매 바 새 배열: insert/remove), 채널 D
// (경계: remove 범위 밖→NaN, first/last 빈 배열→NaN — 전부 pine2py 가드가 있는 정의된 동작이라
// 오라클로 직접 검증 가능), 채널 E(clear), 채널 F(fill 범위 지정 + 디폴트 전체 범위). na(null)
// 배열/na 인덱스 채널(unshift/insert/remove/clear/fill 전부)은 pine2py가 크래시(가드 없음)해 오라클
// 구성 불가 — runtime.test.ts hand-verified로 대체(DIVERGENCES.md #20, LIMITATIONS.md 참조).
// 'var:arrA' 채널(배열 자체)은 array_basic.test.ts와 동일한 이유로 비교 제외 — 내용 검증은
// get/size/first/last 미러 채널이 담당.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_residual";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_size_a",
  "var:__obs_first_a",
  "var:__obs_last_a",
  "var:__obs_shift",
  "var:__obs_shift_size",
  "var:__obs_insert",
  "var:__obs_insert_size",
  "var:__obs_remove",
  "var:__obs_remove_size",
  "var:__obs_remove_oob",
  "var:__obs_first_empty",
  "var:__obs_last_empty",
  "var:__obs_clear_size",
  "var:__obs_fill1",
  "var:__obs_fill2",
  "var:__obs_fill3",
  "var:__obs_fillall",
];

describe("oracle: array_residual", () => {
  it("matches the pine2py golden bar-by-bar for all seventeen numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all seventeen numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_size_a",
      "__obs_first_a",
      "__obs_last_a",
      "__obs_shift",
      "__obs_shift_size",
      "__obs_insert",
      "__obs_insert_size",
      "__obs_remove",
      "__obs_remove_size",
      "__obs_clear_size",
      "__obs_fill1",
      "__obs_fill2",
      "__obs_fill3",
      "__obs_fillall",
    ]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
    // NaN 채널은 toBeCloseTo가 NaN 비교를 못 하므로 명시적으로 확인(array_basic.test.ts의
    // __obs_oob/__obs_emptypop 전례와 동일 사정).
    expect(Number.isNaN(result.finalVarState["__obs_remove_oob"])).toBe(true);
    expect(Number.isNaN(result.finalVarState["__obs_first_empty"])).toBe(true);
    expect(Number.isNaN(result.finalVarState["__obs_last_empty"])).toBe(true);
    expect(golden.finalVarState["__obs_remove_oob"]).toBe("NaN");
    expect(golden.finalVarState["__obs_first_empty"]).toBe("NaN");
    expect(golden.finalVarState["__obs_last_empty"]).toBe("NaN");
  });

  it("grows the var array by exactly one element per bar via unshift (final size equals bar count)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // unshift로 성장하는 채널 A — var 게이트가 배열을 단 한 번만 생성했음을 뜻한다(push 성장을
    // 검증한 array_basic.test.ts의 대칭 사례, 방향만 반대). 골든과 actual 양쪽 모두 확인.
    expect(result.finalVarState["__obs_size_a"]).toBe(data.close.length);
    expect(golden.finalVarState["__obs_size_a"]).toBe(data.close.length);
  });
});
