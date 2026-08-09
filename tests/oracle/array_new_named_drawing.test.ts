// oracle/cases/array_new_named_drawing.pine: array.new_label/new_line/new_box/new_table/
// new_linefill(size, initial_value) -- v4식 명명 typed array 생성자(drawing 핸들 전용, C236).
// pine2py가 5종 전부 array.new<T> 제네릭(C230)과 동일한 무타입 단일 생성자로 라우팅해
// array_new_generic_types.test.ts와 동일하게 array.size() 채널만 비교한다(원소 자체는 참조형
// 핸들이라 수치 비교 무의미).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_new_named_drawing";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_labels_size0",
  "var:__obs_lines_size0",
  "var:__obs_boxes_size0",
  "var:__obs_tables_size0",
  "var:__obs_fills_size0",
  "var:__obs_labels_size_after",
];

describe("oracle: array_new_named_drawing", () => {
  it("matches the pine2py golden bar-by-bar for array.size() channels (named typed drawing constructors)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the size channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_labels_size0",
      "__obs_lines_size0",
      "__obs_boxes_size0",
      "__obs_tables_size0",
      "__obs_fills_size0",
      "__obs_labels_size_after",
    ]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
