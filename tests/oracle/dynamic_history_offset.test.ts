// oracle/cases/dynamic_history_offset.pine: 동적(런타임) 히스토리 오프셋([]) 검증(C228, ROADMAP P3
// next_hint 1순위 -- corpus 클러스터링이 찾아낸 최다빈도 갭). 채널 A/B는 `close[i]`/`high[i + 1]`
// (i가 for 루프 카운터, 리터럴이 아닌 런타임 표현식)를 bar series에서, 채널 C는 파생 가격(hl2)에서
// 각각 offset이 컴파일타임에 알려지지 않은 경우를 pine2py 골든과 대조한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "dynamic_history_offset";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: dynamic_history_offset", () => {
  it("matches the pine2py golden bar-by-bar for close[i]/high[i+1]/hl2[j] dynamic offsets", () => {
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
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
