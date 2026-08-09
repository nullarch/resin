// oracle/cases/array_basic.pine: array.new_float/get/set/push/pop/size — array.* 최초 슬라이스(C79).
// 채널 A(var 배열 매 바 push 성장: size/first/last), 채널 B(매 바 새 배열: fill+set/get/pop/size),
// 채널 C(경계: 범위 밖 get→NaN, 빈 배열 pop→NaN/size→0 — 전부 pine2py 가드가 있는 정의된 동작이라
// 오라클로 직접 검증 가능). na(null) 배열 인자 채널은 pine2py가 크래시(get/set/push/size 가드 없음)해
// 오라클 구성 불가 — runtime.test.ts hand-verified로 대체(LIMITATIONS.md 참조).
// 'var:arr' 채널(배열 자체)은 비교에서 제외: 골든의 리스트 직렬화는 numeric 채널 규약(decodeSentinel)
// 밖이고, pine2js 스냅샷도 참조를 그대로 담아 바별 스냅샷이 아니다 — 배열 내용 검증은 get/size
// 미러 채널이 담당한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_size",
  "var:__obs_first",
  "var:__obs_last",
  "var:__obs_b0",
  "var:__obs_b1",
  "var:__obs_pop",
  "var:__obs_size2",
  "var:__obs_oob",
  "var:__obs_emptypop",
  "var:__obs_emptysize",
];

describe("oracle: array_basic", () => {
  it("matches the pine2py golden bar-by-bar for all ten numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all ten numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_size",
      "__obs_first",
      "__obs_last",
      "__obs_b0",
      "__obs_b1",
      "__obs_pop",
      "__obs_size2",
      "__obs_emptysize",
    ]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
    // NaN 채널은 toBeCloseTo가 NaN 비교를 못 하므로 명시적으로 확인(ta_pivot의 nearlyEqual 전례와
    // 동일 사정 — 여기선 채널이 2개뿐이라 직접 isNaN으로 검사).
    expect(Number.isNaN(result.finalVarState["__obs_oob"])).toBe(true);
    expect(Number.isNaN(result.finalVarState["__obs_emptypop"])).toBe(true);
    expect(golden.finalVarState["__obs_oob"]).toBe("NaN");
    expect(golden.finalVarState["__obs_emptypop"]).toBe("NaN");
  });

  it("grows the var array by exactly one element per bar (final size equals bar count)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // 채널 A의 마지막 바 size = 전체 바 수 — var 게이트가 배열을 단 한 번만 생성했음을 뜻한다
    // (매 바 재생성됐다면 size가 항상 1로 붙박이). 골든과 actual 양쪽 모두 확인.
    expect(result.finalVarState["__obs_size"]).toBe(data.close.length);
    expect(golden.finalVarState["__obs_size"]).toBe(data.close.length);
  });
});
