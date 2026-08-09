// C813 (ROADMAP 배치49 (3-b)) — C572 결함 수정: drawing.* 콜의 state kwarg가 codegen에서
// 조용히 버려지던 문제.
//
// 결함: analyzer는 drawing kwarg 이름을 검증 없이 통과시키는데(DRAWING_METHODS 주석), codegen
// 범용 폴백 `rt.${builtinName}(...)`은 expr.args만 방출하고 expr.kwargs를 통째로 버렸다. 표시용
// kwarg(color/style/size)는 GOAL.md "drawing = no-op"이라 버려도 무해하지만, runtime/drawing.ts가
// 진짜 accessor 쌍으로 구현한 좌표/텍스트 필드(C572)까지 사라져 `box.new(top=99.0)` 뒤
// `box.get_top()`이 NaN이 되는 **조용한 오답**이었다(같은 값을 위치 인자로 주면 99).
// 수정: DRAWING_STATE_PARAM_NAMES(analyzer/call-expr.ts) 표로 state 파라미터만 C129 원칙
// ("값이 지정된 가장 뒤쪽 슬롯까지만 위치 인자로 낮추기")으로 되살린다.
import { describe, expect, it } from "vitest";
import { DRAWING_STATE_PARAM_NAMES } from "../../src/transpiler/analyzer";
import { runPipeline } from "../helpers/pipeline";
import { transpile } from "../../src/transpiler/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3],
  high: [3, 7, 5, 10, 6],
  low: [0, 2, 1, 4, 2],
  close: [2, 4, 3, 9, 2],
  volume: [10, 20, 30, 40, 50],
};

const src = (...lines: string[]): string => ["//@version=5", 'indicator("t")', ...lines].join("\n");

function obs(source: string): unknown[] {
  return runPipeline(source, data).bars.map((b) => b["var:__obs"]);
}

function code(source: string): string {
  const result = transpile(source);
  expect(result.ok).toBe(true);
  return result.ok ? result.code : "";
}

describe("C813 drawing 생성자 kwarg — 값이 살아남는다(C572 결함)", () => {
  it("box.new(left=/top=/right=/bottom=) 완전 키워드 폼이 위치 인자 폼과 같은 값을 준다", () => {
    const kw = obs(src("var float __obs = na", "b = box.new(left=0, top=99.0, right=1, bottom=1.0)", "__obs := box.get_top(b)"));
    const pos = obs(src("var float __obs = na", "b = box.new(0, 99.0, 1, 1.0)", "__obs := box.get_top(b)"));
    expect(kw).toEqual([99, 99, 99, 99, 99]);
    expect(kw).toEqual(pos);
  });

  it("box.new의 마지막 슬롯만 kwarg인 혼합 폼도 살아남는다", () => {
    expect(obs(src("var float __obs = na", "b = box.new(0, 1.0, 1, bottom=42.0)", "__obs := box.get_bottom(b)"))).toEqual([
      42, 42, 42, 42, 42,
    ]);
  });

  it("line.new(x1=/y1=/x2=/y2=)가 살아남는다", () => {
    expect(obs(src("var float __obs = na", "l = line.new(x1=0, y1=1.0, x2=1, y2=77.0)", "__obs := line.get_y2(l)"))).toEqual([
      77, 77, 77, 77, 77,
    ]);
  });

  it("label.new(x=/y=/text=)가 살아남는다(숫자 필드와 문자열 필드 양쪽)", () => {
    expect(obs(src("var float __obs = na", 'lb = label.new(x=0, y=55.0, text="hi")', "__obs := label.get_y(lb)"))).toEqual([
      55, 55, 55, 55, 55,
    ]);
    expect(obs(src("var string __obs = na", 'lb = label.new(x=0, y=55.0, text="hi")', "__obs := label.get_text(lb)"))).toEqual([
      "hi",
      "hi",
      "hi",
      "hi",
      "hi",
    ]);
  });

  it("kwarg 순서가 시그니처와 달라도 이름으로 슬롯을 찾는다", () => {
    expect(obs(src("var float __obs = na", 'lb = label.new(y=9.0, x=0, text="t")', "__obs := label.get_y(lb)"))).toEqual([
      9, 9, 9, 9, 9,
    ]);
  });

  it("표시용 kwarg(border_color/bgcolor 등)가 섞여 있어도 state kwarg는 정확히 낮춰진다", () => {
    expect(
      obs(
        src(
          "var float __obs = na",
          "b = box.new(left=0, top=13.0, right=1, bottom=1.0, border_color=color.red, bgcolor=color.blue)",
          "__obs := box.get_top(b)",
        ),
      ),
    ).toEqual([13, 13, 13, 13, 13]);
  });

  it("state kwarg 값으로 bar series 식을 줄 수 있다(리터럴 전용이 아니다)", () => {
    expect(
      obs(
        src(
          "var float __obs = na",
          'b = box.new(left=bar_index, top=high, right=bar_index+1, bottom=low, text="x")',
          "__obs := box.get_bottom(b)",
        ),
      ),
    ).toEqual([0, 2, 1, 4, 2]);
  });
});

