// oracle/cases/color_from_gradient_kwargs.pine: color.from_gradient(value=/bottom_value=/
// top_value=/bottom_color=/top_color=) kwargs(C479) — pine2py wavealgo/builtins/color.py
// from_gradient 파라미터명 5개 전부 TV 공식 이름과 일치해 진짜 오라클 대조가 가능하다
// (ta.cci(C477)와 동일 유형). 완전 키워드/혼합/위치 3폼이 전부 같은 값을 내는지 확인한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "color_from_gradient_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_grad_kw", "var:__obs_grad_mixed", "var:__obs_grad_pos"];

describe("oracle: color_from_gradient_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_grad_kw", "__obs_grad_mixed", "__obs_grad_pos"]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBe(expected);
    }
  });

  it("all three forms (fully-keyword/mixed/positional) agree with each other", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars as unknown as Record<string, string | null>[]) {
      expect(bar["var:__obs_grad_kw"]).toBe(bar["var:__obs_grad_mixed"]);
      expect(bar["var:__obs_grad_mixed"]).toBe(bar["var:__obs_grad_pos"]);
    }
  });
});
