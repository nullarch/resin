// oracle/cases/request_security_na_ternary_tf.pine: request.security tf 삼항의 na(NaLiteral)
// 분기 폴딩(C514, wild "auto HTF" 변종 (b) 잔여 — 2288dd31000d.pine
// `tfActive(tf1Enabled, tf1) ? tf1 : na`류). resolveSecurityTfLiteral의 NaLiteral 분기가 "D"로
// 직접 정규화하는 결정이 pine2py request_security() 실제 실행과 bar-by-bar 일치함을 오라클로
// 확인한다 — na 분기로 폴딩된 x와 명시적 "D" 인자를 쓴 y가 매 바 동일해야 한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_na_ternary_tf";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// The pine2py golden is its passthrough of f(close) (the chart's bars, the timeframe dropped). resin
// evaluates f(close) in the requested context (analyzer/security-script.ts; resin-harness
// state/repros/security-script-udf.json) and reads the result as it reads the prepass form of the
// same expression, `close + 1`: that is what both calls are compared with here. (On this daily data
// "D" is the chart's own timeframe, where TradingView returns the chart's own bar and resin's
// same-symbol pairing does not yet — resin-harness state/log.md, the security-script iteration; the
// golden's per-bar close + 1 is that value.)
const PREPASS_SOURCE = [
  "//@version=5",
  'indicator("request_security_na_ternary_tf prepass form")',
  'p = request.security(syminfo.tickerid, "D", close + 1)',
  "var float __obs_p = na",
  "__obs_p := p",
].join("\n");

describe("oracle: request_security_na_ternary_tf", () => {
  it("reads bar-by-bar what the prepass form of the same expression reads, through the na-folded tf (x) and the explicit 'D' (y)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const prepass = runPipeline(PREPASS_SOURCE, data).bars.map((b) => b["var:__obs_p"]);

    expect(result.bars).toHaveLength(golden.bars.length);
    expect(result.bars.map((b) => b["var:__obs_x"])).toEqual(prepass);
    expect(result.bars.map((b) => b["var:__obs_y"])).toEqual(prepass);
  });

  it("ends in the prepass form's final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const prepass = runPipeline(PREPASS_SOURCE, data);

    expect(result.finalVarState["__obs_x"]).toEqual(prepass.finalVarState["__obs_p"]);
    expect(result.finalVarState["__obs_y"]).toEqual(prepass.finalVarState["__obs_p"]);
  });

  it("the na-folded branch (x) and the explicit 'D' branch (y) agree bar-by-bar (proves the NaLiteral->D fold)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const xValues = result.bars.map((b) => b["var:__obs_x"]);
    const yValues = result.bars.map((b) => b["var:__obs_y"]);
    expect(xValues).toEqual(yValues);
  });
});
