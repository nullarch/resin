// oracle/cases/time_history_basic.pine: time 계열 빌트인 히스토리 인덱싱(time[n]/hour[n]/
// dayofweek[n]/동적 오프셋 time[bar_index % 3]/리플레이 상수 last_bar_index[n] 등, C368 —
// wild 1위 클러스터 슬라이스 (i)). pine2js는 Context의 time 전체 배열에서 (idx-n) 직접 합성
// ($.barTimeAt, histSlot 0개), pine2py 함수 모드는 ctx.param(ctx.time, "ctx.time")[n](읽기
// 시점 inline push)으로 같은 값을 만든다 — 케이스가 전 읽기를 top-level 무조건 + param 키당
// 바별 첫 읽기 1회 구조로 배치해 DIVERGENCES #6(조건부 스킵/같은 바 catch-up) 트리거가 없어
// 골든 대조가 성립한다. time_close(pine2py dead 0)/timenow(벽시계)는 케이스에서 제외 —
// tests/unit/time_history.test.ts의 hand-verified E2E가 담당.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

describe("oracle: time_history_basic (time 계열 빌트인 히스토리, C368)", () => {
  const CASE_NAME = "time_history_basic";
  const source = readFileSync(join(ROOT, "oracle", "cases", `${CASE_NAME}.pine`), "utf-8");

  it("matches the pine2py golden bar-by-bar (literal/dynamic offsets, warmup NaN, replay constants)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);

    expect(data.time).toBeDefined();
    expect(data.time).toHaveLength(10);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });

  it("consumes no history slots for the whole case (pure derivation from the time array)", async () => {
    // 이 축이 histSlot을 쓰기 시작하면(향후 리팩터링 회귀) 워밍업/record 타이밍 축이 통째로
    // 바뀌므로 구조 자체를 고정해둔다.
    const { transpile } = await import("../../src/transpiler/pipeline");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.historySlotCount).toBe(0);
  });
});
