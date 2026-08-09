// oracle/cases/request_security_bare_udf_call_scalar.pine: request.security 스칼라(비튜플) bare
// UDF call expression(C436, wild 신규 최대 서브클러스터 214/483) —
// `x = request.security(sym, tf, myFunc(...))`. C432(튜플 자매 축)와 동일하게 pine2py의
// _resolve_expression이 UDF 반환값을 Series로 인식 못 해 그대로 통과시키므로(문서화된 의도된
// 설계) 이 축도 진짜 오라클 골든 대조가 가능하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_bare_udf_call_scalar";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_ma"];

describe("oracle: request_security_bare_udf_call_scalar", () => {
  it("matches the pine2py golden bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_ma"]).toBe(golden.finalVarState["__obs_ma"]);
  });

  it("sanity: tracks the CURRENT bar's close+1 every single bar, does not hold constant across the 'D' HTF period (proves eager-passthrough, not a real HTF fetch)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const maValues = result.bars.map((b) => b["var:__obs_ma"]);
    expect(maValues).toEqual(Array.from(data.close).map((c) => c + 1));
  });
});
