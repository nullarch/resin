// oracle/cases/method_receiver_reserved_word.pine: method(receiver, ...)의 첫 매개변수(receiver)
// 이름이 JS 예약어 `this`인 corpus 실사용 패턴(C271, corpus_scan `new Function` 미탐지 38건의
// 대표 형태 -- `method isInRange(Bin this, float val) =>`류). codegen이 이 이름을 literal JS
// 파라미터로 방출하면 "Unexpected token 'this'" SyntaxError였다 -- safeLocalName 접미사 치환으로
// 해소됐는지 pine2py 골든과 바별 수치까지 대조한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "method_receiver_reserved_word";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_result"];

describe("oracle: method_receiver_reserved_word", () => {
  it("matches the pine2py golden bar-by-bar (method receiver named 'this' does not corrupt values)", () => {
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
