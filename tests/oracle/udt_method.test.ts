// oracle/cases/udt_method.pine: method 선언 + obj.method(args) 호출 desugar(UDT 네 번째 슬라이스,
// C124) 오라클 검증. pine2py는 단일 UDT/동명 충돌 없는 시나리오에서 obj.method(args)를 정확히
// method(obj, args)로 desugar하므로 이 케이스는 바이트 단위 대조가 유효하다 — 서로 다른 UDT의 동명
// method 충돌(pine2py flat 네임스페이스 latent 버그)은 오라클 비교 불가 영역이라 별도
// tests/unit/codegen.test.ts hand-verified 테스트로 검증한다(udt_basic/udt_nested와 동일한
// "var:<name>" 채널 제외 관례 — UDT 인스턴스 자체는 dataclass repr() vs plain object로 표현이
// 근본적으로 달라 비교 불가, __obs_* 스칼라 미러만 비교).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_method";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_x", "var:__obs_y", "var:__obs_mag"];

describe("oracle: udt_method", () => {
  it("matches the pine2py golden bar-by-bar (method mutation + implicit-return method call, __obs_* mirrors only)", () => {
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
