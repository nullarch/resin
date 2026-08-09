// oracle/cases/request_financial_kwargs.pine: request.financial kwargs(C385, next_hint(C384)
// 1순위 — wild gate(220) 클러스터 재분포 2위) — pine2py wavealgo/__init__.py L118-120
// request_financial()이 kwargs 값과 무관하게 항상 float('nan')만 반환하는 순수 상수 스텁임을
// golden 대조로 검증한다(request_financial.test.ts와 동일한 nearlyEqual/decodeSentinel 패턴 —
// NaN 채널이라 toBe 대신 사용).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_financial_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_v1", "var:__obs_v2"];

describe("oracle: request_financial_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for both channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for both channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(golden.finalVarState[key]!))).toBe(true);
    }
  });
});
