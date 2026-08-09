// label/line/box get_*/set_* 실 accessor + func-local `var box/label/line X = na` na=null 코드젠
// (C572, LIMITATIONS C571 승계) — wild `str.replace_all(label.get_text(h),...)` 류가
// "Cannot read properties of undefined" exec 크래시를 냈던 클러스터의 회귀 테스트. pine2py는
// 이 getter들도 drawing_noop(값 discard)으로 뭉개는 latent 버그라 오라클 대조 불가 — hand-verified.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import {
  newLabel,
  newLine,
  newBox,
  labelGetX,
  labelGetY,
  labelGetText,
  labelSetX,
  labelSetY,
  labelSetXy,
  labelSetText,
  lineGetX1,
  lineGetY1,
  lineGetX2,
  lineGetY2,
  lineGetPrice,
  lineSetX1,
  lineSetXy1,
  lineSetXy2,
  lineSetFirstPoint,
  boxGetLeft,
  boxGetRight,
  boxGetTop,
  boxGetBottom,
  boxSetTop,
  boxSetLefttop,
  boxSetRightbottom,
  boxSetTopLeftPoint,
  boxSetBottomRightPoint,
  chartPointFromIndex,
} from "../../src/runtime/drawing";

function obs(source: string, data: OHLCVData, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

const FLAT_DATA: OHLCVData = { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 1, 1] };

describe("drawing.ts label/line/box get_*/set_* accessors (unit, no oracle)", () => {
  it("label.new(x, y, text) seeds state; get_x/get_y/get_text read it back", () => {
    const h = newLabel(5, 100.5, "hi");
    expect(labelGetX(h)).toBe(5);
    expect(labelGetY(h)).toBe(100.5);
    expect(labelGetText(h)).toBe("hi");
  });

  it("label.new(x, y) with text omitted defaults to \"\" (TV default), not null", () => {
    const h = newLabel(5, 100.5);
    expect(labelGetText(h)).toBe("");
  });

  it("label.set_x/set_y/set_xy/set_text mutate the same handle set_* writes", () => {
    const h = newLabel(0, 0, "");
    labelSetX(h, 7);
    labelSetY(h, 42);
    labelSetText(h, "updated");
    expect(labelGetX(h)).toBe(7);
    expect(labelGetY(h)).toBe(42);
    expect(labelGetText(h)).toBe("updated");
    labelSetXy(h, 1, 2);
    expect(labelGetX(h)).toBe(1);
    expect(labelGetY(h)).toBe(2);
  });

  it("line.new(x1,y1,x2,y2) seeds state; get_x1/y1/x2/y2 read it back", () => {
    const h = newLine(0, 100, 10, 200);
    expect(lineGetX1(h)).toBe(0);
    expect(lineGetY1(h)).toBe(100);
    expect(lineGetX2(h)).toBe(10);
    expect(lineGetY2(h)).toBe(200);
  });

  it("line.get_price linearly interpolates between the two endpoints", () => {
    const h = newLine(0, 100, 10, 200);
    expect(lineGetPrice(h, 0)).toBe(100);
    expect(lineGetPrice(h, 10)).toBe(200);
    expect(lineGetPrice(h, 5)).toBe(150);
  });

  it("line.get_price on a vertical line (x1===x2) is na, not a crash", () => {
    const h = newLine(3, 100, 3, 200);
    expect(Number.isNaN(lineGetPrice(h, 3))).toBe(true);
  });

  it("line.set_xy1/set_xy2/set_first_point write both coordinates of one endpoint", () => {
    const h = newLine(0, 0, 0, 0);
    lineSetXy1(h, 1, 2);
    lineSetXy2(h, 3, 4);
    expect([lineGetX1(h), lineGetY1(h), lineGetX2(h), lineGetY2(h)]).toEqual([1, 2, 3, 4]);
    lineSetFirstPoint(h, chartPointFromIndex(9, 99));
    expect([lineGetX1(h), lineGetY1(h)]).toEqual([9, 99]);
  });

  it("box.new(left,top,right,bottom) seeds state; get_left/right/top/bottom read it back", () => {
    const h = newBox(0, 100, 5, 90);
    expect(boxGetLeft(h)).toBe(0);
    expect(boxGetTop(h)).toBe(100);
    expect(boxGetRight(h)).toBe(5);
    expect(boxGetBottom(h)).toBe(90);
    boxSetTop(h, 150);
    expect(boxGetTop(h)).toBe(150);
    boxSetLefttop(h, 1, 200);
    expect([boxGetLeft(h), boxGetTop(h)]).toEqual([1, 200]);
  });

  it("box.set_top_left_point/set_bottom_right_point(id, point) write left/top and right/bottom from a chart.point (C619, box counterpart of line.set_first_point/set_second_point)", () => {
    const h = newBox(0, 0, 0, 0);
    boxSetTopLeftPoint(h, chartPointFromIndex(3, 150));
    boxSetBottomRightPoint(h, chartPointFromIndex(9, 50));
    expect([boxGetLeft(h), boxGetTop(h), boxGetRight(h), boxGetBottom(h)]).toEqual([3, 150, 9, 50]);
  });

  it("box.set_top_left_point/set_bottom_right_point fall back to a chart.point's time when index is na, and to NaN when both are na", () => {
    const h = newBox(0, 0, 0, 0);
    boxSetTopLeftPoint(h, { time: 42, index: null, price: 7 });
    expect([boxGetLeft(h), boxGetTop(h)]).toEqual([42, 7]);
    boxSetBottomRightPoint(h, { time: null, index: null, price: null });
    expect(Number.isNaN(boxGetRight(h))).toBe(true);
    expect(Number.isNaN(boxGetBottom(h))).toBe(true);
  });

  it("box.set_top_left_point/set_bottom_right_point on a null point (na) or null handle silently write/discard na, not a crash", () => {
    const h = newBox(0, 0, 0, 0);
    expect(() => boxSetTopLeftPoint(h, null)).not.toThrow();
    expect(Number.isNaN(boxGetLeft(h))).toBe(true);
    expect(() => boxSetBottomRightPoint(null, chartPointFromIndex(1, 2))).not.toThrow();
  });

  it("box.set_rightbottom(right, bottom) mirrors set_lefttop for the opposite corner", () => {
    const h = newBox(0, 0, 0, 0);
    boxSetRightbottom(h, 9, 50);
    expect([boxGetRight(h), boxGetBottom(h)]).toEqual([9, 50]);
  });

  it("get_* on a null handle (na, e.g. an unset `var box b = na`) returns na, not a crash", () => {
    expect(Number.isNaN(labelGetX(null))).toBe(true);
    expect(labelGetText(null)).toBe(null);
    expect(Number.isNaN(boxGetTop(undefined))).toBe(true);
  });

  it("get_* on a NaN handle (array.get() out-of-bounds sentinel for array<box/label/line>) returns na, not a crash", () => {
    // array.ts array.get()의 범위밖 sentinel은 numeric/generic 배열 공용이라 null이 아니라 NaN이다
    // (rt.array.get(box_arr, i) i가 범위 밖이면 NaN) — box.get_top(NaN) 등이 여기서 크래시하면 안 됨.
    expect(Number.isNaN(boxGetTop(NaN))).toBe(true);
    expect(Number.isNaN(lineGetX1(NaN))).toBe(true);
    expect(labelGetText(NaN)).toBe(null);
  });

  it("set_* on a null/NaN handle silently discards (no crash), matching existing drawingNoop convention", () => {
    expect(() => boxSetTop(null, 5)).not.toThrow();
    expect(() => labelSetText(NaN, "x")).not.toThrow();
  });
});

