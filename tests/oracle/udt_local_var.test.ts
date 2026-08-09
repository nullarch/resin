// oracle/cases/udt_local_var.pine: '=' 로컬 UDT 인스턴스 추적(C224) -- var 선언 UDT는 udt_basic.pine이
// 이미 커버하므로 여기서는 '=' 로컬 전용 채널(채널 A: 매 바 재생성된 인스턴스의 필드 대입/읽기,
// 채널 B: '=' 로컬 필드 읽기를 var 누적기 RHS로 사용)만 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_local_var";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_p_x", "var:__obs_p_n", "var:acc", "var:__obs_acc"];

describe("oracle: udt_local_var", () => {
  it("matches the pine2py golden bar-by-bar ('=' local UDT field write/read, __obs_* mirrors + acc)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const prefixed of OBS_KEYS) {
      const key = prefixed.slice("var:".length);
      const expected = golden.finalVarState[key];
      if (expected === undefined) continue;
      const actual = result.finalVarState[key];
      if (typeof expected === "number" && typeof actual === "number") {
        expect(actual).toBeCloseTo(expected, 6);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
