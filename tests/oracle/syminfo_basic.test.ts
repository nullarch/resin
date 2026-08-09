// oracle/cases/syminfo_basic.pine: syminfo.* 14종(ROADMAP P2 "barstate/session/syminfo/timeframe"
// 두 번째 슬라이스) — 전부 pine2py @dataclass 기본값 그대로 고정된 컴파일타임 상수라
// math_const.pine/color_basic.pine과 동일하게 바 데이터와 무관하게 매 바 동일값. 문자열 10종/
// 숫자 4종으로 채널이 갈려 compareStringToGolden/compareToGolden을 onlyKeys로 나눠 각각 적용한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "syminfo_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_ticker",
  "var:__obs_tickerid",
  "var:__obs_prefix",
  "var:__obs_root",
  "var:__obs_description",
  "var:__obs_type",
  "var:__obs_basecurrency",
  "var:__obs_currency",
  "var:__obs_timezone",
  "var:__obs_session",
];

const NUMBER_CHANNELS = ["var:__obs_mintick", "var:__obs_minmove", "var:__obs_pointvalue", "var:__obs_pricescale"];

describe("oracle: syminfo_basic", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
    compareToGolden(result.bars, golden, NUMBER_CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBe(golden.finalVarState[name]);
    }
    for (const key of NUMBER_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBeCloseTo(golden.finalVarState[name] as number, 6);
    }
  });
});
