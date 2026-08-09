// oracle/cases/dynamic_offset_histslot.pine: histSlot 대상(top-level var / top-level '=' 로컬 /
// UDF param / UDF 내부 '=' 로컬 / UDF 내부 var)의 동적(런타임) 히스토리 오프셋 검증(C365, ROADMAP
// P4 🔴🔴 (c) 게이트 완화). 모듈로 순환 오프셋(0=현재 값 분기 포함)/음수 오프셋(항상 NaN)까지
// pine2py 골든과 대조 — pine2py는 이 축을 Series.__getitem__ 런타임 인덱싱으로 자연 지원(범위밖/
// 음수 -> nan)하므로 bar_index_dynamic_offset(C305)과 동일한 대조 구조.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "dynamic_offset_histslot";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// onlyKeys: pine2py는 UDF 내부 var(vacc2)도 flat ctx._var_state로 골든에 노출하지만 pine2js는
// 설계상 그 상태를 콜사이트별 $.fnVars에 격리해 var:<name> 채널로 노출하지 않는다
// (udf_history_basic.test.ts와 동일 사정) — __obs_* 채널만 비교. vacc2의 수치 자체는
// __obs_fvar_dyn(vacc2[nmod] 관측)이 바별로 그대로 검증한다.
const OBS_KEYS = [
  "var:__obs_var_dyn",
  "var:__obs_loc_dyn",
  "var:__obs_param_dyn",
  "var:__obs_flocal_dyn",
  "var:__obs_fvar_dyn",
  "var:__obs_neg_dyn",
];

describe("oracle: dynamic_offset_histslot", () => {
  it("matches the pine2py golden bar-by-bar for dynamic offsets on every histSlot target kind", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  // __obs_neg_dyn은 항상 na(음수 동적 오프셋 NaN 가드)라 nearlyEqual(NaN===NaN PASS)로 대조
  // (bar_index_dynamic_offset 선례 그대로 — toBeCloseTo는 NaN에서 실패).
  it("matches the pine2py golden final var state (__obs_* channels)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      if (!key.startsWith("__obs_")) continue;
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(expected))).toBe(true);
    }
  });
});
