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
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_na_ternary_tf";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_x", "var:__obs_y"];

describe("oracle: request_security_na_ternary_tf", () => {
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

    expect(result.finalVarState["__obs_x"]).toBe(golden.finalVarState["__obs_x"]);
    expect(result.finalVarState["__obs_y"]).toBe(golden.finalVarState["__obs_y"]);
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
