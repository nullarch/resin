// oracle/cases/udf_forward_ref_tuple.pine: forward-reference UDF 튜플 디스트럭처(C412) —
// `[a,b] = f()`가 `f() => ... \n [v1,v2]` 선언보다 스크립트 앞쪽에 오는 패턴(wild
// 1f4336ca1266.pine 실측). analyzeTupleDestructure가 registerFuncSignature prepass 시점(아직
// FuncInfo.tupleArity===null)에 arity를 즉시 읽어버려 항상 거부하던 gap을
// pendingTupleDestructures(analyzeFuncDecl이 bodyAnalyzed=true 직후 즉시 재개)로 수정했다.
// 채널: stateful ta.* 콜 2개를 담은 튜플 반환(maPair, funcTaBases 지연 배정)과 var 상태를 가진
// 튜플 반환(counterPair, funcCallSlots 지연 배정) 양쪽 다 forward-ref 콜사이트에서 정상 동작하는지
// 확인(udf_forward_ref.test.ts의 튜플 반환판, 다중 콜사이트 slotBase 독립성은 여전히 오라클 무효라
// 범위 밖 — MEMORY C9/C162).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_forward_ref_tuple";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_a", "var:__obs_b", "var:__obs_c", "var:__obs_d"];

describe("oracle: udf_forward_ref_tuple", () => {
  it("matches the pine2py golden bar-by-bar (forward-referenced tuple-returning UDF calls, ta + var state)", () => {
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
