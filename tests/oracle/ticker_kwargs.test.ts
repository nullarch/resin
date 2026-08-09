// oracle/cases/ticker_kwargs.pine: ticker.new/modify/renko kwargs(C385, next_hint(C384) 1순위 —
// wild gate(220) 클러스터 재분포 2/3/6위) — wild 실사용 키워드 인자 이름을 pine2py의
// ticker_new/modify/renko 시맨틱과 golden 대조로 검증한다(반환값에 실제로 쓰이는 첫 슬롯이 kwarg
// 폼에서도 정확한 위치로 낮춰지는지가 핵심).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ticker_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_new_full", "var:__obs_new_mixed", "var:__obs_new_ticker_only", "var:__obs_mod", "var:__obs_renko_full"];

describe("oracle: ticker_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for all five channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all five channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
