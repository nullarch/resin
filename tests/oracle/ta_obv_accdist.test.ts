// oracle/cases/ta_obv_accdist.pine: ta.obv()/ta.accdist() 검증(ROADMAP P2 "ta.* 44종" —
// obv/accdist). 둘 다 인자 없음(close/high/low/volume 암묵 사용), sample10.json 전 구간 관측.
// Bar 0 __obs_obv is hand-edited over pine2py's 0 seed to na, the tier-2 value: ta.obv is
// ta.cum(math.sign(ta.change(close)) * volume) and bar 0 has no previous close (ref_v6_ta_math.txt
// f_obv; resin-harness state/repros/cum-na-obv-pvt.json, same data; tier 1 harness tv
// ta_051_iii_nvi_obv).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_obv_accdist";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_obv_accdist", () => {
  it("matches the pine2py golden bar-by-bar for ta.obv/ta.accdist", () => {
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
