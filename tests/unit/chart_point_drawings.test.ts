// chart.point as a value and as the argument of line.new/label.new/box.new (and the setters that take
// a point). Found by the draw_001_chart_point head-to-head case (a hand-built PyneCore fixture of
// identity checks); the rules below are the Pine v6 manual's, not the fixture's:
//   * chart.point.now(price): a point with the price and the current bar's index and time
//     (concepts/lines-and-boxes: "Contains `index` and `time` information"); from_index has no time,
//     from_time has no index.
//   * line.new(first_point, second_point, xloc, extend, color, style, width),
//     label.new(point, text, xloc, yloc, color, style, textcolor, size, textalign, tooltip),
//     box.new(top_left, bottom_right, border_color, border_width, border_style, extend, xloc, bgcolor,
//     text, ...): the point(s) replace the coordinate pair(s), and xloc (default xloc.bar_index) says
//     whether the drawing reads the points' index or their time.
// Before: chart.point.now left index and time na, the three constructors read their point arguments as
// numbers (every coordinate NaN, label text lost) and drawings built from keyword points were all na.
import { describe, expect, it } from "vitest";
import { run } from "../../src/runtime/engine";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import {
  chartPointNew,
  chartPointNow,
  chartPointFromIndex,
  chartPointFromTime,
  newBox,
  newLabel,
  newLine,
  labelSetPoint,
  lineSetFirstPoint,
} from "../../src/runtime/drawing";
import type { OHLCVData } from "../../src/runtime/context";
import type { TranspileErr } from "../../src/transpiler/pipeline";

const T0 = 1_730_678_400_000;
const data: OHLCVData = {
  open: [1, 5, 2, 8, 3],
  high: [3, 7, 5, 10, 6],
  low: [0, 2, 1, 4, 2],
  close: [2, 4, 3, 9, 2],
  volume: [10, 20, 30, 40, 50],
  time: [T0, T0 + 300_000, T0 + 600_000, T0 + 900_000, T0 + 1_200_000],
};

const src = (...lines: string[]): string => ["//@version=6", 'indicator("t")', ...lines].join("\n");

function obs(source: string, d: OHLCVData = data): unknown[] {
  return runPipeline(source, d).bars.map((b) => b["var:__obs"]);
}

function errors(source: string): string[] {
  const r = transpile(source);
  return r.ok ? [] : (r as TranspileErr).errors;
}

function drawings(source: string): Array<{ kind: string; bar: number; state: Record<string, number | string | null> }> {
  const r = transpile(source);
  if (!r.ok) throw new Error((r as TranspileErr).errors.join("; "));
  return run(r, data).viz!.drawings;
}

