// oracle/cases/ta_vwap_kwargs.pine: ta.vwap(source=close) 키워드 인자 오라클 검증(C471, next_hint
// (C470) 지시대로 wild 재스캔 후 신규 "키워드 인자" 잔여 클러스터 최다빈도 6건 해소 — 전량
// `ta.vwap(source = close)` 1-인자 폼). The keyword form is the positional form bar by bar. The
// pine2py golden is NOT ground truth for the values (it never resets; see ta_vwap.test.ts): on
// sample10.json's daily bars every bar starts a session, so ta.vwap(close) is the close (PyneCore
// lib/ta.py vwap, `anchor = session.isfirstbar`; tier 1 resin-harness ta_301_vwap).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_vwap_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_vwap_kwargs", () => {
  it("ta.vwap(source=close) on daily bars is the close on every bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(data.close.length);
    for (let i = 0; i < data.close.length; i++) expect(result.bars[i]!["var:__obs_vwap_kw"]).toBe(data.close[i]);
  });

  it("keyword form matches the positional form bar-by-bar (kwarg is a pure syntax-level normalization)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_vwap_kw"]).toBe(bar["var:__obs_vwap_pos"]);
    }
  });
});
