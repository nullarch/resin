// oracle/cases/array_map_constructor_chain.pine: 생성자 반환 콜의 method-call 스타일 체이닝
// (C223, C222 next_hint 1순위) — `b = a.slice(0,2)`처럼 array/map 생성자 메서드를 method-call
// 형태로 부른 결과를 대입받는 '=' 로컬(b/c/sorted/m2)이 isArrayConstructorCall/isMapConstructorCall의
// 새 method-call 폴백(resolveContainerExprKind 재사용)으로 정적 array/map 판별되고, 그 뒤이은
// `b.push(...)`/`sorted.sort()`/`m2.put(...)` 등 method-call이 정상 라우팅되는지 실제 bar 데이터
// (sample10.json)로 검증. pine2py는 애초에 이름 기반 런타임 디스패치라 이 정적 분류가 필요 없어
// 같은 소스가 수정 없이 골든을 생성한다(GOAL.md "런타임 분기 없음" 원칙과 대비되는 지점).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_map_constructor_chain";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_b_size",
  "var:__obs_b_last",
  "var:__obs_c_size",
  "var:__obs_sorted0",
  "var:__obs_sorted_size",
  "var:__obs_m2_x",
  "var:__obs_m2_y",
  "var:__obs_m1_size",
];

describe("oracle: array_map_constructor_chain", () => {
  it("matches the pine2py golden bar-by-bar for numeric channels", () => {
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
