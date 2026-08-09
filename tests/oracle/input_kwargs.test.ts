// oracle/cases/input_kwargs.pine: input.int/float/bool/string 키워드 인자(title=/minval=/maxval=/
// step=, C132) 검증. pine2py의 대응 함수는 전부 **kwargs를 받아 키워드 호출도 그대로 통과하며
// defval을 반환한다 — 이 골든은 "키워드 인자로 호출해도 이름<->위치 매핑이 pine2py와 동일한가"를
// 검증한다(오버라이드 dict 우선 조회는 여전히 pine2py에 대응이 없어 오라클 비교 불가, hand-verified
// e2e는 tests/unit/codegen.test.ts "CodeGen input.* keyword arguments (C132)" 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "input_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_len", "var:__obs_mult", "var:__obs_useFilter", "var:__obs_label"];

describe("oracle: input_kwargs", () => {
  it("matches the pine2py golden bar-by-bar (keyword args -> same defval passthrough as positional)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state (keyword args -> same defval passthrough as positional)", () => {
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
