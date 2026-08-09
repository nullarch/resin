// oracle/cases/udt_field_container_method_call.pine: UDT 필드가 array<T>/map<K,V>일 때
// method-call 스타일 sugar(C222)가 필드 자체(단일 레벨 DotAccess, `obj.field.method(...)`)를
// 수신자로도 성립하는지 검증(C323, wild 실측 `id.d.unshift(x)`류 — resolveContainerExprKind가
// DotAccess/resolveUdtFieldTypeHint를 인식하도록 확장한 결과). udt_generic_field.pine이 이미
// 검증한 리터럴 네임스페이스 폼(`array.push(b.prices, ...)`)과 값이 동일해야 한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_field_container_method_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_size", "var:__obs_last", "var:__obs_tag", "var:__obs_contains"];

describe("oracle: udt_field_container_method_call", () => {
  it("matches the pine2py golden bar-by-bar for numeric/bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the observed channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMERIC_CHANNELS) {
      const name = key.slice("var:".length);
      const expected = decodeSentinel(golden.finalVarState[name]!);
      const actual = result.finalVarState[name];
      if (Number.isNaN(expected as number)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