describe("C813 drawing setter/getter kwarg", () => {
  it("box.set_top(id=/top=) 두 이름 모두 슬롯으로 낮춰진다", () => {
    const src1 = src("var float __obs = na", "b = box.new(0, 1.0, 1, 2.0)", "box.set_top(b, top=88.0)", "__obs := box.get_top(b)");
    const src2 = src(
      "var float __obs = na",
      "b = box.new(0, 1.0, 1, 2.0)",
      "box.set_top(id=b, top=88.0)",
      "__obs := box.get_top(b)",
    );
    expect(obs(src1)).toEqual([88, 88, 88, 88, 88]);
    expect(obs(src2)).toEqual([88, 88, 88, 88, 88]);
  });

  it("label.set_text(text=)가 텍스트를 실제로 갱신한다", () => {
    expect(
      obs(src("var string __obs = na", 'l = label.new(0, 1.0, "a")', 'label.set_text(l, text="zz")', "__obs := label.get_text(l)")),
    ).toEqual(["zz", "zz", "zz", "zz", "zz"]);
  });

  it("2개 state 슬롯을 받는 setter(label.set_xy/line.set_xy2/box.set_rightbottom)도 낮춰진다", () => {
    expect(
      obs(src("var float __obs = na", 'l = label.new(0, 1.0, "a")', "label.set_xy(l, x=3, y=44.0)", "__obs := label.get_y(l)")),
    ).toEqual([44, 44, 44, 44, 44]);
    expect(
      obs(src("var float __obs = na", "ln = line.new(0, 1.0, 1, 2.0)", "line.set_xy2(ln, x=3, y=66.0)", "__obs := line.get_y2(ln)")),
    ).toEqual([66, 66, 66, 66, 66]);
    expect(
      obs(
        src(
          "var float __obs = na",
          "b = box.new(0, 1.0, 1, 2.0)",
          "box.set_rightbottom(b, right=4, bottom=17.0)",
          "__obs := box.get_bottom(b)",
        ),
      ),
    ).toEqual([17, 17, 17, 17, 17]);
  });

  it("getter의 id= 키워드 폼도 핸들을 잃지 않는다(box.get_top(id=b))", () => {
    expect(obs(src("var float __obs = na", "b = box.new(0, 31.0, 1, 2.0)", "__obs := box.get_top(id=b)"))).toEqual([
      31, 31, 31, 31, 31,
    ]);
  });

  it("line.get_price(x=)는 두 끝점 사이를 보간한 값을 준다", () => {
    expect(obs(src("var float __obs = na", "ln = line.new(0, 0.0, 4, 40.0)", "__obs := line.get_price(ln, x=2)"))).toEqual([
      20, 20, 20, 20, 20,
    ]);
  });
});

