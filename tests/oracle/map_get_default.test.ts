// oracle/cases/map_get_default.pine: map.get(m, key, default) 3-인자 폼(C241, C240 next_hint 1순위,
// corpus 161개 파일 실사용 패턴 대상) — map_basic.pine(C89)이 다루지 않은 3-인자 default 채널
// 전용 오라클. golden(gen_oracle.py, python 직접 실행) 결과가 present-key는 default 무시하고
// 저장값을 그대로 반환, absent-key는 default를 그대로 반환, default 없는 2-인자 폼은 여전히
// na(NaN)임을 확정 — pine2py map_funcs.py get(m, key, default=nan) literal port가 정확함을 확인.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "map_get_default";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_present", "var:__obs_absent", "var:__obs_counter", "var:__obs_absent_no_default"];

describe("oracle: map_get_default", () => {
  it("matches the pine2py golden bar-by-bar for the 3-arg default channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the observed channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMERIC_CHANNELS) {
      const name = key.slice("var:".length);
      const expected = decodeSentinel(golden.finalVarState[name]!);
      const actual = result.finalVarState[name];
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
