// oracle/cases/udf_single_var.pine: UDF 내부 var(bar 간 누적 상태) + 단일 콜사이트. pine2py 골든의
// "var:total" 채널은 무시한다 — pine2py는 UDF 내부 var도 ctx._var_state에 이름 하나로 노출하지만
// pine2js는 그 상태를 콜사이트 전용 $.fnVars 슬롯에 격리해 top-level var:<name> 채널에 노출하지
// 않는다(의도된 격리 설계, tests/helpers/golden.ts의 onlyKeys 참조). 관측은 __obs_s 미러로만 한다.
// (두 개 이상의 콜사이트가 같은 UDF를 부를 때 상태가 독립적으로 분리되는지는 pine2py가 이름
// 문자열 하나로 모든 콜사이트를 공유하는 버그가 있어 오라클로 검증할 수 없다 — 그 검증은
// tests/unit/codegen.test.ts의 hand-verified 케이스가 담당한다, GOAL.md Architecture Decisions 참조)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_single_var";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: udf_single_var", () => {
  it("matches the pine2py golden bar-by-bar on the __obs_s observation channel", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_s"]);
  });

  it("matches the pine2py golden final __obs_s value", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_s).toBeCloseTo(golden.finalVarState.__obs_s as number, 6);
  });
});
