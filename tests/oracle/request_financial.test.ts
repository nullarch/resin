// oracle/cases/request_financial.pine: request.financial(신규, C257) — pine2py
// wavealgo/__init__.py L118-120 request_financial이 인자 전부 무시하고 항상 NaN을 반환하는
// 순수 스텁이라 bar-independent(request_dividends_splits.pine과 동일 관례). 단 값 자체가 NaN이라
// finalVarState 비교는 다른 대다수 케이스의 toBe 대신 nearlyEqual(NaN===NaN을 PASS로 취급, C239와
// 달리 0.0이 아니라 NaN 스텁이라 ta_pivot.test.ts와 동일한 패턴 필요)을 쓴다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_financial";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_fin", "var:__obs_fin_bare"];

describe("oracle: request_financial", () => {
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
