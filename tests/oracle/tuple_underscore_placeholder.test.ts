// oracle/cases/tuple_underscore_placeholder.pine: [_, signalLine, _] = ta.macd(close, 2, 3, 2)
// 검증(C270 — '_' 플레이스홀더가 같은 튜플 디스트럭처링 문장 안에서 반복될 수 있음, corpus 실측
// `[_, signalLine, _] = ta.macd(...)`). analyzer가 '_'의 문장 내 반복만 예외로 허용하고 codegen이
// 두 번째부터 유일한 임시 이름(__tupleDiscardN)으로 치환해 방출하므로(MEMORY.md 참조), 이 골든은
// signal 채널이 ta_macd.pine(동일 fast/slow/signal 파라미터)의 golden과 바이트 단위로 일치해야
// '_' 반복 지원이 나머지 두 채널(macdLine/histLine) 값에 부수 영향을 주지 않았음을 함께 보증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_underscore_placeholder";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: tuple_underscore_placeholder", () => {
  it("matches the pine2py golden bar-by-bar for repeated '_' targets in one tuple destructure", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

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
