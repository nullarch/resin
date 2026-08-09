// oracle/cases/request_security_lower_tf.pine: request.security_lower_tf/request.quandl(신규,
// C310) — pine2py wavealgo/__init__.py L103-113/138-140이 symbol/timeframe/context를 전부
// 무시하는 순수 스텁이라(security_lower_tf는 expression을 원소 1개짜리 배열로 감싸고, quandl은
// 항상 0.0) 실제 close 시리즈 값에 종속된다(bar-dependent, request_financial과 다른 축).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_lower_tf";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_val", "var:__obs_size", "var:__obs_q", "var:__obs_q_bare"];

describe("oracle: request_security_lower_tf", () => {
  it("matches the pine2py golden bar-by-bar for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
