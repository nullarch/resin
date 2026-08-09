// oracle/cases/string_eq_local_hist.pine: string 값을 담은 top-level '=' 로컬 히스토리 인덱스
// (C690, wild "string-hist 잔여" 클러스터 — `s = cond ? "even" : "odd"` 뒤 s[1]/s[2]).
// string_var_hist.test.ts(C675, var 대상)와 동일한 참조형 원형 버퍼($.refHistSlots, RefSeries)를
// '=' 로컬에도 재사용 — 물리적 제약이 var/'=' 로컬 어느 쪽에도 없었음(index-access.ts 주석 참조).
// na 표현 divergence는 C675와 동일: pine2py는 string na도 float('nan')로만 컴파일하지만 pine2js는
// GOAL.md na 3분할 규약대로 참조형 na=null — 워밍업 전 셀은 골든과 직접 비교하지 않는다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "string_eq_local_hist";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: string_eq_local_hist", () => {
  it("matches the pine2py golden bar-by-bar for the current (never-na) string channel", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, ["var:__obs_cur"]);
  });

  it("matches the pine2py golden for [1]/[2] string history once warmed up", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    compareStringToGolden(
      result.bars.slice(1) as unknown as Record<string, string | null>[],
      { ...golden, bars: golden.bars.slice(1) },
      ["var:__obs_prev"],
    );
    compareStringToGolden(
      result.bars.slice(2) as unknown as Record<string, string | null>[],
      { ...golden, bars: golden.bars.slice(2) },
      ["var:__obs_prev2"],
    );
  });

  it("uses GOAL.md na=null for string history reads before warmup, not pine2py's float-nan sentinel", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars[0]!["var:__obs_prev"]).toBeNull();
    expect(result.bars[0]!["var:__obs_prev2"]).toBeNull();
    expect(result.bars[1]!["var:__obs_prev2"]).toBeNull();
  });

  it("alternates even/odd every bar and remembers 1-bar/2-bar-ago values once warmed up", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    const cur = result.bars.map((b) => b["var:__obs_cur"]);
    const prev = result.bars.map((b) => b["var:__obs_prev"]);
    const prev2 = result.bars.map((b) => b["var:__obs_prev2"]);

    expect(cur).toEqual(["even", "odd", "even", "odd", "even", "odd", "even", "odd", "even", "odd"]);
    expect(prev.slice(1)).toEqual(["even", "odd", "even", "odd", "even", "odd", "even", "odd", "even"]);
    expect(prev2.slice(2)).toEqual(["even", "odd", "even", "odd", "even", "odd", "even", "odd"]);
  });
});
