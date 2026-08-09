// oracle/cases/string_var_hist.pine: string 타입 top-level var 히스토리 인덱스(C675, wild
// "string-hist" 클러스터 — `var string s = na` 뒤 s[1]/s[2]). drawing/UDT var(C637/C652)와 동일한
// 참조형 원형 버퍼($.refHistSlots, RefSeries)로 지원 — Float64Array 슬롯이 문자열을 담을 수 없다는
// 제약은 원래 array/map/matrix에만 물리적으로 성립하고, string은 object 원형 버퍼에 그대로 담긴다.
// na 표현 divergence: pine2py는 string na도 구조적으로 float('nan')로만 컴파일하지만(MEMORY.md
// "string na도 항상 float('nan')로 컴파일" 항목), pine2js는 GOAL.md na 3분할 규약대로 참조형 na=null.
// 워밍업 전(히스토리가 아직 없는 바)의 실제 값 채널은 골든과 직접 비교하고, na 셀은 골든의
// "NaN" 센티널과 리터럴 비교하지 않고 pine2js 자체 규약(null)만 확인한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "string_var_hist";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: string_var_hist", () => {
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
