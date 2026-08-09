// oracle/cases/time_channel_smoke.pine: request.security 0번째 슬라이스(ROADMAP P2 [hard->분할])
// 회귀 검증 — OHLCVData/Context에 옵셔널 `time` 채널을 추가해도 이 채널을 참조하는 코드가 아직
// 없으므로(request.security 자체는 다음 슬라이스) 계산 결과가 time 없는 케이스(smoke_var_sma)와
// 완전히 동일해야 한다(C129 원칙과 동형: 새 채널 추가가 기존 동작을 안 바꿈). oracle/data/
// time_channel_smoke.json은 sample10.json과 동일한 OHLCV에 `time`(unix ms, 10 연속일) 배열만
// 추가한 것 — gen_oracle.py가 이 필드를 `rt.context._time_data`로 수동 주입해도(SecurityManager를
// 호출하지 않는 스크립트라) 골든 값에 영향이 없음을 pine2py 쪽에서도 이미 확인.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "time_channel_smoke";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: time_channel_smoke (request.security 0th slice — optional time channel)", () => {
  it("matches the pine2py golden bar-by-bar even though the data carries a time[] array", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    expect(data.time).toBeDefined();
    expect(data.time).toHaveLength(10);

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