describe("C813 method-call sugar 폼(receiver가 'id' 슬롯을 차지)", () => {
  it("b.set_top(top=)가 리터럴 네임스페이스 폼과 같은 코드/값을 낸다", () => {
    const sugar = src("var float __obs = na", "b = box.new(0, 1.0, 1, 2.0)", "b.set_top(top=88.0)", "__obs := box.get_top(b)");
    const plain = src("var float __obs = na", "b = box.new(0, 1.0, 1, 2.0)", "b.set_top(88.0)", "__obs := box.get_top(b)");
    expect(obs(sugar)).toEqual([88, 88, 88, 88, 88]);
    expect(code(sugar)).toContain("rt.box.set_top(b, 88.0)");
    expect(code(sugar)).toBe(code(plain));
  });

  it("l.set_xy(x=, y=) sugar도 -1 오프셋으로 정확히 낮춰진다", () => {
    expect(
      obs(src("var float __obs = na", 'l = label.new(0, 1.0, "a")', "l.set_xy(x=3, y=21.0)", "__obs := label.get_y(l)")),
    ).toEqual([21, 21, 21, 21, 21]);
  });

  it("l.set_text(text=) sugar가 텍스트를 갱신한다", () => {
    expect(
      obs(src("var string __obs = na", 'l = label.new(0, 1.0, "a")', 'l.set_text(text="qq")', "__obs := label.get_text(l)")),
    ).toEqual(["qq", "qq", "qq", "qq", "qq"]);
  });
});

describe("C813 회귀 가드 — 표에 없는 kwarg는 기존과 동일하게 무시된다", () => {
  it("표시용 kwarg만 있는 콜은 출력 코드가 kwarg 없는 콜과 완전히 같다", () => {
    const withKw = src("var float __obs = na", 'lb = label.new(0, 5.0, "x", style=label.style_label_down, color=color.red)', "__obs := label.get_y(lb)");
    const without = src("var float __obs = na", 'lb = label.new(0, 5.0, "x")', "__obs := label.get_y(lb)");
    expect(code(withKw)).toBe(code(without));
    expect(obs(withKw)).toEqual([5, 5, 5, 5, 5]);
  });

  it("표에 없는 이름(오타/미지원 kwarg)은 슬롯을 밀지 않고 방출도 안 한다", () => {
    const withBogus = src("var float __obs = na", "b = box.new(left=0, top=5.0, right=1, bottom=1.0, bogus_zz=3)", "__obs := box.get_top(b)");
    expect(code(withBogus)).toContain("rt.box.new(0, 5.0, 1, 1.0)");
    expect(obs(withBogus)).toEqual([5, 5, 5, 5, 5]);
  });

  it("state가 없는 네임스페이스(table)는 표에 없어 kwarg가 그대로 discard된다", () => {
    const t = src(
      "var float __obs = na",
      "t = table.new(position=position.top_right, columns=2, rows=2)",
      't.cell(0, 0, "x", text_color=color.red)',
      "__obs := 3.0",
    );
    expect(code(t)).toContain("rt.table.new()");
    expect(obs(t)).toEqual([3, 3, 3, 3, 3]);
  });

  it("chart.point 오버로드 kwarg(first_point=/second_point=)는 범위 밖이라 현행 유지(na)", () => {
    const s = src(
      "var float __obs = na",
      "p1 = chart.point.from_index(0, 1.0)",
      "p2 = chart.point.from_index(4, 5.0)",
      "ln = line.new(first_point=p1, second_point=p2)",
      "__obs := line.get_y2(ln)",
    );
    expect(obs(s).every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("C813 DRAWING_STATE_PARAM_NAMES 표 자체의 정합성", () => {
  it("모든 키가 'kind.method' 형태이고 label/line/box 3종만 등재된다(table/polyline/linefill은 state 없음)", () => {
    for (const key of Object.keys(DRAWING_STATE_PARAM_NAMES)) {
      const [kind, method] = key.split(".");
      expect(["label", "line", "box"]).toContain(kind);
      expect(method).toBeTruthy();
    }
    expect(Object.keys(DRAWING_STATE_PARAM_NAMES).some((k) => k.startsWith("table."))).toBe(false);
  });

  it("생성자를 제외한 전 항목의 첫 슬롯이 'id'다(sugar slice(1) 오프셋의 전제)", () => {
    for (const [key, names] of Object.entries(DRAWING_STATE_PARAM_NAMES)) {
      if (key.endsWith(".new")) {
        expect(names[0]).not.toBe("id");
        continue;
      }
      expect(names[0]).toBe("id");
    }
  });

  it("슬롯 이름에 중복이 없다(같은 kwarg가 두 슬롯을 가리키면 낮추기가 모호해진다)", () => {
    for (const names of Object.values(DRAWING_STATE_PARAM_NAMES)) {
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
