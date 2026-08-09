// oracle/cases/for_in_loop.pine: for-in 루프(`for x in arr` / `for [i, v] in arr` /
// `for [k, v] in map` / `for k in map`) analyzer+codegen 실제 구현(C216, C215가 남긴 파서
// 슬라이스의 후속) -- pine2py parser.py _parse_for(L392-441)/codegen.py _gen_for_in(L525-537)
// literal port. array는 인덱스 for로 데슈가링, map은 네이티브 JS Map for...of(entries/keys)
// 재사용(genForInStmt 주석 참조). 이 오라클은 bare array 순회 합/destructure array 인덱스-가중
// 합/destructure map 값 합/bare map 키 카운트/break/continue를 각 __obs_* 채널로 bar-by-bar 검증한다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "for_in_loop";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_sum_bare_array",
  "var:__obs_weighted_array",
  "var:__obs_sum_map",
  "var:__obs_key_count",
  "var:__obs_break",
  "var:__obs_continue",
];

describe("oracle: for_in_loop", () => {
  it("matches the pine2py golden bar-by-bar for bare/destructure array and map for-in, plus break/continue", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("renders the exact accumulated values at the final bar (all '=' locals are reset+resummed every bar, so constant across bars)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_sum_bare_array).toBe(60); // 10 + 20 + 30
    expect(v.__obs_weighted_array).toBe(80); // 10*0 + 20*1 + 30*2
    expect(v.__obs_sum_map).toBe(6); // 1 + 2 + 3
    expect(v.__obs_key_count).toBe(3);
    expect(v.__obs_break).toBe(10); // stops before adding 20 (20 > 15)
    expect(v.__obs_continue).toBe(40); // 10 + 30, skips 20
  });
});
