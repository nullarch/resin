// oracle/cases/tuple_udf_tail_return.pine: UDF 암시 반환 꼬리의 튜플 UDF 콜 전파(C611) —
// (1) 마지막 문장이 request.security(sym, tf, tupleUdf(...)) bare UDF 콜인 래퍼(wrapSec):
//     pine2py request_security._resolve_expression은 UDF 콜(비-Series 값)을 그대로 통과시키고
//     (C432 문서화된 의도된 설계 — request_security_bare_udf_call.test.ts 참조), UDF 암시 반환은
//     마지막 ExprStmt의 값이므로 래퍼가 그 튜플을 무가공 재반환한다. pine2js는 외부 security
//     노드를 완전히 discard하고 내부 콜을 직접 return(HTF 슬롯/프리패스 0)하는 literal port.
// (2) 마지막 문장이 이미 확정된 튜플 반환 UDF의 직접 콜인 체인(chain2 → chain1, wild
//     zigzag→zigzagcore 관용구) — arity/원소 kind를 콜리에서 그대로 승계.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_udf_tail_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_sh", "var:__obs_sl", "var:__obs_c1", "var:__obs_c2"];

describe("oracle: tuple_udf_tail_return", () => {
  it("matches the pine2py golden bar-by-bar for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
