// oracle/cases/ta_pvt_wad.pine: ta.pvt()/ta.wad() 검증(ROADMAP P2 "ta.* 44종" — pvt/wad). 둘 다
// 인자 없음(close/volume 또는 high/low/close 암묵 사용), sample10.json 전 구간 관측.
// Bar 0 __obs_pvt is hand-edited over pine2py's 0 seed to na, the tier-2 value: ta.pvt is
// ta.cum((ta.change(close) / close[1]) * volume) and bar 0 has no previous close (ref_v6_ta_math.txt
// f_pvt; resin-harness state/repros/cum-na-obv-pvt.json, same data; tier 1 harness tv
// ta_341_accdist_pvi_pvt_wad_wvad). ta.wad is 0 there (its gain is 0 on an na change).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_pvt_wad";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_pvt_wad", () => {
  it("matches the pine2py golden bar-by-bar for ta.pvt/ta.wad", () => {
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
