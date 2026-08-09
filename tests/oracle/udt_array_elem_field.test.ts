// oracle/cases/udt_array_elem_field.pine: array<UDT> 원소 접근(array.get/pop, C341) 뒤 '=' 로컬의
// UDT 필드 읽기 -- 채널 A(canonical array.get)/C(array.pop)/D(중첩 UDT 필드의 array<UDT>)만 대조.
// 채널 B(method-call sugar `container.get(idx)`)는 pine2py 자신의 latent 버그로 오라클 불가
// (probe 실측: UDT 원소 배열에서 `.get(idx)`가 idx 정수를 그대로 반환 -- float 배열에선 정상 동작
// 확인됐으므로 이 버그는 UDT 원소일 때만 발현. 오라클 구조적 불가, hand-verified 대체 —
// tests/unit/array_elem_udt_field.test.ts 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_array_elem_field";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_first_top", "var:__obs_first_bull", "var:__obs_popped_top", "var:__obs_item_top"];

describe("oracle: udt_array_elem_field", () => {
  it("matches the pine2py golden bar-by-bar (array.get/pop element UDT field read)", () => {
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
