// oracle/cases/udf_history_nested.pine: UDF 본문 안 if 블록에 중첩(nested)된 '=' 로컬의 히스토리
// (C388 — wild top/btm류 클러스터(C387 next_hint)가 노출한 `[if ...] max = ...; ...; max[1]` 패턴).
// C364까지는 udf-body 루트에서 '='로 선언된 이름만 히스토리 지원 대상이었으나(declScopeKind 게이트),
// resolveFuncInternalRole의 조상-스코프 탐색이 "읽기 지점이 선언 스코프의 자손"임을 이미 구조적으로
// 보장해(JS let 블록 스코프 가시성과 동일 조건) 중첩 여부와 무관히 안전함을 확인, 게이트를 제거했다.
// 이 오라클 케이스는 그 안전성 주장을 pine2py와 직접 대조해 검증한다: 조건(`close > 103`)이 처음
// 몇 바는 거짓이라 선언 자체가 스킵되는 바가 있고(NaN 갭 유발), 이후 매 바 조건이 참이 되는 구간도
// 포함해 "선언 스킵 → 갭" / "선언 실행 → 이전 값" 두 축을 모두 골든으로 확인한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_history_nested";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: udf_history_nested", () => {
  it("matches the pine2py golden bar-by-bar for a UDF if-nested '=' local's [1] history", () => {
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
