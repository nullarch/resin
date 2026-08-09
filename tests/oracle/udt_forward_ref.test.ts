// oracle/cases/udt_forward_ref.pine: top-level TypeDecl forward-reference(C233) — `Point.new(...)`가
// `type Point` 선언보다 스크립트 앞쪽에 오는 패턴. TV/pine2py 둘 다 type 선언 순서 무관(hoisting)이
// 정상 동작이라(PROGRESS.md C232 next_hint, python 직접 실행으로 pine2py errors=[] 확인) analyzer.ts
// analyze()에 prepass(단일 패스 전 top-level TypeDecl 전부를 소스 순서대로 먼저 완전히 처리)를
// 추가해 pine2js도 동일하게 지원하도록 고쳤다. 채널: 생성자 위치 인자(x/y) + 필드 대입(':=') 러닝
// 합계까지 forward-ref 타입에서 정상 동작하는지 확인.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_forward_ref";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_p1_x", "var:__obs_p1_y", "var:__obs_p1_x_acc"];

describe("oracle: udt_forward_ref", () => {
  it("matches the pine2py golden bar-by-bar (forward-referenced UDT construction + field read/write)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state for the __obs_* mirrors", () => {
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
