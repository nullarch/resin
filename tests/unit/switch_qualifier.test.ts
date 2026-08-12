// C554: inferQualifier의 SwitchStmt 분기 정밀화 — switch "표현식"의 한정자는 subject/case 값/
// 각 암 결과의 병합(TV: simple subject + 리터럴 암 → simple). 근거는 wild 코퍼스 오프라인 확정:
// (a) ta.ema에 진짜 series length를 주면 TV 자신이 CE10123("An argument of series int type was
//     used but a simple int is expected")로 거부함 — corpus/wild/scripts_v56/11eaff708880.pine·
//     569b7f9fd0f7.pine 프로브가 TV 에러 원문을 인용.
// (b) 반면 "switch 리터럴 암은 simple을 반환"은 TV가 허용하는 실전 관용구 — 8f2aa9d0ea9d.pine
//     자체 주석("Switch expressions with literal arms return simple values")이 명시 문서화하며,
//     45b3591f3452/d434b524e8e6/ed39d2f54a30/d58c21c97598이 전부 이 패턴으로 ta.ema/atr/dmi length를
//     공급한다. 종전 "SwitchStmt → 무조건 series" 과대분류가 이들을 오탐 거부했다(DIVERGENCES #185).
// pine2py _infer_qualifier는 제어문 전부 SERIES지만 거긴 경고 전용이라 오라클 대조 축이 아니다.

import { describe, it, expect } from "vitest";
import { parse } from "../../src/transpiler/parser";
import { analyze } from "../../src/transpiler/analyzer";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

function analyzeSource(source: string) {
  return analyze(parse(source));
}

const EMA_SERIES_ERR = "length argument of 'ta.ema' cannot be 'series'";

