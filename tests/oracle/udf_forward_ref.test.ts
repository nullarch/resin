// oracle/cases/udf_forward_ref.pine: top-level FuncDecl forward-reference(C255) — 호출이 함수
// 선언보다 스크립트 앞쪽에 오는 패턴(corpus "알 수 없는 함수 호출" 클러스터 최다빈도 26건 실측).
// pine2py도 codegen.py _HOISTABLE_TYPES로 FuncDecl을 hoist해 지원한다(python 직접 실행으로
// errors=[] 확인) — analyzer.ts에 registerFuncSignature prepass(시그니처만 선등록) +
// pendingFuncCallSlots(본문 분석 후 슬롯 배정 지연)를 추가해 pine2js도 동일하게 지원하도록 고쳤다.
// 채널: stateful ta.* 콜(smaHelper)과 var 상태(counter) 양쪽 다 forward-ref 콜사이트에서 정상
// 동작하는지 확인(다중 콜사이트 slotBase 독립성은 오라클 무효라 tests/unit/codegen.test.ts가 담당).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_forward_ref";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_a", "var:__obs_c"];

describe("oracle: udf_forward_ref", () => {
  it("matches the pine2py golden bar-by-bar (forward-referenced UDF calls, ta + var state)", () => {
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
