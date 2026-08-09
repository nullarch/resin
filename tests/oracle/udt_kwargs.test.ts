// oracle/cases/udt_kwargs.pine: UDT 생성자 키워드 인자(`field=value`, C129) 검증. 채널 A는 전
// 필드를 선언 순서 그대로 키워드로 지정, 채널 B는 역순 + 부분 채움(나머지는 명시 기본값), 채널
// C는 위치 인자 + 키워드 인자 혼합을 각각 커버한다. 세 채널 모두 'var' 게이팅으로 첫 바 값에
// 고정되므로(=' 로컬 UDT 추적 미구현, udt_basic.pine과 동일 제약) 바마다 값이 바뀌지는 않지만,
// 키워드가 올바른 필드 슬롯으로 매칭됐는지(순서 무관) bar-by-bar로 반복 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// "var:a"/"var:b"/"var:c" 자체(dataclass repr() 문자열 vs JS plain object)는 udt_basic.pine과
// 동일한 이유로 두 런타임의 표현 형식이 근본적으로 달라 비교 불가 — __obs_* 미러 채널만 비교한다.
const OBS_KEYS = [
  "var:__obs_a_x",
  "var:__obs_a_n",
  "var:__obs_a_flag",
  "var:__obs_a_label",
  "var:__obs_a_y",
  "var:__obs_b_x",
  "var:__obs_b_n",
  "var:__obs_b_y",
  "var:__obs_c_x",
  "var:__obs_c_n",
  "var:__obs_c_flag",
  "var:__obs_c_label",
  "var:__obs_c_y",
];

describe("oracle: udt_kwargs", () => {
  it("matches the pine2py golden bar-by-bar (UDT constructor keyword args, __obs_* mirrors only)", () => {
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
