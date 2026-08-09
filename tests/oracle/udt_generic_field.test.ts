// oracle/cases/udt_generic_field.pine: 제네릭 컨테이너 필드(array<T>/map<K,V>, C126) 오라클 검증.
// 채널 A는 필드 암시 기본값(빈 컨테이너)이 바 0~1에서 그대로 관측됨을, 이후는 array.push/map.put로
// 매 바 누적되는 동적 신호(sum 러닝 합계, map.get 덮어쓰기, map.contains)를 검증한다. UDT 인스턴스
// 자체(var:b)는 udt_basic/udt_nested와 동일 이유로 비교 불가라 제외 -- __obs_* 스칼라 미러만 비교.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_generic_field";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_size", "var:__obs_sum", "var:__obs_tag", "var:__obs_contains"];

describe("oracle: udt_generic_field", () => {
  it("matches the pine2py golden bar-by-bar (array<T>/map<K,V> UDT fields, __obs_* mirrors only)", () => {
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
