// oracle/cases/color_basic.pine: color.* 상수 17종 + rgb/new/from_gradient(C78) — 전부 리터럴
// 인자(na 없음)라 바 데이터와 무관하게 매 바 동일값(math_const.pine/str_basic.pine과 동일 패턴).
// na 전파(rgb의 r/g/b=na)는 pine2py가 크래시해 오라클로 검증 불가 — runtime.test.ts에서
// hand-verified로 대체(LIMITATIONS.md 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "color_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_aqua",
  "var:__obs_black",
  "var:__obs_blue",
  "var:__obs_fuchsia",
  "var:__obs_gray",
  "var:__obs_green",
  "var:__obs_lime",
  "var:__obs_maroon",
  "var:__obs_navy",
  "var:__obs_olive",
  "var:__obs_orange",
  "var:__obs_purple",
  "var:__obs_red",
  "var:__obs_silver",
  "var:__obs_teal",
  "var:__obs_white",
  "var:__obs_yellow",
  "var:__obs_rgb0",
  "var:__obs_rgb1",
  "var:__obs_rgb2",
  "var:__obs_new0",
  "var:__obs_new1",
  "var:__obs_grad0",
  "var:__obs_grad1",
  "var:__obs_grad2",
  "var:__obs_grad3",
  "var:__obs_grad4",
];

describe("oracle: color_basic", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_aqua",
      "__obs_black",
      "__obs_blue",
      "__obs_fuchsia",
      "__obs_gray",
      "__obs_green",
      "__obs_lime",
      "__obs_maroon",
      "__obs_navy",
      "__obs_olive",
      "__obs_orange",
      "__obs_purple",
      "__obs_red",
      "__obs_silver",
      "__obs_teal",
      "__obs_white",
      "__obs_yellow",
      "__obs_rgb0",
      "__obs_rgb1",
      "__obs_rgb2",
      "__obs_new0",
      "__obs_new1",
      "__obs_grad0",
      "__obs_grad1",
      "__obs_grad2",
      "__obs_grad3",
      "__obs_grad4",
    ]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
