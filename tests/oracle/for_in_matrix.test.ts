// oracle/cases/for_in_matrix.pine: for-in 루프 이터러블 판별 확장(C709) -- (1) matrix(TV가 행
// 단위 array로 순회, matrix.ts PineMatrix가 이미 unknown[][]라 JS 네이티브 for-of가 그대로
// 동형) (2) UDT 필드 DotAccess 별칭 '=' 로컬(`aliasedVals = basket.vals`류, resolveContainerExprKind
// 자신은 이미 DotAccess를 지원했으나 analyzeAssignment/VarDecl의 별칭 게이트가 Identifier/
// TernaryOp/CallExpr로만 좁아 진입이 막혀 있었음). 이 오라클은 matrix 행 순회 합/destructure
// 행 인덱스-가중 합/UDT 필드 별칭 array for-in 합을 각 __obs_* 채널로 bar-by-bar 검증한다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "for_in_matrix";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_matrix_sum", "var:__obs_matrix_weighted", "var:__obs_alias_sum"];

describe("oracle: for_in_matrix", () => {
  it("matches the pine2py golden bar-by-bar for matrix row for-in and UDT-field-alias array for-in", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("renders the exact accumulated values at the final bar (all '=' locals are reset+resummed every bar)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_matrix_sum).toBe(21); // 1+2+3+4+5+6
    expect(v.__obs_matrix_weighted).toBe(4); // row0.get(0)*0 + row1.get(0)*1 = 1*0 + 4*1
    expect(v.__obs_alias_sum).toBe(15); // (1+2) + (3+4+5)
  });
});
