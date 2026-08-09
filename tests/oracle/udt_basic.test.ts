// oracle/cases/udt_basic.pine: type 선언 + Type.new(...) 생성 + 필드 읽기/':=' 대입(ROADMAP P2
// 첫 UDT 슬라이스). 채널 A(인자 없는 .new())는 명시 기본값 5종(float/int/bool/string/color) +
// 암시 기본값(생략된 float 필드 -> 0.0)을 검증하고, 채널 B는 위치 인자 부분 채움을, 채널 C는
// 필드 대입(':=')을 매 바 갱신하는 러닝 합계로 동적 신호까지 검증한다. na 생성자 인자/na 필드
// 대입은 pine2py가 na를 타입 무관 float('nan')으로 컴파일해 오라클 비교가 구조적으로 불가능한
// 영역이라(C107/C110급) 이 케이스에서 제외했다 — tests/unit/codegen.test.ts의 hand-verified
// e2e가 그 채널을 대신 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// 오라클 골든의 "var:<name>" 채널은 pine2py의 ctx._var_state 스냅샷 전체를 담아 UDT 인스턴스
// 자체(var:b1/var:b2/var:acc — dataclass repr() 문자열)도 함께 실려있다(gen_oracle.py enc()가
// dataclass를 숫자/컨테이너로 인코딩하지 못해 repr() 폴백). pine2js도 동일 키 아래 JS 객체
// 참조를 그대로 노출하므로(engine.ts snap["var:name"] = ctx.vars[s]) 이 채널은 두 런타임의 표현
// 형식이 근본적으로 다른("#<Bar ...>" 문자열 vs plain object) 비교 불가 영역이다 — __obs_* 미러
// 채널만 골라 비교한다(compareToGolden의 onlyKeys, udf_single_var.test.ts와 동일 관례).
const OBS_KEYS = [
  "var:__obs_b1_x",
  "var:__obs_b1_n",
  "var:__obs_b1_flag",
  "var:__obs_b1_label",
  "var:__obs_b1_c",
  "var:__obs_b1_y",
  "var:__obs_b2_x",
  "var:__obs_b2_n",
  "var:__obs_b2_y",
  "var:__obs_acc_x",
  "var:__obs_acc_flag",
];

describe("oracle: udt_basic", () => {
  it("matches the pine2py golden bar-by-bar (UDT construction + field read/write, __obs_* mirrors only)", () => {
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

    // finalVarState 키는 bars의 "var:<name>" 접두어 없이 bare name(udf_single_var.test.ts와
    // 동일 관례) — OBS_KEYS는 bars 비교용 "var:" 접두어가 있으므로 여기서 걷어낸다.
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
