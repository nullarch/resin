// oracle/cases/array_map_method_call.pine: method-call 스타일 array/map 콜(C222, Pine v5 sugar
// `arr.push(x)` == `array.push(arr, x)`) — top-level var 수신자(arrayVars/mapVars 경로)와 '='
// 로컬 수신자(containerKindHints 경로, C216 for-in 인프라 재사용) 둘 다, 그리고 sort의 order
// 위치가 method-call 형태에서도 정확히 검증되는지(receiverOffset 보정)를 실제 bar 데이터
// (sample10.json)로 검증. pine2py 쪽도 이 문법을 지원한다(parser.py _try_method_style_call —
// 이름 기반 디스패치, python 직접 실행으로 확인) — pine2js는 정적 컨테이너 종류 판별로 동일 결과를
// 낸다는 점만 다르다(GOAL.md "런타임 분기 없음" 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_map_method_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_size",
  "var:__obs_a_last",
  "var:__obs_a_pop",
  "var:__obs_b0",
  "var:__obs_b_size",
  "var:__obs_c_get",
  "var:__obs_c_size",
  "var:__obs_c_contains",
  "var:__obs_d_x",
  "var:__obs_d_size",
];

describe("oracle: array_map_method_call", () => {
  it("matches the pine2py golden bar-by-bar for numeric/bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the observed channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMERIC_CHANNELS) {
      const name = key.slice("var:".length);
      const expected = decodeSentinel(golden.finalVarState[name]!);
      const actual = result.finalVarState[name];
      if (Number.isNaN(expected as number)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
