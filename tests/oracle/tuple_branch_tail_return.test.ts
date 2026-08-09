// oracle/cases/tuple_branch_tail_return.pine: 분기 꼬리(if/switch/삼항)의 튜플 UDF 콜/security
// passthrough 전파(C612, 배치32(1) 잔여) — 4채널 대조.
// (1) pick: if 분기 꼬리가 튜플 UDF 콜/튜플 리터럴 혼합(wild if<tuple-literal|udf-call>).
// (2) choose: subject-less switch 분기 꼬리가 튜플 UDF 콜(wild switch<udf-call>).
// (3) tern: UDF 마지막 문장이 삼항이고 양 분기가 튜플 값(wild ternary<...>).
// (4) wrapIf: if 분기 꼬리가 request.security(sym, tf, tupleUdf(...)) bare UDF 콜 — C432
//     passthrough(비-Series 값 그대로 통과)라 HTF 집계 없이 골든 대조 가능. HTF 집계가 실제로
//     일어나는 sec(tuple-lit) 분기 꼬리는 오라클 구조적 불가(C176)로 hand-verified 유닛 대체.
// 조건은 bar_index % N으로 바마다 토글해 then/else 양 분기가 골든에서 모두 실행된다(sample10은
// close>open이 전 바 true라 close 기반 조건으로는 else 커버리지가 0이 됨 — 실측 후 교체).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "tuple_branch_tail_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_p1",
  "var:__obs_p2",
  "var:__obs_q1",
  "var:__obs_q2",
  "var:__obs_r1",
  "var:__obs_r2",
  "var:__obs_w1",
  "var:__obs_w2",
];

describe("oracle: tuple_branch_tail_return", () => {
  it("matches the pine2py golden bar-by-bar for all eight channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all eight channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