describe("chart.point.now carries the bar's index and time", () => {
  it("index is bar_index, time is the bar's time, price is the argument", () => {
    const s = src(
      "var float __obs = na",
      "p = chart.point.now(close)",
      "__obs := (p.index == bar_index and p.time == time and p.price == close) ? 1.0 : 0.0",
    );
    expect(obs(s)).toEqual([1, 1, 1, 1, 1]);
  });

  it("the fields hold the values of each bar, not the first bar's", () => {
    const s = src("var float __obs = na", "p = chart.point.now(close)", "__obs := p.time - p.index");
    expect(obs(s)).toEqual([T0, T0 + 299_999, T0 + 599_998, T0 + 899_997, T0 + 1_199_996]);
  });

  it("without a time channel the time is 0 (the `time` builtin's default), never na", () => {
    const { time: _time, ...noTime } = data;
    const s = src("var float __obs = na", "p = chart.point.now(close)", "__obs := na(p.time) ? 1.0 : 0.0");
    expect(obs(s, noTime)).toEqual([0, 0, 0, 0, 0]);
  });

  it("from_index has no time and from_time has no index", () => {
    const s = src(
      "var float __obs = na",
      "a = chart.point.from_index(bar_index, close)",
      "b = chart.point.from_time(time, close)",
      "__obs := (na(a.time) and a.index == bar_index and na(b.index) and b.time == time) ? 1.0 : 0.0",
    );
    expect(obs(s)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keyword arguments of chart.point.new/from_index/from_time/now reach their slots", () => {
    const s = src(
      "var float __obs = na",
      "a = chart.point.new(time=7, index=8, price=9.0)",
      "b = chart.point.from_index(price=2.0, index=5)",
      "c = chart.point.from_time(price=3.0, time=6)",
      "d = chart.point.now(price=4.0)",
      "e = chart.point.new(price=1.0, index=2)",
      "__obs := a.time * 1000000 + a.index * 10000 + a.price * 100 + b.index * 10 + b.price + c.time * 1000 + c.price + d.price + e.index * 10 + e.price + (na(e.time) ? 0 : 100000)",
    );
    // 7*1e6 + 8*1e4 + 9*100 + 5*10 + 2 + 6*1000 + 3 + 4 + 2*10 + 1 = 7,086,980
    expect(obs(s)).toEqual([7_086_980, 7_086_980, 7_086_980, 7_086_980, 7_086_980]);
  });

  it("chart.point.now(price=) takes the bar's index and time too", () => {
    const s = src("var float __obs = na", "p = chart.point.now(price=close)", "__obs := p.index == bar_index and p.time == time ? 1.0 : 0.0");
    expect(obs(s)).toEqual([1, 1, 1, 1, 1]);
  });

  it("rejects an unknown or doubly given chart.point keyword argument", () => {
    expect(errors(src("p = chart.point.from_index(idx=1, price=2.0)")).join("\n")).toMatch(/no parameter named 'idx'/);
    expect(errors(src("p = chart.point.from_index(1, index=1)")).join("\n")).toMatch(/'index' is given twice/);
    expect(errors(src("p = chart.point.now(price=1.0, price=2.0)")).join("\n")).toMatch(/'price' is given twice/);
  });
});

describe("line.new with chart.point arguments", () => {
  const pts = ["p1 = chart.point.from_index(bar_index, high)", "p2 = chart.point.from_index(bar_index + 2, low)"];

  it("positional points give x1/y1/x2/y2 from index and price", () => {
    const s = src(
      "var float __obs = na",
      ...pts,
      "ln = line.new(p1, p2)",
      "__obs := line.get_x1(ln) * 1000 + line.get_y1(ln) * 100 + line.get_x2(ln) * 10 + line.get_y2(ln)",
    );
    // bar i: x1=i, y1=high[i], x2=i+2, y2=low[i]
    const expected = [0, 1, 2, 3, 4].map((i) => i * 1000 + data.high[i]! * 100 + (i + 2) * 10 + data.low[i]!);
    expect(obs(s)).toEqual(expected);
  });

  it("first_point=/second_point= keywords and the mixed form read the same points", () => {
    const body = (call: string): string =>
      src("var float __obs = na", ...pts, `ln = ${call}`, "__obs := line.get_x1(ln) * 1000 + line.get_y1(ln) * 100 + line.get_x2(ln) * 10 + line.get_y2(ln)");
    const positional = obs(body("line.new(p1, p2)"));
    expect(obs(body("line.new(first_point=p1, second_point=p2)"))).toEqual(positional);
    expect(obs(body("line.new(p1, second_point=p2)"))).toEqual(positional);
    expect(obs(body("line.new(second_point=p2, first_point=p1)"))).toEqual(positional);
  });

  it("a point built in the argument itself (chart.point.new / now) works too", () => {
    const s = src(
      "var float __obs = na",
      "ln = line.new(chart.point.now(open), chart.point.from_index(bar_index + 1, close))",
      "__obs := line.get_x2(ln) - line.get_x1(ln) + line.get_y1(ln)",
    );
    expect(obs(s)).toEqual(Array.from(data.open).map((o) => 1 + o));
  });

  it("the styling parameters after the points land on their own slots (color, style, width)", () => {
    const d = drawings(
      src(
        "if barstate.islast",
        "    p1 = chart.point.from_index(bar_index, high)",
        "    p2 = chart.point.from_index(bar_index, low)",
        "    line.new(p1, p2, extend=extend.right, color=color.red, style=line.style_dashed, width=3)",
        "    line.new(first_point=p1, second_point=p2, color=color.blue, width=2)",
        "plot(close)",
      ),
    );
    expect(d).toHaveLength(2);
    expect(d[0]!.state).toMatchObject({ x1: 4, y1: 6, x2: 4, y2: 2, extend: "right", color: "#FF5252", style: "dashed", width: 3 });
    expect(d[1]!.state).toMatchObject({ x1: 4, y1: 6, x2: 4, y2: 2, color: "#2196F3", width: 2 });
  });

  it("xloc.bar_time makes the line read the points' time, the default xloc their index", () => {
    const s = (xloc: string): string =>
      src(
        "var float __obs = na",
        "a = chart.point.new(1000, 7, 1.0)",
        "b = chart.point.new(2000, 9, 2.0)",
        `ln = line.new(a, b${xloc})`,
        "__obs := line.get_x1(ln) * 10000 + line.get_x2(ln)",
      );
    expect(obs(s(""))).toEqual([70009, 70009, 70009, 70009, 70009]);
    expect(obs(s(", xloc=xloc.bar_time"))).toEqual([10_002_000, 10_002_000, 10_002_000, 10_002_000, 10_002_000]);
  });

  it("a point that lacks the coordinate xloc names falls back to the one it has", () => {
    const s = src(
      "var float __obs = na",
      "a = chart.point.from_time(1000, 1.0)",
      "b = chart.point.from_time(2000, 2.0)",
      "ln = line.new(a, b)",
      "__obs := line.get_x1(ln) + line.get_x2(ln)",
    );
    expect(obs(s)).toEqual([3000, 3000, 3000, 3000, 3000]);
  });

  it("a point parameter of a user function (type not declared) is told from a coordinate at run time", () => {
    const s = src(
      "var float __obs = na",
      "mk(p, q) => line.new(p, q)",
      "ln = mk(chart.point.from_index(bar_index, high), chart.point.from_index(bar_index, low))",
      "__obs := line.get_y1(ln) - line.get_y2(ln)",
    );
    expect(obs(s)).toEqual(Array.from(data.high).map((h, i) => h - data.low[i]!));
  });

  it("the coordinate overload is unchanged", () => {
    const s = src("var float __obs = na", "ln = line.new(1, 2.0, 3, 4.0, color=color.red)", "__obs := line.get_x2(ln) + line.get_y2(ln)");
    expect(obs(s)).toEqual([7, 7, 7, 7, 7]);
  });
});

describe("box.new with chart.point arguments", () => {
  const pts = ["p1 = chart.point.from_index(bar_index, high)", "p2 = chart.point.from_index(bar_index + 3, low)"];
  const read = "__obs := box.get_left(bx) * 1000 + box.get_top(bx) * 100 + box.get_right(bx) * 10 + box.get_bottom(bx)";

  it("top_left/bottom_right give left/top and right/bottom, positionally, by keyword and mixed", () => {
    const body = (call: string): string => src("var float __obs = na", ...pts, `bx = ${call}`, read);
    const expected = [0, 1, 2, 3, 4].map((i) => i * 1000 + data.high[i]! * 100 + (i + 3) * 10 + data.low[i]!);
    expect(obs(body("box.new(p1, p2)"))).toEqual(expected);
    expect(obs(body("box.new(top_left=p1, bottom_right=p2)"))).toEqual(expected);
    expect(obs(body("box.new(p1, bottom_right=p2)"))).toEqual(expected);
  });

  it("border/bgcolor/text parameters after the points land on their own slots", () => {
    const d = drawings(
      src(
        "if barstate.islast",
        "    p1 = chart.point.from_index(bar_index, high)",
        "    p2 = chart.point.from_index(bar_index, low)",
        '    box.new(p1, p2, border_color=color.red, border_width=2, bgcolor=color.blue, text="t")',
        '    box.new(top_left=p1, bottom_right=p2, border_style=line.style_dotted, text="u")',
        "plot(close)",
      ),
    );
    expect(d[0]!.state).toMatchObject({ left: 4, top: 6, right: 4, bottom: 2, border_color: "#FF5252", border_width: 2, bgcolor: "#2196F3", text: "t" });
    expect(d[1]!.state).toMatchObject({ left: 4, top: 6, right: 4, bottom: 2, border_style: "dotted", text: "u" });
  });

  it("xloc.bar_time reads the points' time", () => {
    const s = src(
      "var float __obs = na",
      "a = chart.point.new(1000, 7, 5.0)",
      "b = chart.point.new(2000, 9, 4.0)",
      "bx = box.new(a, b, xloc=xloc.bar_time)",
      "__obs := box.get_left(bx) * 10000 + box.get_right(bx)",
    );
    expect(obs(s)).toEqual([10_002_000, 10_002_000, 10_002_000, 10_002_000, 10_002_000]);
  });
});

describe("label.new with a chart.point argument", () => {
  it("point= keyword and positional point keep the text and read x/y from the point", () => {
    const s = src(
      "var float __obs = na",
      "p = chart.point.from_index(bar_index, high)",
      'a = label.new(point=p, text="kw")',
      'b = label.new(p, "pos")',
      'c = label.new(p, text="mixed")',
      '__obs := label.get_x(a) + label.get_y(a) + (label.get_text(a) == "kw" ? 100 : 0) + (label.get_text(b) == "pos" ? 1000 : 0) + (label.get_text(c) == "mixed" ? 10000 : 0) + label.get_x(b) + label.get_y(c)',
    );
    const expected = [0, 1, 2, 3, 4].map((i) => i + data.high[i]! + 11100 + i + data.high[i]!);
    expect(obs(s)).toEqual(expected);
  });

  it("a label without text gets the empty string, and the parameters after text land on their own slots", () => {
    const d = drawings(
      src(
        "if barstate.islast",
        "    p = chart.point.from_index(bar_index, high)",
        "    label.new(p)",
        '    label.new(p, "hi", yloc=yloc.abovebar, color=color.red, style=label.style_label_up, textcolor=color.white, size=size.large)',
        '    label.new(point=p, text="k", tooltip="tt")',
        "plot(close)",
      ),
    );
    expect(d[0]!.state).toMatchObject({ x: 4, y: 6, text: "" });
    expect(d[1]!.state).toMatchObject({ x: 4, y: 6, text: "hi", yloc: "abovebar", color: "#FF5252", style: "label_up", textcolor: "#FFFFFF", size: "large" });
    expect(d[2]!.state).toMatchObject({ x: 4, y: 6, text: "k", tooltip: "tt" });
  });

  it("the coordinate overload is unchanged", () => {
    const s = src("var float __obs = na", 'lb = label.new(3, 5.0, "x")', "__obs := label.get_x(lb) + label.get_y(lb)");
    expect(obs(s)).toEqual([8, 8, 8, 8, 8]);
  });
});

describe("setters that take a chart.point", () => {
  it("line.set_first_point/set_second_point/box.set_*_point/label.set_point, positionally and by point=", () => {
    const s = src(
      "var float __obs = na",
      "p = chart.point.from_index(10, 20.0)",
      "q = chart.point.from_index(30, 40.0)",
      "ln = line.new(0, 0.0, 0, 0.0)",
      "bx = box.new(0, 0.0, 0, 0.0)",
      'lb = label.new(0, 0.0, "x")',
      "line.set_first_point(ln, p)",
      "ln.set_second_point(point=q)",
      "box.set_top_left_point(bx, p)",
      "bx.set_bottom_right_point(point=q)",
      "lb.set_point(p)",
      "__obs := line.get_x1(ln) + line.get_y1(ln) + line.get_x2(ln) + line.get_y2(ln) + box.get_left(bx) + box.get_top(bx) + box.get_right(bx) + box.get_bottom(bx) + label.get_x(lb) + label.get_y(lb)",
    );
    // line 10+20+30+40, box 10+20+30+40, label 10+20
    expect(obs(s)).toEqual([230, 230, 230, 230, 230]);
  });

  it("the setters follow the drawing's xloc: bar_time reads the point's time", () => {
    const s = src(
      "var float __obs = na",
      "p = chart.point.new(1000, 7, 1.0)",
      "ln = line.new(0, 0.0, 0, 0.0, xloc=xloc.bar_time)",
      "line.set_first_point(ln, p)",
      "lb = label.new(0, 0.0, 'x', xloc.bar_time)",
      "label.set_point(lb, p)",
      "__obs := line.get_x1(ln) + label.get_x(lb)",
    );
    expect(obs(s)).toEqual([2000, 2000, 2000, 2000, 2000]);
  });
});

describe("runtime/drawing.ts, called directly", () => {
  it("chartPointNow names the bar it is given and leaves both na without one", () => {
    expect(chartPointNow(5, 3, 1234)).toEqual({ time: 1234, index: 3, price: 5 });
    expect(chartPointNow(5)).toEqual({ time: null, index: null, price: 5 });
  });

  it("newLine/newBox/newLabel tell the point overload from the coordinate overload by the first argument", () => {
    const a = chartPointNew(100, 1, 10);
    const b = chartPointNew(200, 2, 20);
    expect(newLine(a, b).state).toEqual({ x1: 1, y1: 10, x2: 2, y2: 20 });
    expect(newLine(a, b, "bar_time", "right", "#fff", "dashed", 4).state).toEqual({
      x1: 100, y1: 10, x2: 200, y2: 20, xloc: "bar_time", extend: "right", color: "#fff", style: "dashed", width: 4,
    });
    expect(newLine(1, 10, 2, 20).state).toEqual({ x1: 1, y1: 10, x2: 2, y2: 20 });
    expect(newBox(a, b, "#f00", 2).state).toEqual({ left: 1, top: 10, right: 2, bottom: 20, border_color: "#f00", border_width: 2 });
    expect(newBox(a, b, undefined, undefined, undefined, undefined, "bar_time").state).toMatchObject({ left: 100, right: 200, xloc: "bar_time" });
    expect(newLabel(a, "t", "bar_time", "price").state).toEqual({ x: 100, y: 10, text: "t", xloc: "bar_time", yloc: "price" });
    expect(newLabel(a).state).toEqual({ x: 1, y: 10, text: "" });
    expect(newLabel(1, 10, "t").state).toEqual({ x: 1, y: 10, text: "t" });
  });

  it("a missing or na point gives na coordinates, not a crash", () => {
    expect(newLine(chartPointFromIndex(1, 2), undefined).state).toMatchObject({ x1: 1, y1: 2 });
    expect(Number.isNaN(newLine(chartPointFromIndex(1, 2), undefined).state.x2 as number)).toBe(true);
    const h = newLine(1, 2, 3, 4);
    expect(() => lineSetFirstPoint(h, null)).not.toThrow();
    expect(() => labelSetPoint(null, chartPointFromTime(1, 2))).not.toThrow();
    expect(Number.isNaN(h.state.x1 as number)).toBe(true);
  });
});
