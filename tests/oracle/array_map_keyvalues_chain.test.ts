// oracle/cases/array_map_keyvalues_chain.pine: map.keys()/map.values()의 method-call 스타일
// 체이닝(C455, wild acc6a643ba18.pine `foot_bar.foot_max_price_vol.values().size()`류) —
// isArrayConstructorCall이 리터럴 `map.values(m)` 형태만 array로 인정하고 sugar 체이닝
// `m.values()`/`m.keys()`는 놓치던 비대칭을 수정한 뒤 top-level var 수신자와 UDT 필드(DotAccess)
// 수신자 둘 다 실제 bar 데이터(sample10.json)로 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_map_keyvalues_chain";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_values_size",
  "var:__obs_values_sum",
  "var:__obs_keys_size",
  "var:__obs_field_values_sum",
  "var:__obs_field_keys_size",
];

describe("oracle: array_map_keyvalues_chain", () => {
  it("matches the pine2py golden bar-by-bar for numeric channels", () => {
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
      if (Number.isNaN(expected as number)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