describe("func-local `var box/label/line X = na` codegen (C572) — reference-type na must be null, not NaN", () => {
  it("box.get_top/get_bottom on a UDF-local `var box b = na` that is later assigned does not crash and reads the real value", () => {
    const src = [
      "f() =>",
      "    var box b = na",
      "    if bar_index == 0",
      "        b := box.new(0, 100.0, 5, 90.0)",
      "    box.get_top(b)",
      "var float __obs_a = na",
      "__obs_a := f()",
    ].join("\n");
    expect(obs(src, FLAT_DATA)).toEqual([100, 100, 100]);
  });

  it("box.get_top on a UDF-local `var box b = na` that is never assigned returns na (not a crash)", () => {
    const src = ["f() =>", "    var box b = na", "    box.get_top(b)", "var float __obs_a = na", "__obs_a := f()"].join("\n");
    for (const v of obs(src, FLAT_DATA)) expect(Number.isNaN(v as number)).toBe(true);
  });

  it("UDF-local `var label l = na` set_text/get_text round-trips through the full pipeline", () => {
    const src = [
      "f() =>",
      "    var label l = na",
      "    if bar_index == 0",
      "        l := label.new(bar_index, high, \"hi\")",
      "    else",
      "        label.set_text(l, \"updated\")",
      "    label.get_text(l)",
      'var string __obs_a = na',
      "__obs_a := f()",
    ].join("\n");
    expect(obs(src, FLAT_DATA)).toEqual(["hi", "updated", "updated"]);
  });
});

describe("wild pattern regression: str.replace_all(label.get_text(...)) / str.tostring(label.get_y(...)) no longer crash (C572)", () => {
  it("str.replace_all(label.get_text(h), \" \", \"\") on a populated label works through the full pipeline", () => {
    const src = [
      "get_lbl() =>",
      "    var label l = na",
      "    if bar_index == 0",
      "        l := label.new(bar_index, high, \"a b c\")",
      "    l",
      'var string __obs_a = na',
      "__obs_a := str.replace_all(label.get_text(get_lbl()), \" \", \"\")",
    ].join("\n");
    expect(obs(src, FLAT_DATA)).toEqual(["abc", "abc", "abc"]);
  });

  it("str.tostring(label.get_y(h), \"#.##\") on a populated label works through the full pipeline", () => {
    const src = [
      "get_lbl() =>",
      "    var label l = na",
      "    if bar_index == 0",
      "        l := label.new(bar_index, 123.456)",
      "    l",
      'var string __obs_a = na',
      '__obs_a := str.tostring(label.get_y(get_lbl()), "#.##")',
    ].join("\n");
    expect(obs(src, FLAT_DATA)).toEqual(["123.46", "123.46", "123.46"]);
  });
});
