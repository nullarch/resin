// oracle/cases/enum_forward_ref.pine: top-level EnumDecl forward-reference(C255) — `Dir.Up` 멤버
// 참조가 `enum Dir` 선언보다 스크립트 앞쪽에 오는 패턴(corpus 실측 3건). TV/pine2py 둘 다 enum
// 선언 순서 무관(hoisting)이 정상 동작이라(python 직접 실행으로 pine2py errors=[] 확인)
// analyzer/udt-decls.ts에 prepassEnumDecl(udt_forward_ref.pine의 TypeDecl prepass와 동일 원칙)을
// 추가해 pine2js도 동일하게 지원하도록 고쳤다. enum_basic.pine과 동일하게 값 자체가 아니라 등가
// 비교 결과만 관측한다(pine2py/pine2js enum 값 표현 방식 차이 회피).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "enum_forward_ref";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_is_up", "var:__obs_is_down"];

describe("oracle: enum_forward_ref", () => {
  it("matches the pine2py golden bar-by-bar (forward-referenced enum member access)", () => {
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
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
