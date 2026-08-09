// oracle/cases/ta_supertrend.pine: ta.supertrend(factor, atrPeriod) 검증 (ROADMAP P2 "ta.* 44종" —
// supertrend). **Intentionally diverges from the pine2py golden** (DIVERGENCES.md #10): supertrend's
// band/direction state is re-seeded every bar from ta.atr's output, and rt.ta.atr (O(1) RMA
// streaming, C53) warms up one bar earlier than pine2py's re-scan atr.py - so the very first valid
// bar (and its seeded band values) lands on a different bar than golden, and that seed then
// propagates through the whole subsequent band/direction trajectory. For this short 10-bar
// sample10.json series there's no additional long-series windowing drift (DIVERGENCES.md #8 point 2
// only applies past length+10 bars), so pine2js and golden happen to match exactly for every bar
// once both are warmed up (bar4 onward) - but that's a property of this short fixture, not a
// guarantee, so this test does NOT use compareToGolden. Values are cross-checked via
// scratch/probe_supertrend.mjs against a literal line-by-line port of supertrend.py's incremental
// branch (see runtime.test.ts's own supertrend describe block for the broader fuzz coverage).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_supertrend";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_supertrend", () => {
  it("golden confirms pine2py is NaN through bar2 and valid from bar3 (one bar later than pine2js, DIVERGENCES.md #10)", () => {
    const golden = loadGolden(CASE_NAME);
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_value"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_direction"]).toBe(0);
    }
    expect(golden.bars[3]!["var:__obs_value"]).toBe(95.5);
    expect(golden.bars[3]!["var:__obs_direction"]).toBe(1);
  });

  it("pine2js is valid one bar earlier (bar2) with a different transient value (96.5 vs golden's bar3=95.5), matching golden bar-for-bar from bar4 onward", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    const expected: [number, number][] = [
      [NaN, 0],
      [NaN, 0],
      [96.5, 1],
      [96.5, 1],
      [97.5, 1],
      [98.5, 1],
      [99.5, 1],
      [99.5, 1],
      [100.5, 1],
      [101.5, 1],
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const [value, direction] = expected[i]!;
      if (Number.isNaN(value)) {
        expect(result.bars[i]!["var:__obs_value"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(value, 9);
      }
      expect(result.bars[i]!["var:__obs_direction"]).toBe(direction);
    }

    // 골든과 bar4부터 실제로 일치함을 명시적으로 재확인(이 짧은 샘플에 한정된 우연 — 일반 보장 아님).
    const golden = loadGolden(CASE_NAME);
    for (let i = 4; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(golden.bars[i]!["var:__obs_value"] as number, 9);
      expect(result.bars[i]!["var:__obs_direction"]).toBe(golden.bars[i]!["var:__obs_direction"]);
    }
  });
});
