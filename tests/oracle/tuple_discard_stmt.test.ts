// oracle/cases/tuple_discard_stmt.pine: 문장 위치(값 폐기) bare 튜플 리터럴(C610, 배치32(2)) —
// UDF 본문 중간 early-exit 가드 `if x <= 0 \n [na, na]`(if 분기 마지막 튜플 폐기) + top-level
// 문장 if 분기 말미 튜플 폐기. pine2py는 bare Python 리스트 식 문장으로 방출해 평가 후 폐기가
// 동일 시맨틱(python 직접 확인). close가 104를 걸쳐 오르내려 가드 분기가 타는 바와 안 타는 바가
// 섞인다 — 폐기가 함수의 진짜 튜플 반환값을 오염시키지 않는지 바별 대조.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_discard_stmt";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: tuple_discard_stmt", () => {
  it("matches the pine2py golden bar-by-bar (discarded tuple in guard branch + top-level)", () => {
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
