// oracle/cases/request_earnings.pine: request.earnings(신규, C397 — wild kwarg 블랑켓 잔여 94건
// 재세분류 1위) — pine2py wavealgo/__init__.py L130-132 request_earnings()이 인자/kwargs 값과
// 무관하게 항상 0.0만 반환하는 순수 상수 스텁임을 골든 대조로 검증한다(request_dividends_splits.
// test.ts와 동일한 compareToGolden 패턴).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_earnings";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_v1", "var:__obs_v2", "var:__obs_v3", "var:__obs_bare"];

describe("oracle: request_earnings", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(golden.finalVarState[key]!))).toBe(true);
    }
  });
});