describe("switch-expression qualifier — TV-simple shapes are accepted as ta.* length (C554)", () => {
  it("accepts a switch over an input.string subject with int-literal arms (wild 45b3591f3452 preset idiom)", () => {
    const prog = analyzeSource(
      [
        'mode = input.string("Standard")',
        "len = switch mode",
        '    "Fast" => 5',
        '    "Standard" => 9',
        "    => 14",
        "e = ta.ema(close, len)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts a switch over syminfo.root with literal arms (wild 8f2aa9d0ea9d cfgEmaLen idiom)", () => {
    const prog = analyzeSource(
      ["len = switch syminfo.root", '    "MES" => 18', '    "MNQ" => 11', "    => 20", "e = ta.ema(close, len)"].join(
        "\n",
      ),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts an input.int call as an arm value (wild d58c21c97598 'Custom' => emaFastLenInput idiom)", () => {
    const prog = analyzeSource(
      [
        'preset = input.string("Default")',
        "custom = input.int(9)",
        "len = switch preset",
        '    "Scalping" => 5',
        '    "Custom" => custom',
        "    => custom",
        "e = ta.ema(close, len)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts a ternary combining a switch-fed var and an input var (wild 8f2aa9d0ea9d effEmaLen idiom)", () => {
    const prog = analyzeSource(
      [
        "auto = input.bool(true)",
        "trendLen = input.int(20)",
        "cfgLen = switch syminfo.root",
        '    "MYM" => 17',
        "    => 20",
        "effLen = auto ? cfgLen : trendLen",
        "e = ta.ema(close, effLen)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts tuple-destructured names from a switch with tuple-literal arms (wild ed39d2f54a30 sensitivity idiom)", () => {
    const prog = analyzeSource(
      [
        'sens = input.string("Standard")',
        "[n1, n2] = switch sens",
        '    "High" => [3, 9]',
        '    "Standard" => [5, 20]',
        "    => [5, 20]",
        "e = ta.ema(close, n1)",
        "d = ta.ema(close, n2)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts a subjectless switch whose conditions are all non-series (input comparisons)", () => {
    const prog = analyzeSource(
      [
        "n = input.int(3)",
        "len = switch",
        "    n > 10 => 20",
        "    n > 5 => 10",
        "    => 5",
        "e = ta.ema(close, len)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("accepts a qualifier-prefixed typed declaration fed by a switch (wild d434b524e8e6 'simple int signalLen = switch ...')", () => {
    const prog = analyzeSource(
      [
        'horizon = input.string("Balanced")',
        "simple int signalLen = switch horizon",
        '    "Scalp" => 9',
        '    "Balanced" => 14',
        "    => 21",
        "a = ta.atr(signalLen)",
        "[dip, dim, adx] = ta.dmi(signalLen, signalLen)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("routes a switch-of-simples length for ta.sma to the fixed fast path (no spurious seriesLength varlen mark)", () => {
    const prog = analyzeSource(
      ['mode = input.string("A")', "len = switch mode", '    "A" => 3', "    => 5", "s = ta.sma(close, len)"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    const calls = [...prog.stateCallSlots.values()].filter((c) => c.fn === "sma");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.seriesLength).toBeUndefined();
  });
});

describe("switch-expression qualifier — genuinely-series shapes are still rejected (no blanket relaxation)", () => {
  it("still rejects a switch over a series subject", () => {
    const prog = analyzeSource(
      ["len = switch close > open", "    true => 5", "    => 10", "e = ta.ema(close, len)"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes(EMA_SERIES_ERR))).toBe(true);
  });

  it("still rejects a switch with a series arm value (bar_index arm)", () => {
    const prog = analyzeSource(
      ['mode = input.string("A")', "len = switch mode", '    "A" => 5', "    => bar_index", "e = ta.ema(close, len)"].join(
        "\n",
      ),
    );
    expect(prog.errors.some((e) => e.includes(EMA_SERIES_ERR))).toBe(true);
  });

  it("still rejects a subjectless switch with a series condition", () => {
    const prog = analyzeSource(
      ["len = switch", "    close > open => 5", "    => 10", "e = ta.ema(close, len)"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes(EMA_SERIES_ERR))).toBe(true);
  });

  it("conservatively rejects a multi-statement arm body (last-expression locals stay unresolved -> series)", () => {
    const prog = analyzeSource(
      ['mode = input.string("A")', "len = switch mode", '    "A" =>', "        t = 5", "        t", "    => 10", "e = ta.ema(close, len)"].join(
        "\n",
      ),
    );
    expect(prog.errors.some((e) => e.includes(EMA_SERIES_ERR))).toBe(true);
  });

  it("still rejects an array.get(arr, loopVar)-fed length (wild 97d0089adfbd exact shape — TV rejects this too, CE10123)", () => {
    const prog = analyzeSource(
      [
        "lens = array.from(5, 9, 14)",
        "for i = 0 to 2",
        "    l = array.get(lens, i)",
        "    e = ta.ema(close, l)",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes(EMA_SERIES_ERR))).toBe(true);
  });
});

describe("switch-fed ta.ema length executes identically to the literal length (pipeline)", () => {
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const data: OHLCVData = {
    open: closes,
    high: closes,
    low: closes,
    close: closes,
    volume: closes.map(() => 1),
  };

  function obs(source: string, key = "__obs_a"): unknown[] {
    return runPipeline(source, data).bars.map((b) => b[`var:${key}`]);
  }

  it("scalar switch result as ta.ema length matches ta.ema(close, 3) bar-by-bar", () => {
    const viaSwitch = obs(
      [
        'mode = input.string("EMA")',
        "len = switch mode",
        '    "EMA" => 3',
        "    => 5",
        "var float __obs_a = na",
        "__obs_a := ta.ema(close, len)",
      ].join("\n"),
    );
    const viaLiteral = obs(["var float __obs_a = na", "__obs_a := ta.ema(close, 3)"].join("\n"));
    expect(viaSwitch).toEqual(viaLiteral);
  });

  it("tuple-destructured switch results feed ta.ema and plain reads correctly", () => {
    const src = [
      'sens = input.string("Standard")',
      "[n1, n2] = switch sens",
      '    "High" => [2, 4]',
      '    "Standard" => [3, 6]',
      "    => [5, 20]",
      "var float __obs_a = na",
      "var float __obs_b = na",
      "__obs_a := ta.ema(close, n1)",
      "__obs_b := n2",
    ].join("\n");
    const result = runPipeline(src, data);
    const a = result.bars.map((b) => b["var:__obs_a"]);
    const b = result.bars.map((bb) => bb["var:__obs_b"]);
    const viaLiteral = obs(["var float __obs_a = na", "__obs_a := ta.ema(close, 3)"].join("\n"));
    expect(a).toEqual(viaLiteral);
    expect(b).toEqual(closes.map(() => 6));
  });
});
