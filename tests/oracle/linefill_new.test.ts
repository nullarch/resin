// oracle/cases/linefill_new.pine: linefill.new/delete(C238, ROADMAP P3 next_hint 1순위 --
// corpus 실측 b7dde3c9d51e.pine). pine2py FUNC_MAP이 linefill 5종 전부(new 포함) drawing_noop
// 인 순수 no-op이라(GOAL.md "drawing 객체는 no-op") 관측 가능한 값이 없다 -- close가 그대로
// 통과하는지(크래시 없이 파이프라인 전체가 도는지)만 비교한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "linefill_new";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_close", "var:__obs_close_after_delete"];

describe("oracle: linefill_new", () => {
  it("matches the pine2py golden bar-by-bar for the close-passthrough channels (linefill.new/delete are pure no-ops)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_close", "__obs_close_after_delete"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
