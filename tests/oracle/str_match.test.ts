// oracle/cases/str_match.pine: str.match — regex search, returns the first matched substring
// (or "" if no match). C574 정정: 원래 pine2py의 bool(re.search(...)) golden과 바이트 대조했으나,
// DIVERGENCES.md #44가 확정한 대로 TV 공식 반환형은 string이라 이 오라클 골든(전부 true/false)은
// 이 시맨틱을 검증할 수 없다 — oracle/golden/str_match.json 자체는 불변 유지(수정 금지 원칙)하고
// 이 테스트만 hand-verified 값으로 대체(scratch/c574_match_probe.mjs로 node RegExp 교차 확인).
// na 전파(source/pattern=na) 경로는 여전히 pine2py가 크래시해 오라클로 검증 불가 —
// runtime.test.ts에서 hand-verified로 대체(LIMITATIONS.md 참조). word-boundary(\b) 패턴은
// pine2py codegen이 "\b"를 이스케이프로 그대로 보존해 생성된 Python 소스에 옮기는데, Python
// 자신의 문자열 리터럴 문법이 \b를 백스페이스 문자로 해석해버려(Pine이 실제로 \b를 이 의미로
// 정의하는지와 무관한 codegen 부작용) 오라클로 검증 불가 — DIVERGENCES.md 참조, 이 채널은
// 오라클 케이스에서 의도적으로 제외.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_match";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// oracle/cases/str_match.pine 채널별 hand-verified 기대값 — node RegExp .exec() 직접 실행으로
// 산출(scratch/c574_match_probe.mjs), 15개 정규식 패턴 교차 실측 결과와 일치.
const EXPECTED: Record<string, string> = {
  __obs_a: "123", // str.match("price 123", "\d+")
  __obs_b: "", // str.match("hello", "\d+") — no match
  __obs_c: "", // str.match("hello", "") — empty pattern matches empty substring
  __obs_d: "", // str.match("", "") — empty pattern matches empty substring
  __obs_e: "", // str.match("", "\d+") — no match
  __obs_f: "he", // str.match("hello", "^he")
  __obs_g: "", // str.match("hello", "^ell") — anchored, no match
  __obs_h: "lo", // str.match("hello", "lo$")
  __obs_i: "", // str.match("Hello", "hello") — case-sensitive, no match
  __obs_j: "abc123", // str.match("abc123", "[a-z]+\d+")
  __obs_k: "cat", // str.match("cat", "cat|dog")
  __obs_l: "aaa", // str.match("aaa", "a{2,3}") — greedy quantifier
  __obs_m: "", // str.match("hello", "[") — invalid regex, treated as no match
  __obs_n: "a.b", // str.match("a.b", "a\.b")
};

describe("oracle: str_match", () => {
  it("matches the hand-verified TV-correct string result bar-by-bar for all fourteen channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      for (const [key, expected] of Object.entries(EXPECTED)) {
        expect(bar[`var:${key}`]).toBe(expected);
      }
    }
  });

  it("matches the hand-verified TV-correct string result in final var state for all fourteen channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(EXPECTED)) {
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});

describe("wild pattern regression: str.tonumber(str.match(timeframe.period, '[0-9]*')) no longer crashes (C574)", () => {
  it("runs through the full pipeline without throwing 'value.trim is not a function' (wild exec cluster, corpus_scan --exec)", () => {
    // 독립 저자 3+건(corpus/wild/scripts_v56: 561e1198c753/8c525c7bdf9a/8c7e2c07b644.pine)의
    // `timeframeNumberstr = str.match(timeframe.period, '[0-9]*') / timeframeNumber =
    // str.tonumber(timeframeNumberstr)` 관용구. timeframe.period는 컴파일타임에 "D"로 폴딩되고
    // (analyzer.ts TIMEFRAME_STRING_PROPS), `[0-9]*`는 "D"에서 위치 0의 빈 문자열에 매치 —
    // str.match가 bool을 반환하던 정정 전에는 str.tonumber(false)가 `false.trim()`으로 크래시했다.
    const source = [
      "var string __obs_a = na",
      "__obs_a := str.match(timeframe.period, '[0-9]*')",
      "var float __obs_b = na",
      "__obs_b := str.tonumber(str.match(timeframe.period, '[0-9]*'))",
    ].join("\n");
    const data = loadOracleData(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_a).toBe("");
    expect(result.finalVarState.__obs_b).toBeNaN();
  });
});
