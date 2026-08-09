// oracle/cases/request_security_lower_tf_kwargs.pine: request.security_lower_tf kwargs(C381) —
// symbol=/timeframe=/expression=/ignore_invalid_symbol=/ignore_invalid_timeframe=/calc_bars_count=
// 전량 키워드 인자 폼(위치+trailing kwarg 혼합/전체 키워드 폼 둘 다)이 pine2py의 순수 스텁 시맨틱
// (expression만 평가, 나머지는 전부 무시)과 golden 대조로 일치함을 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_lower_tf_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_v1", "var:__obs_v2", "var:__obs_v3"];

describe("oracle: request_security_lower_tf_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for all three channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all three channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
