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
import { loadGolden, loadOracleData } from "../helpers/golden";
import { transpile } from "../../src/transpiler/pipeline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_bare_udf_call_scalar";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// The pine2py golden is its passthrough (the UDF on the chart's bars, the timeframe dropped). resin
// now evaluates the expression in the requested context (analyzer/security-script.ts; the oracle
// does too: resin-harness state/repros/security-script-udf.json, a `var`-state UDF summing the
// requested bars' closes), and reads the result as it reads the prepass form of the same expression.
// Here that reading is a same-symbol, same-timeframe request ("D" on this daily data), where
// TradingView and the oracle return the chart's own bar and resin's same-symbol pairing does not yet
// (resin-harness state/log.md, the security-script iteration): once it does, the per-bar close + 1
// of the golden is what both forms read, and these cases compare with it again.
const PREPASS_SOURCE = [
  "//@version=5",
  'indicator("request_security_bare_udf_call_scalar prepass form")',
  'ma = request.security(syminfo.tickerid, "D", close + 1)',
  "var float __obs_ma = na",
  "__obs_ma := ma",
].join("\n");

describe("oracle: request_security_bare_udf_call_scalar", () => {
  it("reads bar-by-bar what the prepass form of the same expression reads", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const prepass = runPipeline(PREPASS_SOURCE, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    expect(result.bars.map((b) => b["var:__obs_ma"])).toEqual(prepass.bars.map((b) => b["var:__obs_ma"]));
  });

  it("ends in the prepass form's final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const prepass = runPipeline(PREPASS_SOURCE, data);

    expect(result.finalVarState["__obs_ma"]).toEqual(prepass.finalVarState["__obs_ma"]);
  });

  it("is not pine2py's passthrough: the UDF call runs in the requested context's own run", () => {
    const result = transpile(loadCaseSource(CASE_NAME));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("$.runSecurityScript(0,");
    expect(result.code).toContain("rt.security.scriptValue(myFunc(");
  });
});
