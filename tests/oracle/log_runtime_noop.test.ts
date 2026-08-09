// oracle/cases/log_runtime_noop.pine: log.info/warning/error(전부 pine2py 순수 no-op) +
// runtime.warning(stderr 출력만 하는 진짜 no-op)이 계산값에 전혀 영향을 주지 않고 이후 문장이
// 그대로 이어지는지를 __obs_x 채널로 검증한다(C231). 가드된 runtime.error("never reached in this
// sample")는 이 10바 표본에서 한 번도 호출되지 않는다 — 실제 halt 동작은 hand-verified E2E
// (tests/unit/codegen.test.ts)로 별도 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "log_runtime_noop";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_x"];

describe("oracle: log_runtime_noop", () => {
  it("matches the pine2py golden bar-by-bar (log.*/runtime.warning no-op, computation unaffected)", () => {
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

    expect(result.finalVarState.__obs_x).toBe(golden.finalVarState.__obs_x);
  });
});
