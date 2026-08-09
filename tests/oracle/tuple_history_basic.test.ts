// oracle/cases/tuple_history_basic.pine: top-level 튜플 디스트럭처 로컬 히스토리(C369, 히스토리
// 클러스터 (ii)슬라이스) 검증 — ta.macd 3-튜플([1]/[2])과 UDF 2-튜플 콜사이트 2곳([1]/[2]/동적
// bar_index%3) 양쪽 값 경로. 모든 이름은 튜플 문장에서 매 바 정확히 한 번만 대입되고 각 이름의
// 히스토리 읽기는 바당 1회 무조건 실행이라 pine2py ctx.param()의 inline push 순서 모호성/같은 바
// 다중 읽기 catch-up 오염(DIVERGENCES #6, MEMORY C365) 트리거를 원천 회피하는 구성이다
// (local_history_basic.test.ts와 동일 원칙). UDF 본문은 순수 산술만 담아 pine2py의 UDF 내부 ta
// 상태 이름-공유 버그(MEMORY C9)와도 무관하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_history_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: tuple_history_basic (top-level 튜플 디스트럭처 로컬 히스토리, C369)", () => {
  it("matches the pine2py golden bar-by-bar for ta.macd/UDF tuple locals' [1]/[2]/dynamic history", () => {
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
