// oracle/cases/na_basic.pine: na(x) bare(비-namespace) 빌트인 콜 검증(C219 next_hint 1순위).
// close[20]은 10바 데이터셋에서 항상 범위 밖(na)이라 true 분기를, close(항상 non-na)로 false
// 분기를, standalone na 리터럴을 na()에 다시 넘긴 na(na)로 리터럴/콜 두 파서 경로가 공존해도
// 서로 깨지지 않음을 매 바 동일하게 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "na_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: na_basic", () => {
  it("matches the pine2py golden bar-by-bar for na(x) true/false/literal branches", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
