// oracle/cases/tuple_string_hist.pine: string 값을 받은 top-level 튜플 디스트럭처 로컬의 히스토리
// 인덱스(C749, wild hist-index(all) 잔여 — `[barSessionName, ...] = getSession(hr)` 뒤
// barSessionName[1]류, corpus/wild c3a7f5c91a6f.pine 실측 패턴 미러). string_eq_local_hist.test.ts
// (C690, '=' 로컬 대상)와 동일한 참조형 원형 버퍼($.refHistSlots, RefSeries)를 튜플 디스트럭처
// 원소에도 재사용 — index-access.ts의 tupleKind 가드에 "string"만 추가(C719 UDT/drawing 핸들
// 확장과 나란히), codegen은 기존 top-level refHistorySlots 바-종료 record 루프를 그대로 공유.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_string_hist";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: tuple_string_hist", () => {
  it("matches the pine2py golden bar-by-bar for the current (never-na) string channel", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, ["var:__obs_cur"]);
  });

  it("matches the pine2py golden for [1]/[2] string history once warmed up", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    compareStringToGolden(
      result.bars.slice(1) as unknown as Record<string, string | null>[],
      { ...golden, bars: golden.bars.slice(1) },
      ["var:__obs_prev"],
    );
    compareStringToGolden(
      result.bars.slice(2) as unknown as Record<string, string | null>[],
      { ...golden, bars: golden.bars.slice(2) },
      ["var:__obs_prev2"],
    );
  });

  it("uses GOAL.md na=null for string history reads before warmup, not pine2py's float-nan sentinel", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars[0]!["var:__obs_prev"]).toBeNull();
    expect(result.bars[0]!["var:__obs_prev2"]).toBeNull();
    expect(result.bars[1]!["var:__obs_prev2"]).toBeNull();
  });

  it("tracks session transitions across bars via the tuple-destructured name's own history, not the UDF's", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    const cur = result.bars.map((b) => b["var:__obs_cur"]);
    expect(cur).toEqual([
      "ASIAN", "ASIAN", "ASIAN", "OFF HOURS", "OFF HOURS", "OFF HOURS", "OFF HOURS", "OFF HOURS", "NEW YORK", "NEW YORK",
    ]);
  });
});
