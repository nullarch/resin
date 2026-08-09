// oracle/cases/fill_basic.pine: fill() 신규 구현 + plot()/hline()의 대입-RHS 지원(`p1 = plot(...)`,
// `h1 = hline(...)`) 신규 구현(C209, PROGRESS next_hint 1순위 -- corpus 최다빈도 fill() 패턴 12건
// 실측). fill()/plot()/hline()의 반환 핸들 자체는 오라클 관측 불가(ctx.plots 죽은 채널)라, fill()에
// 넘기는 series(upper/lower)가 이 신규 문장들과 섞여도 정상 계산됨을 __obs_upper/__obs_lower
// 미러 채널로 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "fill_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_upper", "var:__obs_lower"];

describe("oracle: fill_basic", () => {
  it("matches the pine2py golden bar-by-bar for the upper/lower band channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("transpiles plot()/hline() assignment-RHS + fill() without crashing and keeps values unaffected", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_upper).toBeCloseTo(107.9138857956, 9);
    expect(v.__obs_lower).toBeCloseTo(105.4194475378, 9);
  });
});
