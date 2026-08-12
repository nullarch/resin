// 함수/method/빌트인 호출식(CallExpr) 분석 전체 — analyzer.ts에서 분리(ROADMAP "analyzer.ts 파일
// 분할" 여섯 번째 슬라이스, C145 next_hint 재평가 후 analyzeMethodDecl 대신 이 블록을 택함:
// analyzeFuncDecl/analyzeMethodDecl은 구조가 90% 동일해 분리 이득이 적었지만, 이 블록은 파일에서
// 가장 큰 단일 클러스터이자 이미 완전히 자기완결적이었다 — analyzeCallExpr을 부르는 곳은
// analyzeExpr 단 한 곳(grep으로 확인), analyzeInputCall/analyzeUserFuncCall을 부르는 곳도 이
// 블록 내부뿐이다). 순수 이동만 수행 — 신규 검증 로직 없음.
//
// AnalyzedProgram/LexScope/FuncInfo는 analyzer.ts 전역에서 널리 쓰여 그대로 두고 타입만 export해
// 여기서 import한다. analyzeExpr/resolveUdtObjectType은 analyzeCallExpr 본문 안에서만 호출되는
// 값 import라 analyzer.ts <-> 이 파일 사이에 진짜 순환 import가 생기지만, 그 참조가 함수 본문
// 안(지연 평가)이라 안전하다(ta.ts의 inferQualifier 값-import 순환과 동일 패턴, C142 참조).
import type { Assignment, BinOp, CallExpr, CallKwarg, DotAccess, Expr, FuncDecl, IfStmt, IndexAccess, NumberLiteral, Stmt, StringLiteral, SwitchStmt, TernaryOp, UnaryOp } from "../ast";
import type { AnalyzedProgram, FuncInfo, LexScope, SecurityVarSlice, SecurityVarSliceItem, SecurityVarSliceStmt } from "../analyzer";
import type { DrawingKind } from "./constructors";
import {
  analyzeExpr,
  COLOR_CONSTANTS,
  resolveUdtObjectType,
  resolveArrayElemDrawingKind,
  resolveContainerExprKind,
  resolveDrawingExprKind,
  resolveEnumExprType,
  resolveMatrixExprKind,
  resolveArrayGetElemUdtType,
  resolveArrayGetElemDrawingKind,
  resolveNestedVarOrEqLocalKind,
  isStaticIntExpr,
  BAR_SERIES_NAMES,
  DERIVED_PRICE_NAMES,
  BARMERGE_CONSTANTS,
  TIME_FUNC_NAMES,
  TIMEFRAME_BOOLEAN_PROPS,
  TIMEFRAME_STRING_PROPS,
  timeframeStringPropValue,
  timeframeNumberPropValue,
  timeframeBooleanPropValue,
  CURRENCY_CONSTANTS,
  SYMINFO_NUMBER_PROPS,
  EARNINGS_NUMBER_PROPS,
  DAYOFWEEK_CONSTANTS,
} from "../analyzer";
import { literalOffsetValue } from "./index-access";
import { isUdtConstructorCall } from "./constructors";
import { isHarmlessArgDup } from "./arg-dup";
// C512: request.security tf 삼항 조건의 산술 임계값 폴딩이 timeframe.in_seconds(상수 tf)를
// 컴파일타임에 계산할 때 런타임과 정확히 같은 값을 내도록 런타임 순수 함수를 직접 import한다
// (transpiler→runtime 첫 값 import — in_seconds는 상태/Context 의존이 전혀 없는 순수 함수라
// 계층 위반이 아니며, analyzer 쪽에 사본을 두면 두 구현이 조용히 어긋나는 C136류 함정이 생긴다).
import { in_seconds as timeframeInSeconds } from "../../runtime/timeframe";
// C513: str.tonumber도 같은 원칙(상태/Context 의존 0인 순수 함수)으로 직접 import — auto-HTF
// 변종 (b)의 UDF 본문(`str.tonumber(res) > ...`류) 컴파일타임 폴딩이 런타임과 같은 파싱 규칙
// (C87 pyFloatStr 대응 tonumber)을 쓰도록 보장한다.
// C730: str.tostring도 동일 원칙 — 컴파일타임 2-인자 포맷 폴딩('###M' 접미사 관용구)이 런타임
// 분기(str.ts suffixMatch)와 같은 출력을 내도록 보장한다.
import { tonumber as strTonumber, tostring as strTostring } from "../../runtime/str";

// hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/alertcondition/max_bars_back
// (C208, corpus 최다빈도 '알 수 없는 함수 호출' 스캔) — pine2py wavealgo/builtins/plot.py +
// wavealgo/__init__.py의 alert/alertcondition/max_bars_back(전부 no-op 또는 순수 시각화 metadata
// dict 반환, python 직접 실행으로 확인) 이식. GOAL.md "drawing 객체는 no-op + 발생 카운트 기록"과
// 같은 원칙을 이 시각화/알림 전용 함수군에도 적용 — plot()과 달리 series 인자를 기록할 채널조차
// 없다. v5 제약(plot()과 동일 이유, VERIFIED_SEMANTICS.md CONFIRMED "plot()은 if 블록 안에서 호출
// 불가"의 자매 그룹 — TV는 plotting 계열 함수 전체를 이 restriction으로 묶는다)으로 스크립트
// 최상위에서만 허용. alert()만 예외 — 코퍼스 실측(corpus/scripts grep)상 `if cond\n  alert(...)`처럼
// 조건부 호출이 정상 관용구라 topLevel 요구 대상에서 제외(TV alert()는 원래 조건부 호출을 위해
// 설계된 함수 — plot 계열과 반대). fill(C209, corpus 12건, 전부 `fill(p1, p2, color=...)` 형태로
// plot()/hline()의 대입-RHS 반환 핸들을 인자로 받는 관용구) — pine2py wavealgo/builtins/plot.py의
// fill()도 plot1/plot2/color를 그대로 dict에 담아 반환하는 순수 metadata no-op(python 직접 실행으로
// 확인, 어떤 필드도 실제로 소비 안 함)이라 이 그룹에 합류. 핸들 인자(p1/p2) 자체는 다른 no-op처럼
// discard 대상이라 plot()/hline()이 실제로 무엇을 반환하든(codegen상 각각 `.record()`/`undefined`)
// 무해 — fill()이 그 값을 읽는 코드가 전혀 없다.
const NOOP_BUILTIN_TOPLEVEL = new Set([
  "hline",
  "bgcolor",
  "barcolor",
  "plotshape",
  "plotchar",
  "plotarrow",
  "plotcandle",
  "plotbar",
  "alertcondition",
  "max_bars_back",
  "fill",
]);
const NOOP_BUILTIN_ANY = new Set(["alert"]);
// 인자 개수 대략 검증 — 값 자체는 discard되므로 kwarg 이름별 정밀 검증(plot()의 PLOT_PARAM_NAMES류)은
// 굳이 재현하지 않고, 위치+키워드 합계가 이 범위 안인지만 본다. max는 원래 pine2py 시그니처(위치
// 인자만, **kwargs로 나머지 흡수)의 좁은 개수를 그대로 옮겼었으나(C208), wild 코퍼스에서 plotshape
// 186건/bgcolor 78건/plotchar 15건/barcolor 13건/hline 8건/plotcandle 7건이 이 좁은 상한에 걸려
// "인자 개수 불일치"로 트랜스파일 실패함을 발견(C290, scratch/wild_argcount_cluster.mjs) — 값이
// discard되는 no-op이라 정밀 kwarg 이름 검증 없이 상한만 넉넉히 올려도 안전하므로, pine2py 자신의
// docs/pinescript_visualization_reference.md(1.2~2.2절, TV 공식 시그니처 전체 나열)로 max를 TV
// 실제 파라미터 개수까지 상향(min은 필수 위치 인자 개수 그대로 — series/color/OHLC 등은 여전히
// 필수). plotarrow/plotbar도 같은 문서 근거로 함께 상향(wild 미발현이지만 같은 표·같은 문서·같은
// 위험 0 수정이라 동시 적용, C290). fill/max_bars_back/alert는 이미 문서상 최대(fill 7)보다
// 같거나 넉넉해 변경 불필요. alertcondition만 C656(배치33 (6) argcount 재조사 잔여)에서 3->4로
// 재상향 — TV 공식 시그니처는 3(condition/title/message)뿐이지만 wild 660108167ef8.pine의
// `alertcondition(isB, "BUY Alert", "BUY Alert", alert.freq_once_per_bar_close)`(4번째 위치
// 인자로 alert()의 freq= 상수를 얹은 관용구, 19개 콜사이트 확인)가 TV facade 컴파일러 실측
// accept(scratch/tv_validation/results.jsonl) — "초과인자 관용" 가설(DIVERGENCES #202)로 값
// discard 원칙 그대로 상한만 1 상향. 자기선언 에러 케이스(0ad1bda0c322.pine, 5-인자 —
// 소스 자체가 "ERROR: Too Many" 주석을 달아둔 의도적 무효 예제)는 max=4 유지로 계속 거부.
const NOOP_BUILTIN_ARITY: Readonly<Record<string, { min: number; max: number }>> = {
  hline: { min: 1, max: 7 }, // price,title,color,linestyle,linewidth,editable,display
  bgcolor: { min: 1, max: 6 }, // color,offset,editable,show_last,title,force_overlay
  barcolor: { min: 1, max: 6 }, // color,offset,editable,show_last,title,display
  plotshape: { min: 1, max: 13 }, // series,title,style,location,color,offset,text,textcolor,editable,size,show_last,display,force_overlay
  plotchar: { min: 1, max: 13 }, // series,title,char,location,color,offset,text,textcolor,editable,size,show_last,display,force_overlay
  plotarrow: { min: 1, max: 11 }, // series,title,colorup,colordown,offset,minheight,maxheight,editable,show_last,display,force_overlay
  plotcandle: { min: 4, max: 12 }, // open,high,low,close,title,color,wickcolor,editable,show_last,bordercolor,display,force_overlay
  plotbar: { min: 4, max: 10 }, // open,high,low,close,title,color,editable,show_last,display,force_overlay
  alertcondition: { min: 1, max: 4 }, // condition,title,message,[+1 관용, C656]
  max_bars_back: { min: 1, max: 2 },
  alert: { min: 0, max: 2 },
  fill: { min: 2, max: 8 },
};

// label/line/box/table/polyline(신규, corpus 전체 스캔 실측 — label.new 47/table.cell 46/line.new
// 28/table.new 25/box.new 22개 파일 등, 93개 파일이 이 5개 네임스페이스를 씀) — GOAL.md "drawing
// 객체(label/line/box/table)는 no-op + 발생 카운트 기록". pine2py wavealgo/__init__.py의
// label_new/line_new/box_new/table_new(핸들 dict 반환) + pine2wave/codegen.py FUNC_MAP(L1578-1649,
// 1677-1694)의 나머지 전 setter/getter/delete/cell/merge_cells/clear(전부 drawing_noop, 값 discard)를
// 그대로 이식 — 메서드 존재 여부만 검증하고 인자 개수/kwarg 이름 정밀 검증은 하지 않는다(pine2py
// 자신도 *args/**kwargs로 검증 없음 — hline/fill류 NOOP_BUILTIN_ARITY의 대략적 검증조차 90여
// 메서드 조합엔 이득 대비 비용이 크다고 판단, PROGRESS.md C211 참조). polyline은 pine2py FUNC_MAP이
// new/delete 둘 다 drawing_noop(진짜 핸들 아님)으로 매핑해 둘 다 no-op으로 이식.
const DRAWING_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  label: new Set([
    "new",
    "delete",
    "copy",
    "set_x",
    "set_y",
    "set_xy",
    "set_text",
    "set_color",
    "set_textcolor",
    "set_size",
    "set_style",
    "set_textalign",
    "set_tooltip",
    "set_xloc",
    "set_yloc",
    "set_point",
    "set_text_font_family",
    "get_x",
    "get_y",
    "get_text",
  ]),
  line: new Set([
    "new",
    "delete",
    "copy",
    "set_x1",
    "set_y1",
    "set_x2",
    "set_y2",
    "set_xy1",
    "set_xy2",
    "set_color",
    "set_width",
    "set_style",
    "set_extend",
    "set_xloc",
    "set_first_point",
    "set_second_point",
    "get_x1",
    "get_y1",
    "get_x2",
    "get_y2",
    "get_price",
  ]),
  box: new Set([
    "new",
    "delete",
    "copy",
    "set_left",
    "set_right",
    "set_top",
    "set_bottom",
    "set_lefttop",
    "set_rightbottom",
    "set_top_left_point",
    "set_bottom_right_point",
    "set_bgcolor",
    "set_border_color",
    "set_border_width",
    "set_border_style",
    "set_extend",
    "set_text",
    "set_text_color",
    "set_text_size",
    // set_text_halign/valign/wrap/font_family(C351) -- pine2py 자신의
    // docs/pinescript_visualization_reference.md L371/498/845-847이 "실제 TV box.new() 파라미터,
    // codegen 양쪽 다 미매핑"으로 이미 명시한 known gap(currency/format/scale/chart류 C284~C287과
    // 동일 패턴). GOAL.md "drawing 객체는 no-op" 불변식 그대로 적용 -- 계산 시맨틱 없음.
    "set_text_halign",
    "set_text_valign",
    "set_text_wrap",
    "set_text_font_family",
    "get_left",
    "get_right",
    "get_top",
    "get_bottom",
  ]),
  table: new Set([
    "new",
    "cell",
    "delete",
    "set_bgcolor",
    "set_border_color",
    "set_border_width",
    "set_position",
    "set_frame_color",
    "set_frame_width",
    "cell_set_text",
    "cell_set_bgcolor",
    "cell_set_text_color",
    "cell_set_text_size",
    "cell_set_height",
    "cell_set_width",
    "cell_set_tooltip",
    "cell_set_text_halign",
    "cell_set_text_valign",
    "cell_set_text_font_family",
    "merge_cells",
    "clear",
  ]),
  polyline: new Set(["new", "delete"]),
  // linefill(C238, ROADMAP P3 next_hint 1순위 -- corpus b7dde3c9d51e.pine 1건, `lf = linefill.new(
  // ln1, ln2, color)` + `linefill.delete(lf)`). pine2py FUNC_MAP(codegen.py L1650-1655)이 5종
  // 전부(new 포함 -- label/line/box/table과 달리 진짜 핸들 생성자가 없고 polyline과 동일하게
  // drawing_noop 하나로 묶임) 전부 no-op이라 copy는 아예 없음.
  linefill: new Set(["new", "delete", "set_color", "get_line1", "get_line2"]),
};

// drawing.* 콜 중 **런타임이 실제 state로 소비하는** 파라미터의 위치 이름표(C813, LIMITATIONS C572
// 수정). 위 DRAWING_METHODS 주석대로 analyzer는 drawing kwarg의 이름을 검증하지 않고 그대로
// 통과시키는데, codegen 범용 폴백(`rt.${builtinName}(...)`)은 expr.args만 방출하고 expr.kwargs를
// 통째로 버린다 — 순수 표시용 kwarg(color/style/size...)는 어차피 GOAL.md "drawing = no-op"이라
// 버려도 무해하지만, runtime/drawing.ts가 진짜 accessor 쌍으로 구현한 좌표/텍스트 필드(C572)는
// 그 폐기가 **조용한 오답**이 된다(`box.new(top=99.0)` 뒤 `box.get_top()`이 NaN). 이 표로 그
// state 파라미터만 C129 원칙("값이 지정된 가장 뒤쪽 슬롯까지만 위치 인자로 낮추기")으로 되살린다.
// 범위를 state 파라미터로 좁힌 이유: (1) 표시용 kwarg를 슬롯에 낮춰봐야 runtime이 즉시 discard해
// 이득이 0인데 color/size 상수식이 새로 genExpr를 타는 위험만 생기고 (2) 표에 없는 이름은 기존과
// 동일하게 무시되므로 기존 콜사이트 출력이 한 글자도 안 변한다.
// - 키는 builtinCalls 값과 같은 "kind.method"(리터럴 네임스페이스 콜과 method-call sugar 콜이 같은
//   키를 공유 — sugar는 receiver가 'id' 슬롯을 이미 차지하므로 codegen이 slice(1)로 -1 오프셋 적용).
// - 이름은 TV 공식 파라미터명이며 wild 코퍼스 실측(scratch/c813_wild_scan.mjs: label.new x/y/text,
//   line.new x1/y1/x2/y2, box.new left/top/right/bottom, label.set_text text/id, label.set_xy x/y,
//   line.set_x2 x/id, line.set_xy1·2 x/y, box.set_rightbottom right/bottom 등)와 전부 일치한다.
// - table/polyline/linefill은 runtime에 state가 아예 없어(rt.ts 참조: newTable은 빈 핸들, 나머지는
//   전부 drawingNoop) 등재 대상이 없다. label.new(point=)/line.new(first_point=)/box.new(top_left=)
//   같은 chart.point 오버로드도 제외 — runtime이 ChartPoint 객체를 숫자 필드로 읽을 수 없어
//   낮춰봐야 NaN이라 이득이 없다(현행 유지).
// viz S4 — .new 행들은 C813 당시 "state 파라미터만"에서 표시용 파라미터(TV 공식 시그니처
// 순서)까지 확장됐다: 드로잉이 더 이상 순수 no-op이 아니라 생성 로그로 캡처되므로 색/스타일도
// 이제 state다. chart.point 오버로드(label.new(point, ...))는 여전히 제외 — 위치가 한 칸씩
// 밀려 best-effort 캡처가 어긋날 수 있으나 기존(수치 NaN)과 동급의 열화라 현행 유지.
export const DRAWING_STATE_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  "label.new": ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip"],
  "label.set_x": ["id", "x"],
  "label.set_y": ["id", "y"],
  "label.set_xy": ["id", "x", "y"],
  "label.set_text": ["id", "text"],
  "label.get_x": ["id"],
  "label.get_y": ["id"],
  "label.get_text": ["id"],
  "line.new": ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width"],
  "line.set_x1": ["id", "x"],
  "line.set_y1": ["id", "y"],
  "line.set_x2": ["id", "x"],
  "line.set_y2": ["id", "y"],
  "line.set_xy1": ["id", "x", "y"],
  "line.set_xy2": ["id", "x", "y"],
  "line.get_x1": ["id"],
  "line.get_y1": ["id"],
  "line.get_x2": ["id"],
  "line.get_y2": ["id"],
  "line.get_price": ["id", "x"],
  "box.new": ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text"],
  "table.new": ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width"],
  "box.set_left": ["id", "left"],
  "box.set_right": ["id", "right"],
  "box.set_top": ["id", "top"],
  "box.set_bottom": ["id", "bottom"],
  "box.set_lefttop": ["id", "left", "top"],
  "box.set_rightbottom": ["id", "right", "bottom"],
  "box.get_left": ["id"],
  "box.get_right": ["id"],
  "box.get_top": ["id"],
  "box.get_bottom": ["id"],
};

// method-call 스타일 drawing 콜 판별(C232, `lbl.set_text(x)` == `label.set_text(lbl, x)`) —
// array/map의 method-call sugar(resolveContainerExprKind, 아래 두 분기)와 동일 원칙:
// resolveDrawingExprKind(analyzer.ts, containerKindHints과 나란한 drawingKindHints 체인 조회)로
// receiver('=' 로컬, top-level 포함)의 정적 kind를 확정한 뒤 그 kind의 DRAWING_METHODS 집합에
// method가 있는지만 검사한다. UDF/method 매개변수로 받은 핸들은 array/map과 동일하게 값 흐름
// 추적이 없어 여전히 "지원하지 않는 호출"로 거부됨.
// C354: resolveDrawingExprKind가 null이면(receiver가 Identifier/단일 DotAccess가 아님) receiver가
// array-elem-반환 콜(`boxes.shift()`/`tab.boxes.get(x)`류, CallExpr)인지
// resolveArrayGetElemDrawingKind(C353이 '=' 로컬 대입용으로 이미 만든 헬퍼, 여기선 두 번째
// 소비처로 재사용)로 한 번 더 시도한다 — wild "지원하지 않는 호출: '?.delete'" 6건 전수가 이 축
// (array<box/line> 원소를 꺼내자마자 바로 method-call sugar를 체이닝하는 패턴, '=' 로컬 대입 없이).
// linefill.get_line1/get_line2(C648, wild "?.set_xy1" 3건 — `nFibL.l_fill_.get_line1().set_xy1(...)`/
// `obj.a_Lf1.get(i).get_line1().set_xy1(...)`류) — TV linefill.get_line1/get_line2는 유일하게 자기
// 자신과 다른 drawing kind(line)를 반환하는 drawing 메서드다(나머지는 전부 같은 핸들을 반환하거나
// no-op). receiver가 이 콜 자체(CallExpr)인 경우를 resolveDrawingReceiverKind가 재귀로 한 번 더
// 시도하게 한다 — 그래야 `.get_line1().set_xy1(...)`처럼 중간 변수 없이 바로 체이닝해도 판별된다.
const LINEFILL_LINE_RETURNING_METHODS: ReadonlySet<string> = new Set(["get_line1", "get_line2"]);
function resolveDrawingMethodChainKind(receiver: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (receiver.kind !== "CallExpr" || receiver.callee.kind !== "DotAccess") return null;
  if (!LINEFILL_LINE_RETURNING_METHODS.has(receiver.callee.attr)) return null;
  const objKind = resolveDrawingReceiverKind(receiver.callee.obj, prog, scope);
  return objKind === "linefill" ? "line" : null;
}
// receiver가 top-level/UDF-내부 drawing 핸들 var·'=' 로컬의 히스토리 인덱스(`lab[1]`,
// index-access.ts analyzeIndexAccess의 varRefHistorySlots/refHistorySlots/localRefHistSlots
// 축)인 경우(C652, wild "?.delete" 잔여 — `(lab[1]).delete()`류, `var label lab = na` 뒤 히스토리
// 참조에 바로 method-call sugar를 체이닝). 히스토리 인덱싱은 값의 kind를 바꾸지 않으므로 obj
// 자신의 kind를 그대로 물려받는다 — 그 obj가 실제로 히스토리 인덱싱 가능한 형태인지(매개변수는
// 여전히 미지원 등)는 이 판별의 관심사가 아니다: isDrawingMethodSugarCall이 이 함수로 kind만
// 확정해도, 공용 꼬리 재귀(analyzeCallExpr 끝의 `analyzeExpr(callee.obj, ...)`)가 그 receiver
// 자신을 별도로 analyzeIndexAccess에 태워 지원 여부를 독립적으로 검증한다(미지원 폼이면 더 정확한
// 전용 에러로 대체될 뿐, 조용한 오답이 될 위험 없음).
function resolveDrawingHistoryIndexKind(receiver: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (receiver.kind !== "IndexAccess") return null;
  return resolveDrawingExprKind(receiver.obj, prog, scope);
}
function resolveDrawingReceiverKind(receiver: Expr, prog: AnalyzedProgram, scope: LexScope) {
  return (
    resolveDrawingExprKind(receiver, prog, scope) ??
    resolveArrayGetElemDrawingKind(receiver, prog, scope) ??
    resolveDrawingMethodChainKind(receiver, prog, scope) ??
    resolveDrawingHistoryIndexKind(receiver, prog, scope)
  );
}
function isDrawingMethodSugarCall(receiver: Expr, method: string, prog: AnalyzedProgram, scope: LexScope): boolean {
  const kind = resolveDrawingReceiverKind(receiver, prog, scope);
  return kind !== null && DRAWING_METHODS[kind]!.has(method);
}

// resolveDrawingReceiverKind와 나란한 UDT method 콜 수신자 판별 조합(C354): resolveUdtObjectType이
// null이면(receiver가 array-elem-반환 콜, CallExpr) resolveArrayGetElemUdtType(C341, '=' 로컬 대입용
// 헬퍼를 두 번째 소비처로 재사용)으로 한 번 더 시도한다 — wild "지원하지 않는 호출: '?.delete'"의
// UDT-array 축(`allGaps.shift().delete()`, Gap.delete 사용자 method 디스패치). C632: 그래도 null이면
// receiver 자신이 UDT 생성자/copy/UDF-반환-UDT/삼항 콜(isUdtConstructorCall, analyzeVarDecl 등이
// '=' 대입 우변 판별에 이미 쓰는 순수 구조 판별자)인지 마지막으로 시도한다 — `Type.new().method()`처럼
// 중간 변수 없이 생성자 콜에 바로 method를 체이닝하는 폼(wild `SessionDays.new().from_chart()`류,
// 튜플 172-클러스터 callexpr_other 표본에서 발견, library_import 오염과 무관한 순수 UDT 체이닝
// 갭이었음). C677: resolveUdtObjectType이 undefined면(receiver가 UDT로 확정되지 않음) enum 인스턴스
// 축도 시도한다(resolveEnumExprType, analyzer.ts) — UDT/enum은 서로 다른 네임스페이스(prog.udtTypes
// vs prog.enumTypes)라 receiver 하나가 둘 다일 수 없으므로 순서 무관, CallExpr 폴백보다 먼저
// 확인해야(Identifier/DotAccess는 CallExpr 분기에 안 걸림) 정상 동작. 이 헬퍼는 일반 UDT method
// 디스패치(analyzeCallExpr)에도 공유되므로 스칼라/enum 반환 method도 함께 해소된다(별도 분기 불필요).
export function resolveUdtMethodReceiverType(receiver: Expr, prog: AnalyzedProgram, scope: LexScope): string | undefined {
  const direct = resolveUdtObjectType(receiver, prog, scope);
  if (direct !== undefined) return direct;
  const enumType = resolveEnumExprType(receiver, prog, scope);
  if (enumType !== undefined) return enumType;
  if (receiver.kind !== "CallExpr") return undefined;
  return resolveArrayGetElemUdtType(receiver, prog, scope) ?? isUdtConstructorCall(receiver, prog, scope) ?? undefined;
}
import { TA_REGISTRY, analyzeStatefulCall, taCallReturnArity, resolveTaKwargPositions, type TaRegistryEntry } from "./ta";
import {
  ARRAY_REGISTRY,
  ARRAY_KWARG_PARAM_NAMES,
  MAP_REGISTRY,
  MATRIX_REGISTRY,
  STR_REGISTRY,
  STR_KWARG_PARAM_NAMES,
  analyzeArrayCall,
  analyzeMapCall,
  analyzeMatrixCall,
  analyzeStrCall,
} from "./collections";
import { lookupMethodOverload, mangleMethodName, resolveMethodReceiverTypeName, resolveScalarMethodInfo } from "./udt-types";

// input.int/float/bool/string의 파라미터 이름 -> 위치 고정 매핑표(C132). UDT `.new()`(C129)는
// "필드 이름 -> 슬롯"을 타입 선언마다 동적으로 조회해야 했지만, input.*는 pine2py 시그니처
// (int_input/float_input: defval/title/minval/maxval/step, bool_input/string_input: defval/title,
// wavealgo/builtins/input_funcs.py 확인)가 컴파일타임에 고정돼 있어 이름표 하나로 충분하다
// (next_hint가 예상한 대로 UDT보다 단순 — 동적 조회/필드 목록 순회 불필요). codegen.ts genCallExpr가
// 동일한 표를 그대로 재사용해 kwargs를 위치 인자로 낮춘다(TA_REGISTRY와 같은 analyzer->codegen
// export 관례). C133이 나머지 8종(color/source/symbol/timeframe/session/price/text_area/time,
// 전부 bool/string과 동일한 defval/title 2-파라미터)과 bare `input()`(pine2py any_input, "any"
// 키로 등록 — dot 문법 `input.any`는 TV에 없어 아래 namespace==="input" 화이트리스트에는
// 의도적으로 포함하지 않고 bare Identifier 콜 분기에서만 조회한다) 추가. C134가 마지막 남은
// `enum`(pine2py enum_input(defval, title, options, **kwargs))을 추가 — options는 세 번째
// 위치 슬롯일 뿐 이 표 입장에서는 그냥 이름 하나 더 늘어난 것(파서가 dot 뒤 ENUM 키워드 토큰을
// attr로 거부하던 문제는 parser.ts KEYWORD_AS_ATTR로 별도 해결, analyzer/codegen 쪽은 이 표에
// 항목만 추가하면 기존 analyzeInputCall/genCallExpr 로직이 그대로 재사용됨).
// plot()의 series(항상 위치 인자 0번, 필수) 뒤에 오는 나머지 파라미터 이름표(C159, ROADMAP line
// 1962 "plot() kwargs 확장 슬라이스") — TV 실제 positional 순서(series, title, color, linewidth,
// style, trackprice, histbase, offset, join, editable, show_last, display, format, precision,
// force_overlay) 그대로, series만 표 밖(index i는 실제 위치 인자 i+1에 대응). INPUT_PARAM_NAMES와
// 달리 메서드별 variant가 없어(plot은 항상 이 하나의 시그니처) Record가 아니라 단일 배열이다.
// title은 C135부터 이미 위치 인자로 지원되던 것을 이 표에도 포함시켜 `title=` kwarg로도 지정
// 가능하게 통일(나머지 13종만 다루면 title=만 kwarg 불가능한 비대칭이 생김). GOAL.md "plot은
// Float64Array 수집 채널" 원칙대로 title을 제외한 나머지는 렌더링 전용 no-op — analyzer가
// 검증(개수/이름/중복/위치-키워드 충돌)만 하고 codegen은 여전히 series 인자 하나만 record()한다
// (title도 이미 analyze-time에 prog.plotTitles로 소비되는 순수 메타데이터라 codegen에 안 감).
// viz S1 — plot.style_* 컴파일타임 상수 → 계약 스타일 문자열. TV의 10종 전부이며 이름은
// docs의 pine-viz 계약(v1)과 동일하다. 여기 없는 표현식이 style=로 오면 하드 에러 대신
// 기본 "line"으로 둔다 — 렌더링 메타데이터 때문에 컴파일이 실패하는 커버리지 회귀 금지.
// viz S2 — 캡처 대상 no-op 빌트인의 위치 인자 순서(TV v5 공식 시그니처 기준 — NOOP_BUILTIN_ARITY는
// 개수만 검증하므로 위치→이름 매핑의 소유자는 이 표다). hline은 TV 공식이 editable을 linewidth보다
// 앞에 둔다(NOOP_BUILTIN_ARITY 주석의 관례 표기와 다름) — linestyle 이후의 위치 인자 실사용은
// 사실상 없어 best-effort 추출에는 어느 쪽이든 실해가 없지만 공식 순서를 따른다.
const NOOP_POSITIONAL_ORDER: Readonly<Record<string, readonly string[]>> = {
  bgcolor: ["color", "offset", "editable", "show_last", "title", "force_overlay"],
  barcolor: ["color", "offset", "editable", "show_last", "title", "display"],
  hline: ["price", "title", "color", "linestyle", "editable", "linewidth", "display"],
  fill: ["plot1", "plot2", "color", "title"], // 캡처에 필요한 앞 4개만 — 뒤는 discard 유지
  // viz S3 — NOOP_BUILTIN_ARITY 주석의 TV 시그니처 나열과 동일 순서.
  plotshape: ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "force_overlay"],
  plotchar: ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "force_overlay"],
  plotarrow: ["series", "title", "colorup", "colordown", "offset", "minheight", "maxheight", "editable", "show_last", "display", "force_overlay"],
  plotcandle: ["open", "high", "low", "close", "title", "color", "wickcolor", "editable", "show_last", "bordercolor", "display", "force_overlay"],
  plotbar: ["open", "high", "low", "close", "title", "color", "editable", "show_last", "display", "force_overlay"],
};

// viz S3 — 마커 계열의 네임스페이스 상수 → 계약 문자열. attr에서 접두 없이 그대로 쓴다.
// viz S2/S3 — 캡처 대상 no-op 집합(fill은 args 루프 뒤 별도 캡처).
const VIZ_CAPTURE_NOOPS: ReadonlySet<string> = new Set([
  "bgcolor", "barcolor", "hline", "plotshape", "plotchar", "plotarrow", "plotcandle", "plotbar",
]);

const SHAPE_STYLE_NAMES: ReadonlySet<string> = new Set([
  "xcross", "cross", "triangleup", "triangledown", "flag", "circle",
  "arrowup", "arrowdown", "labelup", "labeldown", "square", "diamond",
]);
const LOCATION_NAMES: ReadonlySet<string> = new Set(["abovebar", "belowbar", "top", "bottom", "absolute"]);
const SIZE_NAMES: ReadonlySet<string> = new Set(["auto", "tiny", "small", "normal", "large", "huge"]);

const HLINE_STYLE_NAMES: ReadonlyMap<string, string> = new Map([
  ["style_solid", "solid"],
  ["style_dotted", "dotted"],
  ["style_dashed", "dashed"],
]);

const PLOT_STYLE_NAMES: ReadonlyMap<string, string> = new Map([
  ["style_line", "line"],
  ["style_stepline", "stepline"],
  ["style_stepline_diamond", "stepline_diamond"],
  ["style_histogram", "histogram"],
  ["style_area", "area"],
  ["style_areabr", "areabr"],
  ["style_columns", "columns"],
  ["style_cross", "cross"],
  ["style_circles", "circles"],
  ["style_linebr", "linebr"],
]);

export const PLOT_PARAM_NAMES: readonly string[] = [
  "title",
  "color",
  "linewidth",
  "style",
  "trackprice",
  "histbase",
  "offset",
  "join",
  "editable",
  "show_last",
  "display",
  "format",
  "precision",
  "force_overlay",
];

// indicator()/strategy() 스크립트 선언(directive)의 파라미터 이름표(C160, LIMITATIONS.md C151
// 발견 gap — plot() kwargs(C159)와 동일 기법: 고정 이름표 + blanket kwargs 체크 예외). directive
// 자체가 codegen.ts에서 완전한 no-op(`return null` — plot과 달리 title조차 소비하지 않음, analyzer.ts
// L525 주석 "indicator()/strategy() - codegen에서 no-op")이라 pine2py에도 대응 구현이 없다(codegen.py는
// declaration.title 하나만 주석으로 뽑아내고 나머지 인자는 전부 버림 — kwargs 자체를 지원 안 함).
// 즉 이 표는 "TV가 실제로 받는 인자 이름"이 아니라 "pine2js가 파싱만 하고 버리는 이름"이므로 pine2py
// 오라클 대조 대상이 아니고(애초에 값 하나도 codegen에 안 실림), 이름 목록은 공개된 Pine v5 언어
// 레퍼런스(indicator/strategy 함수 시그니처, 웹 접근 없이도 이미 잘 알려진 안정된 API)를 그대로
// 옮긴 것 — plot()과 달리 method별 variant가 없어(indicator/strategy 둘 다 고유 시그니처 하나씩)
// Record<string, string[]>로 두 키만 둔다. title은 index 0(항상 위치 인자 0번이자 `title=`
// kwarg로도 가능 — plot의 series와 달리 이 함수들은 "series 같은 필수 실값 인자" 자체가 없어 표
// 밖으로 뺄 이유가 없다, input.*의 defval과 동일한 취급).
const INDICATOR_PARAM_NAMES: readonly string[] = [
  "title",
  "shorttitle",
  "overlay",
  "format",
  "precision",
  "scale",
  "max_bars_back",
  "timeframe",
  "timeframe_gaps",
  "explicit_plot_zorder",
  "max_lines_count",
  "max_labels_count",
  "max_boxes_count",
  "max_polylines_count",
  "calc_bars_count",
  "behind_chart",
];
// strategy()는 indicator()의 공통 파라미터(title~calc_bars_count 등)에 백테스트 엔진 설정
// (pyramiding~fill_orders_on_standard_ohlc)이 추가된 상위집합 시그니처 — TV 문서 순서 그대로.
const STRATEGY_PARAM_NAMES: readonly string[] = [
  "title",
  "shorttitle",
  "overlay",
  "format",
  "precision",
  "scale",
  "pyramiding",
  "calc_on_order_fills",
  "calc_on_every_tick",
  "max_bars_back",
  "backtest_fill_limits_assumption",
  "default_qty_type",
  "default_qty_value",
  "initial_capital",
  "currency",
  "slippage",
  "commission_type",
  "commission_value",
  "process_orders_on_close",
  "close_entries_rule",
  "margin_long",
  "margin_short",
  "explicit_plot_zorder",
  "max_lines_count",
  "max_labels_count",
  "max_boxes_count",
  "max_polylines_count",
  "calc_bars_count",
  "risk_free_rate",
  "use_bar_magnifier",
  "fill_orders_on_standard_ohlc",
];
// library() 스크립트 선언(C274) — indicator/strategy와 동일한 no-op 지시어(codegen 완전 무시,
// 위 주석 참조). 실제 TV 시그니처는 title/overlay 둘뿐(indicator/strategy처럼 방대한 표가 아님) —
// pine2py도 library()를 별도 declaration 노드 없이 그냥 통과 ExprStmt로 흘려보내고 codegen이
// `# library(title)` 주석 한 줄만 뽑을 뿐 인자 이름 자체를 검증하지 않는다(python 소스 확인,
// _SCRIPT_DECL_FUNCS에 indicator/strategy/library 셋이 동일하게 묶여 있음) — 즉 여기도 위와 동일
// 이유로 오라클 대조 대상이 아니고 이름 목록은 공개된 Pine v5 언어 레퍼런스를 그대로 옮긴 것.
const LIBRARY_PARAM_NAMES: readonly string[] = ["title", "overlay"];
// study() — TV v4 legacy 별칭(TV가 이후 버전에서 indicator()로 개명, wild corpus 6개 파일이
// 여전히 이 옛 이름을 씀). pine2py에는 study() 대응 구현이 전혀 없다(grep 0건 — parser.py는
// STRATEGY/INDICATOR/LIBRARY 세 키워드만 선언 토큰으로 인식) — 즉 이 이름은 오라클 대조 자체가
// 불가하고(어차피 directive 전체가 no-op이라 값 검증 대상도 아님, 위 INDICATOR_PARAM_NAMES 주석과
// 동일 급) v4/v5 파라미터 시그니처 동일성은 웹 접근 없이 이 세션이 직접 검증할 수 없는 가설이다
// (DIVERGENCES.md에 'TV 미검증(가설)'로 등재). wild 6개 파일 실사용은 title(위치/title=)/
// shorttitle=/overlay= 세 개뿐이라 INDICATOR_PARAM_NAMES를 그대로 재사용해도 실측 위험은 없음 —
// v5/v6 전용 신규 파라미터(max_polylines_count/calc_bars_count/behind_chart)까지 과허용해도
// 값 자체가 discard라 무해(C283 큐레이션 원칙은 "위치 표 확장"에만 적용, 순수 재사용은 해당 없음).
const DIRECTIVE_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  indicator: INDICATOR_PARAM_NAMES,
  strategy: STRATEGY_PARAM_NAMES,
  library: LIBRARY_PARAM_NAMES,
  study: INDICATOR_PARAM_NAMES,
};

// indicator()/strategy() kwarg 전용 허용 이름(C283, wild 실측 indicator|dynamic_requests 24 /
// max_tables_count 10 — 둘 다 v5/v6 실존 파라미터). 위 표들에 append하면 maxArgs가 밀려 기존
// "0~16개" 등 arity 메시지가 바뀌므로(위치 인자 16개+ 스크립트는 실전 0건이라 위치 지원은 무가치)
// plot의 transp/input.*의 메타데이터 kwarg와 동일하게 kwarg 전용 discard로만 허용한다. library는
// 대상 아님(TV 시그니처에 없음 — title/overlay 둘뿐).
// C560: behind_chart(wild strategy() 5건, solo 3 — 05a0e7efd718.pine이 backtest_fill_limits_assumption/
// use_bar_magnifier 등 다른 obscure 정확 스펠링 인자와 나란히 써 저자가 실제 TV 시그니처를 안다는
// 정황 증거) / linktoseries(wild indicator() 5건, solo 3 — 'Gap Finder'/'AlgoPoint | Reversal
// Master'/'EMA 14 haf-aylık' 세 독립 저자가 동일 이름을 동일 boolean 관용구로 반복 사용, C283
// dynamic_requests와 동일한 "독립 저자 교차 확인" 근거). behind_chart는 INDICATOR_PARAM_NAMES에
// 이미 위치 인자로 있었으나(indicator 전용) strategy()에는 없었다 — 값이 no-op discard라 두 지시어
// 모두에 kwarg-only로 과허용해도 무해(위 원칙과 동일).
const DIRECTIVE_META_KWARG_NAMES: ReadonlySet<string> = new Set([
  "dynamic_requests",
  "max_tables_count",
  "behind_chart",
  "linktoseries",
]);

// 지시어 호출에서 특정 파라미터에 실제로 전달된 값 표현식을 찾는다(C164) — 위치 인자(파라미터
// 순서표의 인덱스)와 키워드 인자 둘 다 커버. 중복(위치+키워드 동시 지정)은 호출부의 공통 kwargs
// 검증이 이미 에러로 잡으므로 여기서는 먼저 발견되는 쪽을 반환하면 충분하다.
function directiveArgExpr(expr: CallExpr, paramNames: readonly string[], name: string): Expr | undefined {
  const idx = paramNames.indexOf(name);
  if (idx >= 0 && idx < expr.args.length) return expr.args[idx];
  for (const kw of expr.kwargs) {
    if (kw.name === name) return kw.value;
  }
  return undefined;
}

// C764: strategy() 지시어 숫자 인자(default_qty_value/pyramiding/initial_capital)가 top-level 유일
// '=' 상수 식별자를 가리키는 경우(`qty1 = 180` 후 `default_qty_value = qty1`, wild 실사용) 재귀
// 해석해 리터럴로 치환한다 — resolveSecurityTfLiteral류와 동일한 uniqueTopEqVars 안전 근거(top-level
// 유일 바인딩 + 재대입 0). strategy()는 항상 top-level 문장이므로(topLevel 게이트) shadowFuncs 대조는
// 불필요 — 그 값 참조 자체가 함수 본문 안일 수 없다.
function resolveDirectiveConstNumber(value: Expr, prog: AnalyzedProgram, visiting: Set<string> = new Set()): number | undefined {
  if (value.kind === "NumberLiteral") return value.value;
  if (value.kind === "Identifier") {
    if (visiting.has(value.name)) return undefined;
    const top = prog.uniqueTopEqVars.get(value.name);
    if (top === undefined) return undefined;
    visiting.add(value.name);
    return resolveDirectiveConstNumber(top.value, prog, visiting);
  }
  return undefined;
}

// request.security의 gaps=/lookahead= kwarg 값을 컴파일타임 boolean으로 확정(C177) — true/false
// 리터럴 또는 barmerge.gaps_on/gaps_off/lookahead_on/lookahead_off 상수만 인정, 그 외(변수/식/
// 다른 네임스페이스의 boolean 상수)는 undefined로 되돌려 호출부가 하드 에러를 내게 한다.
// C707(batch35 next_hint 컴파일타임리터럴값 클러스터): 위 리프 판정은 그대로 두고, 그 리프까지
// 도달하기 위한 변수/삼항 경유만 resolveSecurityTfLiteral/resolveSecurityTfTernaryCondition(tf
// 리졸버)과 완전히 동형으로 재귀 확장한다 — wild `lookahead=lookahead`(top-level '=' 변수 경유
// 리프 그대로 전달)와 `gaps = cond ? barmerge.gaps_on : barmerge.gaps_off`(조건이
// resolveSecurityTfTernaryCondition으로 확정 가능한 삼항) 두 관용구. 위 함수 주석이 명시한 "get()이
// codegen 시점에 리터럴로 확정돼야" 제약은 그대로 유지 — 이 확장은 "무엇을 컴파일타임 상수로
// 증명할 수 있는가"만 넓힐 뿐 런타임 값을 허용하지 않는다(tf 리졸버가 C511-C513에서 넓힌 것과
// 동일한 성격, 코드젠 쪽은 무변경).
function resolveSecurityBooleanKwarg(
  value: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string> = new Set(),
  env: SecurityConstEnv = null,
  funcName: string | null = null,
): boolean | undefined {
  if (value.kind === "BoolLiteral") return value.value;
  if (value.kind === "DotAccess" && value.obj.kind === "Identifier" && value.obj.name === "barmerge") {
    return BARMERGE_CONSTANTS.get(value.attr);
  }
  if (value.kind === "TernaryOp") {
    const cond = resolveSecurityTfTernaryCondition(value.condition, prog, visiting, env, funcName);
    if (cond === undefined) return undefined;
    return resolveSecurityBooleanKwarg(cond ? value.trueExpr : value.falseExpr, prog, visiting, env, funcName);
  }
  if (value.kind === "Identifier") {
    const envVal = env?.get(value.name);
    if (envVal !== undefined) return envVal.kind === "boolean" ? envVal.value : undefined;
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(value.name);
      if (localDef !== undefined) {
        if (localDef.line >= value.line || visiting.has(value.name)) return undefined;
        visiting.add(value.name);
        const result = resolveSecurityBooleanKwarg(localDef.value, prog, visiting, env, funcName);
        visiting.delete(value.name);
        return result;
      }
    }
    if (visiting.has(value.name)) return undefined;
    if (funcName !== null && prog.constVarShadowFuncs.get(value.name)?.has(funcName)) return undefined;
    const def = prog.uniqueTopEqVars.get(value.name);
    if (def === undefined || def.line >= value.line) return undefined;
    visiting.add(value.name);
    const result = resolveSecurityBooleanKwarg(def.value, prog, visiting, null, null);
    visiting.delete(value.name);
    return result;
  }
  return undefined;
}

// request.security의 'timeframe' 인자를 컴파일타임 문자열로 확정(C307, wild 2위 클러스터
// 재조사) — StringLiteral뿐 아니라 timeframe.period/main_period(analyzer.ts TIMEFRAME_STRING_PROPS,
// pine2py Context.timeframe이 항상 고정 "D"라 컴파일타임에 이미 "D"로 폴딩되는 값, DIVERGENCES #112와
// 동일 근거)도 인정한다 — 둘 다 codegen 시점에 이미 확정된 상수 문자열이라 HTF 집계 캐시(security.ts
// build())가 "런타임 tf 변경"으로 취급할 이유가 없다(security.build()는 임의의 tf 문자열을 그대로
// 받아 집계할 뿐 base 데이터의 실제 주기를 전제하지 않음, tf가 리터럴이기만 하면 무해).
// C510: 삼항 tf 인자의 조건이 컴파일타임에 결정 가능한 문자열 동등비교("X == ''"류)이면 그 조건을
// 폴딩해 선택된 분기만 resolveSecurityTfLiteral로 재귀 해석한다(wild 실측: `tf == "" ? timeframe.period
// : tf` — input.timeframe(defval="")가 빈 문자열이면 차트 tf를 쓰는 관용구, 8개 파일). 좌우 피연산자가
// 둘 다 resolveSecurityTfLiteral로 풀리는 "문자열 상수"일 때만 조건을 확정하고, 그 외(비교 대상이
// bar series/식이라 진짜 런타임에 갈리는 조건, 예: `close > open ? "60" : "240"`)는 undefined로
// 돌려보내 기존 하드 에러를 그대로 유지한다 — 보수 원칙(C366과 동일 결).
// C511: 조건이 bare Identifier(bool 변수)일 때, 새 맵을 신설하는 대신 이미 있는 prog.uniqueTopEqVars
// (C367 인프라 — 전역 유일 top-level '=' 바인딩의 값 Expr을 이름으로 조회)로 그 변수의 정의식을 찾아
// 재귀 판정한다(wild `useHtfBarDelta = volDeltaBarTf != "Chart"` 후 `useHtfBarDelta ? volDeltaBarTf :
// timeframe.period`류, 2개 파일). 정의식 자체가 다시 ==/!= 비교나 다른 bool 변수 체인이어야 폴딩되고,
// input.bool(defval=..)처럼 비교가 전혀 없는 bare boolean 상수는 여전히 undefined(기존 거부 테스트
// "bare boolean flag" 그대로 유지 — 그 케이스는 비교식이 아니라 순수 값이라 이 재귀가 애초에 안 걸림).
// def.line < cond.line 순서 가드 + visiting 사이클 가드는 C452 UDF-단일콜사이트 치환의 선례와 동일.
// C512: 산술 임계값 체인(auto-HTF 클러스터 변종 (a)) 폴딩용 숫자 상수 리졸버 —
// `vp2LtfStr = timeframe.in_seconds() >= 14400 ? "15" : ... : timeframe.period`(wild 377d8da362c5
// 등 실측 26파일이 이 축 단독 차단)류 삼항 조건의 양변을 컴파일타임 숫자로 확정한다. 대상:
// NumberLiteral / 단항 마이너스 / timeframe.multiplier(엔진 차트 tf="D" 고정이라 상수 1) /
// timeframe.in_seconds(인자 생략=차트 tf, 또는 인자가 tf 문자열 상수로 풀릴 때 — 런타임 함수를
// 직접 호출해 값 동일성 보장) / uniqueTopEqVars 경유 변수(C511과 동일한 선언-후-사용 line 가드 +
// visiting 사이클 가드) / +,-,* 산술. `/`는 Pine int/int 절삭 나눗셈(rt.idiv)과 JS float 나눗셈이
// 갈릴 수 있어 몫이 정확히 정수일 때만(양쪽 시맨틱이 같은 값) 폴딩하고 그 외/0-나눗셈은 undefined
// (보수 원칙 — input.int류 런타임 오버라이드 가능 값은 CallExpr 미처리로 자연 배제된다).
// C513: auto-HTF 변종 (b) — 삼항 조건이 단일식 본문 UDF 콜(`tfActive(tf1Enabled, tf1)`)일 때
// 인자를 전부 컴파일타임 상수로 확정한 뒤 본문을 "매개변수명 → 상수값" env로 재귀 폴딩한다.
// env는 UDF 본문 표현식 트리 안에서만 유효한 렉시컬 치환 환경이다: Identifier 분기가 env를
// 먼저 조회(매개변수가 top-level 동명 변수를 섀도잉)하고, uniqueTopEqVars 정의식으로 점프하는
// 순간 env를 null로 떨어뜨린다(정의식은 top-level 스코프라 매개변수가 보이면 안 됨). 인자
// 값은 string/number/boolean 셋 중 하나로 태깅해 담는다 — tf 문자열("1")과 임계값 숫자, bool
// 플래그(input.bool)가 한 콜사이트에 섞여 오는 wild 실사용(2288dd31000d 등 2파일) 그대로.
type SecurityConstValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };
type SecurityConstEnv = Map<string, SecurityConstValue> | null;

// 콜사이트 인자 1개를 태깅된 컴파일타임 상수로 확정한다. 시도 순서는 string → number → boolean —
// StringLiteral/NumberLiteral/BoolLiteral은 각각 첫 매칭 리졸버에서만 풀리므로 순서에 의한
// 오분류는 구조적으로 없다(문자열 상수가 숫자로 오인되는 경로 자체가 없음).
function resolveSecurityConstValue(
  expr: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null = null,
): SecurityConstValue | undefined {
  const str = resolveSecurityTfLiteral(expr, prog, visiting, env, funcName);
  if (str !== undefined) return { kind: "string", value: str };
  const num = resolveSecurityNumericConst(expr, prog, visiting, env, funcName);
  if (num !== undefined) return { kind: "number", value: num };
  const bool = resolveSecurityTfTernaryCondition(expr, prog, visiting, env, funcName);
  if (bool !== undefined) return { kind: "boolean", value: bool };
  return undefined;
}

// 이름이 fnName인 top-level FuncDecl이 정확히 1개이고 본문의 마지막 문장이 ExprStmt 또는
// 단일 SwitchStmt(C515, `f() => switch x ... `류 — 파서가 body[0]에 ExprStmt로 안 감싸고
// SwitchStmt 그대로 둠, 별도 분기 필요) 또는 단일 IfStmt(C607, `f() => if cond \n ... else ...`류
// — 파서가 body[0]에 IfStmt 그대로 둠, SwitchStmt와 동일 형태) 또는 Assignment(C608, 아래
// resolveSecurityBodyConstValue 참조)일 때만 그 선언을 돌려준다 — 동명 중복/미선언/마지막 문장이
// 그 외 종류는 undefined(보수 원칙, 폴딩 포기 = 기존 하드 에러 유지). C608: 이전엔 본문이 정확히
// 1문장이어야 했으나, pine2py _emit_implicit_return이 오직 body[-1](마지막 문장)만 보고 그 앞
// 문장은 값 결정에 관여하지 않는다(python 코드젠 직접 확인) — 그 앞 문장이 몇 개든 무관하게
// 마지막 문장만으로 판정하도록 완화(`timeframe = timeframe.period \n if ... timeframe := ...`류,
// wild 156fe2b8bc92/42ca34e3a483.pine 'timeframe_func()' 관용구). 이 조회는 security tf 삼항
// 조건에 UDF 콜이 올 때만 도는 희귀 경로라 선형 스캔으로 충분하다.
function findSecurityFoldableFuncDecl(fnName: string, prog: AnalyzedProgram): FuncDecl | undefined {
  let decl: FuncDecl | undefined;
  for (const stmt of prog.script.body) {
    if (stmt.kind !== "FuncDecl" || stmt.name !== fnName) continue;
    if (decl !== undefined) return undefined;
    decl = stmt;
  }
  if (decl === undefined || decl.body.length === 0) return undefined;
  const last = decl.body[decl.body.length - 1]!;
  if (last.kind !== "ExprStmt" && last.kind !== "SwitchStmt" && last.kind !== "IfStmt" && last.kind !== "Assignment")
    return undefined;
  return decl;
}

// switch(-as-expression) case 본문의 마지막 문장이 ExprStmt일 때만 그 값을 돌려준다(다른 문장으로
// 끝나는 case는 값이 없어 폴딩 불가 — 보수 원칙). Pine은 case 본문에 여러 문장을 허용하고 마지막
// 문장의 값이 case의 값이므로 마지막만 본다(중간 문장은 부작용 — 이 폴딩 경로는 부작용 없는 상수
// 평가 전용이라 존재 자체를 확인만 하고 값 계산에는 관여시키지 않는다).
function lastStmtExprValue(body: Stmt[]): Expr | undefined {
  if (body.length === 0) return undefined;
  const last = body[body.length - 1]!;
  return last.kind === "ExprStmt" ? last.expr : undefined;
}

// C515: switch-as-expression 값을 컴파일타임 상수로 평가(auto-HTF 잔여 — `getEntryTF() => switch
// entryTF \n "1H" => "60" \n ... \n => ""`류, subject가 top-level 상수 문자열로 풀리는 wild
// 관용구). case는 소스 순서대로 평가: 먼저 나온 case의 값이 하나라도 확정 불가면(cv===undefined)
// 그 뒤 case가 매치해도 신뢰할 수 없어 즉시 포기한다(진짜로 먼저 매치했을 수도 있는 case를
// 건너뛰면 오답이 되므로 보수 원칙) — 값이 전부 확정되고 매치가 없으면 다음 case로, 끝까지 매치
// 없으면 default(bare '=>')로 폴백.
function resolveSecuritySwitchConstValue(
  stmt: SwitchStmt,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null = null,
): SecurityConstValue | undefined {
  if (stmt.subject === null) {
    // C606: subject 없는 폼(각 case가 자체 boolean 조건인 if-elif형 switch) — C515가 "wild 실사용
    // 근거 없음"으로 범위 밖에 뒀으나 auto-HTF UDF 관용구(`getHTF() => switch \n timeframe.period
    // == "1" => "5" \n ... \n => "D"`, wild ad6cedfa0292.pine)로 반증됐다. case를 소스 순서대로
    // 평가해 조건이 true로 확정되는 첫 case를 채택 — 확정 true를 만나기 전에 미확정(undefined)
    // 조건이 나오면 그 case를 안전히 건너뛸 수 있다는 보장이 없어 즉시 포기한다(subject형과 동일
    // 보수 원칙).
    for (const c of stmt.cases) {
      if (c.values === null) {
        const value = lastStmtExprValue(c.body);
        return value === undefined ? undefined : resolveSecurityConstValue(value, prog, visiting, env, funcName);
      }
      let matched = false;
      let unresolved = false;
      for (const v of c.values) {
        const cond = resolveSecurityTfTernaryCondition(v, prog, visiting, env, funcName);
        if (cond === true) {
          matched = true;
          break;
        }
        if (cond === undefined) unresolved = true;
      }
      if (matched) {
        const value = lastStmtExprValue(c.body);
        return value === undefined ? undefined : resolveSecurityConstValue(value, prog, visiting, env, funcName);
      }
      if (unresolved) return undefined;
    }
    // C606: 전 case가 확정적으로 false이고 default(bare '=>')도 없음 — C528과 동일 근거(na 폴백)로
    // chartTf 리터럴로 정규화.
    return { kind: "string", value: prog.chartTf };
  }
  const subject = resolveSecurityConstValue(stmt.subject, prog, visiting, env, funcName);
  if (subject === undefined) return undefined;
  for (const c of stmt.cases) {
    if (c.values === null) continue;
    let unresolved = false;
    for (const v of c.values) {
      const cv = resolveSecurityConstValue(v, prog, visiting, env, funcName);
      if (cv === undefined) {
        unresolved = true;
        continue;
      }
      if (cv.kind === subject.kind && cv.value === subject.value) {
        const value = lastStmtExprValue(c.body);
        return value === undefined ? undefined : resolveSecurityConstValue(value, prog, visiting, env, funcName);
      }
    }
    if (unresolved) return undefined;
  }
  const def = stmt.cases.find((c) => c.values === null);
  if (def === undefined) {
    // C528: subject/전체 case 값이 이미 컴파일타임 상수로 확정됐는데(위 루프가 여기 도달했다는
    // 것 자체가 그 증거) 매치가 없고 default(bare '=>')도 없으면 "폴딩 불가"가 아니라 TV
    // switch-as-expression 시맨틱상 확정적으로 na로 평가되는 경우다(09b90603d02b.pine —
    // currentTimeFrame=timeframe.period로 폴딩된 값이 어느 case 라벨과도 안 겹침, default 없음).
    // C514의 NaLiteral=차트 tf 폴백과 동일한 값으로 정규화(배치30 (1), C591부터 prog.chartTf —
    // 이전엔 하드코딩 "D") — 그 폴백 자체가 tf 컨텍스트 전용 의미라 여기서도 tf 리터럴 문자열로만
    // 돌려준다(별도 "na" 태그 없이 C514 선례와 동일 지점에서 동일 처리).
    return { kind: "string", value: prog.chartTf };
  }
  const value = lastStmtExprValue(def.body);
  return value === undefined ? undefined : resolveSecurityConstValue(value, prog, visiting, env, funcName);
}

// C607: IfStmt-as-expression 본문(제어문-식)을 컴파일타임 상수로 평가(auto-HTF UDF 관용구 —
// `autoHTF() => if timeframe.isseconds or timeframe.isintraday \n if ... \n ... else ... \n
// else if timeframe.isdaily \n "W" \n else \n "M"`류, wild dc58f983eeda/796fb9fec3ca 2파일).
// 조건은 기존 resolveSecurityTfTernaryCondition으로 판정(timeframe.is*/산술·논리 이미 지원),
// 매치된 분기의 값은 resolveSecurityBodyConstValue로 재귀 — thenBody 자신이 중첩 IfStmt 하나뿐인
// 패턴(autoHTF 안쪽 if)까지 그 재귀가 자연히 흡수한다. elifClauses는 소스 순서대로 평가 —
// switch 리졸버(C515/C606)와 동일 보수 원칙: 먼저 나온 조건이 미확정이면 뒤 조건이 매치해도
// 신뢰할 수 없어 즉시 포기. else가 없으면(비-완전 분기) 값이 없어 폴딩 불가.
function resolveSecurityIfConstValue(
  stmt: IfStmt,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null = null,
): SecurityConstValue | undefined {
  const cond = resolveSecurityTfTernaryCondition(stmt.condition, prog, visiting, env, funcName);
  if (cond === undefined) return undefined;
  if (cond) return resolveSecurityBodyConstValue(stmt.thenBody, prog, visiting, env, funcName);
  for (const clause of stmt.elifClauses) {
    const c = resolveSecurityTfTernaryCondition(clause.condition, prog, visiting, env, funcName);
    if (c === undefined) return undefined;
    if (c) return resolveSecurityBodyConstValue(clause.body, prog, visiting, env, funcName);
  }
  if (stmt.elseBody === null) return undefined;
  return resolveSecurityBodyConstValue(stmt.elseBody, prog, visiting, env, funcName);
}

// C607: 제어문-식 분기 본문(Stmt[])의 "값"을 재귀 확정 — 마지막 문장이 ExprStmt면 그 식을
// resolveSecurityConstValue로, IfStmt/SwitchStmt(중첩 제어문-식)면 각자의 전용 리졸버로 재귀한다.
// lastStmtExprValue(ExprStmt 전용)와 달리 마지막 문장 자체가 또 다른 제어문-식일 수 있는 경우까지
// 처리 — 그 외로 끝나는 본문은 값이 없어 폴딩 불가(보수 원칙, 기존 하드 에러 유지).
// C608: 마지막 문장이 Assignment('='/':=' 재대입 무관, `x := expr`류)면 별개 — DIVERGENCES.md
// #172(C571)가 이미 확정한 codegen genImplicitReturn과 동일 시맨틱을 재사용한다: TV는 대입문
// 자신도 값(대입된 값)을 가지므로 그게 마지막 문장이면 그 값이 UDF/분기의 암시 반환값이다(pine2py
// _emit_implicit_return은 이 3분기(ExprStmt/IfStmt/SwitchStmt) 밖은 return을 안 내 None을
// 반환하는 latent 버그 — GOAL.md "pine2py의 알려진 버그는 따르지 않는다" 원칙에 따라 codegen이
// 이미 정정해 뒀다, python 직접 실행으로 재확인 완료). 대입된 값(stmt.value) 자체를 재귀 폴딩한다
// (genImplicitReturn의 "대입 후 이름을 참조로 return"과 값 동치 — 이 문장이 그 스코프의 마지막이라
// 사이에 값을 바꿀 문장이 없다). wild `timeframe_func() => timeframe = timeframe.period \n
// if time_warp=='off' \n timeframe := timeframe.period \n else if time_warp=='1m' \n
// timeframe := '1' \n else \n timeframe := timeframe.period`류(156fe2b8bc92/42ca34e3a483.pine)가
// 이 클래스 — 매치된 분기의 ':=' 우변이 그대로 tf 값이다(분기마다 다를 수 있어 na로 뭉개면 안 됨).
function resolveSecurityBodyConstValue(
  body: Stmt[],
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null = null,
): SecurityConstValue | undefined {
  if (body.length === 0) return undefined;
  const last = body[body.length - 1]!;
  if (last.kind === "ExprStmt") {
    const direct = resolveSecurityConstValue(last.expr, prog, visiting, env, funcName);
    if (direct !== undefined) return direct;
    // C625(next_hint(C625)): 직접 해석 실패 + bare Identifier 참조면 '누산기' 관용구 폴백 시도
    // (아래 resolveSecurityAccumulatorTail 참조).
    return last.expr.kind === "Identifier"
      ? resolveSecurityAccumulatorTail(body, last.expr.name, prog, visiting, env, funcName)
      : undefined;
  }
  if (last.kind === "IfStmt") return resolveSecurityIfConstValue(last, prog, visiting, env, funcName);
  if (last.kind === "SwitchStmt") return resolveSecuritySwitchConstValue(last, prog, visiting, env, funcName);
  if (last.kind === "Assignment") return resolveSecurityConstValue(last.value, prog, visiting, env, funcName);
  return undefined;
}

// C625(next_hint(C625)): '누산기(accumulator)' 변수 — `x = <init>` 후 비완전 if/elif(또는 switch)
// 체인이 ':='로 조건부 재대입하고, 마지막에 bare `x` 참조로 함수가 끝나는 관용구
// (get_pivot_resolution() 등, wild 15+파일에 완전동일 중복 포함 — scratch/c625c_topdef_results.json).
// 기존 resolveSecurityBodyConstValue(C607/C608)는 if/elif 자체가 tail이거나 각 분기 끝이 대입일
// 때만 해소했는데, 이 관용구는 "별도 누산기 변수가 분기마다 다를 수 있는 값을 나르고, 매치 없는
// 분기에서는 이전 값이 그대로 살아남는" fallthrough-to-prior-value 시맨틱이라 범위 밖이었다.
// 아래 4개 헬퍼가 body[0..length-2]를 순서대로 심볼릭 실행해 varName의 최종값을 추적한다.
const ACC_BAIL = Symbol("security-accumulator-bail");
type AccumulatorOutcome = SecurityConstValue | undefined | typeof ACC_BAIL;

// varName을 ':='로 재대입하는 문장이 body 안 어디에도(중첩 If/Switch 포함) 없으면 false — 아래
// applyAccumulatorBlock이 이 결과로 If/SwitchStmt의 조건 폴딩 시도 자체를 건너뛴다(무관한 미확정
// 조건 때문에 불필요하게 포기하지 않기 위함, next_hint의 "X를 건드리는 If/SwitchStmt" 원칙).
// Pine의 '='는 항상 새 로컬 선언(중첩 블록 안의 동명 '='는 바깥 변수를 건드리지 않는 섀도잉 —
// MEMORY.md C5)이라 ':='만 "건드림"으로 인정한다.
function accumulatorTouchesVar(body: Stmt[], varName: string): boolean {
  for (const stmt of body) {
    if (stmt.kind === "Assignment" && stmt.operator === ":=" && stmt.name === varName) return true;
    if (stmt.kind === "IfStmt") {
      if (accumulatorTouchesVar(stmt.thenBody, varName)) return true;
      for (const clause of stmt.elifClauses) {
        if (accumulatorTouchesVar(clause.body, varName)) return true;
      }
      if (stmt.elseBody !== null && accumulatorTouchesVar(stmt.elseBody, varName)) return true;
    }
    if (stmt.kind === "SwitchStmt") {
      for (const c of stmt.cases) {
        if (accumulatorTouchesVar(c.body, varName)) return true;
      }
    }
  }
  return false;
}

// If문 분기 선택 — resolveSecurityIfConstValue와 동일한 순서-민감 보수 원칙(먼저 나온 조건이
// 미확정이면 뒤 조건이 매치해도 신뢰할 수 없어 즉시 포기). 매치되는 분기가 없고 else도 없으면
// (비완전 체인) — 이게 바로 누산기 관용구의 핵심 — current(진입 시점 값)를 그대로 유지한다
// (폴딩 실패가 아니라 TV fallthrough 시맨틱 자체이므로 ACC_BAIL이 아니라 current를 그대로 반환).
function applyAccumulatorIfStmt(
  stmt: IfStmt,
  varName: string,
  current: SecurityConstValue | undefined,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null,
): AccumulatorOutcome {
  const cond = resolveSecurityTfTernaryCondition(stmt.condition, prog, visiting, env, funcName);
  if (cond === undefined) return ACC_BAIL;
  if (cond) return applyAccumulatorBlock(stmt.thenBody, varName, current, false, prog, visiting, env, funcName);
  for (const clause of stmt.elifClauses) {
    const c = resolveSecurityTfTernaryCondition(clause.condition, prog, visiting, env, funcName);
    if (c === undefined) return ACC_BAIL;
    if (c) return applyAccumulatorBlock(clause.body, varName, current, false, prog, visiting, env, funcName);
  }
  if (stmt.elseBody === null) return current;
  return applyAccumulatorBlock(stmt.elseBody, varName, current, false, prog, visiting, env, funcName);
}

// switch-as-expression 분기 선택 — resolveSecuritySwitchConstValue와 동일 원칙, 매치가 없고
// default(bare '=>')도 없으면 current 유지(위 If 헬퍼와 대칭).
function applyAccumulatorSwitchStmt(
  stmt: SwitchStmt,
  varName: string,
  current: SecurityConstValue | undefined,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null,
): AccumulatorOutcome {
  if (stmt.subject === null) {
    for (const c of stmt.cases) {
      if (c.values === null) {
        return applyAccumulatorBlock(c.body, varName, current, false, prog, visiting, env, funcName);
      }
      let matched = false;
      let unresolved = false;
      for (const v of c.values) {
        const cond = resolveSecurityTfTernaryCondition(v, prog, visiting, env, funcName);
        if (cond === true) {
          matched = true;
          break;
        }
        if (cond === undefined) unresolved = true;
      }
      if (matched) return applyAccumulatorBlock(c.body, varName, current, false, prog, visiting, env, funcName);
      if (unresolved) return ACC_BAIL;
    }
    return current;
  }
  const subject = resolveSecurityConstValue(stmt.subject, prog, visiting, env, funcName);
  if (subject === undefined) return ACC_BAIL;
  for (const c of stmt.cases) {
    if (c.values === null) continue;
    let unresolved = false;
    for (const v of c.values) {
      const cv = resolveSecurityConstValue(v, prog, visiting, env, funcName);
      if (cv === undefined) {
        unresolved = true;
        continue;
      }
      if (cv.kind === subject.kind && cv.value === subject.value) {
        return applyAccumulatorBlock(c.body, varName, current, false, prog, visiting, env, funcName);
      }
    }
    if (unresolved) return ACC_BAIL;
  }
  const def = stmt.cases.find((c) => c.values === null);
  if (def === undefined) return current;
  return applyAccumulatorBlock(def.body, varName, current, false, prog, visiting, env, funcName);
}

// block을 순서대로 "실행"하며 varName의 값을 갱신한다. topLevel=true일 때만 '='(신규 선언/재선언)도
// 재대입으로 인정(누산기 자신의 최초 선언이 위치한 스코프 — resolveSecurityAccumulatorTail의 최초
// 호출 지점) — If/Switch 분기 본문으로 재귀하면 topLevel=false가 되어 같은 이름의 '='는 항상 새
// 로컬 섀도잉으로 무시된다(accumulatorTouchesVar와 동일 원칙).
function applyAccumulatorBlock(
  block: Stmt[],
  varName: string,
  current: SecurityConstValue | undefined,
  topLevel: boolean,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null,
): AccumulatorOutcome {
  for (const stmt of block) {
    if (
      stmt.kind === "Assignment" &&
      stmt.name === varName &&
      (stmt.operator === ":=" || (topLevel && stmt.operator === "="))
    ) {
      const value = resolveSecurityConstValue(stmt.value, prog, visiting, env, funcName);
      if (value === undefined) return ACC_BAIL;
      current = value;
      continue;
    }
    if (stmt.kind === "IfStmt") {
      if (!accumulatorTouchesVar([stmt], varName)) continue;
      const result = applyAccumulatorIfStmt(stmt, varName, current, prog, visiting, env, funcName);
      if (result === ACC_BAIL) return ACC_BAIL;
      current = result;
      continue;
    }
    if (stmt.kind === "SwitchStmt") {
      if (!accumulatorTouchesVar([stmt], varName)) continue;
      const result = applyAccumulatorSwitchStmt(stmt, varName, current, prog, visiting, env, funcName);
      if (result === ACC_BAIL) return ACC_BAIL;
      current = result;
      continue;
    }
  }
  return current;
}

// resolveSecurityBodyConstValue의 폴백 진입점 — 마지막 문장이 bare Identifier(varName) 참조일 때만
// 호출된다(호출부에서 이미 확인). body 안에서 varName의 최초 top-level '=' 선언을 찾아 그 값으로
// 시작해, 그 뒤(마지막 문장 직전까지)를 순서대로 스캔한다. 최초 선언을 못 찾으면(varName이 이
// 함수의 매개변수이거나 다른 경로로 존재) 폴딩 포기 — 이 메커니즘은 "= 선언 후 := 재대입" 관용구
// 전용이다.
function resolveSecurityAccumulatorTail(
  body: Stmt[],
  varName: string,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null,
): SecurityConstValue | undefined {
  const initIdx = body.findIndex(
    (s, i) => i < body.length - 1 && s.kind === "Assignment" && s.operator === "=" && s.name === varName,
  );
  if (initIdx === -1) return undefined;
  const initStmt = body[initIdx] as Assignment;
  const initValue = resolveSecurityConstValue(initStmt.value, prog, visiting, env, funcName);
  if (initValue === undefined) return undefined;
  const rest = body.slice(initIdx + 1, body.length - 1);
  const result = applyAccumulatorBlock(rest, varName, initValue, true, prog, visiting, env, funcName);
  return result === ACC_BAIL ? undefined : result;
}

// C513: 단일식 본문 UDF 콜을 컴파일타임 상수값으로 평가(auto-HTF 변종 (b), wild
// `tfActive(tf1Enabled, tf1) ? tf1 : na` / `str.tonumber(res) > f_chartTfInMinutes()` 관용구) —
// 위치 인자 전원이 컴파일타임 상수로 확정될 때만 본문을 "매개변수명 → 상수값" env로 재귀 폴딩한다.
// kwargs/인자 개수 불일치(기본값 의존)/다문장 본문/동명 중복 선언은 전부 보수적 포기. 재귀 UDF는
// detectRecursiveFuncCalls가 전역 하드 에러로 막지만 이 리졸버가 그보다 먼저 돌 수 있어 "fn:" 접두
// 방문 가드(Pine 식별자에 ':' 불가라 변수명과 충돌 없음)로 자체 종료를 보장한다. 세 리졸버
// (string/number/boolean)가 각자 이 헬퍼를 호출해 자기 타입만 인정한다 — resolveSecurityConstValue의
// 순차 시도로 같은 본문이 최대 3회 재평가될 수 있으나 wild 실사용 깊이(1~2)에서 무시 가능한 비용.
function resolveSecurityUdfCallValue(
  call: CallExpr,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv,
  funcName: string | null = null,
): SecurityConstValue | undefined {
  if (call.callee.kind !== "Identifier" || call.kwargs.length !== 0) return undefined;
  const fnKey = `fn:${call.callee.name}`;
  if (visiting.has(fnKey)) return undefined;
  const decl = findSecurityFoldableFuncDecl(call.callee.name, prog);
  if (decl === undefined || call.args.length !== decl.params.length) return undefined;
  const callEnv = new Map<string, SecurityConstValue>();
  for (let i = 0; i < call.args.length; i++) {
    const value = resolveSecurityConstValue(call.args[i]!, prog, visiting, env, funcName);
    if (value === undefined) return undefined;
    callEnv.set(decl.params[i]!.name, value);
  }
  visiting.add(fnKey);
  // C526: 본문 평가는 funcName을 decl 자신의 이름으로 바꿔서 재귀한다 — 본문 안 식별자는 이제
  // decl의 스코프에 있으므로, 그 이름이 (callEnv에 없는) 다른 top-level 상수와 겹치면서 동시에
  // decl 자신의 매개변수와도 겹치는 극단적 사례에서도 섀도잉 판정이 정확한 스코프를 본다(실제로는
  // decl 자신의 매개변수는 callEnv가 항상 먼저 잡아 이 경로에 거의 안 걸린다).
  // C608: bodyStmt 종류별 재분기를 직접 하지 않고 resolveSecurityBodyConstValue(decl.body 전체)에
  // 위임 — findSecurityFoldableFuncDecl이 이미 "마지막 문장 kind"만으로 자격을 판정하므로 그
  // 판정 로직과 소비 로직이 여기 두 곳에 나뉘어 발산하는 것을 막는다(MEMORY C136 원칙).
  const result = resolveSecurityBodyConstValue(decl.body, prog, visiting, callEnv, call.callee.name);
  visiting.delete(fnKey);
  return result;
}

function resolveSecurityNumericConst(
  expr: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  env: SecurityConstEnv = null,
  funcName: string | null = null,
): number | undefined {
  if (expr.kind === "NumberLiteral") return expr.value;
  if (expr.kind === "UnaryOp" && expr.op === "-") {
    const inner = resolveSecurityNumericConst(expr.operand, prog, visiting, env, funcName);
    return inner === undefined ? undefined : -inner;
  }
  if (expr.kind === "DotAccess" && expr.obj.kind === "Identifier" && expr.obj.name === "timeframe") {
    return timeframeNumberPropValue(expr.attr, prog.chartTf);
  }
  if (
    expr.kind === "CallExpr" &&
    expr.callee.kind === "DotAccess" &&
    expr.callee.obj.kind === "Identifier" &&
    expr.callee.obj.name === "timeframe" &&
    expr.callee.attr === "in_seconds"
  ) {
    const arg = expr.args[0] ?? expr.kwargs.find((kw) => kw.name === "timeframe")?.value;
    if (arg === undefined) return timeframeInSeconds(prog.chartTf);
    const lit = resolveSecurityTfLiteral(arg, prog, visiting, env, funcName);
    return lit === undefined ? undefined : timeframeInSeconds(lit);
  }
  // C513: str.tonumber(x) — x가 컴파일타임 문자열 상수로 풀릴 때만 런타임 tonumber(C87)를 직접
  // 호출해 폴딩(in_seconds와 동일한 값-동일성 보장 원칙). 파싱 실패(NaN)는 undefined — NaN을
  // 임계값 비교에 흘리지 않는다(비교/na 시맨틱은 VERIFIED_SEMANTICS OPEN, 추측 폴딩 금지).
  if (
    expr.kind === "CallExpr" &&
    expr.callee.kind === "DotAccess" &&
    expr.callee.obj.kind === "Identifier" &&
    expr.callee.obj.name === "str" &&
    expr.callee.attr === "tonumber" &&
    expr.args.length === 1 &&
    expr.kwargs.length === 0
  ) {
    const lit = resolveSecurityTfLiteral(expr.args[0]!, prog, visiting, env, funcName);
    if (lit === undefined) return undefined;
    const num = strTonumber(lit);
    return Number.isNaN(num) ? undefined : num;
  }
  // C735: math.floor(x) — x가 컴파일타임 숫자 상수로 확정될 때만 Math.floor로 폴딩(런타임
  // rt.floor가 Math.floor 그대로라(runtime/math.ts C70) 값 동일성 보장 — C512 in_seconds와 동일
  // 원칙). wild 세션 문자열 조립 관용구(`9 + math.floor((30 + orbMinutes) / 60)`, 0523d8d8b8e4)의
  // 유일 math.* 리프라 floor만 — ceil/round(half-away-from-zero 보정 rt.round)류 형제는 wild
  // 근거가 없어 미포함(C283 큐레이션 원칙).
  if (
    expr.kind === "CallExpr" &&
    expr.callee.kind === "DotAccess" &&
    expr.callee.obj.kind === "Identifier" &&
    expr.callee.obj.name === "math" &&
    expr.callee.attr === "floor" &&
    expr.args.length === 1 &&
    expr.kwargs.length === 0
  ) {
    const inner = resolveSecurityNumericConst(expr.args[0]!, prog, visiting, env, funcName);
    return inner === undefined ? undefined : Math.floor(inner);
  }
  // C735: input.int/float(defval, ...) — defval이 컴파일타임 숫자 상수로 확정될 때만 폴딩.
  // C513 input.bool(boolean 리졸버)과 대칭인 숫자판(C665 3형제 리졸버 대칭 원칙) — 런타임
  // 오버라이드 가드 등록은 C513과 동일하게 아래 Identifier 분기(변수명 필요)에서 한다.
  // C512가 "input.int류는 CallExpr 미처리로 자연 배제"라 적어둔 보수 결정은 tf 위치에서는 여전히
  // 유효하다(C730 런타임 트랙이 오버라이드를 실값 반영 — withSecuritySessionFold 주석 참조).
  // 세션 폴딩 스코프 안에서만 활성 — 거기엔 런타임 평가 트랙이 없어 fail-loud 가드가 최선이고,
  // constStringVars(input.string/timeframe)/C513(input.bool)이 확립한 가드가 숫자에도 동일 성립.
  if (securitySessionFoldDepth > 0 && expr.kind === "CallExpr" && isInputNumericCall(expr)) {
    const defval = expr.args[0] ?? expr.kwargs.find((kw) => kw.name === "defval")?.value;
    if (defval === undefined) return undefined;
    return resolveSecurityNumericConst(defval, prog, visiting, env, funcName);
  }
  // C513: 단일식 본문 UDF 콜(숫자 위치) — 공용 헬퍼가 number로 확정한 값만 인정.
  if (expr.kind === "CallExpr" && expr.callee.kind === "Identifier") {
    const value = resolveSecurityUdfCallValue(expr, prog, visiting, env, funcName);
    return value !== undefined && value.kind === "number" ? value.value : undefined;
  }
  if (expr.kind === "Identifier") {
    const envVal = env?.get(expr.name);
    if (envVal !== undefined) return envVal.kind === "number" ? envVal.value : undefined;
    // C665: resolveSecurityTfLiteral의 C623 funcLocalUniqueEqVars 우선조회를 형제 리졸버(숫자)에도
    // 대칭 적용 — funcName 본문 안에서 정확히 1번 '=' 대입된 로컬 변수(`mins = timeframe.in_seconds(
    // timeframe.period) / 60` 후 `mins <= 1`류 accumulator 조건식)는 top-level uniqueTopEqVars가
    // 못 보는 이름이라 이 조회가 없으면 항상 undefined로 떨어졌다(같은 이름이 top-level에 없으므로
    // 안전 — funcLocalUniqueEqVars와 uniqueTopEqVars는 이름 단위로 구조적으로 상호 배타적).
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(expr.name);
      if (localDef !== undefined) {
        if (localDef.line >= expr.line || visiting.has(expr.name)) return undefined;
        visiting.add(expr.name);
        const result = resolveSecurityNumericConst(localDef.value, prog, visiting, env, funcName);
        visiting.delete(expr.name);
        return result;
      }
    }
    if (visiting.has(expr.name)) return undefined;
    // C526: 이 이름이 funcName(현재 참조가 실제로 위치한 함수) 안에서 매개변수로 섀도잉되면
    // top-level 상수 치환을 건너뛴다 — constStringVars/uniqueTopEqVars 주석 참조.
    if (funcName !== null && prog.constVarShadowFuncs.get(expr.name)?.has(funcName)) return undefined;
    const def = prog.uniqueTopEqVars.get(expr.name);
    if (def === undefined || def.line >= expr.line) return undefined;
    visiting.add(expr.name);
    const result = resolveSecurityNumericConst(def.value, prog, visiting, null, null);
    visiting.delete(expr.name);
    // C735: 정의식이 input.int/float(defval) 폴딩이었으면 C513(input.bool)과 동일 원칙으로
    // 런타임 입력 오버라이드 가드를 등록한다 — 폴딩값은 이미 리터럴로 소비처에 굳으므로,
    // 오버라이드가 다른 값을 주면 조용한 오답 대신 즉시 throw(C366 가드의 숫자판).
    if (
      result !== undefined &&
      def.value.kind === "CallExpr" &&
      isInputNumericCall(def.value) &&
      !prog.securityTfConstGuards.has(expr.name)
    ) {
      prog.securityTfConstGuards.set(expr.name, { literal: result, inputCall: foldSecurityGuardInputCallSlots(def.value, prog) });
    }
    return result;
  }
  if (expr.kind === "BinOp" && (expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/" || expr.op === "%")) {
    const left = resolveSecurityNumericConst(expr.left, prog, visiting, env, funcName);
    const right = resolveSecurityNumericConst(expr.right, prog, visiting, env, funcName);
    if (left === undefined || right === undefined) return undefined;
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
    if (expr.op === "*") return left * right;
    if (right === 0) return undefined;
    // C735: '%' — JS %는 truncated 시맨틱으로 Pine과 동일(MEMORY Pitfalls, rt.pineMod는 0-나눗셈
    // 가드만 얹은 것)이라 0-제수만 배제하면 값 동일성이 보장된다. '/'와 달리 int/float 갈림이 없다.
    if (expr.op === "%") return left % right;
    const quotient = left / right;
    return Number.isInteger(quotient) ? quotient : undefined;
  }
  return undefined;
}

function resolveSecurityTfTernaryCondition(
  cond: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string> = new Set(),
  env: SecurityConstEnv = null,
  funcName: string | null = null,
): boolean | undefined {
  // C513: bool 리터럴 — UDF 인자/본문 폴딩(변종 (b))에 필요한 최소 리프.
  if (cond.kind === "BoolLiteral") return cond.value;
  if (cond.kind === "Identifier") {
    const envVal = env?.get(cond.name);
    if (envVal !== undefined) return envVal.kind === "boolean" ? envVal.value : undefined;
    // C665: resolveSecurityNumericConst와 동일 근거로 boolean 리졸버에도 funcLocalUniqueEqVars
    // 우선조회 대칭 적용(resolveSecurityTfLiteral C623 선례) — input.bool 가드는 top-level
    // constStringVars 경유 값에만 의미가 있어(런타임 오버라이드 채널) 함수-로컬 변수 경로에는
    // 등록하지 않는다(함수-로컬 '=' 대입은 오버라이드 대상이 아님).
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(cond.name);
      if (localDef !== undefined) {
        if (localDef.line >= cond.line || visiting.has(cond.name)) return undefined;
        visiting.add(cond.name);
        const result = resolveSecurityTfTernaryCondition(localDef.value, prog, visiting, env, funcName);
        visiting.delete(cond.name);
        return result;
      }
    }
    if (visiting.has(cond.name)) return undefined;
    // C526: constStringVars/uniqueTopEqVars 주석 참조 — funcName 안에서 매개변수로 섀도잉되면 스킵.
    if (funcName !== null && prog.constVarShadowFuncs.get(cond.name)?.has(funcName)) return undefined;
    const def = prog.uniqueTopEqVars.get(cond.name);
    if (def === undefined || def.line >= cond.line) return undefined;
    visiting.add(cond.name);
    const result = resolveSecurityTfTernaryCondition(def.value, prog, visiting, null, null);
    visiting.delete(cond.name);
    // C513: 정의식이 input.bool(defval) 폴딩이었으면 문자열 상수(constStringVars 분기)와 동일한
    // 원칙으로 런타임 입력 오버라이드 가드를 등록한다 — HTF 집계 tf가 이 bool 기본값으로 이미
    // 확정되므로, 오버라이드가 다른 값을 주면 조용한 오답 대신 즉시 throw로 전환(C366 가드 참조).
    if (
      result !== undefined &&
      def.value.kind === "CallExpr" &&
      isInputBoolCall(def.value) &&
      !prog.securityTfConstGuards.has(cond.name)
    ) {
      // C734: 가드 방출 슬롯의 비리터럴 상수(title 결합 등)는 리터럴로 접어 저장 —
      // foldSecurityGuardInputCallSlots 주석 참조(변경 없으면 원본 그대로).
      prog.securityTfConstGuards.set(cond.name, { literal: result, inputCall: foldSecurityGuardInputCallSlots(def.value, prog) });
    }
    return result;
  }
  // C513: input.bool(defval, ...) — defval이 bool 리터럴일 때만 폴딩(위치 0 또는 defval= kwarg,
  // input.timeframe 상수 폴딩과 동일 계약). 가드 등록은 위 Identifier 분기(변수명 필요)에서 한다.
  if (cond.kind === "CallExpr" && isInputBoolCall(cond)) {
    const defval = cond.args[0] ?? cond.kwargs.find((kw) => kw.name === "defval")?.value;
    if (defval !== undefined && defval.kind === "BoolLiteral") return defval.value;
    return undefined;
  }
  // C513: 단일식 본문 UDF 콜 평가(auto-HTF 변종 (b)) — 공용 헬퍼가 boolean으로 확정한 값만 인정.
  if (cond.kind === "CallExpr" && cond.callee.kind === "Identifier") {
    const value = resolveSecurityUdfCallValue(cond, prog, visiting, env, funcName);
    return value !== undefined && value.kind === "boolean" ? value.value : undefined;
  }
  // C537: timeframe.is*(TIMEFRAME_BOOLEAN_PROPS 7종) — prog.chartTf 기준 컴파일타임 불리언 상수
  // (메인 경로 analyzer.ts builtinBooleanConstants 폴딩과 동일 근거·동일 값, 배치30 (1)부터 chartTf
  // 설정화). wild auto-HTF 관용구(`timeframe.isintraday ? "60" : timeframe.period"`류, C537 프로브
  // 실측 지배 패턴)의 삼항 조건이 이 상수 하나로(또는 and 지배값 short-circuit 경유로) 확정되는 축.
  // 런타임 오버라이드가 없는 고정 환경값이라 input.bool류 가드 등록은 불필요.
  if (cond.kind === "DotAccess" && cond.obj.kind === "Identifier" && cond.obj.name === "timeframe") {
    return timeframeBooleanPropValue(cond.attr, prog.chartTf);
  }
  // C537: `not <cond>` — 피연산자가 확정될 때만 반전(미확정/na는 undefined 그대로 전파 —
  // not의 na 시맨틱(VERIFIED_SEMANTICS OPEN 계열)에 대한 추측 폴딩 없음).
  if (cond.kind === "UnaryOp" && cond.op === "not") {
    const inner = resolveSecurityTfTernaryCondition(cond.operand, prog, visiting, env, funcName);
    return inner === undefined ? undefined : !inner;
  }
  if (cond.kind !== "BinOp") return undefined;
  // C513: and/or — 한쪽이 지배값(and의 false / or의 true)으로 확정되면 다른 쪽이 미확정이어도
  // 폴딩 가능(JS 네이티브·TV Kleene 3치(C69) 어느 쪽 시맨틱에서도 결과가 같은 조합만 폴딩 —
  // and/or na 시맨틱이 VERIFIED_SEMANTICS OPEN이어도 이 폴딩은 양쪽 가설에서 동일해 안전).
  // 양쪽 다 확정이면 그대로, 그 외(지배값 없이 한쪽 미확정)는 undefined.
  if (cond.op === "and" || cond.op === "or") {
    const left = resolveSecurityTfTernaryCondition(cond.left, prog, visiting, env, funcName);
    const right = resolveSecurityTfTernaryCondition(cond.right, prog, visiting, env, funcName);
    if (cond.op === "and") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : undefined;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : undefined;
  }
  if (cond.op === "==" || cond.op === "!=") {
    const left = resolveSecurityTfLiteral(cond.left, prog, visiting, env, funcName);
    const right = resolveSecurityTfLiteral(cond.right, prog, visiting, env, funcName);
    if (left !== undefined && right !== undefined) {
      const eq = left === right;
      return cond.op === "==" ? eq : !eq;
    }
    // C512: 문자열 상수로 안 풀리면 숫자 상수 동등비교 폴백(산술 임계값 체인의 ==/!= 변형).
    const leftNum = resolveSecurityNumericConst(cond.left, prog, visiting, env, funcName);
    const rightNum = resolveSecurityNumericConst(cond.right, prog, visiting, env, funcName);
    if (leftNum !== undefined && rightNum !== undefined && !Number.isNaN(leftNum) && !Number.isNaN(rightNum)) {
      const numEq = leftNum === rightNum;
      return cond.op === "==" ? numEq : !numEq;
    }
    // C537: 불리언 상수 동등비교 폴백(`mode == true`류, wild 461ce8b97d23 실측) — C512 숫자
    // 폴백과 대칭. 양변이 이 리졸버 자신으로 확정될 때만 폴딩(한쪽이라도 미확정이면 undefined).
    const leftBool = resolveSecurityTfTernaryCondition(cond.left, prog, visiting, env, funcName);
    const rightBool = resolveSecurityTfTernaryCondition(cond.right, prog, visiting, env, funcName);
    if (leftBool === undefined || rightBool === undefined) return undefined;
    const boolEq = leftBool === rightBool;
    return cond.op === "==" ? boolEq : !boolEq;
  }
  // C512: 산술 임계값 비교(<,<=,>,>=) — 양변이 컴파일타임 숫자 상수로 확정될 때만 폴딩.
  // NaN이 섞이면 undefined(비교/na 시맨틱은 VERIFIED_SEMANTICS OPEN — 추측 폴딩 금지, 하드 에러 유지).
  if (cond.op === "<" || cond.op === "<=" || cond.op === ">" || cond.op === ">=") {
    const leftNum = resolveSecurityNumericConst(cond.left, prog, visiting, env, funcName);
    const rightNum = resolveSecurityNumericConst(cond.right, prog, visiting, env, funcName);
    if (leftNum === undefined || rightNum === undefined || Number.isNaN(leftNum) || Number.isNaN(rightNum))
      return undefined;
    if (cond.op === "<") return leftNum < rightNum;
    if (cond.op === "<=") return leftNum <= rightNum;
    if (cond.op === ">") return leftNum > rightNum;
    return leftNum >= rightNum;
  }
  return undefined;
}

// C513: `input.bool(...)` 콜 판별(가드 등록/defval 폴딩 게이트 공용). 타입 프레디킷(expr is
// CallExpr)로 쓰면 false 분기에서 TS가 CallExpr 가능성 자체를 소거해(역-narrowing) 뒤따르는
// UDF 콜 분기가 never가 되므로, CallExpr로 좁힌 뒤 호출하는 순수 boolean 판별로 둔다.
// C537: bare `input(false, ...)`(v4 레거시 auto-typed 폼)도 인정 — constStringVars prescan이
// 문자열 축에서 이미 "bare input 콜"을 동급으로 인정하는 것(analyzer.ts 주석)과의 형제 비대칭
// 해소. bool-성은 이 판별이 아니라 소비처의 defval BoolLiteral 검사가 보장한다(문자열/숫자
// defval bare input은 그 검사에서 undefined로 떨어져 기존과 동일하게 보수 거부).
function isInputBoolCall(expr: CallExpr): boolean {
  if (expr.callee.kind === "Identifier" && expr.callee.name === "input") return true;
  return (
    expr.callee.kind === "DotAccess" &&
    expr.callee.obj.kind === "Identifier" &&
    expr.callee.obj.name === "input" &&
    expr.callee.attr === "bool"
  );
}

// C735: input.int/input.float 콜 판별 — isInputBoolCall의 숫자판 형제. bare `input(30, ...)` 폼은
// 여기 포함하지 않는다(bool 축은 defval BoolLiteral 검사가 타입을 보장하지만, 숫자 축을 bare 폼까지
// 열면 문자열/불리언 defval bare input과의 3중 중복 매치가 생겨 시도 순서(string → number → boolean)에
// 의미가 실리므로 보수적으로 명시 네임스페이스 폼만 — wild 실사용(orbMinutes = input.int(30,...))도
// 전부 명시 폼, C283 큐레이션 원칙).
function isInputNumericCall(expr: CallExpr): boolean {
  return (
    expr.callee.kind === "DotAccess" &&
    expr.callee.obj.kind === "Identifier" &&
    expr.callee.obj.name === "input" &&
    (expr.callee.attr === "int" || expr.callee.attr === "float")
  );
}

// C735 opt-in 게이트: 리졸버 확장 2종(문자열 '+' 결합 폴딩, input.int/float defval 폴딩+가드)은
// 이 depth가 양수인 스코프 안에서만 활성화된다. 무조건 활성화하면 tf 위치의 컴파일타임 리졸버가
// C597/C598/C730 런타임 tf 트랙(입력 오버라이드를 가드 throw 없이 실값으로 반영하는 경로)을
// 선점해, 기존에 오버라이드가 정상 동작하던 `str.tostring(input.int(...))` tf 등이 fail-loud
// throw로 다운그레이드된다(C735 구현 중 기존 테스트 13건 실측 — "still rejects ... input.int"/
// "honors a runtime input override" 계열). 활성 지점은 (a) time()/time_close() 세션 콜 리프의
// 인자 폴딩(세션 문자열엔 런타임 평가 트랙이 없어 가드가 최선), (b) C516/C732 UDF 인라인 분기
// 선택 constEnv(그 경로는 이미 input 유래 상수를 fail-loud+실패시 가드 롤백으로 설계함 — C732
// 주석 참조) 두 곳뿐. analyzer는 동기 단일 스레드라 모듈 카운터가 안전하다(재진입은 depth로 흡수).
let securitySessionFoldDepth = 0;
function withSecuritySessionFold<T>(fn: () => T): T {
  securitySessionFoldDepth++;
  try {
    return fn();
  } finally {
    securitySessionFoldDepth--;
  }
}

function resolveSecurityTfLiteral(
  tfArg: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string> = new Set(),
  env: SecurityConstEnv = null,
  funcName: string | null = null,
): string | undefined {
  if (tfArg.kind === "StringLiteral") return tfArg.value;
  // C514: auto-HTF 변종 (b) 잔여 — `tfActive(...) ? tf1 : na`류 삼항의 na(NaLiteral) 분기
  // (2288dd31000d 등, 조건이 false로 폴딩되면 이 분기가 선택된다). pine2py request_security()의
  // 진리값 게이트(`if context is not None and timeframe:`)는 ''(falsy)라면 SecurityManager를
  // 아예 건너뛰고 즉시 현재 바 값을 패스스루하지만, na는 codegen.py._NAN_LITERAL="float('nan')"로
  // 컴파일돼 Python에서 NaN은 truthy라 이 게이트를 **통과**한다 — 즉 na는 ''과 다른 코드 경로다
  // (기존 C435 '' 정규화와 혼동 금지, 실측으로 반증됨 — python 직접 실행, PROGRESS LOG C514).
  // 통과 후 str(float('nan'))="nan"이 SecurityManager.get()에 전달되고 _parse_tf_minutes("nan")은
  // 맵/int 파싱/접미사 전부 실패해 "default to daily"(1440분) 폴백으로 떨어진다 — 이는 "D"의
  // 리터럴 매핑값(1440)과 정확히 같아 _aggregate_by_count(ratio=tf_minutes)에서 완전히 동일한
  // 버킷을 낸다(오라클 request_security_na_ternary_tf golden으로 bar-by-bar 직접 확인, x==y 전
  // 구간). _aggregate_by_time은 "D"만 달력 분기(연/월/일)를 타고 "nan"은 산술 분기(t_sec//86400)를
  // 타 원칙적으로 다른 코드 경로이나(TV 자체 미검증), 값이 수렴한다고 보고 "D"로 직접 정규화한다 —
  // DIVERGENCES 'TV 미검증(가설)' 등재. **배치30 (1), C591**: 이 "D"는 "차트 자신의 tf"(prog.chartTf)
  // 가 아니라 pine2py `_parse_tf_minutes` 파싱 실패 시 항상 떨어지는 daily(1440분) 폴백 상수다 —
  // chartTf를 바꿔도 이 폴백 경로 자체는 그대로 daily이므로 하드코딩 "D" 유지가 맞다(아래 947/4566의
  // ''→차트 tf 정규화와는 다른 축, 혼동 금지).
  if (tfArg.kind === "NaLiteral") return "D";
  if (tfArg.kind === "TernaryOp") {
    const cond = resolveSecurityTfTernaryCondition(tfArg.condition, prog, visiting, env, funcName);
    if (cond === undefined) return undefined;
    return resolveSecurityTfLiteral(cond ? tfArg.trueExpr : tfArg.falseExpr, prog, visiting, env, funcName);
  }
  // C515: 삼항과 대칭으로 switch-as-expression도 직접 tf 위치(또는 위 Identifier 재귀가 가리키는
  // top-level '=' 정의식)에 올 수 있다 — 공용 리졸버가 string으로 확정한 값만 인정.
  if (tfArg.kind === "SwitchStmt") {
    const value = resolveSecuritySwitchConstValue(tfArg, prog, visiting, env, funcName);
    return value !== undefined && value.kind === "string" ? value.value : undefined;
  }
  if (tfArg.kind === "DotAccess" && tfArg.obj.kind === "Identifier" && tfArg.obj.name === "timeframe") {
    return timeframeStringPropValue(tfArg.attr, prog.chartTf);
  }
  // C513: 단일식 본문 UDF 콜(문자열 위치) — 공용 헬퍼가 string으로 확정한 값만 인정.
  if (tfArg.kind === "CallExpr" && tfArg.callee.kind === "Identifier") {
    const value = resolveSecurityUdfCallValue(tfArg, prog, visiting, env, funcName);
    return value !== undefined && value.kind === "string" ? value.value : undefined;
  }
  // C538: str.tostring(숫자상수) — wild tf 잔여 재분류(C537 프로브) 1순위 관용구
  // (`str.tostring(use_time)`/`str.tostring(CANDLE_WIDTH)`류, format 인자 없는 단일 위치인자
  // 형태만). resolveSecurityNumericConst로 확정된 값이 정수일 때만 JS String(n)으로 접는다 —
  // pine2js는 int/float를 값 레벨로 구분 안 해 소수는 TV str(value) 표현("1.5" 등)과 어긋날 수
  // 있으므로 보수적으로 정수만 인정(MEMORY.md C200).
  // C730: 2-인자 포맷 폼도 포맷이 "숫자 패턴 + 문자 접미사" 리터럴(SECURITY_TOSTRING_FMT_RE,
  // '###M'/'####'류 auto-HTF 관용구)일 때만 허용 — 값 폴딩은 런타임 rt.tostring(str.ts
  // suffixMatch 분기)을 직접 호출해 값 동일성 보장(C512 원칙). 그 외 포맷('#.##' 등)은 tf
  // 문자열로 무의미하므로 계속 범위 밖(undefined, 기존 하드 에러 유지).
  if (
    tfArg.kind === "CallExpr" &&
    tfArg.callee.kind === "DotAccess" &&
    tfArg.callee.obj.kind === "Identifier" &&
    tfArg.callee.obj.name === "str" &&
    tfArg.callee.attr === "tostring" &&
    (tfArg.args.length === 1 ||
      (tfArg.args.length === 2 &&
        tfArg.args[1]!.kind === "StringLiteral" &&
        SECURITY_TOSTRING_FMT_RE.test((tfArg.args[1] as StringLiteral).value))) &&
    tfArg.kwargs.length === 0
  ) {
    const num = resolveSecurityNumericConst(tfArg.args[0]!, prog, visiting, env, funcName);
    if (num === undefined || !Number.isInteger(num)) return undefined;
    return tfArg.args.length === 2 ? strTostring(num, (tfArg.args[1] as StringLiteral).value, true) : String(num);
  }
  // C735: 문자열 '+' 결합 폴딩 — 양변이 이 리졸버 자신으로 문자열 상수 확정될 때만 이어붙인다
  // (wild 세션 문자열 조립 관용구 `orbSession = "0930-" + orbEndHour + orbEndMin`, 0523d8d8b8e4).
  // 숫자 덧셈과의 혼동 없음: NumberLiteral/산술 서브트리는 이 리졸버에 분기가 없어 undefined로
  // 자연 배제된다(숫자를 문자열화하려면 명시적 str.tostring(C538)을 거쳐야 — 암묵 int 문자열화의
  // C200 포맷 갈림도 그 게이트가 그대로 막는다). NaLiteral 피연산자는 보수 거부 — 이 리졸버의
  // na→"D" 폴딩은 tf 위치 전용 시맨틱(C514)이라 결합 위치에 새면 "0930-D" 같은 오답이 된다.
  // 세션 폴딩 스코프 전용(withSecuritySessionFold 주석 참조) — tf 위치에서 무조건 활성화하면
  // "'+' concat tf는 문법 밖"이라는 C598 런타임 트랙 경계 테스트/설계와 충돌한다.
  if (securitySessionFoldDepth > 0 && tfArg.kind === "BinOp" && tfArg.op === "+") {
    if (tfArg.left.kind === "NaLiteral" || tfArg.right.kind === "NaLiteral") return undefined;
    const left = resolveSecurityTfLiteral(tfArg.left, prog, visiting, env, funcName);
    if (left === undefined) return undefined;
    const right = resolveSecurityTfLiteral(tfArg.right, prog, visiting, env, funcName);
    if (right === undefined) return undefined;
    return left + right;
  }
  // C366: simple-const 문자열 변수 상수 전파(wild 1위 클러스터 714건 중 실측 ~817파일이 이 폼 —
  // `tf = input.timeframe("60")` / `res = "60"` 후 tf 인자로 전달). constStringVars는 analyze()
  // 사전 스캔이 "top-level 바인딩 정확히 1개(그 외 non-top 바인딩은 전부 FuncDecl/MethodDecl
  // 매개변수여야 함) + ':=' 재대입 0 + 값이 컴파일타임 상수 문자열"만 등재한 맵이다(AnalyzedProgram
  // 주석 참조) — 매개변수 섀도잉이 남아있는 이름은 아래 constVarShadowFuncs 가드가 funcName(현재
  // 참조가 실제로 위치한 함수, scope.func?.name)과 대조해 걸러낸다(C526, 예전엔 "섀도잉이 구조적으로
  // 불가능"이라 여기 가드가 없었으나 그건 매개변수와 이름이 겹치면 통째로 등재 자체를 거부하던
  // 때 얘기 — 이제 등재는 되지만 소비 시점에 스코프를 본다). 진짜 동적 tf(바마다 변하는 식/조건부
  // 대입/재대입)는 여전히 아래 undefined → 기존 하드 에러 그대로(보수 원칙).
  if (tfArg.kind === "Identifier") {
    // C513: UDF 본문 폴딩 중이면 매개변수 치환 env를 최우선 조회(매개변수가 top-level 동명 변수를
    // 섀도잉 — env에 있는데 string이 아니면 그 이름은 이 위치에서 문자열 상수가 될 수 없다).
    const envVal = env?.get(tfArg.name);
    if (envVal !== undefined) return envVal.kind === "string" ? envVal.value : undefined;
    // C623(next_hint(C622)): funcName 본문 안에서 정확히 1번 '=' 대입된 로컬 변수(uniqueTopEqVars의
    // 함수-로컬판, getWeeklyPivot() weeklyTimeframe류) — top-level 맵보다 먼저 조회한다. 이름이
    // 매치되면 그 이름은 이 함수 안에서 진짜 로컬이라(다른 함수/top-level의 동명 바인딩이 있어도
    // 기존 prescanConstVars의 non-top/non-param 카운트가 이미 그 이름의 top-level 등재 자체를
    // disqualify해뒀음 — funcLocalUniqueEqVars와 constStringVars/uniqueTopEqVars는 이름 단위로
    // 구조적으로 상호 배타적) 이후 폴백을 시도하지 않는다 — 해석 실패(declared-after-use/cycle)도
    // 그대로 undefined로 끝난다(top-level로 새는 오답 치환 금지).
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(tfArg.name);
      if (localDef !== undefined) {
        if (localDef.line >= tfArg.line || visiting.has(tfArg.name)) return undefined;
        visiting.add(tfArg.name);
        const result = resolveSecurityTfLiteral(localDef.value, prog, visiting, env, funcName);
        visiting.delete(tfArg.name);
        return result;
      }
    }
    // C526: funcName 안에서 매개변수로 섀도잉되는 이름이면 top-level 상수 치환 자체를 건너뛴다.
    if (funcName !== null && prog.constVarShadowFuncs.get(tfArg.name)?.has(funcName)) return undefined;
    const constInfo = prog.constStringVars.get(tfArg.name);
    if (constInfo !== undefined) {
      // input 출처 상수는 런타임 오버라이드로 변수값이 폴딩된 리터럴과 어긋날 수 있어, 실제로
      // tf 위치에서 소비된 이름만 가드 대상으로 등록한다(codegen이 프리앰블에 1회 throw 가드 방출).
      if (constInfo.inputCall !== null && !prog.securityTfConstGuards.has(tfArg.name)) {
        // C734: 가드 방출 슬롯의 비리터럴 상수(title 결합 등)는 리터럴로 접어 저장 —
        // foldSecurityGuardInputCallSlots 주석 참조(변경 없으면 원본 그대로).
        prog.securityTfConstGuards.set(tfArg.name, { literal: constInfo.literal, inputCall: foldSecurityGuardInputCallSlots(constInfo.inputCall, prog) });
      }
      return constInfo.literal;
    }
    // C512: 상수 문자열 맵에 없으면 uniqueTopEqVars(전역 유일 top-level '=' 바인딩, ':=' 재대입
    // 이름 제외)의 정의식으로 재귀 — `vp2LtfStr = <산술 임계값 삼항 체인>` 뒤 tf 위치에서 그
    // 변수를 소비하는 wild 변종 (a). 정의식 안에서 만나는 input 출처 상수는 재귀 도중
    // constStringVars 분기가 기존 가드 등록을 그대로 수행하므로 별도 가드 배선이 필요 없다.
    if (visiting.has(tfArg.name)) return undefined;
    const def = prog.uniqueTopEqVars.get(tfArg.name);
    if (def === undefined || def.line >= tfArg.line) return undefined;
    visiting.add(tfArg.name);
    const result = resolveSecurityTfLiteral(def.value, prog, visiting, null, null);
    visiting.delete(tfArg.name);
    return result;
  }
  return undefined;
}

// ── 배치31 (a)-2, C598: 변수 경유 tf의 런타임-1회 확정 트리 치환 ──────────────────────────
// resolveSecurityTfLiteral(컴파일타임 폴딩)이 실패한 bare-series 콜사이트의 tf 인자를,
// "재대입 0회" 전제(constStringVars/uniqueTopEqVars — prescanConstVars가 바인딩 전수 카운트로
// 보증)로 정의식을 재귀 치환해 "프리앰블(바 루프 시작 전, ctx당 1회)에서 평가 가능한 자기완결
// 트리"로 빌드한다. 성공하면 C597 인프라(securityRuntimeTfSlots → codegen 프리앰블
// $.rebuildSecurityCache(slot, <트리>))에 그대로 등록되고, 실패(null)하면 기존 하드 에러 그대로.
// wild 실측(C598 프로브, 실패 콜 L:C 좌표 기준 재분류): 변수 경유 최대 하위 클러스터가
// "정의식이 삼항(조건은 input.bool 변수 또는 문자열 ==/!= 비교)"인 폼(20파일)이라 삼항/비교까지
// 문법에 포함한다. UDF 매개변수 경유(param-of, 최다 축)는 사이트별 런타임 슬롯(__secIdx 확장)이
// 필요한 다음 슬라이스.
//
// 안전 근거(왜 이 좁은 문법인가):
// (1) 값 불변성 — 리프가 전부 문자열/불리언 리터럴, 직접 input.*(...) 콜, timeframe.* 문자열
//     프로퍼티(chartTf 폴딩 → 합성 StringLiteral)뿐이라 실행 내내 상수($.inputs는 run 시작 시
//     고정). per-bar 대입문이 매 바 재계산하는 값과 프리앰블 1회 평가 값이 항상 동일하다
//     (input 오버라이드 반영 포함 — codegen 등가성 테스트로 hand-verified).
// (2) 방출 안전 — 치환 트리는 Identifier가 전부 소거돼 프리앰블(per-bar 로컬 스코프 밖)에서도
//     참조 에러가 구조적으로 없다. 리프 input 콜 노드는 자신의 top-level 정의 대입문 분석이
//     이미 builtinCalls에 등록했으므로 genExpr가 rt.input.*($.inputs, ...)로 방출된다(순수
//     읽기라 정의문과의 이중 방출 무해 — C442의 상태 이중 소비 클래스가 아님). 합성 조합자는
//     TernaryOp(네이티브 (c?a:b) 방출)와 ==/!= 비교(genEquality가 노드-키 맵 없이 ===/!==만
//     방출)뿐 — BinOp '+'는 concatBinOps가 노드-키(Map<Expr,_>)라 합성 노드가 숫자 덧셈으로
//     오방출되므로 의도적으로 문법에서 제외. 같은 이유로 and/or(pineAnd)·switch-식(문장 방출
//     필요)·str.tostring(숫자 리졸버 필요)도 이번 슬라이스 밖.
// (3) 재대입 0회 — next_hint(C597)의 실측 갭(':=' 재대입 var는 varQualifiers가 초기값 기준이라
//     qualifier만으론 오판) 때문에 qualifier 필터를 일절 쓰지 않고 prescanConstVars의 바인딩
//     전수 카운트(전역 유일 top-level '=' + ':=' 0회)를 그대로 재사용한다. 매개변수 섀도잉은
//     constVarShadowFuncs(C526), 선언-후-사용은 def.line < 참조 노드 line(기존 관례와 동일),
//     자기/상호 참조는 visiting 사이클 가드.
// (4) constStringVars의 input 출처 이름은 리터럴+throw 가드(securityTfConstGuards) 대신 그
//     input 콜 자체를 리프로 인라인한다 — 이 소비 경로는 런타임 평가라 입력 오버라이드가 캐시
//     tf에 그대로 반영되기 때문(가드는 "컴파일타임 고정 캐시" 소비 전용이라 여기선 미등록.
//     같은 이름을 다른 콜사이트가 폴딩 경로로 소비하면 그쪽 가드는 기존대로 등록됨 — 보수적).
function bareInputDefval(call: CallExpr): Expr | undefined {
  return call.args.length > 0 ? call.args[0]! : call.kwargs.find((k) => k.name === "defval")?.value;
}

// C598: input 콜 리프가 프리앰블(per-bar 로컬 스코프 밖, ctx당 1회)에서 자기완결로 방출 가능한지 —
// 방출되는 슬롯(비-discard) 인자에 리터럴/timeframe.* 문자열 상수(analyzeExpr가 방문해
// builtinStringConstants로 폴딩 방출) 이외의 값(예: '=' 로컬 Identifier)이 끼면 그 이름이
// 프리앰블 스코프에 없어 ReferenceError가 난다. 판정 기준(INPUT_PARAM_NAMES 슬롯 표 ×
// INPUT_DISCARD_SLOT_NAMES, 표 밖 메타 kwarg 면제)은 isSecurityScalarConstInputCall(C438)과
// 동일 — C597 직접-콜 분기가 이 가드 없이 `input.timeframe(n)`(defval이 '=' 로컬)을 통과시켜
// 실행 시 ReferenceError가 나던 기존 버그도 이 가드를 공유해서 고친다(C598에서 실측 발견,
// PROGRESS LOG 참조). 주의: C366 폴딩 경로의 securityTfConstGuards 방출(codegen 프리앰블 throw
// 가드)에도 같은 클래스의 잔존 갭이 있으나(title 위치 Identifier 등) 그쪽은 별도 축(LIMITATIONS
// C598 — 폴딩 거부로 바꾸면 현행 transpile-ok 파일이 역행하므로 가드 방출 설계 재검토 필요).
function securityRuntimeTfInputCallSafe(call: CallExpr, prog: AnalyzedProgram): boolean {
  const literalish = (v: Expr): boolean =>
    v.kind === "StringLiteral" ||
    v.kind === "NumberLiteral" ||
    v.kind === "BoolLiteral" ||
    (v.kind === "UnaryOp" && v.op === "-" && v.operand.kind === "NumberLiteral") ||
    (v.kind === "DotAccess" &&
      v.obj.kind === "Identifier" &&
      v.obj.name === "timeframe" &&
      timeframeStringPropValue(v.attr, prog.chartTf) !== undefined);
  const callee = call.callee;
  const method = callee.kind === "DotAccess" ? callee.attr : "any";
  const paramNames = INPUT_PARAM_NAMES[method] ?? [];
  return (
    call.args.every(literalish) &&
    call.kwargs.every(
      (kw) => INPUT_DISCARD_SLOT_NAMES.has(kw.name) || !paramNames.includes(kw.name) || literalish(kw.value),
    )
  );
}

function resolveSecurityRuntimeTfString(
  expr: Expr,
  prog: AnalyzedProgram,
  funcName: string | null,
  visiting: Set<string>,
): Expr | null {
  if (expr.kind === "StringLiteral") return expr;
  if (expr.kind === "DotAccess" && expr.obj.kind === "Identifier" && expr.obj.name === "timeframe") {
    const lit = timeframeStringPropValue(expr.attr, prog.chartTf);
    if (lit === undefined) return null;
    const synth: StringLiteral = { kind: "StringLiteral", value: lit, line: expr.line, col: expr.col };
    return synth;
  }
  if (expr.kind === "CallExpr") {
    const callee = expr.callee;
    // 직접 input 콜 리프 — 문자열 위치는 항상-string인 input.timeframe/input.string만.
    // (C597의 top-level "직접 콜" 분기는 any-attr 그대로 유지되고, 여기는 치환 트리 내부 리프
    // 전용이라 더 좁다.) bare input(...)(v4 auto-typed, C537)은 defval 리터럴 타입으로 판별.
    if (callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "input") {
      // defval 부재(title=만 있는 콜)는 거부 — 방출이 rt.input.*($.inputs, undefined, ...)가 되어
      // 오버라이드 없으면 undefined가 tf로 흘러가는 반정의 동작(기존 C435 "폴딩 불가" 거부 유지).
      const dv = bareInputDefval(expr);
      const dvOk =
        dv !== undefined &&
        (dv.kind === "StringLiteral" ||
          (dv.kind === "DotAccess" &&
            dv.obj.kind === "Identifier" &&
            dv.obj.name === "timeframe" &&
            timeframeStringPropValue(dv.attr, prog.chartTf) !== undefined));
      return (callee.attr === "timeframe" || callee.attr === "string") && dvOk && securityRuntimeTfInputCallSafe(expr, prog)
        ? expr
        : null;
    }
    if (callee.kind === "Identifier" && callee.name === "input") {
      return bareInputDefval(expr)?.kind === "StringLiteral" && securityRuntimeTfInputCallSafe(expr, prog) ? expr : null;
    }
    // C730: str.tostring 조합자 — wild tf 잔여 최대 리프(input.int 파생값 문자열화:
    // `str.tostring(tf1)`/`str.tostring(timeframe.multiplier * intRes, '###M')` auto-HTF 관용구).
    // 값 서브트리는 resolveSecurityRuntimeTfNumber의 정수-보장 좁은 문법(리터럴/input 정수 defval/
    // timeframe 숫자 상수 폴딩/+·-·* 산술)만 — 정수 미보장(input.float 등)이면 방출값이
    // pyFloatStr("120.0")로 어긋나므로 거부한다. 원본 노드 재사용이 아니라 합성 CallExpr를 만들어
    // (인자가 Identifier-소거된 서브트리로 교체됨 — C598 프리앰블 ReferenceError 클래스 방지)
    // builtinCalls("tostring") + tostringIntArgCalls(isInt=true 방출)에 여기서 직접 등록한다 —
    // 합성 노드는 이 트리에서만 도달 가능하므로 per-bar 방출 경로는 바이트 불변. 2-인자 포맷은
    // 컴파일타임 폴딩(C730 확장)과 동일한 SECURITY_TOSTRING_FMT_RE 리터럴만 인정.
    if (
      callee.kind === "DotAccess" &&
      callee.obj.kind === "Identifier" &&
      callee.obj.name === "str" &&
      callee.attr === "tostring" &&
      expr.kwargs.length === 0 &&
      (expr.args.length === 1 ||
        (expr.args.length === 2 &&
          expr.args[1]!.kind === "StringLiteral" &&
          SECURITY_TOSTRING_FMT_RE.test((expr.args[1] as StringLiteral).value)))
    ) {
      const num = resolveSecurityRuntimeTfNumber(expr.args[0]!, prog, funcName, visiting);
      if (num === null || !num.isInt) return null;
      const synthArgs: Expr[] = expr.args.length === 2 ? [num.node, expr.args[1]!] : [num.node];
      const synth: CallExpr = { kind: "CallExpr", callee, args: synthArgs, kwargs: [], line: expr.line, col: expr.col };
      prog.builtinCalls.set(synth, "tostring");
      prog.tostringIntArgCalls.add(synth);
      return synth;
    }
    return null;
  }
  if (expr.kind === "Identifier") {
    // C623(next_hint(C622)): funcName 로컬 단일대입 변수 — resolveSecurityTfLiteral Identifier
    // 분기와 동일한 우선순위/상호배타 근거(주석 참조). 재귀는 funcName을 유지한다(정의식 자신이
    // 여전히 그 함수 스코프 안에 있음 — top-level uniqueTopEqVars 체인의 funcName=null 리셋과 다름).
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(expr.name);
      if (localDef !== undefined) {
        if (localDef.line >= expr.line || visiting.has(expr.name)) return null;
        visiting.add(expr.name);
        const result = resolveSecurityRuntimeTfString(localDef.value, prog, funcName, visiting);
        visiting.delete(expr.name);
        return result;
      }
    }
    if (funcName !== null && (prog.constVarShadowFuncs.get(expr.name)?.has(funcName) ?? false)) return null;
    const constInfo = prog.constStringVars.get(expr.name);
    if (constInfo !== undefined) {
      if (constInfo.inputCall !== null) {
        // 방출 불가한 input 콜(비리터럴 title 등)은 리프 거부 — 리터럴+가드 폴백은 그 가드 자신이
        // 같은 ReferenceError 클래스(위 헬퍼 주석의 C366 잔존 갭)라 여기서 새로 만들지 않는다.
        return securityRuntimeTfInputCallSafe(constInfo.inputCall, prog) ? constInfo.inputCall : null;
      }
      const synth: StringLiteral = { kind: "StringLiteral", value: constInfo.literal, line: expr.line, col: expr.col };
      return synth;
    }
    if (visiting.has(expr.name)) return null;
    const def = prog.uniqueTopEqVars.get(expr.name);
    if (def === undefined || def.line >= expr.line) return null;
    visiting.add(expr.name);
    // def.value는 항상 top-level '=' 값이라 스코프가 top-level로 리셋된다(funcName=null,
    // resolveSecurityTfLiteral의 동일 재귀 관례).
    const result = resolveSecurityRuntimeTfString(def.value, prog, null, visiting);
    visiting.delete(expr.name);
    return result;
  }
  if (expr.kind === "TernaryOp") {
    const cond = resolveSecurityRuntimeTfBool(expr.condition, prog, funcName, visiting);
    if (cond !== null) {
      const t = resolveSecurityRuntimeTfString(expr.trueExpr, prog, funcName, visiting);
      const f = t === null ? null : resolveSecurityRuntimeTfString(expr.falseExpr, prog, funcName, visiting);
      if (t !== null && f !== null) {
        const synth: TernaryOp = { kind: "TernaryOp", condition: cond, trueExpr: t, falseExpr: f, line: expr.line, col: expr.col };
        return synth;
      }
    }
    // C730: 런타임 bool 문법 밖(또는 분기 빌드 실패) 조건이라도 컴파일타임으로 접히면(wild 지배
    // 관용구: `timeframe.ismonthly ? str.tostring(..,'###M') : timeframe.isweekly ? ..` —
    // timeframe.is*는 chartTf 유도 상수) 죽은 분기를 프루닝하고 선택된 분기만 빌드한다. 단
    // 폴딩 시도가 securityTfConstGuards를 새로 등록했으면(입력 유래 문자열 비교 경유) 그 가드는
    // 이 런타임 소비 경로에서 호출부 롤백 규칙(C598/C599)과 충돌하므로 등록분을 되돌리고 폴딩을
    // 포기한다(가드-프리 조건만 프루닝 — 보수 원칙).
    const guardSnapshot = new Set(prog.securityTfConstGuards.keys());
    const folded = resolveSecurityTfTernaryCondition(expr.condition, prog, visiting, null, funcName);
    let foldedGuardFree = folded !== undefined;
    for (const k of prog.securityTfConstGuards.keys()) {
      if (!guardSnapshot.has(k)) {
        foldedGuardFree = false;
        prog.securityTfConstGuards.delete(k);
      }
    }
    if (!foldedGuardFree) return null;
    return resolveSecurityRuntimeTfString(folded ? expr.trueExpr : expr.falseExpr, prog, funcName, visiting);
  }
  return null;
}

// 위 문자열 문법의 삼항 조건 전용 bool 문법 — input.bool(직접/변수 경유)과 문자열 ==/!= 비교만.
// </>/<=/>= 비교는 의도적으로 제외: bar series 조건(`close > open ? ...`)이 진짜 동적 tf의 대표
// 폼이라(기존 "still rejects ternary/dynamic" 테스트가 고정) 숫자 비교 축은 열지 않는다.
function resolveSecurityRuntimeTfBool(
  expr: Expr,
  prog: AnalyzedProgram,
  funcName: string | null,
  visiting: Set<string>,
): Expr | null {
  if (expr.kind === "BoolLiteral") return expr;
  if (expr.kind === "CallExpr") {
    const callee = expr.callee;
    if (callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "input") {
      // 문자열 리프와 대칭 — defval 부재/비-bool 리터럴 defval은 거부(undefined 조건 방지).
      return callee.attr === "bool" && bareInputDefval(expr)?.kind === "BoolLiteral" && securityRuntimeTfInputCallSafe(expr, prog)
        ? expr
        : null;
    }
    if (callee.kind === "Identifier" && callee.name === "input") {
      return bareInputDefval(expr)?.kind === "BoolLiteral" && securityRuntimeTfInputCallSafe(expr, prog) ? expr : null;
    }
    return null;
  }
  if (expr.kind === "Identifier") {
    if (funcName !== null && (prog.constVarShadowFuncs.get(expr.name)?.has(funcName) ?? false)) return null;
    if (visiting.has(expr.name)) return null;
    const def = prog.uniqueTopEqVars.get(expr.name);
    if (def === undefined || def.line >= expr.line) return null;
    visiting.add(expr.name);
    const result = resolveSecurityRuntimeTfBool(def.value, prog, null, visiting);
    visiting.delete(expr.name);
    return result;
  }
  if (expr.kind === "BinOp" && (expr.op === "==" || expr.op === "!=")) {
    const l = resolveSecurityRuntimeTfString(expr.left, prog, funcName, visiting);
    if (l === null) return null;
    const r = resolveSecurityRuntimeTfString(expr.right, prog, funcName, visiting);
    if (r === null) return null;
    const synth: BinOp = { kind: "BinOp", op: expr.op, left: l, right: r, line: expr.line, col: expr.col };
    return synth;
  }
  return null;
}

// C730: str.tostring 조합자의 포맷 리터럴 허용 패턴 — 숫자 자리표시('#'만) + 선택적 문자 접미사.
// '###M'/'###W'/'###D'(auto-HTF 관용구)와 '####'(순수 정수 표기)만 통과, '.'/'0' 포함 포맷은
// 소수 출력이라 tf 문자열로 무의미해 거부(컴파일타임 폴딩 C730 확장과 런타임 조합자가 공유).
const SECURITY_TOSTRING_FMT_RE = /^#+[A-Za-z]*$/;

// C730: 위 문자열 문법의 str.tostring 값 인자 전용 숫자 서브트리 문법 — "프리앰블 1회 평가 가능 +
// 정수 보장"이 성립하는 리프만. isInt=false 조합(예: input.float 리프)은 tostring 방출이
// pyFloatStr("120.0")로 떨어져 tf 문자열이 오염되므로 호출부가 거부한다(값 자체를 넓히는 용도가
// 아니라 tostring 조합자 전용 — </>/<= 숫자 비교 축은 여전히 닫혀 있음, C598 "still rejects
// dynamic" 불변 유지). 리프: NumberLiteral / timeframe 숫자 프로퍼티(chartTf 폴딩 → 합성
// NumberLiteral) / input.int·bare input(정수 NumberLiteral defval + securityRuntimeTfInputCallSafe
// 방출 게이트) / Identifier 치환(funcLocalUniqueEqVars → constVarShadowFuncs 가드 →
// uniqueTopEqVars, 문자열 문법과 동일 우선순위·line·visiting 가드) / +·-·* 산술(합성 BinOp —
// 숫자 피연산자 확정이라 concatBinOps 노드-키 문자열 연결 오방출 클래스 무관, '/'는 rt.idiv/
// pineDiv 노드-키 판별과 어긋날 수 있어 제외).
function resolveSecurityRuntimeTfNumber(
  expr: Expr,
  prog: AnalyzedProgram,
  funcName: string | null,
  visiting: Set<string>,
): { node: Expr; isInt: boolean } | null {
  if (expr.kind === "NumberLiteral") return { node: expr, isInt: Number.isInteger(expr.value) };
  if (expr.kind === "DotAccess" && expr.obj.kind === "Identifier" && expr.obj.name === "timeframe") {
    const num = timeframeNumberPropValue(expr.attr, prog.chartTf);
    if (num === undefined) return null;
    const synth: NumberLiteral = { kind: "NumberLiteral", value: num, raw: String(num), line: expr.line, col: expr.col };
    return { node: synth, isInt: Number.isInteger(num) };
  }
  if (expr.kind === "CallExpr") {
    const callee = expr.callee;
    const isDotInput = callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "input";
    const isBareInput = callee.kind === "Identifier" && callee.name === "input";
    if (!isDotInput && !isBareInput) return null;
    if (isDotInput && callee.kind === "DotAccess" && callee.attr !== "int" && callee.attr !== "float") return null;
    const dv = bareInputDefval(expr);
    if (dv === undefined || dv.kind !== "NumberLiteral" || !securityRuntimeTfInputCallSafe(expr, prog)) return null;
    // input.float는 런타임 값이 소수일 수 있어 isInt 미보장 — 호출부(tostring 조합자)가 거부.
    const isInt = (isBareInput || (callee.kind === "DotAccess" && callee.attr === "int")) && Number.isInteger(dv.value);
    return { node: expr, isInt };
  }
  if (expr.kind === "Identifier") {
    if (funcName !== null) {
      const localMap = prog.funcLocalUniqueEqVars.get(funcName);
      const localDef = localMap?.get(expr.name);
      if (localDef !== undefined) {
        if (localDef.line >= expr.line || visiting.has(expr.name)) return null;
        visiting.add(expr.name);
        const result = resolveSecurityRuntimeTfNumber(localDef.value, prog, funcName, visiting);
        visiting.delete(expr.name);
        return result;
      }
    }
    if (funcName !== null && (prog.constVarShadowFuncs.get(expr.name)?.has(funcName) ?? false)) return null;
    if (visiting.has(expr.name)) return null;
    const def = prog.uniqueTopEqVars.get(expr.name);
    if (def === undefined || def.line >= expr.line) return null;
    visiting.add(expr.name);
    const result = resolveSecurityRuntimeTfNumber(def.value, prog, null, visiting);
    visiting.delete(expr.name);
    return result;
  }
  if (expr.kind === "BinOp" && (expr.op === "+" || expr.op === "-" || expr.op === "*")) {
    const l = resolveSecurityRuntimeTfNumber(expr.left, prog, funcName, visiting);
    if (l === null) return null;
    const r = resolveSecurityRuntimeTfNumber(expr.right, prog, funcName, visiting);
    if (r === null) return null;
    const synth: BinOp = { kind: "BinOp", op: expr.op, left: l.node, right: r.node, line: expr.line, col: expr.col };
    return { node: synth, isInt: l.isInt && r.isInt };
  }
  return null;
}

// 배치31 (b)-2, C600: tf 자리 하나(직접 tfArg든 tf-param 콜사이트 실인자든)를 런타임 1회 확정
// 트리로 해석하는 공용 이단 판정 — (1) C597 직접 input.*(...) 콜(any-attr, 방출-슬롯 리터럴 게이트),
// (2) 아니면 C598 정의식 재귀 치환 트리. 기존 main-flow 인라인 로직을 바이트 동등하게 추출한 것
// (사이트별 리졸버와의 사본 발산 방지 — MEMORY C136 원칙).
function resolveSecurityRuntimeTfArg(tfArg: Expr, prog: AnalyzedProgram, funcName: string | null): Expr | null {
  const isDirectInputCall =
    tfArg.kind === "CallExpr" &&
    tfArg.callee.kind === "DotAccess" &&
    tfArg.callee.obj.kind === "Identifier" &&
    tfArg.callee.obj.name === "input";
  // C598 버그 수정: 직접 콜이라도 방출 슬롯에 비리터럴 인자(defval의 '=' 로컬 등)가 있으면
  // 프리앰블 rebuildSecurityCache 방출이 그 이름을 참조하지 못해 ReferenceError였다
  // (securityRuntimeTfInputCallSafe 주석 참조 — C597 초판이 이 가드를 빠뜨림).
  if (isDirectInputCall && securityRuntimeTfInputCallSafe(tfArg as CallExpr, prog)) return tfArg;
  // 배치31 (a)-2, C598: 변수 경유("재대입 0회" 전제)/삼항/문자열 비교 조건 tf를 런타임-1회
  // 확정 트리로 치환(resolveSecurityRuntimeTfString 주석 참조). 실패하면 null → 기존 에러.
  return resolveSecurityRuntimeTfString(tfArg, prog, funcName, new Set());
}

// C529: tf 인자가 이 request.security 콜을 감싼 UDF 자신의 매개변수(bare Identifier)일 때,
// 그 함수의 콜사이트 전수에서 그 위치의 실인자를 resolveSecurityTfLiteral로 접어 콜사이트별 tf
// 리터럴 배열(funcAllCallSites 순서 = C453 서수 순서)을 만든다. 하나라도 실패하면 전체 null(기존
// 하드 에러로 폴백 — 보수 원칙). C539: in-func 콜사이트(다른 UDF 본문 안 `wrap() => getS("60")`류,
// wild param:callsite-in-func 40파일 중 리터럴/top-level 상수 실인자 축)도 허용 — C453 expression
// 축과 달리 tf 실인자는 값이 "컴파일타임 리터럴로 접힐 때만" 성공하므로 콜사이트가 어느 스코프에
// 있든 접힌 값은 스코프 독립적이다. 스코프 의존 위험 2종은 구조적으로 차단된다: (1) 호출자 자신의
// 매개변수를 그대로 전달하는 transitive 폼(`wrap(t) => getS(t)`)은 그 이름이 constStringVars/
// uniqueTopEqVars에 없어(매개변수는 등재 대상 아님) 자연 실패 → 기존 하드 에러 유지, (2) top-level
// 상수와 동명인 호출자 매개변수 섀도잉은 funcName=그 콜사이트의 inFuncName을 리졸버에 넘겨 C526
// constVarShadowFuncs 가드가 걸러낸다(함수-로컬 '=' 섀도잉은 prescanConstVars가 그 이름을 아예
// 등재하지 않아 원천 불가). __secIdx 배선(registerSecurityTfSiteOrdinals)과 codegen 콜사이트 방출
// (funcSecIdxArgs)은 CallExpr 노드 키라 콜사이트 위치와 무관하게 그대로 작동한다.
// C453과 달리 지연 큐가 필요 없다: 소비하는 맵(constStringVars/uniqueTopEqVars)이 전부 prescan이라
// 본문 분석 시점에 이미 완성돼 있고, uniqueTopEqVars의 선언-후-사용은 리졸버 내부 line 검사가
// 실인자 노드 자신의 line으로 판정한다(in-func 콜사이트도 실인자 텍스트의 물리적 line 기준 —
// "함수 본문은 자신보다 앞서 선언된 top-level 이름만 참조 가능" TV 규칙과 방향이 같아 보수적).
// 매개변수 default 폴백은 미지원(FuncInfo가 default 식을 보존하지 않음 — 실인자 명시 필수).
// 배치31 (b)-2, C600: 리터럴 전용에서 "리터럴×런타임 혼합"으로 확장 — 사이트마다 먼저 리터럴
// 폴딩을 시도하고(성공 시 그 사이트 슬롯은 기존과 완전 동일한 컴파일타임 고정 + freeze 가드 유지),
// 실패하면 그 시도가 새로 등록한 freeze 가드만 롤백한 뒤(C598 부분 폴딩 클래스 — 이 사이트 슬롯은
// "컴파일타임 고정 캐시" 전제가 없다) 런타임 1회 확정 트리((a)/(a)-2와 동일 문법,
// resolveSecurityRuntimeTfArg)를 시도한다. 사이트 하나라도 둘 다 실패하면 전체 null(기존 하드 에러
// 폴백 — 보수 원칙, 부분 지원 없음). 반환이 전부 string이면 기존 C529 경로(uniform 붕괴 포함)와
// 완전 동일하게 소비되고, Expr가 하나라도 섞이면 tfSiteMixed로 각 사이트 슬롯이 개별
// securityRuntimeTfSlots에 등록된다(자리표시 + 프리앰블 rebuildSecurityCache — 트리는 Identifier
// 전소거 자기완결이라 콜사이트가 어느 스코프에 있든 방출 안전, C539 "접힌 값은 스코프 독립"
// 원칙의 런타임 트리판).
function resolveSecurityTfParamSiteValues(
  tfArg: Expr,
  prog: AnalyzedProgram,
  scope: LexScope,
): (string | Expr)[] | null {
  if (tfArg.kind !== "Identifier" || scope.func === null) return null;
  const paramIdx = scope.func.paramNames.indexOf(tfArg.name);
  if (paramIdx < 0) return null;
  const sites = prog.funcAllCallSites.get(scope.func.name);
  if (sites === undefined || sites.length === 0) return null;
  const values: (string | Expr)[] = [];
  for (const s of sites) {
    const argExpr = s.call.args[paramIdx] ?? s.call.kwargs.find((kw) => kw.name === tfArg.name)?.value;
    if (argExpr === undefined) return null;
    const guardKeysBefore = new Set(prog.securityTfConstGuards.keys());
    const lit = resolveSecurityTfLiteral(argExpr, prog, undefined, undefined, s.inFuncName);
    if (lit !== undefined) {
      // C435와 동일한 '' = 차트 tf 정규화 — 고정 리터럴 경로와 대칭(배치30 (1)부터 prog.chartTf).
      values.push(lit === "" ? prog.chartTf : lit);
      continue;
    }
    // 실패한 폴딩 시도의 신규 가드만 롤백(C598) — 이 사이트는 런타임 경로로 가므로 freeze 전제가
    // 없다. 앞선 사이트/다른 콜사이트가 폴딩 소비한 기존 가드는 스냅샷 밖이라 안전하고, 같은
    // 이름을 뒤 사이트가 폴딩 소비하면 그 사이트의 자기 시도가 재등록한다(C598 dedup 원칙).
    for (const k of prog.securityTfConstGuards.keys()) {
      if (!guardKeysBefore.has(k)) prog.securityTfConstGuards.delete(k);
    }
    const runtime = resolveSecurityRuntimeTfArg(argExpr, prog, s.inFuncName);
    if (runtime === null) return null;
    values.push(runtime);
  }
  return values;
}

// C529: 콜사이트별 tf 슬롯 블록을 쓰는 함수의 __secIdx 배선 — C453 processPendingSecurityParamExprs
// 꼬리와 동일한 두 부수효과(hasSecParamCalls로 함수 시그니처에 __secIdx 추가, funcAllCallSites
// 순서 그대로 콜사이트별 서수 등록). 같은 함수에 대해 여러 번 호출돼도(본문에 해당 콜 2개 이상,
// 또는 C453 pending과 공존) 같은 값으로 재설정될 뿐이라 멱등이다.
function registerSecurityTfSiteOrdinals(prog: AnalyzedProgram, funcInfo: FuncInfo): void {
  funcInfo.hasSecParamCalls = true;
  const sites = prog.funcAllCallSites.get(funcInfo.name)!;
  sites.forEach((site, ordinal) => prog.funcSecIdxArgs.set(site.call, ordinal));
}

// request.security의 필수 3인자(symbol/timeframe/expression)를 위치+키워드 슬롯 병합으로 받는다
// (C409, wild 47건 — 전량 완전 키워드형 `request.security(symbol=..., timeframe=..., expression=...
// [, lookahead=...])` 폼). gaps=/lookahead=/ignore_invalid_symbol=/currency=는 기존 SECURITY_POSITIONAL_
// NAMES 위치 루프 + 아래 kwargs 루프가 그대로 처리하므로 이 리졸버는 앞쪽 3슬롯만 다룬다 — symbol은
// 값 검증 없이 버려지는 인자라(위 주석 참조) 존재 여부만 확인, timeframe/expression은 반환된 Expr
// 노드를 기존 로직이 그대로 소비한다(codegen은 prog.securityCallSlots 등을 CallExpr 노드 자체로
// 키잉하므로 인자가 위치/키워드 중 어느 쪽에서 왔는지 무관 — codegen 변경 불필요).
const SECURITY_LEAD_PARAM_NAMES = ["symbol", "timeframe", "expression"] as const;
function resolveSecurityLeadArgs(
  expr: CallExpr,
  prog: AnalyzedProgram,
): { symbolArg: Expr; tfArg: Expr; seriesArg: Expr } | null {
  const slots: (Expr | undefined)[] = [expr.args[0], expr.args[1], expr.args[2]];
  let ok = true;
  for (const kw of expr.kwargs) {
    const idx = SECURITY_LEAD_PARAM_NAMES.indexOf(kw.name as (typeof SECURITY_LEAD_PARAM_NAMES)[number]);
    if (idx === -1) continue; // gaps/lookahead/ignore_invalid_symbol/currency — 아래 별도 루프가 처리
    if (idx < expr.args.length) {
      if (!isHarmlessArgDup(expr.args[idx], kw.value)) {
        prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        ok = false;
      }
      continue;
    }
    if (slots[idx] !== undefined) {
      prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      ok = false;
      continue;
    }
    slots[idx] = kw.value;
  }
  if (slots[0] === undefined || slots[1] === undefined || slots[2] === undefined) {
    prog.errors.push(
      `'request.security' call argument count mismatch: requires 3~5 (symbol, timeframe, expression[, gaps[, lookahead]]) (symbol/timeframe/expression supported positionally or as keywords, gaps/lookahead supported positionally or as keywords, ignore_invalid_symbol/currency/calc_bars_count keyword-only) (L${expr.line}:${expr.col})`,
    );
    return null;
  }
  if (!ok) return null;
  return { symbolArg: slots[0], tfArg: slots[1], seriesArg: slots[2] };
}

// request.security 셋째 슬라이스 서브슬라이스 3a(C180, 상세 설계는 C179가 ROADMAP에 확정) —
// expression 인자가 BAR_SERIES_NAMES bare 식별자가 아닐 때 "표현식 콜사이트"로 좁게 지원할지
// 판정한다. v1 스코프: 서브트리 전체에서 정확히 1개의 ta.* 콜(TA_REGISTRY dispatch==="ta", 다중
// 반환 제외 — dmi류는 튜플 디스트럭처링 전용이라 스칼라 표현식 위치에 못 옴)만 허용하고, 그 콜의
// 인자를 포함해 트리의 나머지 전부는 bare series 식별자/숫자·불리언 리터럴/산술(BinOp·UnaryOp)만
// 허용한다 — 다른 어떤 콜(request.*/strategy.*/plot 등, math.*/str.* 순수 빌트인, 두 번째 이상의
// ta.* 콜, UDF/method 콜)도, IndexAccess(`close[1]`)도, 삼항/제어흐름류도 전부 무효(narrow 시작 —
// 후속 슬라이스에서 확장하는 관례, C176이 hlc3/hl2를 첫 슬라이스에서 제외한 선례와 동형). 이
// 함수들은 "구조가 유효한가"만 판정한다 — 실제 등록(analyzeStatefulCall 호출 + taSlots 배정)은
// 호출부(analyzeCallExpr의 request.security 분기)가 수행한다.
// C543: math.sum(source, length) — TA_REGISTRY dispatch:"math"(ta.ts, 일반 비-security 콜사이트와
// 동일 항목 — 고정폭 슬라이딩 윈도우 합계, 매 바 상태가 있다). next_hint(C542)가 이 함수를
// matchSecurityExprMathCall(순수 함수 전용 — 클론 생성 + prog.builtinCalls 직접 등록, taCalls
// 등록 없음)의 화이트리스트에 추가하라고 지시했으나, 그 경로는 "바마다 독립 상태 없음"이 전제라
// math.sum(상태 있음)을 넣으면 프리패스 루프의 매 h 반복마다 슬라이딩 윈도우 상태가 유실되는
// 조용한 오답 codegen을 낳는다(analyzeStatefulCall/taCalls 슬롯 배정을 안 거치므로) — 실측
// 확인(scratch/c543_mathsum_probe.mjs 등)으로 이 next_hint 자체가 틀렸음을 발견. 올바른 경로는
// ta.* 콜과 동일한 이 함수(analyzeStatefulCall + taCalls 슬롯) — TA_REGISTRY가 이미 dispatch로
// "ta"/"math" 네임스페이스를 구분해두므로(analyzer.ts L2993 `entry.dispatch === namespace`와
// 동일 패턴) namespace 판정만 "math"로 넓히면 나머지 메커니즘(kwargs/다중반환/슬롯)은 전부
// 무변경 재사용된다. math.random(TA_REGISTRY의 유일한 형제 dispatch:"math" 항목)은 wild
// request.security 표현식 안 실사용 0건(c543 재확인)이라 이번 슬라이스는 "sum"만 명시적으로
// 화이트리스트(C283 큐레이션 원칙 — 형제라고 예방적으로 같이 안 넓힌다).
function matchSecurityExprTaCall(node: CallExpr): { fn: string; entry: TaRegistryEntry } | null {
  const callee = node.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier") return null;
  const ns = callee.obj.name;
  const isMathSum = ns === "math" && callee.attr === "sum";
  if (ns !== "ta" && !isMathSum) return null;
  const entry = TA_REGISTRY[callee.attr];
  if (!entry || entry.dispatch !== (isMathSum ? "math" : "ta")) return null;
  // C362: vwap의 3-인자 폼은 인자 개수 의존 다중 반환(returnArityByArgCount)이라 entry.returnArity
  // 직접 읽기 대신 콜사이트 인자 개수로 판정 — 다중 반환은 스칼라 표현식 위치(security expr)에
  // 못 오므로 기존 dmi류와 동일하게 거부. 1/2-인자 vwap(스칼라 폼)은 계속 통과한다.
  if (taCallReturnArity(entry, node.args.length) !== undefined) return null;
  // C653: array<float> 핸들 반환 TA(ta.pivot_point_levels) — security expr의 out[h]/버퍼는
  // Float64Array라 배열 핸들이 흘러들면 Number(array)=NaN 조용한 부식(C602 클래스). 거부.
  if (entry.returnsArrayHandle === true) return null;
  // C443: entry.kwargParamNames가 등재된 함수(atr/sma/ema/... — 일반 non-security 콜사이트의
  // isTaKwargCall 예외와 동일 조건, C400/C402)는 kwargs를 허용한다. 미등재 함수는 기존대로 blanket 거부
  // (ta.* 콜 kwargs 전체가 아니라 "이 함수가 kwargs 지원을 이식받았는가"가 진짜 게이트).
  if (node.kwargs.length > 0 && entry.kwargParamNames === undefined) return null;
  return { fn: callee.attr, entry };
}

// C605: 위 matchSecurityExprTaCall의 자매 — 스칼라 expression 위치(단일 반환만) 대신
// AnalyzedProgram.uniqueTopEqTuples 치환 전용 위치(다중 반환만)에 쓰인다. `ta.macd/bb/kc/dmi/
// supertrend` 등 다중 반환 콜은 top-level 유일 튜플 디스트럭처(`[a, b] = ta.supertrend(...)`)의
// RHS로만 등장할 수 있고, 그 대상 이름 하나(예 stDir)가 request.security expression에서 쓰이면
// 이 매처가 재검증한다 — dispatch/kwargs 게이트는 matchSecurityExprTaCall과 동일, arity 조건만
// 반대(다중 반환이어야 함). math.sum은 애초에 단일 반환이라 이 위치에 등장할 수 없다(제외).
function matchSecurityExprMultiReturnTaCall(node: CallExpr): { fn: string; entry: TaRegistryEntry } | null {
  const callee = node.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier" || callee.obj.name !== "ta") return null;
  const entry = TA_REGISTRY[callee.attr];
  if (!entry || entry.dispatch !== "ta") return null;
  if (taCallReturnArity(entry, node.args.length) === undefined) return null;
  if (node.kwargs.length > 0 && entry.kwargParamNames === undefined) return null;
  return { fn: callee.attr, entry };
}

const SECURITY_EXPR_ARITH_OPS: ReadonlySet<string> = new Set(["+", "-", "*", "/"]);

// C449: 비교(</>/<=/>=)·논리(and/or) 연산자 — wild 실측(scratch/c436_security_expr_cluster_probe.mjs
// 'binop-compare:>'/'binop-compare:<'/'binop-logical:and'/그 var-subst 변형, 90941dd9a72a.pine
// `high[2] < low[0] and close[1] > open[1]` 등)이 전부 이미 지원되는 leaf(bare/파생 시리즈·정수
// 리터럴 히스토리·top-level '=' 치환)만으로 구성돼 있어 이 두 연산자 클래스만 추가하면 net-gain이
// 확정된다. codegen(genBinOp)이 이미 `<`/`>`/`<=`/`>=`→rt.pineLt류, `and`/`or`→rt.pineAnd/pineOr로
// 방출하고 `l`/`r`을 secCtx와 함께 genExpr해 이 위치(프리패스 루프)에서도 그대로 재사용 가능 —
// 산술(C367)과 코드 경로가 완전히 같다("불리언을 0.0/1.0으로?"라던 구 설계 우려는 착수 중 실측으로
// 해소: 결과가 $.securityExprCache의 Float64Array에 JS 숫자 강제변환(true→1/false→0/NaN→NaN)으로
// 저장되고 그대로 읽혀도, rt.na()의 na 판별과 JS 네이티브 조건문의 truthy 판정은 이 인코딩과 이미
// 호환된다 — 유일하게 어긋났던 rt.pineAnd/pineOr의 엄격한 `===false`/`===true` 비교는 이 김에
// 함께 고쳤다(위 numeric.ts C449 주석 참조), 하위 호환 유지). ==/!=는 genEquality가 secCtx를 아예
// 안 받는 별도 함수라 이 슬라이스와 다른 수정이 필요해 당시 범위 밖으로 남겼다 — C602가 해소(아래
// SECURITY_EXPR_EQUALITY_OPS 주석 참조). not(UnaryOp)은 C449 당시 유일한 wild 예시
// 0523d8d8b8e4.pine이 na()/session-string time()에 가려져 net-gain 0이라 제외했으나, C733이
// na() 리프와 함께 허용(UnaryOp case 주석 참조 — wild `not na(ta.pivothigh(...))` 관용구).
const SECURITY_EXPR_COMPARE_OPS: ReadonlySet<string> = new Set(["<", ">", "<=", ">="]);
const SECURITY_EXPR_LOGICAL_OPS: ReadonlySet<string> = new Set(["and", "or"]);
// C602: ==/!= — genEquality(codegen.ts)가 secCtx를 안 받는 별도 함수였다(바로 위 주석의 C449이
// 이 슬라이스 밖으로 명시적으로 남긴 축). genEquality에 secCtx를 스레딩하기만 하면 나머지(NaLiteral
// 리프 rt.na() 분기 포함)는 buildSecurityExprNode의 기존 BinOp/leaf 재귀와 완전히 같은 경로 —
// wild 실측(C601 c601_residual_probe): security-expr 거부 잔여 중 ==/!= 비교가 expression에 있는
// 파일 20개, 그중 security-expr 거부가 유일한 블로커인 파일 11개.
const SECURITY_EXPR_EQUALITY_OPS: ReadonlySet<string> = new Set(["==", "!="]);

// C445: math.* 콜 리프 케이스(next_hint(C443/C444) 2번 후보) — wild 재확인(scratch/c445_probe2.mjs,
// request.security(...) 호출 span 안에 math.* 텍스트가 실제로 등장하는지 정밀 검사) 결과 next_hint가
// 지목한 891103d44223.pine(`ta.lowest(..., math.max(...))`)은 실측 재확인에서 그 형태가 아니었다
// (C438 교훈대로 액면가 불신 확인됨) — 실제로는 top-level '=' var-subst 대상(safeDaysLen =
// math.max(1, daysBreakLen))의 **값**이 math.max라 Identifier var-subst 재귀 경로(위 case
// "Identifier")가 그 값을 다시 buildSecurityExprNode에 먹여 여기 CallExpr 분기까지 내려온다.
// dc2c13bddd19.pine/bb3c03b9594a.pine(`ta.stdev(math.log(close/close[1]), N) * math.sqrt(252)`,
// math.log는 ta.* 인자 안에서, math.sqrt는 산술 피연산자로 등장)/f051606fdbe4.pine
// (`math.avg(conversionLine, baseLine)` 단독)까지 재확인으로 4파일 net-gain 확정(2 -> 4, 여전히
// 저비용). math.*는 전부 순수 함수(바마다 독립 상태 없음, 일반 analyzeCallExpr 분기 주석과 동일
// 근거)라 ta.*와 달리 taCalls 등록이 불필요 — nz(C444)와 완전히 동일한 메커니즘(클론 생성 +
// prog.builtinCalls 직접 등록, codegen의 일반 builtinCalls 폴백이 C444가 고친 secCtx 스레딩을 그대로
// 재사용). kwargs는 wild 근거 없음(위 4파일 전부 위치 인자 전용) — kwargs 있으면 이 분기가 안 걸려
// 미지원 그대로 거부(MATH_KWARG_PARAM_NAMES 경로는 codegen에서 secCtx를 안 물려주는 별도 미확인
// 갭이 있어 이번 슬라이스가 그 경로를 밟지 않도록 의도적으로 피한다). 인자 개수 규칙은 일반
// analyzeCallExpr의 math.* 분기(round/round_to_mintick 1~2, max/min/avg 2개 이상, pow/atan2 정확히
// 2개, 나머지 단항)를 그대로 미러 — 이 콜사이트는 일반 analyzeExpr를 안 거쳐(C180) 인자 개수 검증이
// 따로 없으므로 여기서 직접 검증해야 코드젠에 잘못된 arity의 rt.* 호출이 새지 않는다.
const SECURITY_EXPR_MATH_METHODS: ReadonlySet<string> = new Set([
  "abs",
  "round",
  "max",
  "min",
  "avg",
  "floor",
  "ceil",
  "sqrt",
  "pow",
  "log",
  "log10",
  "exp",
  "sign",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "todegrees",
  "toradians",
  "round_to_mintick",
]);

function securityExprMathArityOk(method: string, argCount: number): boolean {
  if (method === "round" || method === "round_to_mintick") return argCount >= 1 && argCount <= 2;
  if (method === "max" || method === "min" || method === "avg") return argCount >= 2;
  if (method === "pow" || method === "atan2") return argCount === 2;
  return argCount === 1;
}

function matchSecurityExprMathCall(node: CallExpr): string | null {
  const callee = node.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier" || callee.obj.name !== "math") return null;
  if (!SECURITY_EXPR_MATH_METHODS.has(callee.attr)) return null;
  if (node.kwargs.length > 0) return null;
  if (!securityExprMathArityOk(callee.attr, node.args.length)) return null;
  return callee.attr;
}

// strategy.closedtrades.<method>(index)/strategy.opentrades.<method>(index)(C308) — 3-level
// 체이닝(entry_comment/exit_comment만 지원하던 C173 열한째 슬라이스를 확장)이라 위 namespace
// (callee.obj.kind===Identifier 전제)로는 못 잡아 DRAWING_METHODS와 동일한 "네임스페이스 ->
// 허용 method 집합" 표로 판별한다. pine2py wavealgo/strategy/types.py Trade dataclass(entry_id/
// exit_id/entry_price/exit_price/entry_bar/exit_bar/profit) 필드셋과 대응 — 단 pine2js는 트레이드
// 배열을 보유하지 않아(GOAL.md "bar loop 안 할당 제로") closedtrades는 entry_comment/exit_comment와
// 동일하게 **가장 최근 청산 트레이드 1건만**(runtime/strategy.ts lastClosed* 필드), opentrades는
// Position dataclass(entry_id/entry_price/entry_bar/size)에 대응하고 STRATEGY_RUNTIME_PROPS의
// opentrades 스칼라 카운트(posSize===0?0:1)와 같은 전제라 index=0(단일 가상 트레이드, 피라미딩도
// 압축)만 유효 — 그 외 index는 트레이드 히스토리 미보유라 명시적 하드 에러(LIMITATIONS.md, 조용한
// 오답 방지). profit/profit_percent/max_drawdown/max_runup(C312, C308이 범위 밖으로 보류했던 4종)은
// codegen.ts OPEN_TRADE_CLOSE_PRICE_METHODS(opentrades.profit/profit_percent만 `$.close.get(0)`
// 암묵 주입 — 미실현 손익 계산에 종가가 필요, C308 원래 우려 해소)와 runtime/strategy.ts
// updateTradeExcursion(max_drawdown/max_runup의 바별 인트라바 추적) 참조.
const STRATEGY_TRADE_ACCESSOR_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  closedtrades: new Set([
    "entry_comment",
    "exit_comment",
    "entry_price",
    "exit_price",
    "entry_bar_index",
    "exit_bar_index",
    "entry_id",
    "exit_id",
    "profit",
    "size",
    // C312: max_drawdown/max_runup/profit_percent(C308이 범위 밖으로 보류했던 3종)
    "profit_percent",
    "max_drawdown",
    "max_runup",
    // C418: entry_time/exit_time/commission(wild "지원하지 않는 호출" '?.' 서브클러스터 — 3-level
    // 체이닝이라 위 namespace 판별로는 못 잡히던 진짜 TV 빌트인 갭, LIMITATIONS.md 참조).
    "entry_time",
    "exit_time",
    "commission",
  ]),
  opentrades: new Set([
    "entry_price",
    "entry_bar_index",
    "entry_id",
    "size",
    // C312: profit(종가 인자 필요해 C308이 보류)/profit_percent/max_drawdown/max_runup
    "profit",
    "profit_percent",
    "max_drawdown",
    "max_runup",
    // C418: entry_time/commission(exit_time은 opentrades에 없음 — 아직 청산 전이라 TV에도 대응
    // 함수 자체가 없음, wild grep 0건으로 sanity 확인).
    "entry_time",
    "commission",
  ]),
};

// C367: request.security expression 확장 좁은 문법 빌더 — 기존 "정확히 1개의 ta.* 콜"(C180 v1)을
// (a) ta.* 콜 0~N개(형제 위치 산술 조합 — 프리패스가 표현식을 통째로 행별 재계산하는 구조라 콜
// 수와 무관), (b) hl2/hlc3/ohlc4/hlcc4 파생가(genDerivedPriceExpr가 secCtx 무관 합성), (c) bare/
// 파생 시리즈의 음수 아닌 정수 리터럴 히스토리(close[1] — HTF 프리패스에서 "그 tf의 이전 행",
// genBarRef offset-1 선례의 일반화), (d) 전역 유일 top-level '=' 바인딩 식별자의 재귀 인라인 치환
// (uniqueTopEqVars — TV는 expression을 요청 tf 문맥에서 재평가하므로 정의식 치환이 정확히 TV
// 시맨틱, C366 tf 상수 전파의 시리즈판), (e) 치환 경로로만 도달하는 input.int/float/bool·bare
// input 스칼라 상수(defval/전 인자 리터럴 한정 — 프리패스는 바 루프 밖 1회 평가), (f) C370
// hist-on-expr: bare/파생이 아닌 유효 서브식의 정수 리터럴 히스토리(`ta.sma(close,10)[1]`/치환
// 변수 `ma[1]` — 프리패스 안 서브식별 Float64Array 버퍼, SecurityExprHistRead 주석)로 넓힌다.
// (g) C439: ta.* 콜의 인자 자리에 다른 ta.* 콜의 중첩(`ta.ema(ta.tr, len)` — wild 최다 잔여
// ta-call:* 서브클러스터, 이전엔 hardcoded allowTa=false로 거부됐으나 codegen이 인자를 1회만
// genExpr해 이중 전진 위험이 없음을 확인 후 허용, buildSecurityExprNode CallExpr case 주석 참조).
// 반환 bodyExpr는 프리패스에서 genExpr할 "빌드된" 트리다: 합성 노드(BinOp/UnaryOp/IndexAccess/
// ta CallExpr)는 항상 새 노드로 만들고(같은 정의가 여러 콜사이트/원소에 치환돼도 ta 슬롯이 독립 —
// TV의 "요청별 재평가"와 일치하고, stateCallSlots 등 노드-키 맵의 이중 소비(C180/MEMORY C340
// 클래스)도 구조적으로 차단), 리프(리터럴/bare·파생 식별자)와 input CallExpr는 원본 노드를
// 공유한다 — input 콜은 codegen이 builtinCalls(노드 키) 조회로 방출하므로 클론하면 안 되고(치환
// 경로 한정이라 정의문의 메인 패스 분석이 등록을 선행 보장 — 선언-후-사용 line 검사), 상태가
// 없어 재평가가 안전하다(C366 tf 가드가 프리앰블에서 같은 노드를 genExpr 재사용한 선례). 치환된
// 정의 안의 int/int 나눗셈은 idivBinOps가 원본 노드 키로 등록돼 있으므로 클론에 승계한다.
interface SecurityExprTaCallRef {
  taCall: CallExpr;
  fn: string;
  entry: TaRegistryEntry;
}
// histReads(C370, hist-on-expr): "유효 서브식[정수 리터럴 n>=1]" — bare/파생 시리즈가 아닌 obj
// (ta.* 콜/치환 변수/산술 조합)의 히스토리를 프리패스 안 서브식별 Float64Array 버퍼로 지원한다.
// node는 bodyExpr에 박히는 빌드된 IndexAccess 클론(codegen이 노드 identity로 버퍼 읽기 치환),
// obj는 버퍼를 채울 서브식 루트. 배열 순서 = 버퍼 인덱스 = 행별 fill 문 순서 — 재귀가 obj를
// 먼저 빌드하므로 중첩 히스토리는 안쪽 항목이 항상 앞이다(fill이 앞 버퍼만 읽는 불변식).
export interface SecurityExprHistRead {
  node: IndexAccess;
  obj: Expr;
}
export interface SecurityExprBuild {
  bodyExpr: Expr;
  taCalls: SecurityExprTaCallRef[];
  histReads: SecurityExprHistRead[];
  // C738: top-level var 상태 변수 리플레이 슬라이스(analyzer.ts SecurityVarSlice 주석 참조) —
  // null이면 기존 경로 그대로.
  varSlice: SecurityVarSlice | null;
}

// C542: seriesArg 서브트리 안에서 참조되는 Identifier 이름 전부를 모은다(secParamMultiSiteGeneric
// 후보 판정 전용 — buildSecurityExprNode가 실제로 재귀하는 노드 종류(BinOp/UnaryOp/TernaryOp/
// IndexAccess/DotAccess.obj/CallExpr args+kwargs)만 따라간다. 과다수집은 무해하다 — 여기서는
// "매개변수를 하나라도 참조하는가"만 판정하고, 실제 빌드 가능 여부는 아래 buildSecurityExprNode가
// paramEnv로 다시 검증한다).
function collectSecurityExprIdentNames(node: Expr, out: Set<string>): void {
  switch (node.kind) {
    case "Identifier":
      out.add(node.name);
      return;
    case "UnaryOp":
      collectSecurityExprIdentNames(node.operand, out);
      return;
    case "BinOp":
      collectSecurityExprIdentNames(node.left, out);
      collectSecurityExprIdentNames(node.right, out);
      return;
    case "TernaryOp":
      collectSecurityExprIdentNames(node.condition, out);
      collectSecurityExprIdentNames(node.trueExpr, out);
      collectSecurityExprIdentNames(node.falseExpr, out);
      return;
    case "IndexAccess":
      collectSecurityExprIdentNames(node.obj, out);
      collectSecurityExprIdentNames(node.index, out);
      return;
    case "DotAccess":
      collectSecurityExprIdentNames(node.obj, out);
      return;
    case "CallExpr":
      for (const a of node.args) collectSecurityExprIdentNames(a, out);
      for (const kw of node.kwargs) collectSecurityExprIdentNames(kw.value, out);
      return;
    default:
      return;
  }
}

// C731: buildSecurityExprNode paramEnv 맵의 값 — 실인자 Expr + 그 실인자가 물리적으로 속한 UDF
// 이름(top-level 콜사이트면 null). 치환 진입 시 funcName을 이 값으로 갈아타야 C526 섀도잉 가드/
// C452 콜사이트 치환/함수-로컬 유일 '=' 치환이 실인자 자신의 스코프로 정확히 동작한다(paramEnv
// 파라미터 주석 참조).
// C732: env — 그 실인자 위치에서 활성이던 paramEnv(없으면 undefined/null). 중첩 인라인(인라인된
// 본문 안의 또 다른 bare UDF 콜 — C516이 범위 밖으로 미뤄뒀던 축)에서 안쪽 콜의 실인자가 바깥
// 함수의 매개변수를 참조하면(`compositeMtfEma(tf, len) => ... ta.ema(compositeSelectedSource(),
// len)`의 len처럼) 그 이름은 안쪽 본문의 env가 아니라 이 캡처된 바깥 env로 풀어야 한다 — 치환
// 진입 시 funcName과 함께 이 env로 갈아탄다(렉시컬 캡처와 동형).
type SecurityParamEnvEntry = { expr: Expr; funcName: string | null; env?: ReadonlyMap<string, SecurityParamEnvEntry> | null };

// C731: in-func 콜사이트의 indexWrap(index 서브트리는 pending 함수 본문 스코프에 살지만 합성
// IndexAccess 빌드는 실인자 스코프로 걷는다 — 두 스코프의 이름 해석이 갈릴 수 있는 "스코프 민감"
// bare Identifier를 모은다. bar series/시간류 bare·DotAccess 네임스페이스 상수(barstate.* 등)는
// 어느 스코프에서나 동일 해석이라 제외. 하나라도 나오면 그 pending은 보수적으로 거부(wild 실측
// 이 관용구의 index는 전부 리터럴/barstate 삼항 — 식별자 없음).
function collectSecurityScopeSensitiveIdents(node: Expr, out: Set<string>): void {
  switch (node.kind) {
    case "Identifier":
      if (
        !BAR_SERIES_NAMES.has(node.name) &&
        !DERIVED_PRICE_NAMES.has(node.name) &&
        !SECURITY_EXPR_TIME_BAR_NAMES.has(node.name) &&
        !TIME_FUNC_NAMES.has(node.name)
      )
        out.add(node.name);
      return;
    case "DotAccess":
      return; // 네임스페이스 상수(barstate.*/timeframe.* 등) — 스코프 무관
    case "UnaryOp":
      collectSecurityScopeSensitiveIdents(node.operand, out);
      return;
    case "BinOp":
      collectSecurityScopeSensitiveIdents(node.left, out);
      collectSecurityScopeSensitiveIdents(node.right, out);
      return;
    case "TernaryOp":
      collectSecurityScopeSensitiveIdents(node.condition, out);
      collectSecurityScopeSensitiveIdents(node.trueExpr, out);
      collectSecurityScopeSensitiveIdents(node.falseExpr, out);
      return;
    case "IndexAccess":
      collectSecurityScopeSensitiveIdents(node.obj, out);
      collectSecurityScopeSensitiveIdents(node.index, out);
      return;
    case "CallExpr":
      for (const a of node.args) collectSecurityScopeSensitiveIdents(a, out);
      for (const kw of node.kwargs) collectSecurityScopeSensitiveIdents(kw.value, out);
      return;
    default:
      return;
  }
}

// C739(배치37(3) 9차): 읽기-지점 오프셋 후보 판정 — `bareSeries[오프셋식]`의 오프셋식이 "둘러싼
// UDF의 매개변수 + 숫자 리터럴 + (+ - *) 산술 + 단항 -"만으로 구성됐는지(wild 실측 폼:
// `high[_bar]`(84d597064e48)/`close[12 * yearOffset + monthOffset]`(5147b944d115) — 나눗셈/삼항/
// 콜 등은 wild 근거가 없어 미포함, C283 큐레이션 원칙). 이 형태는 값이 chart-컨텍스트 스칼라
// (매개변수는 JS 함수 인자로 읽기 지점에 실존)라 HTF-컨텍스트 민감 표현식(bar series/ta.* — TV는
// expression 전체를 HTF 문맥에서 평가)이 구조적으로 섞일 수 없어 읽기-지점 평가가 TV와 정합한다.
function isSecurityUdfScopeOffsetExpr(node: Expr, paramNames: readonly string[]): boolean {
  switch (node.kind) {
    case "NumberLiteral":
      return true;
    case "Identifier":
      return paramNames.includes(node.name);
    case "UnaryOp":
      return node.op === "-" && isSecurityUdfScopeOffsetExpr(node.operand, paramNames);
    case "BinOp":
      return (
        (node.op === "+" || node.op === "-" || node.op === "*") &&
        isSecurityUdfScopeOffsetExpr(node.left, paramNames) &&
        isSecurityUdfScopeOffsetExpr(node.right, paramNames)
      );
    default:
      return false;
  }
}

// request.security expression 좁은 문법 거부 에러(단일 발신 지점 — C453부터 인라인 경로와 지연
// 처리 경로(processPendingSecurityParamExprs)가 같은 메시지를 공유한다. 문구는 기존 테스트가
// 매칭하는 문자열이므로 바꾸지 말 것).
function pushSecurityExprUnsupportedError(prog: AnalyzedProgram, expr: CallExpr): void {
  prog.errors.push(
    `'request.security' 'expression' argument only supports bare/derived series ('open'/'high'/'low'/'close'/'volume'/'hl2'/'hlc3'/'ohlc4'/'hlcc4')·TV built-in bar variables ('time'/'time_close'/'bar_index')·number/boolean/na literals·arithmetic (+ - * /)·integer-literal history ('close[1]'/'ta.sma(close,10)[1]' — any valid subexpression)·comparison (</>/<=/>=/==/!=)·logical (and/or/not)·ternary ('cond ? a : b' — in value/offset position)·ta.* calls (multiple/nested allowed)·nz() calls (1~2 positional arguments)·na() calls (1 argument)·fixnan() calls (1 argument)·math.* calls (positional only, abs/round/max/min/avg/floor/ceil/sqrt/pow/log/log10/exp/sign/trig·inverse trig/atan2/todegrees/toradians/round_to_mintick)·substitution of a globally unique top-level '=' variable (when its value fits this grammar, including input.int/float/bool scalar constants) — request.*/strategy.*/UDF calls·multi-return TA·':=' reassigned variables are not implemented (L${expr.line}:${expr.col})`,
  );
}

// funcName: 이 root가 물리적으로 위치한 UDF 이름(scope.func?.name — top-level이면 null). C452의
// UDF 매개변수 단일 콜사이트 치환(buildSecurityExprNode Identifier case)이 소비한다.
// outerSymbol/outerTf(C616, chained-security-var): 지금 빌드 중인 이 request.security 콜 자신의
// symbol/tf 인자 — buildSecurityExprNode Identifier case가 치환 대상 top-level 변수의 정의 자체가
// request.security(...) 콜일 때(변수 경유 간접 nested-security) 이 값과 AST 구조적으로 비교해
// "안전 투과" 여부를 판정한다. 값을 모르는 호출부(비교 불필요)는 null로 생략 가능.
// C738(배치37 (3) series-arg VAR_DECL 축): top-level `var` 상태 변수 리플레이 슬라이스의 빌드
// 컨텍스트 — buildSecurityExpr(top-level 루트, funcName===null)에서만 활성화되는 모듈 상태
// (withSecuritySessionFold C735와 동일한 "동기 단일 스레드 opt-in 스코프" 패턴 — 파라미터 스레딩
// 대신 모듈 상태를 쓰는 이유도 동일: buildSecurityExprNode의 ~50개 재귀 호출부를 전부 건드리지
// 않기 위함). 슬라이스 빌드 실패 시 null로 되돌려 기존 경로(closure 이름이 실제로 도달하면 기존
// 하드 에러) 그대로 폴백한다 — 순수 추가.
interface SecurityVarSliceBuildCtx {
  closure: Set<string>; // 슬라이스에 편입된 top-level var 이름들(참조 폐쇄, 고정)
  writeLines: Map<string, number[]>; // closure var -> 전체 ':=' 라인(치환 위치-안전성 검사)
  shadowFuncs: Map<string, Set<string>>; // closure var -> 동명 로컬/매개변수를 가진 함수들
  // '=' 치환 위치-안전성: 치환된 정의식이 closure var를 직접 참조하면, 정의 라인과 사용 라인
  // 사이에 그 var의 ':='가 하나라도 있으면 값이 달라진다(정의식은 원래 자기 라인에서 평가됨).
  // useLine은 "지금 빌드 중인 표현식이 소스에서 평가되는 라인"(슬라이스 항목은 그 문장 라인,
  // body는 security 콜 라인) — uniqueTopEqVars 치환 하강 시 def.line으로 갈아탄다(중첩 치환은
  // 각 홉이 자기 구간만 검사하면 충분).
  useLine: number;
  readCount: number; // closure var 읽기 횟수(IndexAccess obj/튜플 인자 등 금지 위치 검출용)
  bodyPhase: boolean; // true면 지금 body(root) 빌드 중 — bodyUsed 판정용
  bodyUsed: boolean; // body가 closure var를 실제로 읽었는가(false면 슬라이스 통째로 폐기)
}
let secVarSliceCtx: SecurityVarSliceBuildCtx | null = null;

// 슬라이스 후보 참조 폐쇄(phase A) — root 표현식에서 시작해 (a) topVarSliceCandidates 이름은
// closure에 편입하고 그 선언 초기식+':=' 문장 서브트리를 재귀 스캔, (b) uniqueTopEqVars/함수-로컬
// '=' 이름은 정의식을 재귀 스캔(치환이 그 서브트리를 끌어들이므로)한다. 스캔은 빌더가 실제로
// 방문하는 것보다 과대(프루닝될 분기 포함)여도 안전하다 — 편입된 var가 빌드 불가면 슬라이스
// 전체가 폴백할 뿐이고, body가 실제로 안 읽으면 폐기된다(bodyUsed).
function discoverSecurityVarSliceClosure(root: Expr, prog: AnalyzedProgram): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [];
  const scannedEq = new Set<string>();
  const scanNames = (names: Set<string>): void => {
    for (const n of names) {
      if (closure.has(n)) continue;
      if (prog.topVarSliceCandidates.has(n)) {
        closure.add(n);
        queue.push(n);
        continue;
      }
      const eqDef = prog.uniqueTopEqVars.get(n);
      if (eqDef !== undefined && !scannedEq.has(n)) {
        scannedEq.add(n);
        const sub = new Set<string>();
        collectSecurityExprIdentNames(eqDef.value, sub);
        scanNames(sub);
      }
    }
  };
  const scanStmt = (stmt: Stmt, out: Set<string>): void => {
    if (stmt.kind === "Assignment") {
      collectSecurityExprIdentNames(stmt.value, out);
      return;
    }
    if (stmt.kind === "IfStmt") {
      collectSecurityExprIdentNames(stmt.condition, out);
      for (const s of stmt.thenBody) scanStmt(s, out);
      for (const c of stmt.elifClauses) {
        collectSecurityExprIdentNames(c.condition, out);
        for (const s of c.body) scanStmt(s, out);
      }
      if (stmt.elseBody !== null) for (const s of stmt.elseBody) scanStmt(s, out);
    }
    // 그 외 문장 종류는 phase B가 어차피 스킵/거부 — 스캔 불필요.
  };
  const rootNames = new Set<string>();
  collectSecurityExprIdentNames(root, rootNames);
  scanNames(rootNames);
  while (queue.length > 0) {
    const v = queue.pop()!;
    const cand = prog.topVarSliceCandidates.get(v)!;
    const sub = new Set<string>();
    collectSecurityExprIdentNames(cand.value, sub);
    for (const st of cand.writeStmts) scanStmt(st, sub);
    scanNames(sub);
  }
  return closure;
}

// phase B: 고정된 closure로 슬라이스 문장들을 검증·빌드한다. 실패 시 null(호출부가 ctx를 비워
// 기존 경로로 폴백). 조건부 실행 위치(if 본문 값/elif·중첩 if 조건)는 새 ta 콜 등록을 금지한다 —
// 원본에선 매 바 무조건 평가되던 '=' 정의식의 ta 상태가, 치환 후 분기 선택된 행에서만 전진하면
// TV per-call 시맨틱(C64)과 어긋나는 조용한 상태 갭이 되기 때문(순수식은 어느 쪽이든 관측 동치).
function buildSecurityVarSlice(
  prog: AnalyzedProgram,
  callLine: number,
  taCalls: SecurityExprTaCallRef[],
  histReads: SecurityExprHistRead[],
  outerSymbol: Expr | null,
  outerTf: Expr | null,
): SecurityVarSlice | null {
  const ctx = secVarSliceCtx!;
  const buildAt = (value: Expr, line: number, conditional: boolean): Expr | null => {
    ctx.useLine = line;
    const taBefore = taCalls.length;
    // C741: inSubst=true — 슬라이스에 실리는 노드(선언 초기식/':=' 값/if 조건)는 전부 콜보다 소스
    // 앞의 top-level 문장 유래라(cand.line/writeLines < callLine 게이트) 메인 패스 analyzeExpr를
    // 이미 거쳤다 — input 콜 리프의 builtinCalls 등록이 보장되는 "치환 경로" 안전 근거(C516의
    // "top-level '=' 변수 값과 동일 근거")가 그대로 성립한다. inSubst=false였던 동안 `var p =
    // input.int(...)` init이 위치인자 폼조차 거부되던 갭(LIMITATIONS C738(e)의 "kwarg 한정" 서술은
    // 과소기술이었음, wild bc4a6d1b2c8b 실측).
    const built = buildSecurityExprNode(value, prog, callLine, new Set(), taCalls, true, true, histReads, false, null, null, false, outerSymbol, outerTf);
    if (built === null) return null;
    if (conditional && taCalls.length > taBefore) return null;
    return built;
  };
  const buildBody = (body: Stmt[]): SecurityVarSliceStmt[] | null => {
    const out: SecurityVarSliceStmt[] = [];
    for (const s of body) {
      if (s.kind === "Assignment" && s.operator === ":=" && ctx.closure.has(s.name)) {
        const value = buildAt(s.value, s.line, true);
        if (value === null) return null;
        out.push({ kind: "assign", name: s.name, value });
        continue;
      }
      if (!stmtContainsClosureWrite(s, ctx.closure)) continue; // 슬라이스와 무관한 문장 — 스킵
      if (s.kind !== "IfStmt") return null; // closure 갱신을 품은 다른 종류(중첩 '=' 등) — 미지원
      const built = buildIf(s);
      if (built === null) return null;
      out.push(built);
    }
    return out;
  };
  const buildIf = (stmt: IfStmt, topLevelCond: boolean = false): SecurityVarSliceStmt | null => {
    // top-level if의 조건만 무조건 평가 위치(ta 허용) — elif/중첩 if 조건은 앞 조건이 거짓/참일
    // 때만 평가되는 조건부 위치다(Pine if 시맨틱과 JS if 방출이 정확히 동형).
    const cond = buildAt(stmt.condition, stmt.line, !topLevelCond);
    if (cond === null) return null;
    const then = buildBody(stmt.thenBody);
    if (then === null) return null;
    const elifs: { cond: Expr; body: SecurityVarSliceStmt[] }[] = [];
    for (const c of stmt.elifClauses) {
      const ec = buildAt(c.condition, stmt.line, true);
      if (ec === null) return null;
      const eb = buildBody(c.body);
      if (eb === null) return null;
      elifs.push({ cond: ec, body: eb });
    }
    let els: SecurityVarSliceStmt[] | null = null;
    if (stmt.elseBody !== null) {
      els = buildBody(stmt.elseBody);
      if (els === null) return null;
    }
    return { kind: "if", cond, then, elifs, els };
  };
  const items: SecurityVarSliceItem[] = [];
  const stmtSet = new Set<Stmt>();
  for (const v of ctx.closure) {
    const cand = prog.topVarSliceCandidates.get(v);
    if (cand === undefined) return null;
    // 선언·모든 갱신이 콜보다 소스에서 앞서야 한다 — 샘플 시점(콜 위치)이 모든 슬라이스 문장
    // 뒤에 오는 방출 구조(문장들 → out[h])와 원본 실행 순서가 일치하는 조건.
    if (cand.line >= callLine) return null;
    for (const wl of cand.writeLines) if (wl >= callLine) return null;
    const init = buildAt(cand.value, cand.line, false);
    if (init === null) return null;
    items.push({ line: cand.line, kind: "init", name: v, value: init });
    for (const ws of cand.writeStmts) stmtSet.add(ws);
  }
  for (const st of stmtSet) {
    if (st.kind === "Assignment" && st.operator === ":=" && ctx.closure.has(st.name)) {
      // top-level bare ':=' — 무조건 실행 위치(ta 허용).
      const value = buildAt(st.value, st.line, false);
      if (value === null) return null;
      items.push({ line: st.line, kind: "stmt", stmt: { kind: "assign", name: st.name, value } });
      continue;
    }
    if (st.kind !== "IfStmt") return null;
    const built = buildIf(st, true);
    if (built === null) return null;
    items.push({ line: st.line, kind: "stmt", stmt: built });
  }
  items.sort((a, b) => a.line - b.line);
  return { varNames: [...ctx.closure], items };
}

function stmtContainsClosureWrite(stmt: Stmt, closure: ReadonlySet<string>): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const node = n as { kind?: string; operator?: string; name?: string } & Record<string, unknown>;
    if (node.kind === "Assignment" && node.operator === ":=" && node.name !== undefined && closure.has(node.name)) {
      found = true;
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === "line" || k === "col") continue;
      walk(node[k]);
    }
  };
  walk(stmt);
  return found;
}

function buildSecurityExpr(
  root: Expr,
  prog: AnalyzedProgram,
  callLine: number,
  funcName: string | null,
  outerSymbol: Expr | null = null,
  outerTf: Expr | null = null,
): SecurityExprBuild | null {
  const taCalls: SecurityExprTaCallRef[] = [];
  const histReads: SecurityExprHistRead[] = [];
  // C738: top-level 루트(funcName===null)에서만 var 슬라이스를 시도한다 — 콜이 UDF 본문 안이면
  // callLine(함수 본문 내 라인)과 top-level ':=' 라인의 순서 비교가 실행 순서를 뜻하지 않아
  // 위치-안전성 판정 자체가 성립하지 않는다(보수 거부, wild 대상 전량이 top-level 콜).
  if (funcName === null) {
    const closure = discoverSecurityVarSliceClosure(root, prog);
    if (closure.size > 0) {
      const ctx: SecurityVarSliceBuildCtx = {
        closure,
        writeLines: new Map([...closure].map((v) => [v, prog.topVarSliceCandidates.get(v)?.writeLines ?? []])),
        shadowFuncs: new Map([...closure].map((v) => [v, prog.topVarSliceCandidates.get(v)?.shadowFuncs ?? new Set()])),
        useLine: callLine,
        readCount: 0,
        bodyPhase: false,
        bodyUsed: false,
      };
      secVarSliceCtx = ctx;
      try {
        let varSlice = buildSecurityVarSlice(prog, callLine, taCalls, histReads, outerSymbol, outerTf);
        if (varSlice === null) {
          // 슬라이스 빌드 실패 — ctx를 비우고 기존 경로로 완전 폴백(closure 이름이 body에서
          // 실제로 도달하면 기존 하드 에러, 프루닝 등으로 도달 안 하면 기존 그대로 통과).
          secVarSliceCtx = null;
          taCalls.length = 0;
          histReads.length = 0;
        } else {
          ctx.bodyPhase = true;
          ctx.useLine = callLine;
        }
        const sliceTaEnd = taCalls.length;
        const sliceHistEnd = histReads.length;
        const bodyExpr = buildSecurityExprNode(root, prog, callLine, new Set(), taCalls, true, false, histReads, false, funcName, null, false, outerSymbol, outerTf);
        if (bodyExpr === null) return null;
        if (varSlice !== null && !ctx.bodyUsed) {
          // body가 closure var를 전혀 안 읽음(프루닝 등) — 슬라이스와 그 등록물을 통째로 폐기해
          // 기존 출력을 바이트 단위로 보존한다.
          taCalls.splice(0, sliceTaEnd);
          histReads.splice(0, sliceHistEnd);
          varSlice = null;
        }
        return { bodyExpr, taCalls, histReads, varSlice };
      } finally {
        secVarSliceCtx = null;
      }
    }
  }
  const bodyExpr = buildSecurityExprNode(root, prog, callLine, new Set(), taCalls, true, false, histReads, false, funcName, null, false, outerSymbol, outerTf);
  return bodyExpr === null ? null : { bodyExpr, taCalls, histReads, varSlice: null };
}

// C616(chained-security-var): resolveSecurityLeadArgs의 무음(no-error) 버전 — 아래 Identifier case가
// "이 값이 유효한 request.security 콜인가"를 투기적으로 확인할 때 쓴다. 원본은 실패 시 prog.errors에
// 진단을 push하는 부작용이 있어(그 콜 "자신"의 진단 목적) 재사용하면 이미 별도 top-level 대입문으로
// 정상 분석된 콜에 대해 같은 메시지가 중복 push될 위험이 있다 — 판정 실패는 조용히 null로 폴백
// (기존 거부 동작 그대로 유지)해야 한다.
function tryResolveSecurityLeadArgsQuiet(node: Expr): { symbolArg: Expr; tfArg: Expr; seriesArg: Expr } | null {
  if (node.kind !== "CallExpr") return null;
  const callee = node.callee;
  if (!(callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "request" && callee.attr === "security")) return null;
  const slots: (Expr | undefined)[] = [node.args[0], node.args[1], node.args[2]];
  for (const kw of node.kwargs) {
    const idx = SECURITY_LEAD_PARAM_NAMES.indexOf(kw.name as (typeof SECURITY_LEAD_PARAM_NAMES)[number]);
    if (idx === -1) continue;
    if (idx < node.args.length) return null;
    if (slots[idx] !== undefined) return null;
    slots[idx] = kw.value;
  }
  if (slots[0] === undefined || slots[1] === undefined || slots[2] === undefined) return null;
  return { symbolArg: slots[0], tfArg: slots[1], seriesArg: slots[2] };
}

// C616: symbol/tf 인자 AST 구조적 동치 비교 — line/col은 무시하고 그 외 전 필드가 재귀적으로 동일해야
// true(값이 우연히 같아도 소스 표현이 다르면 false — "같은 문법 그대로 재사용"만 안전 판정 대상이라는
// next_hint(C615) 취지에 정합, 값 동치가 아니라 구문 동치를 요구해 보수적으로 판정한다).
function astExprEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!astExprEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  keys.delete("line");
  keys.delete("col");
  for (const k of keys) {
    if (!astExprEqual(ao[k], bo[k])) return false;
  }
  return true;
}

// C441: bare/파생 시리즈(BAR_SERIES_NAMES/DERIVED_PRICE_NAMES) 5+4종과 동일 범주의 TV 내장
// bar-scoped 식별자(wild 실측 37건, "var-subst:undeclared" 오분류 버킷 — 진단 스크립트가 이
// 3종을 BAR_SERIES_NAMES에 없다는 이유로 "이름을 못 찾음"으로 잘못 라벨링했을 뿐, 실제로는 매
// 스크립트가 이 이름을 선언 없이 TV 내장 변수로 그대로 쓴 것). pine2py security.py
// _resolve_expression은 8종 OHLC(V) identity만 다루고 time/time_close/bar_index 분기가 아예 없어
// (analyzer.ts BAR_INDEX_NAME/TIME_VAR_NAMES 주석과 동일한 "오라클 구조적 불가" 축, C176류) 순수
// hand-verified 신규 설계 — HTF 바의 open 시각/근사 close 시각/HTF 시퀀스 내 0-based 위치로 매핑
// (runtime/security.ts SecurityCache.timeOpen/timeClose·SecurityField 'bar_index' 주석 참조).
// TV 미검증(가설), DIVERGENCES 등재. 히스토리 인덱스([n])는 wild 근거 0건이라 미지원 유지(아래
// IndexAccess case가 이 세트를 참조하지 않아 bare 식과 달리 자동으로 "미지원" 에러 경로를 탄다).
// "bar_index" 리터럴(analyzer.ts BAR_INDEX_NAME과 같은 값) — 그 상수를 여기서 직접 import하면
// analyzer.ts <-> call-expr.ts 순환 import 사이에서 모듈 최상위 Set 리터럴이 TDZ로 깨진다(실측
// 발견 — 기존 BAR_SERIES_NAMES/DERIVED_PRICE_NAMES는 함수 본문 안에서만 참조돼 이 문제가 없었다).
const SECURITY_EXPR_TIME_BAR_NAMES: ReadonlySet<string> = new Set(["time", "time_close", "bar_index"]);

const SECURITY_INPUT_SCALAR_METHODS: ReadonlySet<string> = new Set(["int", "float", "bool"]);

function isSecurityScalarLiteral(node: Expr): boolean {
  return (
    node.kind === "NumberLiteral" ||
    node.kind === "BoolLiteral" ||
    (node.kind === "UnaryOp" && node.op === "-" && node.operand.kind === "NumberLiteral")
  );
}

// input 콜이 "스칼라 상수" 항으로 치환 가능한가 — defval(위치 0)이 숫자/불리언 리터럴이고, 값이
// 실제로 방출 코드에 실리는 인자/kwarg는 전부 리터럴이어야 한다(프리패스는 바 루프 밖 1회 평가라
// 바 종속 값·'=' 로컬 참조가 끼면 방출 코드가 ReferenceError로 깨짐). "방출되는가"의 기준은
// codegen(genCallExpr input 분기)과 정확히 동일하게 잡는다: 그 method의 위치 슬롯 표
// (INPUT_PARAM_NAMES)에 있는 이름이면서 INPUT_DISCARD_SLOT_NAMES(값이 항상 "undefined"로
// 대체)가 아닌 kwarg만 값이 실린다 — 표 밖의 순수 메타 kwarg(group=/confirm= 등)와 discard
// 슬롯(tooltip=/inline= 등)은 값이 아예 방출되지 않아 변수여도 무관하다(wild 관용구
// `input.int(200, "T", group = g1)` — 실측 42파일 회수분의 주 원인). 주의: INPUT_META_KWARG_NAMES는
// 이 판정에 못 쓴다 — C349가 bare-input용으로 넣은 minval/maxval/step이 input.int/float에서는
// 진짜 방출 슬롯이라 그 집합 기준 면제는 조용한 ReferenceError가 된다(구현 중 실측 발견).
// input.source(defval이 series)/input.string/timeframe 등은 여기서 자연히 걸러진다. 값은 런타임에
// rt.input.*($.inputs, ...)로 재평가되므로 입력 오버라이드도 그대로 반영된다 — HTF 집계 tf가
// 트랜스파일 시점에 고정되는 C366(가드 필요)과 달리 가드 불필요.
// C438: defval은 위치 0 또는 'defval=' 키워드 폼 둘 다 허용(C435 resolveConstStringExpr의 "위치
// 우선, kwarg 폴백" 원칙 재사용, wild 실측 `input.int(defval = 200, title = "T")`) — 일반(비-security)
// codegen이 이미 kwarg-only defval을 정상 처리함을 실측 확인(genCallExpr가 위치/키워드를 구분 없이
// 슬롯에 채움), kwargs.every 루프가 'defval' kwarg 자신의 리터럴 여부도 이미 검증하므로 이 게이트는
// 진입 가드만 완화하면 된다.
function isSecurityScalarConstInputCall(node: CallExpr): boolean {
  const callee = node.callee;
  const isScalarMethod =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "input" &&
    SECURITY_INPUT_SCALAR_METHODS.has(callee.attr);
  const isBare = callee.kind === "Identifier" && callee.name === "input";
  if (!isScalarMethod && !isBare) return false;
  const defval = node.args[0] ?? node.kwargs.find((kw) => kw.name === "defval")?.value;
  if (defval === undefined || !isSecurityScalarLiteral(defval)) return false;
  const literalish = (v: Expr): boolean => isSecurityScalarLiteral(v) || v.kind === "StringLiteral";
  const method = callee.kind === "DotAccess" ? callee.attr : "any";
  const paramNames = INPUT_PARAM_NAMES[method] ?? [];
  return (
    node.args.every(literalish) &&
    node.kwargs.every(
      (kw) =>
        INPUT_DISCARD_SLOT_NAMES.has(kw.name) || !paramNames.includes(kw.name) || literalish(kw.value),
    )
  );
}

// C603(배치31 (f)): input.string() — '=='/'!=' 피연산자 위치 전용 string 상수 항.
// int/float/bool(isSecurityScalarConstInputCall)과 같은 "원본 노드 보존(builtinCalls 등록 재사용,
// rt.input.string 재평가로 입력 오버라이드 반영) + 방출 슬롯 전-리터럴" 계약이지만, 값 타입이
// string이라 SECURITY_INPUT_SCALAR_METHODS에 합류시킬 수 없다 — 그 집합은 root/삼항 분기 등
// "값 위치"에서도 통과해 Float64Array 캐시가 문자열을 Number() 강제변환으로 조용히 NaN 부식시킨다
// (C602 StringLiteral 위치 제약과 동일 위험 클래스). 대신 buildSecurityExprNode의 allowString
// 위치 플래그(BinOp '=='/'!=' case만 자신의 두 피연산자 재귀에 켬, Identifier 치환 재귀만 상속)가
// 이 게이트를 소비한다. defval은 위치 0 또는 'defval=' kwarg 폼(C438 원칙 재사용, wild 실측
// d50dfbd3dd99.pine `input.string(title="...", defval="EMA", ...)`). 방출 판정 기준은
// isSecurityScalarConstInputCall과 동일(INPUT_PARAM_NAMES × INPUT_DISCARD_SLOT_NAMES — string의
// options/tooltip/inline/group은 전부 discard 슬롯이라 codegen이 항상 "undefined"로 방출, 비리터럴
// group 변수/배열 options kwarg는 값이 안 실려 무관: wild 13d402d29c9c.pine `input.string("SMA",
// title="MA Type", options=["SMA","EMA"], group=grpMA)`).
function isSecurityConstStringInputCall(node: CallExpr): boolean {
  const callee = node.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier" || callee.obj.name !== "input" || callee.attr !== "string") return false;
  const defval = node.args[0] ?? node.kwargs.find((kw) => kw.name === "defval")?.value;
  if (defval === undefined || defval.kind !== "StringLiteral") return false;
  const literalish = (v: Expr): boolean => isSecurityScalarLiteral(v) || v.kind === "StringLiteral";
  const paramNames = INPUT_PARAM_NAMES["string"]!;
  return (
    node.args.every(literalish) &&
    node.kwargs.every(
      (kw) => INPUT_DISCARD_SLOT_NAMES.has(kw.name) || !paramNames.includes(kw.name) || literalish(kw.value),
    )
  );
}

// C734: 순수 문자열 컴파일타임 상수 리졸버 — resolveSecurityTfLiteral의 tf 전용 부작용
// (NaLiteral→"D" 정규화, constStringVars 경유 시 securityTfConstGuards 등록)이 없는 판.
// title 등 "tf가 아닌 문자열 슬롯" 폴딩 전용이라 리터럴/'+' 결합/'=' 상수 식별자 체인만 인정하고
// input 콜(오버라이드 채널)·timeframe.*(chartTf 의존)은 CallExpr/DotAccess 미처리로 자연 배제.
// Identifier 조회 체인(funcLocalUniqueEqVars 우선 → constVarShadowFuncs 가드 → uniqueTopEqVars,
// 선언-후-사용 line 검사 + visiting 사이클 가드)은 resolveSecurityNumericConst와 동일 관례(C665).
function resolveSecurityPlainStringConst(
  expr: Expr,
  prog: AnalyzedProgram,
  visiting: Set<string>,
  funcName: string | null,
): string | undefined {
  if (expr.kind === "StringLiteral") return expr.value;
  if (expr.kind === "BinOp" && expr.op === "+") {
    const left = resolveSecurityPlainStringConst(expr.left, prog, visiting, funcName);
    if (left === undefined) return undefined;
    const right = resolveSecurityPlainStringConst(expr.right, prog, visiting, funcName);
    return right === undefined ? undefined : left + right;
  }
  if (expr.kind === "Identifier") {
    if (visiting.has(expr.name)) return undefined;
    if (funcName !== null) {
      const localDef = prog.funcLocalUniqueEqVars.get(funcName)?.get(expr.name);
      if (localDef !== undefined) {
        if (localDef.line >= expr.line) return undefined;
        visiting.add(expr.name);
        const result = resolveSecurityPlainStringConst(localDef.value, prog, visiting, funcName);
        visiting.delete(expr.name);
        return result;
      }
    }
    if (funcName !== null && prog.constVarShadowFuncs.get(expr.name)?.has(funcName)) return undefined;
    const def = prog.uniqueTopEqVars.get(expr.name);
    if (def === undefined || def.line >= expr.line) return undefined;
    visiting.add(expr.name);
    const result = resolveSecurityPlainStringConst(def.value, prog, visiting, null);
    visiting.delete(expr.name);
    return result;
  }
  return undefined;
}

// C734: 방출 슬롯 비리터럴 컴파일타임 상수 폴딩 클론 — isSecurityScalarConstInputCall/
// isSecurityConstStringInputCall(위 형제쌍)이 "방출 슬롯 전-리터럴"만 통과시키던 것을, 값이
// 컴파일타임 상수로 확정되는 식별자/문자열 결합/상수 산술이면 리터럴로 접은 클론으로 통과시킨다
// (wild STILL_NONE 재분류 실측: `input.int(DEF, "T", minval=MINV, group=g)` defval/minval 위치
// top-level '=' 상수 식별자(7dd531b1cffd), `input.int(defval=300, title=ind4+"Length", ...)`
// title 문자열 결합(6e8eb2f215d2/c74f5f840079)). 원본 노드는 per-bar 위치에서 기존대로 방출되고
// (클론이라 불변), 프리앰블 방출은 접힌 리터럴이라 자기완결(C598 ReferenceError 클래스 원천 차단).
// 값 보존 논거: 접는 대상이 전부 ':='-프리 컴파일타임 상수라 per-bar 평가와 동일 값이며, input
// 콜 자신은 원형(rt.input.*) 그대로 보존돼 런타임 오버라이드 채널도 불변. bool 폴딩은 wild 근거가
// 없고 resolveSecurityTfTernaryCondition이 input.bool 오버라이드 가드를 등록하는 부작용이 있어
// 의도적으로 미포함(숫자/문자열 리졸버는 가드 등록 지점이 없어 부작용 0). 등록명은 원본 노드의
// builtinCalls 등록(analyzeInputCall이 arity/kwarg 검증 완료)을 그대로 복사 — 등록이 없으면
// 이 콜은 정상 분석 경로를 거치지 않은 것이므로 폴딩을 포기한다(보수 원칙).
function buildSecurityConstFoldedInputCallClone(
  node: CallExpr,
  prog: AnalyzedProgram,
  funcName: string | null,
  wantString: boolean,
): CallExpr | null {
  const regName = prog.builtinCalls.get(node);
  if (regName === undefined || !regName.startsWith("input.")) return null;
  const method = regName.slice("input.".length);
  if (wantString ? method !== "string" : !SECURITY_INPUT_SCALAR_METHODS.has(method) && method !== "any") return null;
  const paramNames = INPUT_PARAM_NAMES[method] ?? [];
  const foldSlot = (v: Expr): Expr | null => {
    if (isSecurityScalarLiteral(v) || v.kind === "StringLiteral") return v;
    const str = resolveSecurityPlainStringConst(v, prog, new Set(), funcName);
    if (str !== undefined) {
      const synth: StringLiteral = { kind: "StringLiteral", value: str, line: v.line, col: v.col };
      return synth;
    }
    const num = resolveSecurityNumericConst(v, prog, new Set(), null, funcName);
    if (num !== undefined && !Number.isNaN(num)) {
      // raw는 codegen genExpr가 그대로 방출하는 JS 리터럴 텍스트 — String(num)은 음수("-2")/지수
      // 표기("1e-7") 모두 인자 위치에서 유효한 JS 식이다.
      const synth: NumberLiteral = { kind: "NumberLiteral", value: num, raw: String(num), line: v.line, col: v.col };
      return synth;
    }
    return null;
  };
  let changed = false;
  const args: Expr[] = [];
  for (let i = 0; i < node.args.length; i++) {
    const orig = node.args[i]!;
    const slotName = paramNames[i];
    // arity 초과는 analyzeInputCall이 이미 하드 에러 — 여기 도달하면 비정상 경로라 방어적 포기.
    if (slotName === undefined) return null;
    // discard 슬롯 위치 인자는 codegen이 항상 "undefined"로 대체해 값이 방출되지 않는다 — 원형 유지.
    if (INPUT_DISCARD_SLOT_NAMES.has(slotName)) {
      args.push(orig);
      continue;
    }
    const folded = foldSlot(orig);
    if (folded === null) return null;
    if (folded !== orig) changed = true;
    args.push(folded);
  }
  const kwargs: CallKwarg[] = [];
  for (const kw of node.kwargs) {
    // 방출 판정은 형제 predicate와 동일 기준: discard 슬롯/표 밖 메타 kwarg는 값이 안 실린다.
    if (INPUT_DISCARD_SLOT_NAMES.has(kw.name) || !paramNames.includes(kw.name)) {
      kwargs.push(kw);
      continue;
    }
    const folded = foldSlot(kw.value);
    if (folded === null) return null;
    if (folded !== kw.value) changed = true;
    kwargs.push(folded === kw.value ? kw : { name: kw.name, value: folded, line: kw.line, col: kw.col });
  }
  // 전-리터럴이면 형제 predicate가 이미 처리했을 경로 — 클론 낭비 없이 포기(방어).
  if (!changed) return null;
  // defval 타입 규율은 형제 predicate 그대로, 단 "접힌 뒤" 기준으로 판정 — 스칼라 변형은 숫자/불리언
  // 리터럴(bare input의 문자열 defval이 값 위치로 새는 Float64Array 부식 차단 유지), string 변형은
  // StringLiteral('=='/'!=' 피연산자 위치 전용, allowString 게이트는 호출부가 건다).
  const defval = args[0] ?? kwargs.find((kw) => kw.name === "defval")?.value;
  if (defval === undefined) return null;
  if (wantString ? defval.kind !== "StringLiteral" : !isSecurityScalarLiteral(defval)) return null;
  const clone: CallExpr = { kind: "CallExpr", callee: node.callee, args, kwargs, line: node.line, col: node.col };
  prog.builtinCalls.set(clone, regName);
  return clone;
}

// C734(후속): securityTfConstGuards 가드 방출용 input 콜의 방출 슬롯 best-effort 폴딩 —
// LIMITATIONS C598이 "별도 축"으로 남겨뒀던 갭(가드 방출이 genExpr 재사용이라 title 위치
// '=' 상수 식별자/문자열 결합이 프리앰블 스코프에 없어 ReferenceError)의 폴딩판 해소. 위
// buildSecurityConstFoldedInputCallClone과 달리 (a) 전 input method 허용(tf/bool 가드 대상엔
// timeframe/string/bool/bare 모두 옴), (b) 슬롯별 best-effort(폴딩 실패 슬롯은 원형 유지 —
// timeframe.* DotAccess defval처럼 이미 방출-안전한 값을 건드리지 않고, 진짜 동적 값이 남는
// 기존 크래시 클래스는 현행 유지. 폴딩 거부로 바꾸면 현행 transpile-ok 파일이 역행한다는
// C598 주석의 결정 그대로), (c) defval 타입 게이트 없음(가드는 결과를 저장된 리터럴과 비교만
// 하는 boolean 문맥이라 값-위치 부식 클래스가 성립 안 함). 변경이 없으면 원본을 그대로 돌려줘
// 기존 방출 바이트 불변.
function foldSecurityGuardInputCallSlots(call: CallExpr, prog: AnalyzedProgram): CallExpr {
  const regName = prog.builtinCalls.get(call);
  if (regName === undefined || !regName.startsWith("input.")) return call;
  const method = regName.slice("input.".length);
  const paramNames = INPUT_PARAM_NAMES[method] ?? [];
  // 가드 인풋 콜은 constStringVars/uniqueTopEqVars 경유 top-level 정의값이라 식별자 해석은 항상
  // top-level 스코프(funcName=null) — resolveSecurityPlainStringConst 주석의 C665 관례와 동일.
  const tryFold = (v: Expr): Expr | null => {
    if (isSecurityScalarLiteral(v) || v.kind === "StringLiteral") return null;
    const str = resolveSecurityPlainStringConst(v, prog, new Set(), null);
    if (str !== undefined) {
      const synth: StringLiteral = { kind: "StringLiteral", value: str, line: v.line, col: v.col };
      return synth;
    }
    const num = resolveSecurityNumericConst(v, prog, new Set(), null, null);
    if (num !== undefined && !Number.isNaN(num)) {
      const synth: NumberLiteral = { kind: "NumberLiteral", value: num, raw: String(num), line: v.line, col: v.col };
      return synth;
    }
    return null;
  };
  let changed = false;
  const args = call.args.map((a, i) => {
    const slotName = paramNames[i];
    if (slotName === undefined || INPUT_DISCARD_SLOT_NAMES.has(slotName)) return a;
    const folded = tryFold(a);
    if (folded === null) return a;
    changed = true;
    return folded;
  });
  const kwargs = call.kwargs.map((kw): CallKwarg => {
    if (INPUT_DISCARD_SLOT_NAMES.has(kw.name) || !paramNames.includes(kw.name)) return kw;
    const folded = tryFold(kw.value);
    if (folded === null) return kw;
    changed = true;
    return { name: kw.name, value: folded, line: kw.line, col: kw.col };
  });
  if (!changed) return call;
  const clone: CallExpr = { kind: "CallExpr", callee: call.callee, args, kwargs, line: call.line, col: call.col };
  prog.builtinCalls.set(clone, regName);
  return clone;
}

// C438: input.source(defval, ...) 치환 — pine2py wavealgo/builtins/input_funcs.py
// source_input(defval, title, **kwargs)는 title/kwargs를 전부 무시하고 defval을 그대로 반환하는
// 순수 identity 함수임을 python 직접 실행으로 확인(`source_input(close,'Source') is close` == True).
// int/float/bool(위 isSecurityScalarConstInputCall)과 달리 이 콜은 "원본 CallExpr 노드를 보존"할
// 필요가 전혀 없다 — 그 값 자체가 defval과 동일하므로, defval 서브트리를 이 좁은 문법으로 재귀
// 빌드해 그 결과로 완전히 대체한다(title/kwargs는 버림). wild 실측(scratch/c438_ta_call_arg_probe.mjs)
// 결과 defval은 전부 bare/파생 시리즈 식별자(close/hl2/hlc3/ohlc4 등, 이미 이 문법이 지원하는 leaf)
// 였다 — 원본 노드를 안 남기므로 builtinCalls 등록 여부와 무관해 inSubst 게이트도 불필요(인라인/치환
// 양쪽 다 안전, isSecurityScalarConstInputCall의 "인라인은 등록 없어 크래시" 제약이 적용되지 않음).
// C440: bare input(defval, ...)(namespace 없는 일반 오버로드)도 pine2py wavealgo/builtins/
// input_funcs.py any_input(defval, title, **kwargs)가 `return defval`뿐인 동일한 identity 함수임을
// 확인(python 직접 실행 불필요 — 소스가 title/kwargs를 아예 안 건드리는 한 줄 return이라 자명).
// wild 재프로브(scratch/c438_ta_call_arg_probe.mjs, next_hint(C439))가 "var-subst:eq-value:
// udf-call(bare)"로 잘못 분류했던 9건 전량이 실제로는 진짜 UDF가 아니라 이 bare input(series
// defval)이었다(classifyTop이 namespace 없는 모든 CallExpr을 UDF로 뭉뚱그려 오분류 — C438이 이미
// 남긴 "진단 프로브 버킷 카운트를 액면대로 믿지 말 것" 교훈의 재발현). defval이 스칼라 리터럴이면
// isSecurityScalarConstInputCall 경로(원본 노드 보존 + rt.input.*로 입력 오버라이드 유지)를 그대로
// 타야 하므로 이 함수는 그 경우 일부러 undefined를 반환해 자리를 비켜준다 — 안 그러면 이 함수가
// switch에서 먼저 걸려 원본 노드를 버리고 리터럴을 그대로 박아 넣어(override 불가능한 컴파일타임
// 상수화) 기존 동작을 조용히 퇴화시킨다.
function matchSecurityInputSourceDefval(node: CallExpr): Expr | undefined {
  const callee = node.callee;
  const isSource = callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "input" && callee.attr === "source";
  const isBare = callee.kind === "Identifier" && callee.name === "input";
  if (!isSource && !isBare) return undefined;
  const defval = node.args[0] ?? node.kwargs.find((kw) => kw.name === "defval")?.value;
  if (defval === undefined) return undefined;
  if (isBare && isSecurityScalarLiteral(defval)) return undefined;
  return defval;
}

// C601(배치31 (c)): 값위치 TernaryOp의 ta-콜 포함 분기를 eager 평가로 강제하는 래퍼 — 분기
// 서브트리를 offset-0 히스토리 버퍼(histReads/C370 fill 메커니즘 그대로)로 감싼다. 프리패스
// fill 문이 매 행(h) 분기식을 조건과 무관하게 정확히 1회 평가해(ta 상태 전진 — TV는 삼항
// 양쪽을 항상 평가, C66/VERIFIED_SEMANTICS CONFIRMED와 정합: "등록/전진은 무조건") 버퍼에
// 기록하고, 본식의 JS ?:는 그 행 버퍼만 조건부로 읽는다("값 소비만 분기"). genIndexAccess의
// 리터럴 버퍼 경로가 n=0에서 `(h >= 0 ? buf[h - 0] : NaN)`(항상 buf[h], 워밍업 가드 no-op)을
// 방출하므로 codegen 변경이 0줄이다. post-order push라 안쪽(분기 내부) 버퍼가 항상 앞 인덱스
// — fill이 이미 채워진 앞 버퍼만 읽는 기존 불변식 유지.
function wrapSecurityEagerBranch(built: Expr, histReads: SecurityExprHistRead[]): Expr {
  const zero: NumberLiteral = { kind: "NumberLiteral", value: 0, raw: "0", line: built.line, col: built.col };
  const clone: IndexAccess = { kind: "IndexAccess", obj: built, index: zero, line: built.line, col: built.col };
  histReads.push({ node: clone, obj: built });
  return clone;
}

// C732(배치37 (3) 2차 슬라이스): expression 인자 UDF 콜 인라인(C516)의 본문 값 확정 — 단일식
// 전용이던 것을 다문장/제어문-식 본문까지 확장한다. 선행 문장이 전부 '=' 로컬 선언일 때만(그 값
// 참조는 buildSecurityExprNode의 funcLocalUniqueEqVars 치환(C692)이 해소 — 여기서는 ':=' 대상
// 판정용으로 이름만 수집) 마지막 문장의 값을 돌려준다: ExprStmt/'=' 대입은 그 값, ':=' 재대입은
// 대상이 이 본문(또는 바깥 재귀 레벨)의 선행 '=' 로컬일 때만(암시 반환값 = 대입값, C608/
// DIVERGENCES #172와 동일 시맨틱 — top-level var ':='는 HTF 재평가 문맥의 전역 부작용이라 보수
// 거부. 대상 로컬은 재대입으로 funcLocalUniqueEqVars 미등재라 그 이름을 다시 읽는 값은 빌드가
// 자연 실패해 안전), SwitchStmt/IfStmt는 아래 분기 선택기로 위임. 그 외 종류(for/while/var 등
// 선행 문장 포함)는 undefined(보수 원칙 — 기존 하드 에러 유지). 선택되지 않은 분기의 선행 로컬에
// ta.* 콜이 있어도(죽은 로컬 포함) 등록 자체가 안 돼 상태가 전진하지 않는다 — 이 값이 소비되는
// HTF 프리패스 문맥에는 관측 채널이 결과값 하나뿐이라 관측 불가 차이다(C616 "독립 재계산 등가"와
// 동일 근거).
function resolveSecurityInlineBodyValueExpr(
  body: Stmt[],
  prog: AnalyzedProgram,
  constEnv: SecurityConstEnv,
  bodyFuncName: string | null,
  outerLocalNames: ReadonlySet<string>,
): Expr | undefined {
  if (body.length === 0) return undefined;
  const localNames = new Set(outerLocalNames);
  for (let i = 0; i < body.length - 1; i++) {
    const s = body[i]!;
    if (s.kind !== "Assignment" || s.operator !== "=") return undefined;
    localNames.add(s.name);
  }
  const last = body[body.length - 1]!;
  if (last.kind === "ExprStmt") return last.expr;
  if (last.kind === "Assignment") {
    if (last.operator === "=" || localNames.has(last.name)) return last.value;
    return undefined;
  }
  if (last.kind === "SwitchStmt") return selectSecurityInlineSwitchBranch(last, prog, constEnv, bodyFuncName, localNames);
  if (last.kind === "IfStmt") return selectSecurityInlineIfBranch(last, prog, constEnv, bodyFuncName, localNames);
  return undefined;
}

// C732: switch 분기 선택 — resolveSecuritySwitchConstValue(C515/C606)와 동일한 보수 순서(먼저 나온
// case의 라벨/조건이 하나라도 미확정이면 즉시 포기, 매치 없으면 default)를 그대로 따르되, 값을
// 상수로 폴딩하는 대신 선택된 case 본문의 "값 표현식"을 돌려줘 buildSecurityExprNode가 이어서
// 빌드하게 한다. subject/조건이 콜사이트 인자 유래 컴파일타임 상수(constEnv — input 유래는 기존
// constStringVars 경로가 securityTfConstGuards 오버라이드 throw 가드를 등록)로 확정되면 매 바 같은
// 분기만 실행되므로 미선택 분기의 ta.* 콜을 등록하지 않는 것이 TV per-call 전진(C64 CONFIRMED)과
// 정합 — C601 eager 래핑이 필요한 런타임 분기와 구조적으로 다르다. 매치 없고 default(bare '=>')도
// 없으면 TV switch-as-expression 시맨틱상 확정 na — 값 문맥이라 NaLiteral 합성(C528의 chartTf
// 정규화는 tf 문맥 전용이라 여기 해당 없음).
function selectSecurityInlineSwitchBranch(
  stmt: SwitchStmt,
  prog: AnalyzedProgram,
  constEnv: SecurityConstEnv,
  bodyFuncName: string | null,
  localNames: ReadonlySet<string>,
): Expr | undefined {
  const naFallback: Expr = { kind: "NaLiteral", line: stmt.line, col: stmt.col };
  if (stmt.subject === null) {
    // C606과 동일: 각 case가 자체 boolean 조건인 if-elif형 switch.
    for (const c of stmt.cases) {
      if (c.values === null) return resolveSecurityInlineBodyValueExpr(c.body, prog, constEnv, bodyFuncName, localNames);
      let matched = false;
      let unresolved = false;
      for (const v of c.values) {
        const cond = resolveSecurityTfTernaryCondition(v, prog, new Set(), constEnv, bodyFuncName);
        if (cond === true) {
          matched = true;
          break;
        }
        if (cond === undefined) unresolved = true;
      }
      if (matched) return resolveSecurityInlineBodyValueExpr(c.body, prog, constEnv, bodyFuncName, localNames);
      if (unresolved) return undefined;
    }
    return naFallback;
  }
  const subject = resolveSecurityConstValue(stmt.subject, prog, new Set(), constEnv, bodyFuncName);
  if (subject === undefined) return undefined;
  for (const c of stmt.cases) {
    if (c.values === null) continue;
    let unresolved = false;
    for (const v of c.values) {
      const cv = resolveSecurityConstValue(v, prog, new Set(), constEnv, bodyFuncName);
      if (cv === undefined) {
        unresolved = true;
        continue;
      }
      if (cv.kind === subject.kind && cv.value === subject.value)
        return resolveSecurityInlineBodyValueExpr(c.body, prog, constEnv, bodyFuncName, localNames);
    }
    if (unresolved) return undefined;
  }
  const def = stmt.cases.find((c) => c.values === null);
  if (def === undefined) return naFallback;
  return resolveSecurityInlineBodyValueExpr(def.body, prog, constEnv, bodyFuncName, localNames);
}

// C732: if 분기 선택 — resolveSecurityIfConstValue(C607)와 동일한 보수 순서(먼저 나온 조건이
// 미확정이면 즉시 포기). else 없는 비-완전 분기에서 전 조건이 확정 false면 TV if-식 시맨틱상
// 확정 na — 값 문맥이라 NaLiteral 합성(C607의 undefined 포기는 상수 폴딩이 na를 표현할 수 없던
// 제약이고, 이 트랙은 NaLiteral이 이미 지원 리프다).
function selectSecurityInlineIfBranch(
  stmt: IfStmt,
  prog: AnalyzedProgram,
  constEnv: SecurityConstEnv,
  bodyFuncName: string | null,
  localNames: ReadonlySet<string>,
): Expr | undefined {
  const cond = resolveSecurityTfTernaryCondition(stmt.condition, prog, new Set(), constEnv, bodyFuncName);
  if (cond === undefined) return undefined;
  if (cond) return resolveSecurityInlineBodyValueExpr(stmt.thenBody, prog, constEnv, bodyFuncName, localNames);
  for (const clause of stmt.elifClauses) {
    const c = resolveSecurityTfTernaryCondition(clause.condition, prog, new Set(), constEnv, bodyFuncName);
    if (c === undefined) return undefined;
    if (c) return resolveSecurityInlineBodyValueExpr(clause.body, prog, constEnv, bodyFuncName, localNames);
  }
  if (stmt.elseBody === null) return { kind: "NaLiteral", line: stmt.line, col: stmt.col };
  return resolveSecurityInlineBodyValueExpr(stmt.elseBody, prog, constEnv, bodyFuncName, localNames);
}

// C736(배치37 (3) series-arg tf.period 등식 폴딩): 삼항 조건이 `timeframe.period == "리터럴"`
// (또는 '!=', 피연산자 순서 무관) 꼴이면 요청 tf 컨텍스트에서 컴파일타임 판정한다 — TV
// request.security의 expression은 요청된 tf의 컨텍스트에서 평가되므로(C735 time 콜 tf 슬롯과 동일
// 컨텍스트 스위칭 근거) timeframe.period는 차트 tf가 아니라 "바깥 security 콜의 대상 tf"(outerTf)로
// 접는다. wild d44d2be59428: `size = timeframe.period=="1"?ta.sma(volume,4999)*...:
// timeframe.period=="5"?...:na` 후 `request.security("BTCUSDT","1",size)`/("...","5",size) —
// 폴딩이 각 콜사이트에서 참 분기 하나를 선택(프루닝)한다. 이 조건 꼴은 기존에 무조건 거부라
// (DotAccess case가 period를 배제 — 문자열이 Float64Array 캐시에 못 실림) 폴딩 실패(undefined) 시
// 동작 불변. 프루닝(미선택 분기 폐기)은 관측 동치 — 그 분기의 ta 콜 상태는 콜사이트별 독립
// 슬롯이고 값이 어디에도 안 실리므로 전진 생략이 밖에서 관측 불가(C730 tf-트랙 삼항 폴딩 프루닝과
// 동일 근거)이며, 오히려 미선택 분기가 이 좁은 문법 밖이어도 수용된다.
// 비교는 raw 문자열 등식이되 outerTf 리터럴이 "정규형"일 때만 판정한다 — TV timeframe.period는
// 정규형(배수 1의 S/D/W/M은 문자 단독, 분은 숫자만)으로 표기되므로 비정규형 요청("1D" 등)은 period
// 문자열("D")과 raw 비교가 어긋날 수 있다(security 컨텍스트의 period 정규화 여부는 TV 미검증 —
// 보수적으로 폴딩 자체를 거부해 기존 하드 에러 유지). main_period는 security 컨텍스트와 무관하게
// 차트 tf로 고정일 가능성이 있어 제외(period만 — C735 time 콜 tf 슬롯의 TIMEFRAME_STRING_PROPS
// 전체 허용과 의도적으로 다름). outerTf 해석은 C735와 동일하게 평문 resolveSecurityTfLiteral —
// withSecuritySessionFold 게이트를 켜지 않아 C730 런타임 tf 트랙(input 오버라이드 실값 반영)을
// 선점하지 않는다(MEMORY C735). NaLiteral→"D" 폴딩(C514)은 그대로 상속 — 이 엔진의 na-tf 집계
// 자체가 "D" 버킷이라 내부 일관.
const SECURITY_CANONICAL_TF_RE = /^(?:[1-9]\d*|[SDWM]|[1-9]\d*[SDWM])$/;
function isCanonicalSecurityTfEqString(tf: string): boolean {
  // "1D"/"1W"/"1M"/"1S"(배수 1 + 문자)는 비정규형 — TV period 표기("D" 등)와 raw 등식이 어긋날
  // 수 있어 제외. 배수>=2("2D"/"30S")·분 숫자("1"/"60")·문자 단독("D")은 정규형 그대로 판정.
  return SECURITY_CANONICAL_TF_RE.test(tf) && !/^1[SDWM]$/.test(tf);
}
function foldSecurityTfPeriodEqCondition(
  cond: Expr,
  prog: AnalyzedProgram,
  funcName: string | null,
  outerTf: Expr | null,
): boolean | undefined {
  if (outerTf === null) return undefined;
  if (cond.kind !== "BinOp" || (cond.op !== "==" && cond.op !== "!=")) return undefined;
  const isPeriod = (e: Expr): boolean =>
    e.kind === "DotAccess" && e.obj.kind === "Identifier" && e.obj.name === "timeframe" && e.attr === "period";
  let other: Expr;
  if (isPeriod(cond.left)) other = cond.right;
  else if (isPeriod(cond.right)) other = cond.left;
  else return undefined;
  // 비교 상대는 StringLiteral 직접 폼만(C283 큐레이션 — wild 실사용 전량이 이 폼). 변수/입력
  // 경유 폼은 폴딩 거부(undefined) → 기존 하드 에러 유지.
  if (other.kind !== "StringLiteral") return undefined;
  const outerLit = resolveSecurityTfLiteral(outerTf, prog, new Set(), null, funcName);
  if (outerLit === undefined || !isCanonicalSecurityTfEqString(outerLit)) return undefined;
  const eq = outerLit === other.value;
  return cond.op === "==" ? eq : !eq;
}

function buildSecurityExprNode(
  node: Expr,
  prog: AnalyzedProgram,
  callLine: number,
  visiting: Set<string>,
  taCalls: SecurityExprTaCallRef[],
  allowTa: boolean,
  inSubst: boolean,
  histReads: SecurityExprHistRead[],
  // C446: offset(IndexAccess.index) 위치 표시 — true면 그 위치의 삼항은 조건/분기 전부
  // allowTa=false(offsetCode 텍스트 중복 방출 위험 원천 차단)로 좁게 검증한다(아래 IndexAccess
  // case의 동적 오프셋 재귀 호출만 true를 넘긴다). C601(배치31 (c), Fable 감독 승인)부터 값
  // 위치(false)의 일반 삼항도 허용된다 — TernaryOp case 주석 참조. na 조건의 JS 네이티브 (B)
  // (false 분기) 동작은 메인 경로 삼항과 동일한 기존 divergence(VERIFIED_SEMANTICS OPEN 유지,
  // 새 추측 구현 아님)다.
  allowTernary: boolean = false,
  // C452: node가 물리적으로 속한 UDF 이름(top-level이면 null) — Identifier case의 UDF 매개변수
  // 단일 콜사이트 치환에만 쓰인다. 다른 모든 재귀 호출은 이 값을 그대로 물려줘야 한다(같은 함수
  // 본문 안에서 재귀 중이므로) — 오직 "치환"(top-level 유일 '=' 변수 값으로, 또는 유일 콜사이트의
  // 실인자로 갈아끼우는 두 지점)만 null로 리셋한다. 두 치환 대상 모두 top-level 콜사이트/대입문의
  // 값이라 그 서브트리 안의 추가 식별자는 더 이상 이 UDF의 매개변수일 수 없기 때문이다.
  funcName: string | null = null,
  // C516: 단일식 본문 UDF 콜 인라인 치환(C367(a) 잔여, "이 콜사이트"의 파라미터명 -> 실인자 Expr
  // 맵). funcName/prog.funcSingleCallSiteArgs(전역 유일 콜사이트)와 달리 이 값은 "지금 이 서브트리가
  // 어느 인라인된 함수의 본문 안에 있는가"를 나타내며 콜사이트별로 독립적이다(C452는 함수 전체에
  // 콜사이트가 1개뿐이어야 하지만, 이 메커니즘은 매 콜사이트마다 별도로 인라인되므로 다중
  // 콜사이트에도 각자 적용된다). 다른 모든 재귀 호출은 이 값을 그대로 물려줘야 한다 — 오직 (a)
  // 새 인라인 콜의 본문 진입(새 맵으로 교체) (b) 이 맵의 파라미터를 실인자로 치환(호출부 스코프로
  // 복귀하므로 null로 리셋) 두 지점만 예외. 중첩 인라인(치환된 본문 안에 또 다른 bare UDF 콜)은
  // 이번 슬라이스 범위 밖 — CallExpr case의 새 분기가 paramEnv!==null이면 인라인을 시도하지 않아
  // 자연히 미지원(기존 하드 에러)으로 떨어진다.
  // C731: 값을 Expr에서 SecurityParamEnvEntry로 확장 — entry.funcName은 그 실인자가 물리적으로
  // 속한 UDF 이름(top-level이면 null). 치환 시 funcName을 이 값으로 갈아탄다(아래 Identifier case
  // 주석 참조). C516 인라인은 콜사이트가 root와 같은 트리라 funcName 그대로를 담고, pending
  // in-func 콜사이트(processPendingSecurityParamExprs)는 site.inFuncName을 담는다.
  paramEnv: ReadonlyMap<string, SecurityParamEnvEntry> | null = null,
  // C603(배치31 (f)): "이 node의 값이 '=='/'!=' 피연산자로만 소비되는 위치인가" — BinOp equality
  // case만 자신의 두 피연산자 재귀에 true를 켜고, Identifier의 세 치환 재귀(paramEnv/uniqueTopEqVars/
  // 단일 콜사이트 매개변수)만 이 값을 상속한다(치환은 그 피연산자 자리를 통째로 갈아끼우는 것이라
  // 위치가 보존됨). 그 외 모든 재귀(산술/삼항 분기/오프셋/콜 인자)는 기본값 false — string 값이
  // Float64Array 캐시(out[h]/히스토리 버퍼)로 새는 것을 위치로 구조적 차단(C602 StringLiteral
  // 주석과 동일 위험 클래스). true인 위치는 genEquality가 결과를 boolean으로 좁혀 소비.
  allowString: boolean = false,
  // C616(chained-security-var): 지금 이 재귀 트리가 속한 "바깥" request.security 콜 자신의 symbol/tf
  // 인자(원본 AST, 컴파일타임 미확정이어도 무방 — astExprEqual은 값이 아니라 구문을 비교한다). 모든
  // 재귀 호출은 이 값을 그대로 물려준다(funcName/paramEnv와 달리 "치환/인라인 진입점"에서도 리셋
  // 없음 — 바깥 콜 자신은 서브트리 전체에서 하나뿐이라 컨텍스트가 절대 안 바뀐다). Identifier case의
  // uniqueTopEqVars 치환에서만 실제로 읽는다.
  outerSymbol: Expr | null = null,
  outerTf: Expr | null = null,
): Expr | null {
  switch (node.kind) {
    case "NumberLiteral":
    case "BoolLiteral":
    // C601: na 리터럴 — wild 삼항 분기 관용구(`cond ? x : na`)의 리프. 이 좁은 문법은 전 위치가
    // 숫자 문맥(Float64Array 캐시)이라 genExpr(NaLiteral) 범용 경로의 "NaN" 방출이 정확히 맞다
    // (참조형 na=null 분기는 이 문법에 도달 불가).
    case "NaLiteral":
      return node;
    // C602가 '=='/'!=' 피연산자 직접 리프로 열었던 StringLiteral을 C603이 allowString 위치 플래그로
    // 일반화 — 직접 피연산자뿐 아니라 Identifier 치환 체인(`s = "SMA"` 후 `s == "SMA"`)을 거쳐도
    // 같은 위치 제약 안에서 허용된다. allowString=false(값 위치)면 기존과 동일하게 거부.
    case "StringLiteral":
      return allowString ? node : null;
    case "Identifier": {
      if (
        BAR_SERIES_NAMES.has(node.name) ||
        DERIVED_PRICE_NAMES.has(node.name) ||
        SECURITY_EXPR_TIME_BAR_NAMES.has(node.name) ||
        // C604: year/month/dayofmonth/dayofweek/hour/minute/second/weekofyear bare 식별자
        // (wild 1783e8094cac.pine `ta.valuewhen(dayofweek == dayofweek.friday, high, 1)`) —
        // bar_index/time과 동일한 "top-level bare, 별도 Series 없이 매 바 그 자리에서 파생"
        // 원칙(codegen.ts genIdentifier가 이미 이 8종을 $.barTimeMs 기반 rt.datetime.*로
        // 방출). genIdentifier의 secCtx 스레딩(아래)만 추가하면 그대로 재사용 가능.
        TIME_FUNC_NAMES.has(node.name)
      )
        return node;
      // C516: 인라인 중인 UDF의 파라미터 — 이 콜사이트의 실인자로 치환. 실인자는 호출부(바깥)
      // 스코프에 속하므로 paramEnv/funcName 둘 다 null로 리셋(이 UDF의 본문 스코프를 벗어나
      // "치환"하는 지점이라는 점에서 위 C452/eq-var 치환과 동일 원칙). callLine은 그대로 —
      // request.security 콜 자신의 줄 기준 선언-후-사용 판정이 이 콜사이트에도 여전히 유효하다
      // (인라인이 같은 표현식 트리 안에서 일어나 별도 콜사이트 줄이 없다).
      // C542: visiting 키를 "p:"(매개변수 치환)/"v:"(top-level 변수 치환) 접두로 분리 — 매개변수
      // 이름과 top-level 변수 이름이 우연히 같으면(wild `num_candles = 10` 후 `f(tf, num_candles) =>`)
      // 하나의 공유 문자열 키스페이스가 "매개변수를 막 치환했다"를 "그 변수를 자기참조 중"으로
      // 오판해 안전한 치환을 거짓 순환으로 거부하던 실제 버그(secParamMultiSiteGeneric 실측 발견).
      const pVisitKey = "p:" + node.name;
      const vVisitKey = "v:" + node.name;
      if (paramEnv !== null) {
        const argEntry = paramEnv.get(node.name);
        // C737: paramEnv 프레임별 방문 키 — 이름만으로 키를 잡으면(기존 pVisitKey) 서로 다른 env
        // 프레임의 같은 매개변수 이름이 하나의 키로 뭉개져, 바깥 프레임의 치환이 진행 중일 때 체인
        // (collapse/인라인)으로 재진입한 안쪽 프레임의 정당한 치환까지 거짓 순환으로 거부된다(wild
        // psyll `nr ? source[..] : source` paramSubstRoot 라우트 실측 — C714 "이름-키 대신 선언
        // 노드-키" 원칙의 paramEnv판). 실인자 expr는 항상 원본 AST 노드라 line:col이 물리 노드
        // 식별자로 유효하고, 진짜 재귀(같은 노드·같은 이름 재방문)는 여전히 같은 키로 차단된다.
        // C452/C695 분기(아래)는 이름당 치환 내용이 고정(단일사이트/만장일치)이라 기존 이름 키 유지.
        const pFrameKey = argEntry === undefined ? pVisitKey : pVisitKey + "@" + argEntry.expr.line + ":" + argEntry.expr.col;
        if (argEntry !== undefined && !visiting.has(pFrameKey)) {
          visiting.add(pFrameKey);
          // C731: 치환 후 funcName은 실인자가 물리적으로 속한 스코프(entry.funcName)로 갈아탄다 —
          // C516 인라인은 콜사이트가 root와 같은 트리라 entry.funcName===funcName(기존 동작 그대로),
          // pending in-func 콜사이트는 site.inFuncName이라 C526 섀도잉 가드/C452/함수-로컬 치환이
          // 그 함수의 스코프로 정확히 동작한다. C732: paramEnv도 실인자 위치에서 활성이던 캡처 env
          // (entry.env)로 갈아탄다 — 중첩 인라인에서 실인자가 바깥 함수 매개변수를 참조하는 경우
          // (SecurityParamEnvEntry.env 주석 참조). 기존 경로는 entry.env가 전부 null/undefined라
          // 동작 불변.
          const built = buildSecurityExprNode(argEntry.expr, prog, callLine, visiting, taCalls, allowTa, true, histReads, allowTernary, argEntry.funcName, argEntry.env ?? null, allowString, outerSymbol, outerTf);
          visiting.delete(pFrameKey);
          return built;
        }
      }
      // C526: node.name이 funcName(지금 인라인 중인 UDF) 안에서 매개변수로 섀도잉되면 top-level
      // 상수 치환을 건너뛴다 — 이 경우 바로 아래 C452 분기(그 함수 자신의 매개변수 치환)가 이어서
      // 정확한 스코프로 처리한다(constStringVars/uniqueTopEqVars 주석 참조).
      const shadowedHere = funcName !== null && (prog.constVarShadowFuncs.get(node.name)?.has(funcName) ?? false);
      const def = shadowedHere ? undefined : prog.uniqueTopEqVars.get(node.name);
      // def.line >= callLine: 선언-후-사용(uniqueTopEqVars 주석). visiting: 자기/상호 참조 사이클 가드.
      if (def !== undefined && def.line < callLine && !visiting.has(vVisitKey)) {
        visiting.add(vVisitKey);
        // C447: allowTernary를 그대로 물려준다 — 이 Identifier가 offset 위치(allowTernary=true)에서
        // 왔는데 def.value가 삼항이면(wild `idxVar = barstate.isrealtime ? 1 : 0` 후 `close[idxVar]`,
        // C446 인라인 관용구의 var 치환형) 여기서 안 물려주면 기본값 false로 조용히 리셋돼 거부된다.
        // 값 위치(allowTernary=false)에서 온 호출은 그대로 false가 전달되니 var-subst:eq-value:ternary
        // 스킵 결정(VERIFIED_SEMANTICS OPEN)은 변함없다. funcName은 null로 리셋 — def.value는
        // top-level '=' 대입문의 값이라 이 UDF의 매개변수일 수 없다(위 funcName 파라미터 주석 참조).
        // C616(chained-security-var, next_hint(C615)): def.value 자신이 request.security(...) 콜이면
        // (wild `weekly_mvrv_data = request.security(sym, "W", ta.rsi(close,14))` 후 다른
        // `request.security(sym, "W", weekly_mvrv_data + 1)`) 아래 CallExpr case는 request.security를
        // 이 좁은 문법의 허용 목록에 안 넣어 항상 실패한다(pushSecurityExprUnsupportedError 메시지
        // 그대로). outerSymbol/outerTf(지금 빌드 중인 바깥 콜 자신의 symbol/tf)가 이 내부 콜의
        // symbol/tf와 AST 구조적으로 동일하면 — 둘 다 완전히 같은 HTF 리플레이(같은 symbol+tf)이므로
        // 변수 참조 대신 그 내부 콜의 expression 인자를 이 자리에 직접 재귀 빌드해도 수치적으로
        // 등가하다(같은 결정적 HTF 캐시를 독립적으로 두 번 계산할 뿐 — 매 바 동일 값. ta.* 콜은 각자
        // 독립 slot으로 재등록돼 상태 충돌 없음, 위 C439 주석과 동일 원칙). symbol/tf가 다르면(또는
        // outerSymbol/outerTf 자체가 없으면) 안전하지 않으니 기존처럼 raw CallExpr을 그대로 재귀시켜
        // 항상 거부되는 기존 동작을 보존한다(순수 추가 — 회귀 없음).
        const innerLead = tryResolveSecurityLeadArgsQuiet(def.value);
        const chainSafe =
          innerLead !== null &&
          outerSymbol !== null &&
          outerTf !== null &&
          astExprEqual(outerSymbol, innerLead.symbolArg) &&
          astExprEqual(outerTf, innerLead.tfArg);
        const substRoot = chainSafe ? innerLead.seriesArg : def.value;
        // C738: var 슬라이스 활성 시 치환 위치-안전성 — 이 정의식이 closure var를 직접 참조하면
        // 정의 라인(def.line)과 지금 사용 위치(ctx.useLine) 사이에 그 var의 ':='가 하나라도 있을
        // 때 치환이 값을 바꾼다(정의식은 원래 자기 라인에서 평가되던 것). 하강 시 useLine을
        // def.line으로 갈아타 중첩 치환은 각 홉이 자기 구간만 검사한다(SecurityVarSliceBuildCtx
        // 주석 참조). 참조 수집은 과대(프루닝될 분기 포함)여도 보수 방향이라 안전.
        let sliceSavedUseLine: number | null = null;
        if (secVarSliceCtx !== null && secVarSliceCtx.closure.size > 0) {
          const defRefs = new Set<string>();
          collectSecurityExprIdentNames(substRoot, defRefs);
          for (const r of defRefs) {
            if (!secVarSliceCtx.closure.has(r)) continue;
            const wls = secVarSliceCtx.writeLines.get(r) ?? [];
            for (const w of wls) {
              if (w > def.line && w < secVarSliceCtx.useLine) {
                visiting.delete(vVisitKey);
                return null;
              }
            }
          }
          sliceSavedUseLine = secVarSliceCtx.useLine;
          secVarSliceCtx.useLine = def.line;
        }
        const built = buildSecurityExprNode(substRoot, prog, callLine, visiting, taCalls, allowTa, true, histReads, allowTernary, null, null, allowString, outerSymbol, outerTf);
        if (sliceSavedUseLine !== null && secVarSliceCtx !== null) secVarSliceCtx.useLine = sliceSavedUseLine;
        visiting.delete(vVisitKey);
        return built;
      }
      // C738(배치37 (3) series-arg VAR_DECL 축): top-level `var` 상태 변수 — 활성 슬라이스의
      // closure에 편입된 이름이면 프리패스 로컬 읽기로 그대로 통과시킨다(codegen genIdentifier가
      // secCtx.sliceLocals로 방출). funcName 스코프에서 동명 로컬/매개변수로 섀도잉되면 건너뛰어
      // 아래 C692 함수-로컬 분기가 정확한 스코프로 처리하게 한다(섀도잉된 이름을 전역 var로 잘못
      // 읽는 조용한 오답 방지 — closure 이름과 uniqueTopEqVars는 상호 배타라 위 분기와는 충돌 없음).
      if (
        secVarSliceCtx !== null &&
        secVarSliceCtx.closure.has(node.name) &&
        !(funcName !== null && (secVarSliceCtx.shadowFuncs.get(node.name)?.has(funcName) ?? false)) &&
        !(funcName !== null && prog.funcLocalUniqueEqVars.get(funcName)?.get(node.name) !== undefined)
      ) {
        secVarSliceCtx.readCount++;
        if (secVarSliceCtx.bodyPhase) secVarSliceCtx.bodyUsed = true;
        return node;
      }
      // C692(배치35 (1) series-arg 실질착수 서브셋): funcName 본문 안에서 정확히 1번 '=' 대입된
      // func-local 변수(prog.funcLocalUniqueEqVars — resolveSecurityTfLiteral/NumericConst/
      // BooleanConst(C623/C665)가 이미 쓰는 동일 prescan 인프라 재사용, 이번이 이 좁은 문법
      // expression 빌더에서의 첫 소비). 위 uniqueTopEqVars는 top-level 이름만 봐서 UDF 본문 안
      // request.security 호출의 보조 로컬(`val = which=="close" ? close : ...` 후
      // `request.security(sym, tf, val)`)은 항상 null로 떨어졌다 — funcLocalUniqueEqVars와
      // uniqueTopEqVars는 이름 단위로 상호 배타적(constVarsPrescan이 분리 등록)이라 이 조회는 위
      // top-level 분기와 충돌하지 않는다. funcName/paramEnv를 그대로 물려준다 — 치환값이 여전히
      // 같은 함수 본문 스코프 안(top-level 변수 치환과 달리 null로 리셋할 이유가 없음, 이 값이 그
      // 함수의 매개변수를 참조해도 C452/paramEnv 조회가 계속 유효해야 함). 실패(null)해도 즉시
      // 포기하지 않고 아래 C452/C663 분기로 자연히 흘러가게 둔다(이 이름이 매개변수가 아니라
      // C452는 어차피 안 걸리지만, 함수 자체가 죽은 코드면 C663 플레이스홀더가 여전히 유효).
      const flVisitKey = "fl:" + funcName + ":" + node.name;
      if (funcName !== null && !visiting.has(flVisitKey)) {
        const localDef = prog.funcLocalUniqueEqVars.get(funcName)?.get(node.name);
        if (localDef !== undefined && localDef.line < callLine) {
          visiting.add(flVisitKey);
          // C697(배치35 (1) series-arg 잔여 — wild WaveTrend류 `tfsrc = request.security(sym, tf,
          // src)` 후 같은 함수 본문 안 `esa = ta.ema(tfsrc, chlen)`/`ci = (tfsrc-esa)/(...)`): 위
          // top-level uniqueTopEqVars 분기의 C616 chained-security-var 판정을 func-local 값에도
          // 동일하게 적용 — localDef.value 자신이 request.security(...) 콜이고 그 symbol/tf가 이
          // 바깥 콜과 AST 동일하면 내부 콜의 expression 인자(흔히 그 함수 자신의 매개변수, 예 'src')로
          // 직접 재귀한다. funcName/paramEnv를 그대로 물려주므로 그 매개변수는 이어서 기존
          // C452/C695 콜사이트 치환이 마저 해소한다(top-level 전용이었던 비대칭 해소, 순수 추가).
          const innerLead = tryResolveSecurityLeadArgsQuiet(localDef.value);
          const flChainSafe =
            innerLead !== null &&
            outerSymbol !== null &&
            outerTf !== null &&
            astExprEqual(outerSymbol, innerLead.symbolArg) &&
            astExprEqual(outerTf, innerLead.tfArg);
          const flSubstRoot = flChainSafe ? innerLead.seriesArg : localDef.value;
          const flBuilt = buildSecurityExprNode(flSubstRoot, prog, callLine, visiting, taCalls, allowTa, true, histReads, allowTernary, funcName, paramEnv, allowString, outerSymbol, outerTf);
          visiting.delete(flVisitKey);
          if (flBuilt !== null) return flBuilt;
        }
      }
      // C605: top-level 유일 튜플 디스트럭처 대상(`[supertrend, stDir] = ta.supertrend(...)`) —
      // 다중 반환 ta.* 콜을 이 위치 전용 매처(matchSecurityExprMultiReturnTaCall)로 재검증하고 그
      // 인자들을 재귀 치환(top-level 스코프이므로 funcName/paramEnv는 null)한 뒤 클론을 taCalls에
      // 등록한다. 클론 자신은 반환값이 없어(runtime/ta.ts supertrend 등이 $.taScratch에 쓰고
      // void를 반환) 그대로는 값 위치에 못 온다 — securityExprTupleTaReads에 등록한 합성 CallExpr
      // 래퍼(원본 소스에 대응 없는 센티널, genCallExpr이 stateCallSlots보다 먼저 조회)로 대체해
      // `(그 콜, $.taScratch[index])` comma-식을 낸다. allowTa=false 위치(오프셋 등, C439/C446과
      // 동일 위험 클래스)에서는 스칼라 ta 콜과 동일하게 거부.
      const tVisitKey = "t:" + node.name;
      const tupleDef = prog.uniqueTopEqTuples.get(node.name);
      if (allowTa && tupleDef !== undefined && tupleDef.line < callLine && !visiting.has(tVisitKey)) {
        const taMatch = matchSecurityExprMultiReturnTaCall(tupleDef.source);
        if (taMatch !== null) {
          visiting.add(tVisitKey);
          const resolvedArgs = resolveTaKwargPositions(tupleDef.source, taMatch.entry);
          const sliceReadsBeforeTuple = secVarSliceCtx !== null ? secVarSliceCtx.readCount : 0;
          const args: Expr[] = [];
          let ok = true;
          for (const a of resolvedArgs) {
            if (a === undefined) {
              ok = false;
              break;
            }
            const builtArg = buildSecurityExprNode(a, prog, callLine, visiting, taCalls, allowTa, true, histReads, false, null, null, false, outerSymbol, outerTf);
            if (builtArg === null) {
              ok = false;
              break;
            }
            args.push(builtArg);
          }
          // C738: 튜플 정의(원래 자기 소스 라인에서 평가)의 인자가 var 슬라이스 closure를 읽으면
          // 평가 위치 이동으로 값이 달라질 수 있어 보수 거부(위 uniqueTopEqVars 치환의 위치-안전성
          // 검사와 같은 축 — 이 경로는 wild 근거가 없어 구간 검사 대신 전면 거부).
          if (secVarSliceCtx !== null && secVarSliceCtx.readCount > sliceReadsBeforeTuple) ok = false;
          visiting.delete(tVisitKey);
          if (ok) {
            const clone: CallExpr = {
              kind: "CallExpr",
              callee: tupleDef.source.callee,
              args,
              kwargs: [],
              line: tupleDef.source.line,
              col: tupleDef.source.col,
            };
            taCalls.push({ taCall: clone, fn: taMatch.fn, entry: taMatch.entry });
            const wrapper: CallExpr = {
              kind: "CallExpr",
              callee: tupleDef.source.callee,
              args: [],
              kwargs: [],
              line: node.line,
              col: node.col,
            };
            prog.securityExprTupleTaReads.set(wrapper, { taCall: clone, index: tupleDef.index });
            return wrapper;
          }
        }
      }
      // C452: UDF 매개변수 — 그 함수가 스크립트 전체에서 정확히 1개의(그리고 top-level인) 콜사이트만
      // 가지면(funcSingleCallSiteArgs, prepassIndexSingleCallSites) 위 uniqueTopEqVars 치환과 동일한
      // 안전 근거(결과가 정확히 하나뿐이라 콜사이트별 분기가 필요 없음)로 그 콜사이트의 실인자로
      // 치환한다. wild `f_sec(sym, expr) => request.security(sym, tf, expr, ...)`가 정확히 1곳에서만
      // 호출되는 폼(var-subst:udf-param 서브클러스터의 안전한 부분집합 — 콜사이트가 2개 이상이면
      // funcSingleCallSiteArgs에 등록 자체가 안 돼 이 분기가 자연히 안 걸린다, 기존 미지원 그대로).
      if (funcName !== null && !visiting.has(pVisitKey)) {
        const info = prog.funcs.get(funcName);
        const paramIdx = info !== undefined ? info.paramNames.indexOf(node.name) : -1;
        if (info !== undefined && paramIdx >= 0) {
          const call = prog.funcSingleCallSiteArgs.get(funcName);
          if (call !== undefined) {
            const paramName = info.paramNames[paramIdx]!;
            const argExpr = call.args[paramIdx] ?? call.kwargs.find((kw) => kw.name === paramName)?.value;
            if (argExpr !== undefined) {
              visiting.add(pVisitKey);
              // 콜사이트가 top-level(prepassIndexSingleCallSites가 강제)이므로 funcName은 null —
              // 그 실인자 서브트리 안의 식별자는 더 이상 이 UDF의 매개변수일 수 없다. callLine도
              // 콜사이트 자신의 줄로 바뀐다(원래 callLine은 함수 본문 안 request.security 호출
              // 줄이라, 콜사이트 스코프의 "선언-후-사용" 판정 기준으로는 부적절).
              const built = buildSecurityExprNode(argExpr, prog, call.line, visiting, taCalls, allowTa, true, histReads, allowTernary, null, null, allowString, outerSymbol, outerTf);
              visiting.delete(pVisitKey);
              return built;
            }
          }
        }
      }
      // C695(배치35 (1) series-arg 잔여 — wild `reso(exp, use, res) => request.security(sym, res,
      // exp, ...)`가 2곳에서 `reso(closeSeries, useRes, stratRes)`/`reso(openSeries, useRes,
      // stratRes)`처럼 호출되는 형태): C452는 콜사이트가 "정확히 1개"여야만 매개변수를 치환하지만,
      // 콜사이트가 2개 이상이어도 특정 매개변수의 실인자가 "모든" 콜사이트에서 구문적으로 동일
      // (astExprEqual, C616이 이미 쓰는 line/col-무시 구조 비교)하면 그 매개변수만큼은 콜사이트별
      // 분기가 필요 없다는 뜻이라 안전하게 치환 가능하다(반대로 `exp`처럼 콜사이트마다 실인자가
      // 다른 매개변수는 이 조건을 만족 못해 기존처럼 미지원 유지). C452와 동일하게 top-level
      // 콜사이트만 후보로 삼는다(in-func 콜사이트가 하나라도 섞이면 그 실인자가 자기 함수 스코프
      // 변수일 수 있어 "top-level처럼 안전" 전제가 깨지므로 보수적으로 전부 포기).
      // C563과의 경계: 만약 이 만장일치 실인자가 "전 콜사이트 bare UDF 콜"(resolveSecuritySiteArgBareUdfRoot)
      // 조건까지 만족하면 이 축은 C563의 영역이다 — pine2py request_security._resolve_expression은
      // OHLC(V) identity-match 외 값을 그대로 통과시키므로(C562 재확인, uniform passthrough collapse가
      // 정답) 이 경우엔 buildSecurityExprNode의 "진짜 HTF 재계산 트리" 치환을 양보해야 한다(안 그러면
      // exprMatch!==null이 되어 그 위 analyzeCallExpr 디스패치가 secParamAllBareUdf/secParamMultiSite를
      // 아예 계산하지 않게 됨, C563 describe 블록의 회귀 테스트로 발견). 이 판정은 파라미터 자신이
      // 아니라 "이 좁은 문법 서브트리가 도달한 실제 값"에 걸어야 하므로, 만장일치 값 자체가 bare UDF
      // 콜로 귀결될 때만 양보하고 그 외(문자열/숫자 리터럴 등, 이번 슬라이스의 실제 wild 근거)는
      // 그대로 진행한다.
      if (funcName !== null && !visiting.has(pVisitKey)) {
        const info = prog.funcs.get(funcName);
        const paramIdx = info !== undefined ? info.paramNames.indexOf(node.name) : -1;
        if (info !== undefined && paramIdx >= 0 && prog.funcSingleCallSiteArgs.get(funcName) === undefined) {
          const sites = prog.funcAllCallSites.get(funcName);
          if (sites !== undefined && sites.length >= 2 && sites.every((s) => s.inFuncName === null)) {
            const paramName = info.paramNames[paramIdx]!;
            const argExprs = sites.map((s) => s.call.args[paramIdx] ?? s.call.kwargs.find((kw) => kw.name === paramName)?.value);
            const first = argExprs[0];
            const allBareUdf = sites.every((s, i) => {
              const a = argExprs[i];
              if (a === undefined) return false;
              const root = resolveSecuritySiteArgBareUdfRoot(a, s.inFuncName, s.call.line, prog);
              return root.kind === "CallExpr" && root.callee.kind === "Identifier" && prog.funcs.has(root.callee.name);
            });
            if (!allBareUdf && first !== undefined && argExprs.every((a) => a !== undefined && astExprEqual(a, first))) {
              visiting.add(pVisitKey);
              const built = buildSecurityExprNode(first, prog, sites[0]!.call.line, visiting, taCalls, allowTa, true, histReads, allowTernary, null, null, allowString, outerSymbol, outerTf);
              visiting.delete(pVisitKey);
              if (built !== null) return built;
            }
          }
        }
      }
      // C663(배치34 (2)): 위 어느 치환 경로에도 안 걸린 식별자가 물리적으로 위치한 UDF
      // (funcName) 자신이 스크립트 전체에서 콜사이트 0개("완전 죽은 코드")면, 그 이름이 매개변수든
      // (call===undefined가 0개/2개+ 둘 다 뜻할 수 있어 funcAllCallSites 전수 목록으로 실제 0개만
      // 가려낸다) 함수-로컬 '=' 변수든 심지어 미선언 이름이든 상관없이 안전한 플레이스홀더로 접는다
      // — 이 서브트리는 어떤 실행 경로로도 도달 불가라 값 자체가 영원히 관측되지 않는다(C624가
      // 이미 같은 request.security 콜의 tf 매개변수에 적용한 동일 원칙, 주석 참조). wild
      // PineCoders 관용구 `f_security(_sym, _res, _src) => request.security(_sym, _res, _src[1],
      // ...)`가 헬퍼로 정의만 되고 어디서도 호출되지 않는 폼(series-arg 클러스터 solo 최다
      // 서브그룹) + 그 오프셋 위치의 func-local 변수(`data[isLive ? 1 : 0]`, isLive는 매개변수가
      // 아닌 '=' 로컬이라 위 매개변수 분기 자체가 안 걸림)를 함께 해소한다(scratch/
      // c663_verify_deadcode.mjs 22파일 실측 + 잔여 2파일 재확인). 플레이스홀더는 NaN(NaLiteral)이
      // 아니라 NumberLiteral(1) — 죽은 코드라도 이 값이 `ta.highest(high, days)`류 length 인자
      // 위치에 꽂히면 프리앰블에서 무조건 1회 실행되는 taCalls 초기화(highest() 등이 `new
      // Array(length)`를 즉시 할당)가 NaN을 만나 RangeError로 실측 크래시한다(scratch/
      // c663_verify_deadcode.mjs 재실행 65083cec171e.pine `getLookbackHigh(days)` 미호출 함수로
      // 확인) — value/offset/divisor/length 전 위치에서 공통으로 안전한 유한 양수 1을 대신 쓴다.
      if (funcName !== null) {
        const sites = prog.funcAllCallSites.get(funcName);
        if (sites === undefined || sites.length === 0) {
          return { kind: "NumberLiteral", value: 1, raw: "1", line: node.line, col: node.col };
        }
      }
      return null;
    }
    case "UnaryOp": {
      // C733(배치37(3) not/na() 리프 소형 축): 'not'도 허용 — codegen genExpr UnaryOp가 이미
      // rt.pineNot(C25, na 전파)을 방출하고 이 사이클에 secCtx 스레딩 갭(C444/C446과 동일
      // 클래스)을 함께 고쳤다. C449 당시 "유일 wild 예시가 na()/session-string time()에 가려져
      // net-gain 0"이라 제외했던 축인데, na() 리프가 이번에 같이 열리면서 wild `not na(ta.pivothigh
      // (...)) ? time[N] : na`(15135dffd21f/4294118ebf47) 및 UDF 인라인 rocPct·slopePct 관용구
      // (07ef05436530)의 차단 리프가 이 둘로 좁혀졌다(scratch/c731_risk_classify.mjs 재실행 실측).
      if (node.op !== "-" && node.op !== "not") return null;
      const operand = buildSecurityExprNode(node.operand, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      if (operand === null) return null;
      const clone: UnaryOp = { kind: "UnaryOp", op: node.op, operand, line: node.line, col: node.col };
      return clone;
    }
    case "BinOp": {
      if (
        !SECURITY_EXPR_ARITH_OPS.has(node.op) &&
        !SECURITY_EXPR_COMPARE_OPS.has(node.op) &&
        !SECURITY_EXPR_LOGICAL_OPS.has(node.op) &&
        !SECURITY_EXPR_EQUALITY_OPS.has(node.op)
      )
        return null;
      // C602: '=='/'!=' 양변에 한해 string을 리프로 허용(일반 switch 최상단 무조건-리프 목록엔
      // 안 넣는다 — 거기 넣으면 root/삼항 분기 등 "값 위치"로도 새어나가 out[h]/버퍼
      // Float64Array 대입에서 문자열이 Number() 강제변환으로 조용히 NaN이 된다, SYMINFO_STRING_PROPS
      // 배제와 동일한 위험 클래스). 이 위치는 genEquality가 항상 그 결과를 boolean으로 좁혀
      // 소비하므로(genExpr 범용 StringLiteral/builtinCalls 방출 그대로 재사용) 구조적으로 안전 —
      // wild 실측(scratch/c602_eq_samples.mjs): '=='/'!=' 우변 35건이 StringLiteral(예 `maType ==
      // "SMA"`). C603부터 직접 StringLiteral 특수분기 대신 allowString 위치 플래그를 피연산자
      // 재귀에 켠다(StringLiteral case + Identifier 치환 상속 + input.string 게이트가 소비) —
      // 좌변 Identifier의 정의식이 input.string()/문자열 리터럴인 var-subst 체인까지 같은 위치
      // 제약 안에서 열린다(배치31 (f), wild `maType = input.string("SMA",...)` 후 `maType == "SMA"`).
      const isEq = SECURITY_EXPR_EQUALITY_OPS.has(node.op);
      const buildEqOperand = (operand: Expr): Expr | null =>
        buildSecurityExprNode(operand, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, isEq, outerSymbol, outerTf);
      const left = buildEqOperand(node.left);
      if (left === null) return null;
      const right = buildEqOperand(node.right);
      if (right === null) return null;
      const clone: BinOp = { kind: "BinOp", op: node.op, left, right, line: node.line, col: node.col };
      if (prog.idivBinOps.has(node)) prog.idivBinOps.add(clone);
      return clone;
    }
    // C446: offset 위치(allowTernary=true) — wild `close[barstate.isrealtime ? 1 : 0]`류
    // (repaint 방지 관용구). 조건/양쪽 분기는 ta.* 없이(allowTa=false — offsetCode 텍스트가
    // rt.secHistGet/genDerivedPriceExpr에서 최대 4회 중복 방출될 수 있어 상태 콜 원천 금지)
    // 재귀 검증만 하고 eager 래핑도 없다(순수식은 lazy JS ?:와 eager가 관측 불가 동치).
    // C601(배치31 (c), Fable 감독 승인 — wild 실측: security-expr 거부 386파일 중 삼항 81파일/
    // 단독 차단 40파일): 값 위치(allowTernary=false)의 일반 삼항 허용. 조건은 JS ?:에서도
    // 무조건 평가되므로 ta 콜을 그대로 인라인 허용하고(지배 wild 패턴 `close > ta.ema(...) ? 1 :
    // close < ta.ema(...) ? -1 : 0`의 중첩 조건 포함), 분기는 빌드 중 ta 콜이 새로 등록됐을
    // 때만(16파일 실측) wrapSecurityEagerBranch(offset-0 버퍼)로 eager 평가를 강제한다 —
    // lazy JS ?:로 그냥 방출하면 미선택 바에서 분기 안 ta 상태가 전진하지 않아 TV(삼항 양쪽
    // 항상 평가, VERIFIED_SEMANTICS CONFIRMED 연동 축)와 갈리는 조용한 상태 갭이 생긴다.
    // 순수 분기는 래핑 없이 lazy 그대로(관측 불가 차이, 버퍼 비용 0).
    case "TernaryOp": {
      // C736: `timeframe.period == "리터럴"` 등식 조건은 요청 tf 컨텍스트에서 컴파일타임 확정 —
      // 판정되면 선택 분기 하나만 이 노드 위치의 파라미터 그대로 이어서 빌드한다(프루닝 — 치환이
      // 그 자리를 통째로 갈아끼우는 것이라 allowTernary/allowString 위치가 보존되는 C603 원칙).
      // 미판정(undefined — outerTf 미확정/비정규형/다른 조건 꼴)이면 기존 경로 그대로.
      const tfEqFold = foldSecurityTfPeriodEqCondition(node.condition, prog, funcName, outerTf);
      if (tfEqFold !== undefined) {
        return buildSecurityExprNode(
          tfEqFold ? node.trueExpr : node.falseExpr,
          prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, allowTernary, funcName, paramEnv, allowString, outerSymbol, outerTf,
        );
      }
      const branchTa = allowTernary ? false : allowTa;
      const condition = buildSecurityExprNode(node.condition, prog, callLine, visiting, taCalls, branchTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      if (condition === null) return null;
      const taBeforeTrue = taCalls.length;
      const trueBuilt = buildSecurityExprNode(node.trueExpr, prog, callLine, visiting, taCalls, branchTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      if (trueBuilt === null) return null;
      const trueExpr = !allowTernary && taCalls.length > taBeforeTrue ? wrapSecurityEagerBranch(trueBuilt, histReads) : trueBuilt;
      const taBeforeFalse = taCalls.length;
      const falseBuilt = buildSecurityExprNode(node.falseExpr, prog, callLine, visiting, taCalls, branchTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      if (falseBuilt === null) return null;
      const falseExpr = !allowTernary && taCalls.length > taBeforeFalse ? wrapSecurityEagerBranch(falseBuilt, histReads) : falseBuilt;
      const clone: TernaryOp = { kind: "TernaryOp", condition, trueExpr, falseExpr, line: node.line, col: node.col };
      return clone;
    }
    // barstate.isrealtime — 위 삼항 조건 leaf(wild 실측 전량이 이 형태). codegen.ts genExpr
    // DotAccess가 secCtx일 때 analyzer.ts BARSTATE_PROPS의 "$.idx===$.barCount-1"(메인 컨텍스트 전용,
    // 프리패스 h와 무관) 대신 secCtx.loopVar/cacheVar 기반 식으로 재작성한다.
    // barstate.isconfirmed/ishistory(C628, wild `_exp[barstate.isconfirmed ? 0 : 1]`(3파일, 다만
    // 그 obj가 3-콜사이트 UDF 매개변수라 이 슬라이스로는 해소 안 됨)/`ds[barstate.ishistory ? 0 : 1]`
    // (2파일, ds가 top-level 유일 '=' 변수라 실제 해소됨)) — isconfirmed는 C481이 buildSecurityExpr
    // root-only 특수분기로만 열어뒀던 것을 여기로 일반화(위치 무관 컴파일타임 상수라 syminfo/earnings/
    // timeframe/dayofweek과 동일 근거로 안전 — root 특수분기는 이제 완전히 redundant라 제거).
    // ishistory는 신규 leaf: codegen.ts가 isrealtime과 대칭인 "$.idx < $.barCount-1" 재작성을 추가
    // 방출한다. 다른 barstate.* 프로퍼티(isfirst 등)는 여전히 이 위치 wild 근거가 없어 미포함(C283
    // 큐레이션 원칙 유지).
    // syminfo.*(C481, wild `expression = syminfo.shares_outstanding_float` 1건) — SYMINFO_NUMBER_PROPS만
    // 허용한다(이 재귀 switch 어디서든 안전 — 위치 무관 컴파일타임 상수라 barstate와 달리 나머지
    // 위치에서 허용해도 별도 시맨틱 함의가 없다). 이 좁은 문법의 프리패스 캐시는 Float64Array
    // 전용(runtime/security.ts)이라 SYMINFO_STRING_PROPS(문자열 상수, 예: currency="USD")를 그
    // 배열에 넣으면 Number("USD")===NaN으로 조용히 깨진다 — 값 타입이 이미 숫자로 확정된 NUMBER_PROPS만
    // 안전. 개별 이름 큐레이션 없이 맵 전체를 허용해도 안전한 이유는 그 안의 전 항목이 이미 메인
    // 경로에서 hand-verified 컴파일타임 숫자 상수이기 때문(C391).
    case "DotAccess": {
      if (
        node.obj.kind === "Identifier" &&
        node.obj.name === "barstate" &&
        (node.attr === "isrealtime" || node.attr === "isconfirmed" || node.attr === "ishistory" || node.attr === "islast")
      )
        return node;
      // C669(배치34 (2) 4순위 '튜플리터럴-series'): session.ismarket/isfirstbar_regular/
      // islastbar_regular — wild `request.security(...,[session.isfirstbar_regular,
      // session.islastbar_regular],...)`/`[..., session.ismarket, ...]`. barstate.*와 동일한
      // "위치 무관 컴파일타임 상수" 근거(SESSION_PROPS 산식이 BARSTATE_PROPS의 isfirst/isrealtime과
      // 문자열까지 동일 — analyzer.ts 주석 참조, 세션 인프라 없는 백테스트 모드 전제의 동일한
      // 기존 근사). isfirstbar/islastbar(비-regular 변형)는 wild 근거가 없어 미포함(C283 큐레이션
      // 원칙). ispremarket/ispostmarket도 wild 근거 없음.
      if (
        node.obj.kind === "Identifier" &&
        node.obj.name === "session" &&
        (node.attr === "ismarket" || node.attr === "isfirstbar_regular" || node.attr === "islastbar_regular")
      )
        return node;
      if (node.obj.kind === "Identifier" && node.obj.name === "syminfo" && SYMINFO_NUMBER_PROPS.has(node.attr)) return node;
      // earnings.future_eps/future_period_end_time/future_revenue/future_time(C482, wild
      // request.security(..., [..., earnings.future_time, ...], ...) 배열 원소) — SYMINFO_NUMBER_PROPS와
      // 동일 근거로 맵 전체 허용(전 항목이 이미 메인 경로에서 hand-verified 컴파일타임 숫자 NaN 상수).
      if (node.obj.kind === "Identifier" && node.obj.name === "earnings" && EARNINGS_NUMBER_PROPS.has(node.attr)) return node;
      // C517: timeframe.isintraday/isdaily/isweekly/ismonthly/isseconds/isminutes/isdwm(wild
      // `request.security(..., [..., timeframe.isintraday, ...], ...)` 등) — SYMINFO_NUMBER_PROPS와
      // 동일 근거: TIMEFRAME_BOOLEAN_PROPS 전 항목이 이미 메인 경로(analyzer.ts L5046)에서
      // hand-verified 컴파일타임 boolean 상수(prog.chartTf 기준, 배치30 (1) C591부터 설정화 —
      // C435/timeframeStringPropValue 주석 참조)라 Float64Array 캐시에 0/1로 안전하게 들어간다.
      // period/main_period(timeframeStringPropValue)는 syminfo 문자열 상수와 동일 이유로 여전히 배제.
      if (node.obj.kind === "Identifier" && node.obj.name === "timeframe" && TIMEFRAME_BOOLEAN_PROPS.has(node.attr)) return node;
      // C604: dayofweek.sunday~saturday(analyzer.ts DAYOFWEEK_CONSTANTS, C497) — syminfo/earnings/
      // timeframe 상수와 동일한 구조적 판별(값이 컴파일타임 숫자 상수라 위 이름들과 동일 위험군).
      if (node.obj.kind === "Identifier" && node.obj.name === "dayofweek" && DAYOFWEEK_CONSTANTS.has(node.attr)) return node;
      return null;
    }
    case "IndexAccess": {
      // C437 동적 오프셋: index가 컴파일타임 리터럴로 안 접히면(변수 치환/산술/중첩 히스토리 등)
      // 같은 좁은 문법으로 재귀 빌드해 런타임 오프셋 표현식으로 허용한다(ROADMAP P4 클러스터
      // index-dynamic-or-negative, wild `close[gainLossDays]`류). 리터럴이지만 음수/비정수면
      // 여전히 하드 리젝(TV 자체가 음수 리터럴 히스토리 오프셋을 허용하지 않음 — 메인 analyzer
      // index-access.ts analyzeIndexAccess의 동일 정책과 대칭, "리터럴인데 무효"와 "진짜 동적"을
      // 구분해야 음수 리터럴이 조용히 항상-NaN 동적 표현식으로 새지 않는다).
      const litOffset = literalOffsetValue(node.index);
      if (litOffset !== null && (!Number.isInteger(litOffset) || litOffset < 0)) return null;
      let indexNode: Expr;
      if (litOffset !== null) {
        indexNode = node.index;
      } else {
        // 오프셋 위치의 ta.* 콜은 금지(allowTa=false) — 반복 평가(rt.secHistGet이 여러 read
        // 지점에서 offsetCode 텍스트를 중복 방출) 시 상태가 이중 전진하는 것을 원천 차단.
        // allowTernary=true: 이 위치(오프셋)에서만 C446 삼항을 허용한다.
        const builtIdx = buildSecurityExprNode(node.index, prog, callLine, visiting, taCalls, false, inSubst, histReads, true, funcName, paramEnv, false, outerSymbol, outerTf);
        if (builtIdx === null) return null;
        indexNode = builtIdx;
      }
      // bare/파생 시리즈 obj는 기존 캐시 배열 직접 읽기 경로 그대로(C367 — 리터럴 출력 바이트 불변,
      // 동적 오프셋은 codegen이 rt.secHistGet으로 이관).
      if (node.obj.kind === "Identifier" && (BAR_SERIES_NAMES.has(node.obj.name) || DERIVED_PRICE_NAMES.has(node.obj.name))) {
        const clone: IndexAccess = { kind: "IndexAccess", obj: node.obj, index: indexNode, line: node.line, col: node.col };
        return clone;
      }
      // C370 hist-on-expr: obj 자신이 이 확장 문법에 맞으면(ta.* 콜/치환 변수/산술 조합) 프리패스
      // 안 서브식별 히스토리 버퍼로 지원 — 프리패스가 행 시퀀스를 순서대로 재실행하므로 "그 서브식의
      // n행 전 값" = 버퍼[h-n]이 정확한 대응(bare 시리즈 캐시 읽기와 같은 시맨틱/워밍업 NaN).
      // obj 재귀가 taCalls/histReads를 먼저 채우므로 중첩 히스토리는 안쪽 버퍼가 항상 앞 인덱스다.
      const sliceReadsBeforeObj = secVarSliceCtx !== null ? secVarSliceCtx.readCount : 0;
      const builtObj = buildSecurityExprNode(node.obj, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      if (builtObj === null) return null;
      // [0]은 "그 행 자신" — 버퍼 없이 서브식 인라인 평가(bare 시리즈 offset 0 경로와 동일 발상).
      // 동적 오프셋은 런타임에야 값이 정해지므로(0일 수도 있음) 이 컴파일타임 단축을 못 타고
      // 항상 버퍼를 배정한다 — rt.secHistGet이 런타임에 off===0을 h 그대로 읽어 동치를 보장.
      if (litOffset === 0) return builtObj;
      // C738: obj 서브트리가 var 슬라이스 closure를 읽으면 거부 — 히스토리 버퍼 fill은 행 최상단
      // (슬라이스 문장 이전)에서 실행돼 그 행의 갱신 전 값을 기록하므로 `x[1]`이 "직전 행 종료
      // 시점 값"이 아니라 한 행 더 밀린 값을 돌려주게 된다(오프셋/인덱스 위치의 closure 읽기는
      // 순수 로컬 읽기라 무해 — obj만 검사).
      if (secVarSliceCtx !== null && secVarSliceCtx.readCount > sliceReadsBeforeObj) return null;
      const clone: IndexAccess = { kind: "IndexAccess", obj: builtObj, index: indexNode, line: node.line, col: node.col };
      histReads.push({ node: clone, obj: builtObj });
      return clone;
    }
    case "CallExpr": {
      // C737(배치37(3) 7차 — 래퍼-UDF 경유 체인): 이 노드 자신이 request.security(...) 콜이고
      // symbol/tf가 지금 빌드 중인 바깥 콜(outerSymbol/outerTf)과 AST 구조적으로 동일하면, C616이
      // Identifier-def 위치(uniqueTopEqVars/funcLocalUniqueEqVars 치환 시점) 한정으로 하던
      // chained-security-var collapse를 트리 임의 위치로 일반화해 내부 콜의 expression 인자를 이
      // 자리에서 직접 재귀 빌드한다(같은 결정적 HTF 캐시의 독립 재계산 — C616 주석의 등가 논증
      // 그대로, ta 클론은 각자 독립 슬롯). 실발현 폼은 C516/C732 UDF 인라인 본문 루트가
      // request.security인 경우(wild psyll 템플릿 `avg_price = tf_security(ta.sma(close,len))` 후
      // 다른 사이트 인자가 avg_price를 참조 → uniq-eq 치환 → 인라인 → 본문 루트가 바깥과 같은
      // symbol/tf의 security 콜) — Identifier-def 경로는 def.value가 "직접" security 콜일 때만
      // collapse해 래퍼-UDF 한 겹을 못 뚫었다. funcName/paramEnv는 그대로 물려준다(내부 expression이
      // 인라인 매개변수를 참조하면 활성 inlineEnv가 마저 해소). gaps/lookahead 등 lead 3슬롯 밖
      // kwargs는 C616 Identifier 경로(tryResolveSecurityLeadArgsQuiet가 lead만 매핑)와 동일 근거로
      // 무시 — 같은 symbol+tf 아이덴티티 매핑에서는 결과에 영향 없음. symbol/tf 불일치면 이 분기를
      // 그냥 지나쳐 아래 기존 분기들에 안 걸리고 null(항상 거부되던 기존 동작 보존, 순수 추가).
      // 종료 보장: seriesArg는 이 노드의 진부분트리 + env 경유 역참조는 기존 "fn:"/"v:"/"fl:"
      // visiting 가드가 그대로 차단.
      if (outerSymbol !== null && outerTf !== null) {
        const chainLead = tryResolveSecurityLeadArgsQuiet(node);
        if (chainLead !== null && astExprEqual(outerSymbol, chainLead.symbolArg) && astExprEqual(outerTf, chainLead.tfArg)) {
          return buildSecurityExprNode(chainLead.seriesArg, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, allowTernary, funcName, paramEnv, allowString, outerSymbol, outerTf);
        }
      }
      const taMatch = matchSecurityExprTaCall(node);
      if (taMatch !== null) {
        if (!allowTa) return null;
        // C439: ta.* 콜 인자는 allowTa를 그대로 물려받아 중첩 ta.* 콜을 허용한다(wild
        // `ta.ema(ta.tr, len)`류 — 이전엔 hardcoded false로 원천 거부했으나, 이 위치는
        // IndexAccess 동적 오프셋(offsetCode 텍스트가 genDerivedPriceExpr에서 최대 4회 중복
        // 방출되는 실제 구조적 위험, 위 offset 분기 주석 참조)과 달리 codegen(genCallExpr
        // args.map)이 각 인자를 정확히 1회만 genExpr해 방출한다 — 텍스트 중복이 없어 중첩
        // ta 콜이 이중 전진할 위험이 구조적으로 없다(analyzeStatefulCall이 각 taCalls 항목을
        // 독립 slot으로 등록하므로 상태 충돌도 없음). 안쪽 콜이 먼저 taCalls에 push되므로
        // (post-order) slot 번호도 안쪽이 항상 앞선다.
        // C443: kwargs(length=/source=...)는 resolveTaKwargPositions(일반 non-security 콜사이트와
        // 동일한 위치+키워드 정규화 함수, C400)로 위치 배열로 먼저 접어 넣는다 — kwarg **값**도
        // 이 좁은 문법으로 재귀 검증/치환(var-subst 등)돼야 하므로 원본 kwargs를 그대로 클론에
        // 보존하면 안 된다(재귀를 안 거친 임의 표현식이 codegen 프리패스로 새는 것을 방지). 구멍
        // (필수 위치가 위치도 키워드도 못 받음)은 즉시 실패 — 상세 에러 메시지는 이 좁은 문법
        // 밖이라 손실되지만(일반 blanket-거부와 동일 관례), 실제 wild 실사용은 전부 구멍 없이
        // 온전한 형태라 net-gain에 영향 없음.
        const resolvedArgs = resolveTaKwargPositions(node, taMatch.entry);
        const args: Expr[] = [];
        for (const a of resolvedArgs) {
          if (a === undefined) return null;
          const builtArg = buildSecurityExprNode(a, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
          if (builtArg === null) return null;
          args.push(builtArg);
        }
        const clone: CallExpr = { kind: "CallExpr", callee: node.callee, args, kwargs: [], line: node.line, col: node.col };
        taCalls.push({ taCall: clone, fn: taMatch.fn, entry: taMatch.entry });
        return clone;
      }
      // C444: nz(value[, replacement]) 좁은 문법 리프 케이스 — wild
      // `ta.cum(nz((high+low+close)/3,0.0)*nz(volume,0.0))`(next_hint(C443)). nz는 stateless
      // 순수 함수라(일반 경로 NZ_KWARG_PARAM_NAMES 참조) ta.* 콜과 달리 taCalls 등록이 필요 없다 —
      // 하지만 이 위치(인라인, inSubst=false로도 등장)는 request.security expression 콜사이트
      // 자신이 일반 analyzeExpr를 안 거쳐(C180 이중 소비 방지) 원본 노드가 builtinCalls에 등록돼
      // 있지 않다 — input.source(아래 sourceDefval)처럼 원본을 버리고 대체할 수도 없다(defval
      // 정체성이 없다, 값 자체가 이 노드). ta.*(C439/C443)와 동일하게 클론을 만들어 codegen이 이미
      // 갖고 있는 nz 분기(codegen.ts genCallExpr builtinCalls 일반 폴백)를 그대로 재사용하도록 그
      // 클론을 prog.builtinCalls에 직접 등록한다(일반 analyzeExpr의 nz 분기가 원본 노드에 하는 것과
      // 동일 — call-expr.ts L1638 참조). kwargs는 wild 근거가 없어(위치 전용) 이번 슬라이스 범위 밖
      // — kwargs가 있으면 이 분기가 안 걸려 아래로 떨어져 미지원 그대로 거부된다.
      if (
        node.callee.kind === "Identifier" &&
        node.callee.name === "nz" &&
        node.kwargs.length === 0 &&
        node.args.length >= 1 &&
        node.args.length <= 2
      ) {
        const nzArgs: Expr[] = [];
        for (const a of node.args) {
          const builtArg = buildSecurityExprNode(a, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
          if (builtArg === null) return null;
          nzArgs.push(builtArg);
        }
        const nzClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: nzArgs, kwargs: [], line: node.line, col: node.col };
        prog.builtinCalls.set(nzClone, "nz");
        return nzClone;
      }
      // C733: na(x) bare 콜 리프 — nz(C444)와 완전히 동일한 메커니즘(이 콜사이트는 일반
      // analyzeExpr를 안 거쳐(C180) 원본이 builtinCalls에 없으므로 클론을 만들어 직접 등록,
      // codegen genCallExpr builtinCalls 일반 폴백이 rt.na(...)를 방출 — 메인 경로의 bare na 콜
      // 분기(아래 L4077대)와 동일 태그 "na"). 인자 정확히 1개/kwargs 없음(메인 경로와 동일
      // arity). 반환은 boolean이지만 Float64Array 캐시의 true→1/false→0 강제변환은 비교/논리
      // 연산자(C449)와 동일 인코딩이라 안전. UDF가 na를 섀도잉하면 메인 경로와 달리 여기선
      // 그 UDF 콜이 위 C516 인라인 분기(prog.funcs 조회)에 먼저 안 걸리는데, bare 콜 인라인
      // 분기는 이 아래 있으므로 na 섀도잉 UDF는 이 분기가 먼저 삼킨다 — wild에 그런 폼이 없고
      // (na는 예약 시맨틱 이름) 삼켜도 rt.na 시맨틱으로 동작해 조용한 오답 위험은 이름 재정의
      // 자체가 이미 안티패턴인 극단 케이스에 한정, C283 큐레이션 원칙상 방어 분기 미추가.
      if (
        node.callee.kind === "Identifier" &&
        node.callee.name === "na" &&
        node.kwargs.length === 0 &&
        node.args.length === 1
      ) {
        const naArg = buildSecurityExprNode(node.args[0]!, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
        if (naArg === null) return null;
        const naClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: [naArg], kwargs: [], line: node.line, col: node.col };
        prog.builtinCalls.set(naClone, "na");
        return naClone;
      }
      // C740: bare fixnan(source) stateful 콜 리프 — wild d2146eb06afe DMI 관용구
      // `plus = fixnan(100 * ta.rma(plusDM, len) / trur)`가 uniq-eq 치환 체인으로 이 위치에
      // 도달한다. fixnan은 nz/na(stateless — builtinCalls 클론 등록)와 달리 "직전 비-na 값"을
      // 기억하는 stateful 콜(TA_REGISTRY dispatch:"bare", C18/C26)이므로 위 ta.* 분기(C439)와
      // 동일하게 클론을 taCalls에 push한다 — 콜사이트(analyzer.ts L7461류)가 analyzeStatefulCall로
      // 슬롯을 배정하고, codegen stateCallSlots 일반 분기가 `rt.fixnan($.taSlots[N], arg)`를
      // 방출한다(암묵 bar 주입 없음 — secCtx 스레딩은 인자 genExpr에만 걸려 자동 안전). taCalls
      // 기반 안전장치(조건부 var-slice 거부 L2372/삼항 eager wrap L3500)도 전부 그대로 적용된다.
      // 게이트: (1) ta.*와 동일한 allowTa(IndexAccess 인덱스 등 stateful 금지 위치 거부),
      // (2) 동명 user UDF가 있으면 이 분기를 건너뛴다 — 메인 경로가 isUserFuncCall(L4265)을 bare
      // TA_REGISTRY(L5159)보다 먼저 디스패치하는 것과 대칭(na의 "섀도잉 UDF도 삼킨다"와 달리
      // fixnan은 상태 시맨틱이라 삼키면 조용한 오답 — 아래 C516 인라인 분기가 UDF로 처리).
      // kwargs는 kwargParamNames(["source"], C501)로 위치 정규화 — 구멍/미지 이름은 즉시 거부
      // (ta.* 분기와 동일 관례). 초과 인자는 클론에 실려 analyzeStatefulCall arity 검증이 잡는다.
      if (node.callee.kind === "Identifier" && node.callee.name === "fixnan" && !prog.funcs.has("fixnan")) {
        const fixnanEntry = TA_REGISTRY["fixnan"];
        if (fixnanEntry !== undefined && fixnanEntry.dispatch === "bare") {
          if (!allowTa) return null;
          const resolvedFixnanArgs = resolveTaKwargPositions(node, fixnanEntry);
          const fixnanArgs: Expr[] = [];
          for (const a of resolvedFixnanArgs) {
            if (a === undefined) return null;
            const builtArg = buildSecurityExprNode(a, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
            if (builtArg === null) return null;
            fixnanArgs.push(builtArg);
          }
          const fixnanClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: fixnanArgs, kwargs: [], line: node.line, col: node.col };
          taCalls.push({ taCall: fixnanClone, fn: "fixnan", entry: fixnanEntry });
          return fixnanClone;
        }
      }
      // C735: time(timeframe[, session[, timezone]])/time_close(...) 세션 콜 리프 — wild
      // `request.security(tid, "D", time(timeframe.period, sessionInput))`(b754d988456a 등) /
      // `not na(time(engineTF, "1330-1600", nyTimezone))`(0523d8d8b8e4). nz(C444)와 동일 메커니즘
      // (이 콜사이트는 일반 analyzeExpr를 안 거쳐(C180) 원본이 builtinCalls에 없으므로 클론을 만들어
      // 직접 등록, codegen genCallExpr "time"/"timeClose" 분기가 rt.time.resolve(...)를 방출 —
      // 그 분기의 암묵 barTimeMs 주입은 secCtx일 때 HTF 캐시 timeOpen[loopVar]로 갈아탄다,
      // codegen.ts 참조). 세 인자 전부 컴파일타임 상수 문자열로 접어 StringLiteral 클론에 담는다
      // (프리패스 방출이라 per-bar 로컬 Identifier가 남으면 안 되는 C598 클래스 — 리터럴 폴딩이
      // 구조적으로 안전한 유일 경로. input 출처 상수는 resolveSecurityTfLiteral의 constStringVars
      // 분기가 기존 securityTfConstGuards fail-loud 가드를 그대로 등록한다 — 세션/타임존 문자열도
      // "런타임 오버라이드 시 폴딩 리터럴과 어긋남" 위험이 tf와 동일 클래스라 같은 가드가 정확).
      // tf 인자(슬롯 0)의 timeframe.period/main_period는 HTF 컨텍스트 전환 — 이 표현식은 요청된
      // tf의 컨텍스트에서 평가되므로(TV request.security 컨텍스트 스위칭) 차트 tf가 아니라 "바깥
      // security 콜의 대상 tf"(outerTf)로 접는다(DotAccess case가 period를 배제해온 것과 별개 축 —
      // 여기서는 값이 컴파일타임 확정될 때만 통과라 조용한 오답 없음). bars_back 4번째 슬롯/kwargs
      // 폼은 wild 근거가 없어 범위 밖(C283 큐레이션) — 걸리면 아래로 떨어져 기존 거부 유지가 아니라
      // 인자 폴딩 실패와 동일하게 명시 거부(null)한다(동명 UDF 인라인 폴백이 삼킬 이름이 아님).
      // NaLiteral 인자는 전 슬롯 보수 거부 — resolveSecurityTfLiteral의 na→"D" 폴딩은 tf 위치
      // 전용 시맨틱(C514)이고, 메인 경로 time(na)의 null 낮춤(C575)과도 다른 값이라 접지 않는다.
      if (
        node.callee.kind === "Identifier" &&
        (node.callee.name === "time" || node.callee.name === "time_close") &&
        node.kwargs.length === 0 &&
        node.args.length >= 1 &&
        node.args.length <= 3
      ) {
        const foldedArgs: Expr[] = [];
        for (let i = 0; i < node.args.length; i++) {
          const orig = node.args[i]!;
          // C743: 인자가 인라인 매개변수(paramEnv 프레임)면 실인자 expr로 먼저 치환한다(transitive
          // — 실인자가 다시 바깥 프레임의 매개변수면 캡처 env(entry.env)로 갈아타며 따라간다, 위
          // Identifier case C731/C732와 동일 규칙). 리졸버 자신의 env 조회(C513)는
          // SecurityConstEnv(상수 값 맵) 트랙이라 이 SecurityParamEnvEntry 프레임을 모른다 — 래퍼
          // UDF `is_newbar(res) => ta.change(time(res)) != 0`이 리터럴 실인자('D')로 호출돼도
          // time(res) 폴딩이 항상 실패하던 갭(wild 6e7ece629e2f, adopt(r,s)=>security(tid,r,s)
          // 경유). 치환 결과가 timeframe.period류면 아래 i===0 분기가 그대로 적용돼야 하므로(HTF
          // 컨텍스트 전환 — 차트 tf로 접으면 조용한 오답) 치환을 분기 판정보다 먼저 한다. 프레임
          // 체인은 항상 유한하지만(각 홉이 더 바깥 프레임으로만 이동) 홉 상한으로 방어(C737 취지).
          let a: Expr = orig;
          let aFunc = funcName;
          let aEnv = paramEnv;
          for (let hop = 0; hop < 32 && a.kind === "Identifier" && aEnv !== null; hop++) {
            const entry = aEnv.get(a.name);
            if (entry === undefined) break;
            a = entry.expr;
            aFunc = entry.funcName;
            aEnv = entry.env ?? null;
          }
          let lit: string | undefined;
          if (a.kind === "NaLiteral") {
            lit = undefined;
          } else if (
            i === 0 &&
            a.kind === "DotAccess" &&
            a.obj.kind === "Identifier" &&
            a.obj.name === "timeframe" &&
            TIMEFRAME_STRING_PROPS.has(a.attr)
          ) {
            lit = outerTf !== null ? withSecuritySessionFold(() => resolveSecurityTfLiteral(outerTf, prog, new Set(), null, funcName)) : undefined;
          } else {
            lit = withSecuritySessionFold(() => resolveSecurityTfLiteral(a, prog, new Set(), null, aFunc));
          }
          if (lit === undefined) return null;
          const litNode: StringLiteral = { kind: "StringLiteral", value: lit, line: orig.line, col: orig.col };
          foldedArgs.push(litNode);
        }
        const timeClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: foldedArgs, kwargs: [], line: node.line, col: node.col };
        prog.builtinCalls.set(timeClone, node.callee.name === "time" ? "time" : "timeClose");
        return timeClone;
      }
      // C536: int(x)/float(x)/bool(x) 형변환 bare 콜 리프 케이스 — nz(C444)와 동일 근거: 이
      // 콜사이트도 원본 analyzeExpr을 안 거쳐(C180) builtinCalls에 등록이 안 돼 있으므로 클론을
      // 만들어 codegen이 이미 갖고 있는 일반 폴백(genCallExpr builtinCalls, call-expr.ts L2503의
      // 메인 경로와 동일 태그 "int"/"float"/"bool")을 그대로 재사용한다. 인자 정확히 1개, kwargs
      // 없음(메인 경로와 동일 arity 제약 — 위치 인자 1개 초과/kwargs는 이번 슬라이스 범위 밖, 걸리면
      // 아래로 떨어져 기존처럼 미지원 거부). string(x)는 이 슬라이스에 포함하지 않는다(메인 경로가
      // tostringIntArgCalls 정수-포맷 판별에 scope 인자를 쓰는데(analyzer.ts L2510
      // isStaticIntExpr(expr.args[0]!, prog, scope)) 이 좁은 문법 재귀는 scope를 갖고 있지 않아
      // 같은 판별을 그대로 이식할 수 없음 — 별도 축으로 후순위).
      if (
        node.callee.kind === "Identifier" &&
        (node.callee.name === "int" || node.callee.name === "float" || node.callee.name === "bool") &&
        node.kwargs.length === 0 &&
        node.args.length === 1
      ) {
        const castArg = buildSecurityExprNode(node.args[0]!, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
        if (castArg === null) return null;
        const castClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: [castArg], kwargs: [], line: node.line, col: node.col };
        prog.builtinCalls.set(castClone, node.callee.name);
        return castClone;
      }
      // C445: math.* 콜 리프 케이스 — 위 SECURITY_EXPR_MATH_METHODS/matchSecurityExprMathCall 주석
      // 참조. nz(C444)와 동일하게 이 콜사이트는 원본이 builtinCalls에 없어(C180) 클론을 만들어 직접
      // 등록한다 — codegen 일반 builtinCalls 폴백(genCallExpr, C444가 secCtx 스레딩 고침)이 그대로
      // `rt.<method>(...)`를 낸다.
      const mathMethod = matchSecurityExprMathCall(node);
      if (mathMethod !== null) {
        const mathArgs: Expr[] = [];
        for (const a of node.args) {
          const builtArg = buildSecurityExprNode(a, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
          if (builtArg === null) return null;
          mathArgs.push(builtArg);
        }
        const mathClone: CallExpr = { kind: "CallExpr", callee: node.callee, args: mathArgs, kwargs: [], line: node.line, col: node.col };
        prog.builtinCalls.set(mathClone, mathMethod);
        return mathClone;
      }
      // input.source(defval, ...)는 원본 노드 보존 없이 defval 서브트리로 완전히 대체(위
      // matchSecurityInputSourceDefval 주석 참조) — inSubst 무관 항상 허용.
      const sourceDefval = matchSecurityInputSourceDefval(node);
      if (sourceDefval !== undefined) {
        return buildSecurityExprNode(sourceDefval, prog, callLine, visiting, taCalls, allowTa, inSubst, histReads, false, funcName, paramEnv, false, outerSymbol, outerTf);
      }
      // input 스칼라 상수는 치환 경로(inSubst)로만 허용 — 인라인 폼은 이 콜사이트가 일반
      // analyzeExpr를 안 거쳐(C180 이중 소비 방지) builtinCalls 등록이 없어 codegen이 크래시한다.
      if (inSubst && isSecurityScalarConstInputCall(node)) return node;
      // C603: input.string 상수는 위 게이트에 더해 '=='/'!=' 피연산자 위치(allowString)까지 요구 —
      // 값 위치로 새면 Float64Array가 문자열을 NaN으로 부식(isSecurityConstStringInputCall 주석).
      if (inSubst && allowString && isSecurityConstStringInputCall(node)) return node;
      // C734: 방출 슬롯에 비리터럴 컴파일타임 상수(defval/minval 위치 '=' 상수 식별자, title 위치
      // 문자열 결합)가 낀 input 콜은 리터럴로 접은 클론으로 통과 — 위 predicate 형제쌍이 거부한
      // 경우에만 시도하므로 기존 통과 파일의 방출 바이트는 불변(buildSecurityConstFoldedInputCallClone
      // 주석 참조). string 변형은 C603과 동일하게 allowString 위치 게이트를 상속한다.
      if (inSubst) {
        const foldedInput = buildSecurityConstFoldedInputCallClone(node, prog, funcName, false);
        if (foldedInput !== null) return foldedInput;
        if (allowString) {
          const foldedStringInput = buildSecurityConstFoldedInputCallClone(node, prog, funcName, true);
          if (foldedStringInput !== null) return foldedStringInput;
        }
      }
      // C516: bare 콜이 단일식(ExprStmt) 본문의 top-level UDF를 가리키면(위치 인자 개수 정확히
      // 일치, kwargs 없음) "이 콜사이트"의 실인자 -> 파라미터명 paramEnv로 본문을 재귀 빌드해
      // 인라인한다(C367(a) UDF 콜 롱테일 잔여, wild `f_ma(close, len) => cond ? ta.ema(...) :
      // ta.sma(...)`류). C452(함수 전체 유일 콜사이트 치환)와 달리 콜사이트 개수 제약이 없다 —
      // 이 콜 자신이 실인자를 쥐고 있으므로 매 콜사이트가 독립적으로 인라인된다. 본문(only.expr)은
      // FuncDecl로서 정상 analyzeExpr를 이미 거쳤으므로(top-level '=' 변수 값과 동일 근거)
      // inSubst=true. 중첩 인라인(이미 다른 인라인 본문 안, paramEnv!==null)은 범위 밖 — 그
      // 서브트리 안 또 다른 bare UDF 콜은 이 분기가 안 걸려 기존처럼 미지원으로 떨어진다. "fn:"
      // 방문 가드는 resolveSecurityUdfCallValue와 동일 관례(Pine 식별자는 ':' 불가라 변수명과
      // 충돌 없음) — detectRecursiveFuncCalls(전역 하드 에러)보다 이 리졸버가 먼저 돌 수 있어
      // 자체 종료를 보장해야 한다.
      // C695(배치35 (1) series-arg 잔여 — wild getKijun/getMidPoint 관용구): 단일문 본문이 ExprStmt가
      // 아니라 '=' Assignment 하나뿐인 UDF(`getMidPoint(len, off) => MidPointOffset = math.avg(...)`,
      // 마지막 줄에 별도 bare 참조 없이 대입 자체가 암묵 반환값)도 동일 근거로 인라인 대상 — 이 축은
      // 이미 resolveSecurityUdfCallValue의 컴파일타임 상수 폴딩 트랙(resolveSecurityBodyConstValue,
      // findSecurityFoldableFuncDecl이 last.kind==="Assignment"도 인정)에는 있었으나 이 일반 expr-tree
      // 빌더 트랙에는 이식돼 있지 않던 비대칭이었다. decl.body.length===1로 좁혀(다문장 본문은 여전히
      // 아래 "still rejects a multi-statement UDF body" 테스트대로 거부 — resolveSecurityBodyConstValue의
      // if/switch/누산 폴딩까지 이 트랙에 전부 이식하는 것은 범위 밖) only.value를 본문 표현식으로 삼는다.
      // C732: 기존 paramEnv === null 게이트(중첩 인라인 금지) 제거 — 인라인된 본문 안의 또 다른
      // bare UDF 콜도 재귀 인라인한다. 안쪽 콜의 실인자가 바깥 매개변수를 참조하는 경우는 entry.env
      // 캡처(SecurityParamEnvEntry.env 주석)가 해소하고, 자기/상호 재귀는 "fn:" visiting 가드가
      // 기존과 동일하게 차단한다(wild `compositeMtfEma(tf,len) => ... ta.ema(compositeSelectedSource(),
      // len) ...`류 — 0-인자 switch 셀렉터 UDF가 security-래핑 UDF 본문 안에서 호출되는 폼).
      if (node.callee.kind === "Identifier" && node.kwargs.length === 0) {
        const fnKey = `fn:${node.callee.name}`;
        if (!visiting.has(fnKey)) {
          const decl = findSecurityFoldableFuncDecl(node.callee.name, prog);
          if (decl !== undefined && decl.params.length === node.args.length) {
            const last = decl.body[decl.body.length - 1]!;
            // C732: 분기 선택(switch/if)이 필요할 때만 콜사이트 인자 const env를 구축 — 확정되는
            // 인자만 담고 나머지는 생략(선택이 그 값을 실제로 요구하면 리졸버가 자연 실패해 보수
            // 포기). 인자는 이 콜사이트 스코프(funcName)에서 해석하고, visiting은 const 트랙 자체
            // 종료 보장이 있는 별도 Set(expr 트랙의 "p:"/"v:"/"fl:" 키스페이스와 격리). 인자가
            // 바깥 인라인의 매개변수 참조면(paramEnv 활성) 그 entry의 원 실인자로 한 단계 풀어서
            // 해석한다 — const 리졸버는 SecurityParamEnvEntry env를 모르는 별도 트랙이라 여기서
            // 수동으로 언랩한다(1-hop이면 wild 실사용 전부 커버, 더 깊은 체인은 보수 포기).
            let constEnv: SecurityConstEnv = null;
            // C598 선례: 아래 const 해석이 input 유래 상수를 폴딩하며 등록하는 오버라이드 throw
            // 가드(securityTfConstGuards)는 이 인라인이 최종 실패하면 스퓨리어스라 스냅샷 이후
            // 신규분을 롤백한다(성공 시엔 정당 소비라 유지 — fail-loud).
            const guardKeysBeforeInline =
              last.kind === "SwitchStmt" || last.kind === "IfStmt" ? new Set(prog.securityTfConstGuards.keys()) : null;
            if (last.kind === "SwitchStmt" || last.kind === "IfStmt") {
              constEnv = new Map<string, SecurityConstValue>();
              for (let i = 0; i < node.args.length; i++) {
                let argForConst = node.args[i]!;
                let argScopeFunc = funcName;
                if (paramEnv !== null && argForConst.kind === "Identifier") {
                  const outerEntry = paramEnv.get(argForConst.name);
                  if (outerEntry !== undefined) {
                    argForConst = outerEntry.expr;
                    argScopeFunc = outerEntry.funcName;
                  }
                }
                // C735: 세션 폴딩 스코프 — 이 분기 선택 경로는 이미 input 유래 상수를 fail-loud
                // 가드+실패시 롤백(guardKeysBeforeInline)으로 설계했으므로(C732), input.int/float
                // defval 폴딩을 여기서도 활성화한다(wild 12d12c19ebfa `f_get_len_int(days, use_time)`).
                const cv = withSecuritySessionFold(() => resolveSecurityConstValue(argForConst, prog, new Set(), null, argScopeFunc));
                if (cv !== undefined) constEnv.set(decl.params[i]!.name, cv);
              }
            }
            const bodyValueExpr = resolveSecurityInlineBodyValueExpr(decl.body, prog, constEnv, decl.name, new Set());
            if (bodyValueExpr !== undefined) {
              // C731: 실인자는 이 콜사이트(=지금 걷는 트리)와 같은 스코프에 살아 funcName 그대로.
              // C732: 활성 paramEnv도 함께 캡처(중첩 인라인 렉시컬 캡처 — env 주석 참조).
              const inlineEnv = new Map<string, SecurityParamEnvEntry>();
              for (let i = 0; i < node.args.length; i++) inlineEnv.set(decl.params[i]!.name, { expr: node.args[i]!, funcName, env: paramEnv });
              visiting.add(fnKey);
              // C732: 본문 빌드의 funcName — 기존 단일식 경로는 호출부 funcName 그대로(기존 동작/
              // 출력 바이트 보존), 새로 열린 다문장/제어문-식 경로는 decl 자신(선행 '=' 로컬이
              // funcLocalUniqueEqVars 치환(C692)으로 풀리려면 본문 스코프가 정확해야 하고, C526
              // 섀도잉 가드도 본문 식별자에는 decl 스코프가 맞다).
              const isLegacySingle =
                decl.body.length === 1 && (last.kind === "ExprStmt" || (last.kind === "Assignment" && last.operator === "="));
              const bodyFuncName = isLegacySingle ? funcName : decl.name;
              const built = buildSecurityExprNode(bodyValueExpr, prog, callLine, visiting, taCalls, allowTa, true, histReads, false, bodyFuncName, inlineEnv, false, outerSymbol, outerTf);
              visiting.delete(fnKey);
              if (built !== null) return built;
            }
            // 인라인 최종 실패 — 분기 선택 중 등록된 신규 input 가드는 스퓨리어스라 롤백
            // (guardKeysBeforeInline 주석 참조).
            if (guardKeysBeforeInline !== null) {
              for (const k of prog.securityTfConstGuards.keys()) {
                if (!guardKeysBeforeInline.has(k)) prog.securityTfConstGuards.delete(k);
              }
            }
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export const INPUT_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  // int는 bool/string/timeframe/color(C292/C293/C295/C343)와 동일 축으로 TV 공식 시그니처가
  // minval/maxval/step 뒤(6번째 위치)에 tooltip을 둔다(C344, wild 실측 13d7d6e2ff01.pine
  // `input.int(100,"Max Labels to Keep",10,500,1,"Maximum number of persistent labels to
  // display",group=g5)`) — pine2py int_input(defval,title,minval,maxval,step,**kwargs)는 5-positional
  // 고정이라 6번째 위치 인자는 그 자신도 TypeError, 오라클 구조적 불가 hand-verified(DIVERGENCES
  // #107과 동일 축). float도 C344 당시엔 wild 근거가 없어 5슬롯이었으나(int와 형제 함수라 TV 공식
  // 시그니처가 동일 위치에 tooltip을 두는 것이 자연스럽다는 정황은 있었음) C556 wild 재실측으로
  // 6번째 위치 tooltip 실사용 12건 확인(예: `input.float(0.00001,"...",0.00001,100.0,0.5,
  // "0.00001 - 100",group="...")`) — int와 동일하게 확장(DIVERGENCES #107 축, hand-verified).
  int: ["defval", "title", "minval", "maxval", "step", "tooltip"],
  float: ["defval", "title", "minval", "maxval", "step", "tooltip"],
  // bool/string/bare input()의 tooltip/inline/(group/options)(C292, wild 실측 58건 — 이전 결정
  // "pine2py string_input(defval,title,**kwargs)가 위치 인자 2개까지만 받아 3번째 위치 인자를 주면
  // pine2py 자신도 TypeError"는 여전히 사실이지만, wild 코퍼스가 그 3번째 이후 위치에 실제로 값을
  // 채워 호출하는 실사용을 대량으로 노출했다(`input.bool(true, "Show Last", ts, '1', gv)` = defval,
  // title, tooltip, inline, group 위치 5개, `input.string(defval, title, [...options], tooltip,
  // inline)` 등) — TV 공식 레퍼런스 매뉴얼의 잘 알려진 고정 시그니처 순서와 정확히 일치한다(TV
  // 미검증 세션이지만 커뮤니티/공식 문서 통설, DIVERGENCES #107 "TV 미검증(가설)"). ta.tr(C291)과
  // 동일한 구조: pine2py 오라클이 이 위치 형태를 구조적으로 실행 못 해 오라클 불가, hand-verified.
  // 값은 title로만 lookup되고 tooltip/inline/group/options 전부 UI 메타데이터 discard(런타임 무영향,
  // runtime/input.ts 변경 0줄)라 순서를 다소 보수적으로 wild 실측 최대 위치까지만 채운다(TV 전체
  // 시그니처의 confirm/display/active는 위치 슬롯 wild 근거가 없어 이번 슬라이스 범위 밖 — 이미
  // kwarg로는 INPUT_META_KWARG_NAMES가 전 method 공통 허용 중이라 실사용 손실 없음, C348이 active를
  // 그 집합에 추가).
  bool: ["defval", "title", "tooltip", "inline", "group"],
  // string은 TV 공식 시그니처가 options를 title 바로 뒤(3번째 위치)에 둔다 — enum과 동일한 진짜
  // 위치 슬롯이지만, 값 자체는 여전히 discard(아래 INPUT_DISCARD_SLOT_NAMES가 codegen에서 항상
  // "undefined"로 방출 — options가 배열 리터럴이라 genExpr에 그대로 못 넘기는 기존 제약,
  // C258 주석 원리 재사용). group도 bool(C292)과 동일하게 6번째 위치 슬롯으로 열었다(C295, wild
  // 실측 `input.string(defval,title,[...options],tooltip,inline,group)` — TV 공식 시그니처
  // 순서 그대로).
  string: ["defval", "title", "options", "tooltip", "inline", "group"],
  // color도 bool/string(C292/C295)과 동일한 축 — TV 공식 시그니처가 title 바로 뒤(3번째 위치)에
  // tooltip을 둔다(C343, wild 실측 `input.color(color.rgb(...), "Neutral Color", "This doubles
  // as the solid color.", group="Color")`/`input.color(clr5, "Default", "Text Colors", inline=i1,
  // group=g1, ...)` — inline/group은 이 두 파일 모두 kwarg로만 쓰여 위치 슬롯 확장 근거가 아직
  // 없다, wild 실측 최대 위치까지만 채우는 기존 원칙 유지).
  color: ["defval", "title", "tooltip"],
  source: ["defval", "title"],
  symbol: ["defval", "title"],
  // timeframe도 string(C292)과 동일하게 TV 공식 시그니처가 options를 title 바로 뒤(3번째 위치)에
  // 둔다(C293 wild 실측: `input.timeframe('5', 'Resolution', ['1','3','5',...])`) — 값은 여전히
  // discard(INPUT_DISCARD_SLOT_NAMES가 codegen에서 항상 "undefined"로 방출).
  timeframe: ["defval", "title", "options"],
  session: ["defval", "title"],
  price: ["defval", "title"],
  text_area: ["defval", "title"],
  time: ["defval", "title"],
  // bare input()도 TV 공식 시그니처가 title 다음에 tooltip을 둔다(options는 없음 — 타입 자동추론이라
  // enum류 드롭다운 개념 자체가 없음, C133 기존 결정 유지). wild 실측 최대 위치가 tooltip까지라
  // 거기서 멈춘다(bool/string과 동일 원칙).
  any: ["defval", "title", "tooltip"],
  enum: ["defval", "title", "options"],
};

// bool/string/bare input()의 새 위치 슬롯(C292) 중 값이 실제로 런타임에 영향을 주면 안 되는 순수
// UI 메타데이터 이름 — enum/string의 기존 "options" discard 원칙(C258)을 group/tooltip/inline까지
// 일반화한 것. codegen의 genCallExpr input.* 분기가 이 집합에 속한 슬롯은 위치로 왔든 kwarg로
// 왔든 항상 리터럴 "undefined"로 방출한다(런타임 input.ts 시그니처 변경 없이 그대로 discard).
export const INPUT_DISCARD_SLOT_NAMES: ReadonlySet<string> = new Set(["options", "tooltip", "inline", "group"]);

// input.* UI 메타데이터 kwargs(C283, wild 코퍼스 1위 클러스터 "'X'에 없는 인자 이름" 1,974건의
// 지배 서브클러스터 — input.int|group 887 / input.bool|group 451 / tooltip/inline/confirm/display
// 다수). TV 입력 다이얼로그 표시 전용이라 계산에 무영향이고, pine2py input_funcs.py의 전 함수가
// `**kwargs`로 흡수만 하고 본문에서 전혀 소비하지 않음을 python 직접 실행으로 실증(metadata를 줘도
// 반환값은 defval 그대로). string의 options(C258)와 동일하게 **위치 슬롯이 아니라 kwarg 전용**으로
// 허용한다 — INPUT_PARAM_NAMES에 넣으면 maxArgs가 밀려 위치 인자 매핑이 깨진다. codegen은
// paramNames 슬롯만 순회해 방출하므로 이 이름들은 최종 JS에 아예 실리지 않는다(값 discard).
// pine2py는 Python **kwargs 특성상 "아무 이름이나" 흡수하지만 그건 언어 부작용이지 TV 시맨틱이
// 아니므로(C107 원칙) blanket 허용 대신 wild 실측에 나온 메타데이터 이름만 큐레이션한다.
// 전 method 균일 적용은 TV의 method별 정확한 signature보다 약간 관대하다(LIMITATIONS.md C283).
// active=(C348, wild "'X'에 없는 인자 이름" 클러스터 재분류 결과 80건 중 51건/64%로 압도적 지배 --
// 다른 input의 bool 값에 따라 이 입력을 설정 다이얼로그에 표시할지 여부를 결정하는 TV v5 조건부
// 표시 kwarg, 계산에 무영향인 순수 UI 메타데이터라 group/tooltip과 동일 축).
// minval/maxval/step(C349, 잔여 29건 클러스터의 input()|minval(3)+input()|step(1) 재분류 --
// bare input()은 C131~C133이 int/float/bool/string 4종에만 이 세 이름을 위치 슬롯으로 주고
// "any"(bare 호출)에는 tooltip까지만 채운 뒤 넘어간 단순 범위 누락(의도적 거부 근거 없음, C133
// 주석은 options만 다룸). wild 전체 재검색 결과 클러스터 3건보다 훨씬 넓게 퍼져있음(bare input()
// minval= 28건/maxval= 14건/step= 5건, first-error 집계 특성상 빙산의 일각) -- 대부분 title 뒤에
// 곧장 `input(3, title="[ST] Factor", minval=1, maxval=100)`류 정당한 위치로 나타나 int/float가
// 이미 지원하는 것과 같은 값을 bare 호출에도 준 실사용. int/float는 이미 이 세 이름을 실제 위치
// 슬롯(INPUT_PARAM_NAMES)으로 갖고 있어 그쪽 kwarg는 paramIndex 경로가 먼저 잡으므로(analyzeInputCall
// 위 isMetaKwarg 조건의 `!paramIndex.has(kw.name)` 가드) 이 추가와 무충돌 -- bool/string/color 등
// 나머지 method에는 group/tooltip처럼 순수 kwarg 전용 discard로만 새로 열린다(C283 "전 method 균일
// 적용은 TV의 method별 정확한 시그니처보다 약간 관대" 원칙 재적용). options는 이번 범위 밖 유지(C133이
// "타입 자동추론이라 드롭다운 개념 자체가 없음"으로 명시적 근거를 남긴 결정이라 재검토 없이 유지,
// wild 실측 9건은 next_hint로 인계 -- 그 중 상당수가 `type=integer`류 v3/v4 레거시 표기와 공존해
// 별도 축 오염 가능성 있음, LIMITATIONS.md C349 참조).
export const INPUT_META_KWARG_NAMES: ReadonlySet<string> = new Set([
  "group",
  "tooltip",
  "inline",
  "confirm",
  "display",
  "active",
  "minval",
  "maxval",
  "step",
]);
// options=[...] kwarg를 받는 method 집합 — string(C258 최초)에 wild 실측(int|options 34,
// timeframe|options 11, session|options 7)로 확인된 int/float/timeframe/session을 추가(TV v5
// 레퍼런스의 options 지원 목록과 일치). enum은 options가 진짜 위치 슬롯(INPUT_PARAM_NAMES.enum)이라
// 이 집합 대상이 아니고, bare input()은 TV에 options가 없어 계속 거부(C258 기존 테스트 유지).
export const INPUT_OPTIONS_KWARG_METHODS: ReadonlySet<string> = new Set(["string", "int", "float", "timeframe", "session"]);

// ticker.new/modify/renko의 kwargs 이름표(C385, next_hint(C384) 1순위 — wild gate(220) 클러스터
// 재분포 상위 3종). 8종 전부(new/standard/modify/heikinashi/renko/kagi/linebreak/pointfigure) 중
// wild kwargs 실사용은 이 3종뿐(standard/heikinashi/kagi/linebreak/pointfigure는 0건 — C283
// "wild 실측만 큐레이션" 원칙대로 나머지는 blanket 거부 유지). runtime/ticker.ts의
// newTicker(prefix,ticker,session,adjustment)/modify(tickerid,session,adjustment)/
// renko(symbol,style,atr_length,box_size)는 각각 첫 1~2개 인자만 반환값에 실제로 쓰이고 나머지는
// pine2py wavealgo/__init__.py L228-251 원본부터 무시되는 순수 discard 파라미터라(python 소스
// 직접 확인) 이름/위치가 TV 실제 시그니처와 달라도 안전 — 단 반환값에 쓰이는 첫 슬롯(new의
// prefix/ticker, modify의 tickerid, renko의 symbol)만큼은 정확한 위치로 낮춰야 한다(C129 원칙,
// 안 그러면 `ticker.new(prefix=x, ticker=y)`류가 빈 문자열로 조용히 틀어짐). 이름 목록은 wild
// corpus 실측 그대로(scratch/probe_c371_kwarg_cluster.mjs 재실행 + corpus grep) — new는
// prefix/ticker/session만 관측(adjustment= 0건, C381의 currency= 제외 원칙과 동일하게 미지원
// 유지), modify는 tickerid/session/adjustment/backadjustment 4종(backadjustment는 TV의 실제
// futures 연속계약 파라미터로 pine2py 시그니처엔 없으나 어차피 discard라 runtime에 4번째 인자로만
// 추가), renko는 symbol/style/param/source/request_wicks 5종(TV 실제 파라미터명이 pine2py의
// atr_length/box_size와 이름이 달라 — style만 일치, param/source/request_wicks는 pine2py 시그니처
// 자체에 없음 — symbol 외엔 어차피 discard라 이름 불일치가 무해).
export const TICKER_KWARG_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  new: ["prefix", "ticker", "session"],
  modify: ["tickerid", "session", "adjustment", "backadjustment"],
  renko: ["symbol", "style", "param", "source", "request_wicks"],
};

// math.abs/round/sign(number=/precision=) kwargs(C404, next_hint(C403) 1순위 재세분류 — 원 힌트는
// abs/round/max/min/sign 5종을 지목했으나, wild corpus 재확인 결과 math.max/min이 자기 자신의
// kwarg로 'number='을 받은 경우는 0건(전부 `math.max(x, math.round(number=...))`처럼 **중첩**
// math.abs/round 호출의 kwarg였을 뿐 — `grep -rEo 'math\.(max|min)\([^,)]*number\s*='` 재확인,
// TV 실제 시그니처도 max/min은 number1/number2 가변 명명이라 이 표와 애초에 다른 축)이라 3종만
// 채택. python inspect.signature 재확인 결과 3종 전부 어떤 kwarg 이름을 줘도 pine2py가 크래시하는
// 축이다(abs=Python builtin, 키워드 인자 자체를 받지 않음 `abs() takes no keyword arguments`/
// round=wavealgo pine_round(value, precision=0)의 실제 첫 파라미터명이 'value'라 'number='을
// 넘기면 TypeError, wild 실사용은 항상 number=까지 명시적으로 써서(fab0b2ffba07.pine 등) precision=
// 만 이름이 일치해도 이 조합으로는 오라클 불가/sign=wavealgo sign(x)의 실제 파라미터명이 'x')
// ta.crossover/alma/pivotlow(C401)/atr(C402)와 동일하게 오라클 대신 codegen 동치성 hand-verified로
// 검증한다. rt.abs/round/sign(runtime/numeric.ts)는 전부 위치 인자만 받는 순수 함수라 pine2py
// 내부 파라미터명 불일치가 pine2js 자신의 codegen에는 영향이 없다 — 표는 TV가 wild에서 실제로 쓰는
// kwarg 이름(number/precision) 그대로 이름/중복/위치·키워드 충돌 검증에만 쓰인다.
export const MATH_KWARG_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  abs: ["number"],
  round: ["number", "precision"],
  sign: ["number"],
  // ceil/floor(number=)(C474, next_hint(C473) — wild 3개 파일 12건 전량 `math.ceil/floor(number = ...)`
  // 완전 키워드 폼). python inspect.signature 재확인 결과 pine2py wavealgo ceil(x)/floor(x)의 실제
  // 파라미터명이 'x'라(round=value와 동일 유형) abs/round/sign과 동일하게 이름 불일치 — 오라클 대신
  // codegen 동치성 hand-verified로 검증한다. rt.ceil/floor(runtime/numeric.ts)는 위치 인자만 받는
  // 순수 함수라 이 이름 불일치가 codegen에는 영향 없음.
  ceil: ["number"],
  floor: ["number"],
};

// color.from_gradient(value=/bottom_value=/top_value=/bottom_color=/top_color=) kwargs(C479,
// next_hint(C478) 1순위 — pine2py wavealgo/builtins/color.py from_gradient의 실제 파라미터명
// 5개(value/bottom_value/top_value/bottom_color/top_color)가 python inspect.signature 재확인
// 결과 TV 공식 이름과 전부 정확히 일치한다 — MATH_KWARG_PARAM_NAMES류의 "이름 불일치"
// 문제조차 없는 진짜 완전 키워드 폼 오라클 축(ta.cci(C477)/str.tostring(C403)과 동일 유형).
// 5개 전부 기본값 없는 필수 위치 인자라(rgb/new와 달리 가변 인자 개수 아님) 전부 필수로 검증한다.
export const COLOR_KWARG_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  from_gradient: ["value", "bottom_value", "top_value", "bottom_color", "top_color"],
};

// nz(source=/replacement=) kwargs(C405, next_hint(C404) 1순위 — wild grep 재확인 8개 파일:
// 'source='이 항상 함께 쓰이고(단독 또는 replacement=와 조합), positional value + 'replacement='
// 단독 폼도 1건(22fe43610207.pine `nz(index[1], replacement = -1)`)). python inspect.signature
// 재확인 결과 pine2py wavealgo core.nz의 실제 첫 파라미터명이 'value'인데 wild는 항상 'source='을
// 씀(math.round precision= 사례와 동일한 부분 오라클 축) — replacement=만 이름이 일치해 오라클
// 가능, source=는 그대로 넘기면 TypeError로 크래시(구조적 불가, codegen 동치성 hand-verified
// 대체). 표는 이름/중복/위치·키워드 충돌 검증에만 쓰인다 — nz는 namespace 없는 bare 콜이라 표는
// MATH/STR/TICKER처럼 Record가 아니라 단일 함수용 배열이다.
export const NZ_KWARG_PARAM_NAMES: readonly string[] = ["source", "replacement"];

// timeframe.in_seconds(timeframe=) kwarg(C405, next_hint(C404) 1순위 — wild 2개 파일). python
// inspect.signature 재확인 결과 pine2py wavealgo timeframe_in_seconds의 실제 파라미터명이 정확히
// 'timeframe'이라(codegen.py L1709 `wa.timeframe_in_seconds` 매핑 대상 재확인) math.*/nz와 달리
// 이름 불일치 없이 완전 키워드 폼까지 오라클 가능. from_seconds는 wild kwarg 실사용 0건이라
// 미확장(기존 위치 인자 전용 유지).
export const TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES: readonly string[] = ["timeframe"];

// runtime.error/warning(message=) kwarg(C472, next_hint(C471) 지시대로 잔여 클러스터 개별 재확인 —
// wild 3개 파일 전량이 정확히 `runtime.error(message = "...")`/`runtime.error(message="..." + var +
// "...")` 형태). python inspect.signature 재확인 결과 pine2py wavealgo runtime_error(message: str = "")/
// runtime_warning(message: str = "")의 실제 파라미터명이 정확히 'message'라
// TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES(C405)와 동일하게 이름 불일치 없이 완전 키워드 폼까지
// 오라클 가능.
export const RUNTIME_KWARG_PARAM_NAMES: readonly string[] = ["message"];

// bare time()/time_close(timeframe=/session=/timezone=/bars_back=) kwargs(C475/C727) — 위치 인자와
// 완전히 같은 순서의 "위치/키워드 슬롯 병합"(math.*류와 동일 원칙). pine2py엔 time()/time_close()
// 함수 자체가 없어(ctx.time/ctx.time_close bare 변수 property뿐, C299/C400 참조) 원래도 오라클
// 불가 hand-verified 축. bars_back(4번째 슬롯, C727 배치37 지시로 재평가 — 이전엔 "TV 3-파라미터
// 시그니처에 없는 이름"이라 거부했으나, wild 9개 파일 전량(4번째 위치인자 5건/키워드 4건)이 정확히
// 같은 파라미터명·위치로 쓰고 있어 TV v6 실제 시그니처로 재확정) 도입 — "그 바 자신의 시각을
// bars_back만큼 과거/미래로 이동해 같은 timeframe/session/timezone으로 재계산"으로 설계
// (runtime/context.ts timeAtBarsBack 참조, TV 미검증(가설), DIVERGENCES #219).
export const TIME_CALL_KWARG_PARAM_NAMES: readonly string[] = ["timeframe", "session", "timezone", "bars_back"];

// timestamp(...) kwargs(next_hint(C405) 1순위) — pine2py wavealgo.timestamp(*args)는 순수 위치
// 전용(python 직접 실행 재확인, `def timestamp(*args) -> int`, docstring만 `timestamp(year, month,
// day, hour=0, minute=0, second=0)` / `timestamp(timezone, year, month, day, hour=0, minute=0,
// second=0)` 두 형태를 문서화할 뿐 실제로는 어떤 키워드 인자도 구조적으로 못 받는다 — math.*/nz류의
// "이름 일치 부분만 오라클"과도 다른 100% hand-verified 축, codegen 동치성으로 대체). pine2js 자신의
// rt.timestamp(runtime/numeric.ts)는 tz-first 2-오버로드 + dateString 1-오버로드(C289)를 args[0]의
// **런타임 타입**(string 여부)으로 판별한다 — 'timezone' kwarg 이름이 주어지면(또는 위치 인자로
// tz 값이 먼저 온 경우) 반드시 슬롯 0(맨 앞)으로 가야 이 판별과 합치하는데, year/month/day 등의
// 슬롯 인덱스 자체가 timezone 유무에 따라 통째로 밀린다(tz 있으면 year=슬롯1, 없으면 year=슬롯0) —
// 그래서 MATH_KWARG_PARAM_NAMES류처럼 "표 순서 = 고정 슬롯 인덱스" 패턴을 그대로 못 쓰고, 어느 표를
// 쓸지부터 콜사이트마다 동적으로 고르는 전용 리졸버가 필요(wild 실사용 5파일 실측: (a)
// `timestamp(syminfo.timezone, year=..., month=..., ...)` 위치 tz + 키워드 나머지 혼합/(b)
// `timestamp(year=2024, month=1, ...)` tz 없는 완전 키워드/(c) `timestamp(timezone="...",
// year=..., ...)` tz도 키워드인 완전 키워드/(d) `timestamp(dateString="...")` — 4종 전부 이
// 리졸버로 커버됨을 wild 소스 직접 대조로 확인).
export const TIMESTAMP_DATESTRING_SLOT: readonly string[] = ["dateString"];
export const TIMESTAMP_WITH_TZ_SLOTS: readonly string[] = ["timezone", "year", "month", "day", "hour", "minute", "second"];
export const TIMESTAMP_WITHOUT_TZ_SLOTS: readonly string[] = ["year", "month", "day", "hour", "minute", "second"];

// 콜사이트 하나가 어느 슬롯 표를 써야 하는지 판별하는 순수 함수 — analyzer/codegen이 각자 독립
// 호출해도 항상 같은 결과(analyzer가 이미 통과시킨 콜사이트만 codegen이 재계산하므로 안전, C400
// resolveTaKwargPositions와 동일 원칙). 'dateString' 키워드가 있으면 그 오버로드 전용, 그 외엔
// 위치 인자가 1개라도 있거나(맨 앞이 곧 tz 슬롯) 'timezone' 키워드가 있으면 tz-포함 표, 아니면
// tz-미포함 표.
export function resolveTimestampKwargSlots(expr: CallExpr): readonly string[] {
  const kwargNames = new Set(expr.kwargs.map((kw) => kw.name));
  if (kwargNames.has("dateString")) return TIMESTAMP_DATESTRING_SLOT;
  if (expr.args.length > 0 || kwargNames.has("timezone")) return TIMESTAMP_WITH_TZ_SLOTS;
  return TIMESTAMP_WITHOUT_TZ_SLOTS;
}

// input.* 인자개수/kwargs 검증 공통 로직(C133) — namespace 호출(input.color 등, DotAccess 분기
// 아래)과 bare input()(any_input, Identifier 콜 분기) 양쪽에서 재사용한다. paramNames 표
// 하나로 인자개수 상한 + 모르는 이름/중복 지정/위치·키워드 충돌 셋 다 검증(UDT `.new()` kwargs,
// C129와 동일한 세 가지 검증)하고 builtinCalls에 `input.<method>`로 등록한다(codegen.ts
// genCallExpr가 이 접두어로 $.inputs 암묵 주입 여부를 판별). errorLabel은 사용자가 실제로 쓴
// 호출 표기(namespace는 "input.color", bare는 "input()")를 에러 메시지에 그대로 반영하기 위한
// 것으로, builtinCalls 등록 키(항상 "input.<method>")와는 별개다.
function analyzeInputCall(expr: CallExpr, method: string, errorLabel: string, prog: AnalyzedProgram): void {
  const paramNames = INPUT_PARAM_NAMES[method]!;
  const maxArgs = paramNames.length;
  if (expr.args.length > maxArgs) {
    prog.errors.push(
      `'${errorLabel}' call argument count mismatch: requires 0~${maxArgs}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
    );
  } else {
    const paramIndex = new Map(paramNames.map((name, i) => [name, i]));
    const seenKwargNames = new Set<string>();
    for (const kw of expr.kwargs) {
      // kwarg 전용 메타데이터 이름(C258 string options → C283 일반화: group/tooltip/inline/confirm/
      // display 전 method + options 지원 method 집합)은 paramNames 위치 슬롯표에 없다(위
      // INPUT_META_KWARG_NAMES 주석 참조 — 위치 슬롯으로 넣으면 maxArgs가 밀려 위치 인자 매핑이
      // 깨짐) — kwarg 이름 자체는 여기서 별도로 허용하고 위치-키워드 충돌 검사는 애초에 위치
      // 슬롯이 없으니 성립하지 않는다. enum의 options는 진짜 위치 슬롯이라 paramIndex 경로가 먼저
      // 잡아 이 분기에 오지 않는다(집합 조건도 enum 미포함이라 이중 안전).
      const isMetaKwarg =
        INPUT_META_KWARG_NAMES.has(kw.name) || (kw.name === "options" && INPUT_OPTIONS_KWARG_METHODS.has(method));
      // C762: 메타 kwarg 중 'options'를 뺀 나머지(group/tooltip/inline/confirm/display/active)는
      // codegen이 항상 discard(INPUT_DISCARD_SLOT_NAMES, "undefined" 방출)하는 순수 UI 힌트라
      // 런타임에 전혀 안 읽힌다 — 중복 지정돼도 어느 쪽이 "이기든" 결과가 같으므로(무해) 값 비교
      // 없이 항상 허용한다. options는 배열 리터럴이라 값 동일성 판단이 이 슬라이스 범위 밖
      // (isHarmlessArgDup 미지원 kind) — 기존 무조건 거부 유지.
      if (isMetaKwarg && !paramIndex.has(kw.name)) {
        if (kw.name === "options" && seenKwargNames.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        }
        seenKwargNames.add(kw.name);
        continue;
      }
      const idx = paramIndex.get(kw.name);
      if (idx === undefined) {
        prog.errors.push(`unknown argument name for '${errorLabel}': '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (kw.name === "defval" || kw.name === "options") {
        // defval은 실제로 계산에 쓰이는 값, options는 배열이라 값 동일성 판단 불가 — 이 둘만 기존
        // 값 비교(위치-키워드) / 무조건 거부(키워드-키워드) 시맨틱을 유지한다. C762가 아래로 넓힌
        // "이름 무조건 허용"의 유일한 예외.
        if (seenKwargNames.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
          prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
      }
      // C762: title/minval/maxval/step/tooltip(위치 슬롯 버전) 등 defval/options 이외의 모든
      // 위치 슬롯은 runtime/input.ts에서 확인: title은 오버라이드-키로만 쓰이고 corpus/production
      // 실행은 항상 overrides={}라 값이 뭐든 결과가 같고, minval/maxval/step은 `_minval`/
      // `_maxval`/`_step` 언더스코어 접두 매개변수로 애초에 읽히지 않는다 — 중복이 값 일치
      // 여부와 무관하게 무해하다.
      seenKwargNames.add(kw.name);
    }
  }
  prog.builtinCalls.set(expr, `input.${method}`);
}

// strategy.risk.max_drawdown(value, type)/max_intraday_loss(value, type)(C322) — 둘 다 정확히
// 같은 2-파라미터(value, type) 계약이라 MEMORY.md C26("형제 함수 간 검증 비대칭 방지")에 따라
// 검증 로직을 함수 하나로 공유한다. wild 실사용에 위치 인자만(2개)/키워드만(value=/type=)/혼용
// (`max_drawdown(cond ? a : b, type=strategy.cash)`) 세 형태가 전부 나타나 max_intraday_filled_orders
// 의 "위치 또는 키워드 하나" 이분법보다 한 단계 넓은 "이름별로 위치 또는 키워드 중 하나" 해석이
// 필요하다. allow_entry_in/max_intraday_filled_orders와 동일하게 strategy.risk.*는
// STRATEGY_RUNTIME_PROPS에 없는 프로퍼티라 공용 꼬리의 analyzeExpr(callee.obj) 재귀에 맡기면 안
// 되므로(MEMORY.md C173) 호출부에서 인자만 분석하고 즉시 return해야 한다.
function analyzeStrategyRiskThresholdCall(expr: CallExpr, displayName: string, prog: AnalyzedProgram, scope: LexScope): void {
  // C771 — strategy.* 전반과 동일하게 선행 strategy() 선언 불필요(analyzer.ts strategy.* 단일
  // 레벨 분기 주석 참조, wild tv_verdict 실측).
  if (!prog.stmtCalls.has(expr)) {
    prog.errors.push(
      `'${displayName}' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
    );
  } else {
    if (expr.args.length > 2) {
      prog.errors.push(
        `'${displayName}' call argument count mismatch: requires 2 (value, type), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const seen = new Set<string>();
    if (expr.args.length >= 1) seen.add("value");
    if (expr.args.length >= 2) seen.add("type");
    for (const kw of expr.kwargs) {
      if (kw.name !== "value" && kw.name !== "type") {
        prog.errors.push(`'${displayName}' only supports keyword arguments 'value='/'type=': '${kw.name}=' (L${kw.line}:${kw.col})`);
      } else if (seen.has(kw.name)) {
        const posArg = kw.name === "value" ? expr.args[0] : expr.args[1];
        if (!isHarmlessArgDup(posArg, kw.value)) {
          prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
      } else {
        seen.add(kw.name);
      }
    }
    if (!seen.has("value") || !seen.has("type")) {
      prog.errors.push(`'${displayName}' call requires both value and type arguments (L${expr.line}:${expr.col})`);
    }
  }
  prog.builtinCalls.set(expr, displayName);
  for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
  for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
}

export function analyzeCallExpr(expr: CallExpr, prog: AnalyzedProgram, scope: LexScope, topLevel: boolean): void {
  const { callee } = expr;
  // 키워드 인자(`name=value`)는 UDT 생성자 호출(`TypeName.new(...)`, C129)과 input.int/float/
  // bool/string(C132) 두 곳에서만 의미가 있다 — 그 외 호출(UDF/method/나머지 빌트인)에서 kwargs가
  // 하나라도 있으면 여기서 미리 하드 에러로 거부해, 아래 각 분기가 개별적으로 kwargs 지원 여부를
  // 신경 쓸 필요가 없게 한다(파서는 문법만 인식하고 의미는 analyzer가 부여한다는 원칙, C126 등
  // 필드 타입 검증과 동일 구조). 이 판별은 아래 namespace/method 계산과 같은 조건이지만 그 지역
  // 변수들이 아직 선언되기 전이라 callee를 직접 재확인한다.
  const isUdtConstructorCall =
    callee.kind === "DotAccess" &&
    callee.attr === "new" &&
    callee.obj.kind === "Identifier" &&
    prog.udtTypes.has(callee.obj.name);
  // 사용자 정의 함수 호출의 키워드 인자(C396, wild "지원하지 않는 호출"/"키워드 인자" 클러스터
  // 재조사 — source=/length=/x=/leftbars= 등 UDF 매개변수 이름 모양 kwarg가 106건 중 다수를 차지함을
  // 확인, TV v5는 UDF 호출도 named argument를 지원하는 진짜 문법인데 analyzeUserFuncCall이 지금까지
  // expr.kwargs를 아예 안 봐서 이 blanket 거부에 걸려 있었다). 이 판별은 top-level 함수 이름의
  // 직접 Identifier 콜만 대상 — method(receiver, ...) 형태의 bare method-as-function 호출(C267)은
  // wild 실사용이 희박하고 첫 인자 UDT 타입 추론이 이 시점에 아직 안 끝나 범위 밖으로 유지(기존과
  // 동일하게 kwargs 있으면 계속 거부).
  const isUserFuncCall = callee.kind === "Identifier" && prog.funcs.has(callee.name);
  const isInputKwargsCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "input" &&
    Object.prototype.hasOwnProperty.call(INPUT_PARAM_NAMES, callee.attr);
  // bare `input(...)`(pine2py any_input, C133) — namespace 없는 Identifier 콜이라 위
  // isInputKwargsCall(DotAccess 전제)과 별도 판별이 필요하다.
  const isBareInputCall = callee.kind === "Identifier" && callee.name === "input";
  // bare `plot(...)`(C159, ROADMAP line 1962) — PLOT_PARAM_NAMES 예외 추가.
  const isPlotCall = callee.kind === "Identifier" && callee.name === "plot";
  // bare `indicator(...)`/`strategy(...)`/`library(...)`(C160, LIMITATIONS.md C151 발견 — library는
  // C274가 추가, study는 C399가 v4 legacy 별칭으로 추가) — DIRECTIVE_PARAM_NAMES 예외 추가. topLevel
  // 무관하게(isPlotCall과 동일 이유) 여기서는 이름만 판별 — non-topLevel 호출은 아래 분기 조건
  // (`&& topLevel`)을 못 타 기존과 동일하게 "알 수 없는 함수 호출"로 계속 거부됨.
  const isDirectiveCall =
    callee.kind === "Identifier" &&
    (callee.name === "indicator" || callee.name === "strategy" || callee.name === "library" || callee.name === "study");
  // `strategy.entry(...)`의 qty=/comment= kwargs(C164 둘째 슬라이스) + `strategy.exit(...)`의
  // from_entry=/limit=/stop=(C167 다섯째 슬라이스)/qty=(C168)/trail_points=/trail_offset=(C170
  // 트레일링 스톱) + `strategy.close(...)`의 qty=/
  // comment=와 `strategy.close_all(...)`의 comment=(C168 여섯째 슬라이스) + `strategy.order(...)`
  // (C169 — entry와 동일 kwargs) — 여기서는 호출 모양만
  // 판별해 blanket 거부에서 빼고, 이름/중복/위치-키워드 충돌 검증은 아래 strategy.* 분기가
  // 수행한다(strategy.cancel/cancel_all은 예외 대상이 아니라 kwargs가 있으면 여기서 그대로 거부됨).
  const isStrategyOrderCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "strategy" &&
    (callee.attr === "entry" ||
      callee.attr === "order" ||
      callee.attr === "exit" ||
      callee.attr === "close" ||
      callee.attr === "close_all");
  // `request.security(...)`의 gaps=/lookahead= kwargs(C177, request.security 둘째 슬라이스) —
  // blanket 거부 예외에 추가. 이름/값 검증(boolean 리터럴 또는 barmerge.* 상수만, 그 외 kwarg 이름
  // 거부)은 아래 request.security 전용 분기가 수행한다.
  const isRequestSecurityCall =
    callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "request" && callee.attr === "security";
  // `request.security_lower_tf(symbol=, timeframe=, expression=, ignore_invalid_symbol=,
  // ignore_invalid_timeframe=, calc_bars_count=)`(C381, next_hint(C380) 1순위 — wild gate(220)
  // 클러스터 재분포 1위, 순증 상한 8건). pine2py wavealgo/__init__.py request_security_lower_tf()
  // (L104-113)가 전부 named parameter(**kwargs 흡수 아님)이나 expression 외엔 본문에서 100% 미사용인
  // 순수 스텁 — 단 request.security류의 ignore_invalid_symbol=/currency=(C376)와 달리 이 콜은 codegen이
  // 커스텀 슬롯이 아니라 범용 위치 인자 폴백(`rt.request.security_lower_tf(...args)`)을 타므로
  // expression=처럼 값이 실제로 출력에 실리는 kwarg는 위치 슬롯으로 낮추는 codegen 변경이 필요하다
  // (strategy.entry류 KWARG_SLOTS와 동일 원리). blanket 거부 예외에 추가 — 이름/중복/위치·키워드 충돌
  // 검증은 아래 request.security_lower_tf 전용 분기가 수행한다.
  const isRequestSecurityLowerTfCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "request" &&
    callee.attr === "security_lower_tf";
  // `request.financial(symbol=, financial_id=, period=, gaps=, lookahead=, ignore_invalid_symbol=)`
  // (C385, next_hint(C384) 1순위 — wild gate(220) 클러스터 재분포 2위, 순증 상한 4건). pine2py
  // wavealgo/__init__.py request_financial()(L118-120)은 인자 전부(위치·kwargs 무관, **kwargs
  // 포함) 완전히 무시하고 항상 float('nan')만 반환하는 순수 상수 스텁(python 소스 직접 확인 — 조건
  // 분기 자체가 없음) — request.dividends/splits(C239)와 같은 이유로 기존엔 blanket 거부 예외에
  // 안 넣었으나(주석 L1798-1812대로 "kwargs 지원 실익 없음"), 이번엔 C381/C384와 같은 축(값은
  // discard해도 kwargs 문법 자체는 wild가 실제로 쓰므로 파싱만 허용)으로 재평가해 뒤집는다. 반환값이
  // 항상 상수라 request.security_lower_tf와 달리 위치-슬롯 낮춤(KWARG_SLOTS) 자체가 불필요 —
  // codegen 범용 fallback(위치 인자만 방출, C211)이 kwargs를 그대로 버려도 출력이 이미 옳다. 이름/
  // 중복 검증은 아래 request.financial 전용 분기가 수행한다.
  const isRequestFinancialCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "request" &&
    callee.attr === "financial";
  // `request.earnings(ticker=, field=, gaps=, lookahead=, ignore_invalid_symbol=)`(C397, next_hint(C396)
  // 1순위 — wild kwarg 블랑켓 잔여 94건 재세분류 결과 ignore_invalid_symbol= 21건/gaps= 3건 =
  // 24건으로 최다. pine2py wavealgo/__init__.py request_earnings(ticker=None, field=None, gaps=False,
  // lookahead=False, **kwargs)(L130-132)이 dividends/splits(C239)와 완전히 동일한 형태의 순수
  // 스텁(인자 전부 무시, 항상 0.0 반환) — request.financial과 동일 원칙으로 blanket 거부 예외에
  // 추가하고 이름/중복 검증만 하고 값은 discard. 위치 인자 최대 4개(ticker/field/gaps/lookahead,
  // dividends/splits와 동일 시그니처 shape). 이름/중복 검증은 아래 request.earnings 전용 분기가 수행한다.
  const isRequestEarningsCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "request" &&
    callee.attr === "earnings";
  // `request.dividends(ticker=, field=, gaps=, lookahead=, ignore_invalid_symbol=)`/
  // `request.splits(...)`(C398, next_hint(C397) 1순위 — wild 20건이 정확히
  // `request.dividends(syminfo.tickerid, dividends.gross, barmerge.gaps_on, barmerge.lookahead_on,
  // ignore_invalid_symbol=true)` 폼(+1건 gaps= 단독). C397이 request.earnings에 적용한 것과 완전히
  // 동일한 패턴 — pine2py wavealgo/__init__.py L122-128 request_splits/request_dividends(ticker=None,
  // field=None, gaps=False, lookahead=False, **kwargs)가 순수 스텁(인자 전부 무시, 항상 0.0 반환)이라
  // 반환값 검증 없이 이름/중복만 확인하면 됨. 위치 인자 최대 4개(ticker/field/gaps/lookahead,
  // earnings/financial과 동일 시그니처 shape). 이름/중복 검증은 아래 request.dividends/splits
  // 전용 분기가 수행한다.
  const isRequestDividendsOrSplitsCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "request" &&
    (callee.attr === "dividends" || callee.attr === "splits");
  // `color.new(colorVal, transp=...)`(C371, wild kwarg 게이트 클러스터 1위 62/220건 — corpus 실측
  // 187/206건이 이 kwarg 형태) — TV 공식 시그니처 두 번째 위치 인자 'transp'를 키워드로도 받는다.
  // blanket 거부 예외에 추가. 이름/중복 검증은 아래 color 분기(method === "new")가 수행한다.
  const isColorNewCall =
    callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "color" && callee.attr === "new";
  // `color.from_gradient(value=..., bottom_value=..., top_value=..., bottom_color=..., top_color=...)`
  // (C479, COLOR_KWARG_PARAM_NAMES 참조) — blanket 거부 예외에 추가. 이름/중복/위치·키워드 충돌/
  // 필수 인자 검증은 아래 color 분기(method === "from_gradient")가 수행한다.
  const isColorFromGradientKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "color" &&
    callee.attr === "from_gradient";
  // hline/bgcolor/.../alert/alertcondition/max_bars_back(C208) — 값이 전부 discard되는 no-op
  // 콜이라 kwarg 이름별 정밀 검증 없이 blanket 거부에서만 뺀다(위 NOOP_BUILTIN_TOPLEVEL/ANY 주석 참조).
  const isNoopBuiltinCall =
    callee.kind === "Identifier" && (NOOP_BUILTIN_TOPLEVEL.has(callee.name) || NOOP_BUILTIN_ANY.has(callee.name));
  // label/line/box/table/polyline(신규) — kwarg 이름 정밀 검증 없이 blanket 거부에서만 뺀다(위
  // DRAWING_METHODS 주석과 동일 이유, isNoopBuiltinCall과 같은 성격이지만 DotAccess 콜이라 별도 판별).
  const isDrawingCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    Object.prototype.hasOwnProperty.call(DRAWING_METHODS, callee.obj.name) &&
    DRAWING_METHODS[callee.obj.name]!.has(callee.attr);
  // method-call-sugar 형태의 drawing 콜(`dash.cell(0, 0, "x", text_color=..., text_size=...)`,
  // C384, wild gate(220) 잔여 최다 서브클러스터 — dash.cell 5/tb.cell 4/tbl.cell 2 등 사용자가 지은
  // table 변수 위 .cell() 호출, 순증 상한 16건). 위 isDrawingCall은 receiver가 리터럴 네임스페이스
  // Identifier("table" 등)일 때만 잡아 sugar 콜(receiver가 변수)은 여전히 blanket 거부에 걸렸다 —
  // array/map sugar가 kwargs 자체를 범위 밖으로 유지한 것(C222)과 같은 축이지만, 그쪽은 wild 실사용
  // 0건이라 유지된 반면 이쪽은 실사용이 있어 뒤집는다. text_color/text_size류는 순수 표시값(GOAL.md
  // drawing no-op 불변식)이라 이름 검증 없이 통째로 허용해도 안전 — 값은 기존 리터럴 폼과 동일하게
  // codegen 범용 fallback(위치 인자만 방출, C211)에서 discard된다.
  const isDrawingMethodSugarKwargsCall =
    callee.kind === "DotAccess" && isDrawingMethodSugarCall(callee.obj, callee.attr, prog, scope);
  // `strategy.risk.max_intraday_filled_orders(count=...)`(C320) — wild 실사용에 `count=` 키워드
  // 인자가 나타나(8830cf208b52.pine) blanket 거부 예외에 추가. 3-level DotAccess라 isStrategyOrderCall
  // (obj.kind===Identifier 전제)로는 못 잡아 별도 판별이 필요하다. 이름/개수 검증은 아래
  // strategy.risk.max_intraday_filled_orders 전용 분기가 수행한다.
  const isStrategyRiskMaxIntradayFilledOrdersCall =
    callee.kind === "DotAccess" &&
    callee.attr === "max_intraday_filled_orders" &&
    callee.obj.kind === "DotAccess" &&
    callee.obj.attr === "risk" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy";
  // `strategy.risk.max_intraday_loss(value=..., type=...)`/`max_drawdown(value=..., type=...)`
  // (C322) — max_intraday_filled_orders와 동일한 이유(3-level DotAccess)로 blanket 거부 예외에
  // 추가. 이름/개수/중복 검증은 analyzeStrategyRiskThresholdCall이 수행한다.
  const isStrategyRiskThresholdCall =
    callee.kind === "DotAccess" &&
    (callee.attr === "max_intraday_loss" || callee.attr === "max_drawdown") &&
    callee.obj.kind === "DotAccess" &&
    callee.obj.attr === "risk" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy";
  // year/month/.../weekofyear(time=..., timezone=...)(C326) — 위치 2-인자 폼(175건)이 압도적
  // 다수지만 2개 파일(4호출)이 time=/timezone= 키워드 폼도 씀 — blanket 거부 예외에 추가.
  // 이름/개수/중복 검증은 아래 TIME_FUNC_NAMES 분기가 수행한다.
  const isTimeFuncCall = callee.kind === "Identifier" && TIME_FUNC_NAMES.has(callee.name);
  // bare time(timeframe=/session=/timezone=)/time_close(...)(C475, TIME_CALL_KWARG_PARAM_NAMES
  // 참조) — blanket 거부 예외에 추가. 이름/개수/위치·키워드 충돌 검증은 아래 "time"/"time_close"
  // 전용 분기가 수행한다.
  const isTimeCallKwargCall = callee.kind === "Identifier" && (callee.name === "time" || callee.name === "time_close");
  // array.* 'id=' 계열 키워드 인자(C382, wild gate(220) 재분포 1위 — ARRAY_KWARG_PARAM_NAMES
  // 20종, analyzer/collections.ts 주석 참조). TV 공식 시그니처의 컨테이너 참조 인자 이름이 거의
  // 전부 'id'(wild 실측 다수 콜사이트로 확인). blanket 거부 예외에 추가 — namespace가 리터럴
  // "array"인 정적 콜만 대상(receiver-sugar `arr.size(id=)`는 wild 0건, C222 원칙대로 여전히
  // 거부). 이름/개수/위치·키워드 충돌 검증은 analyzer/collections.ts analyzeArrayCall이 수행한다.
  const isArrayIdKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "array" &&
    Object.prototype.hasOwnProperty.call(ARRAY_KWARG_PARAM_NAMES, callee.attr);
  // `strategy.cancel(id=)`(C382, wild 실측 1건 f8629b966f24.pine `strategy.cancel(id='exit'+...)`
  // — TV 시그니처의 유일한 인자 id가 위치 인자와 100% 동등한 키워드 폼, strategy.close의 id=
  // (C293)와 동일 패턴). blanket 거부 예외에 추가 — cancel_all은 TV에 id 파라미터 자체가 없고
  // wild 실사용도 0건이라 이번 슬라이스 제외 유지(아래 method==="cancel" 분기만 적용).
  const isStrategyCancelCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "strategy" &&
    callee.attr === "cancel";
  // `ticker.new/modify/renko(...)`의 kwargs(C385, TICKER_KWARG_PARAM_NAMES 참조) — blanket 거부
  // 예외에 추가. 이름/중복/위치·키워드 충돌 검증은 아래 namespace==="ticker" 전용 분기가 수행한다.
  const isTickerKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "ticker" &&
    Object.prototype.hasOwnProperty.call(TICKER_KWARG_PARAM_NAMES, callee.attr);
  // `math.abs/round/sign(number=/precision=)`(C404, MATH_KWARG_PARAM_NAMES 참조) — blanket 거부
  // 예외에 추가. 이름/중복/위치·키워드 충돌 검증은 아래 math.* 전용 분기가 수행한다.
  const isMathKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "math" &&
    Object.prototype.hasOwnProperty.call(MATH_KWARG_PARAM_NAMES, callee.attr);
  // `ta.sma/ema/rsi/highest/lowest/crossover/crossunder/change/cum/alma/pivotlow/atr/pivothigh
  // (source=/length=/source1=/source2=/leftbars=/rightbars=/offset=/sigma=...)`(C400/C402,
  // next_hint(C399/C401) — wild kwarg 블랑켓 잔여 재세분류 결과 ta.*(source=/length=/source1=/
  // source2=) kwarg 24건으로 최대 서브클러스터, atr/pivothigh는 C401 이후 캐스케이드 재노출로 추가
  // 편입). TA_REGISTRY.kwargParamNames가 등재된 함수만 예외 — ta.vwap는 C471부터 "source" 단일
  // 이름만 등재(anchor/stdev_mult는 여전히 위치 전용이라 C294가 우려한 인자 개수별 반환 arity
  // [hard] 축은 발현 불가, analyzer/ta.ts TA_REGISTRY.vwap 주석 참조). 이름/중복/위치·키워드
  // 충돌/구멍 검증은 analyzer/ta.ts analyzeStatefulCall이 수행한다.
  const isTaKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "ta" &&
    TA_REGISTRY[callee.attr]?.kwargParamNames !== undefined;
  // `str.tostring(value=/format=)`(C403, next_hint(C402) 1순위 — wild kwarg 블랑켓 최다 서브클러스터).
  // STR_KWARG_PARAM_NAMES가 등재된 str.* 메서드만 예외(현재 tostring 1종). 이름/중복/위치-키워드
  // 충돌/구멍 검증은 analyzer/collections.ts analyzeStrCall이 수행한다.
  const isStrKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "str" &&
    Object.prototype.hasOwnProperty.call(STR_KWARG_PARAM_NAMES, callee.attr);
  // `nz(source=/replacement=)`(C405, NZ_KWARG_PARAM_NAMES 참조) — blanket 거부 예외에 추가. nz는
  // namespace 없는 bare Identifier 콜이라 DotAccess 판별이 아니라 이름만 확인한다. 이름/중복/
  // 위치·키워드 충돌 검증은 아래 nz 전용 분기가 수행한다.
  const isNzKwargCall = callee.kind === "Identifier" && callee.name === "nz";
  // `fixnan(source=)`(C557, TA_REGISTRY.fixnan.kwargParamNames 참조) — blanket 거부 예외에 추가.
  // fixnan은 dispatch:"bare"라 isTaKwargCall(callee.obj.name==="ta"만 확인)에 안 걸려 nz/timestamp와
  // 동일하게 namespace 없는 bare Identifier 콜 전용 플래그가 필요하다. 이름/중복/위치·키워드 충돌
  // 검증은 기존 analyzeStatefulCall(ta.ts)이 TA_REGISTRY.kwargParamNames로 그대로 수행.
  const isFixnanKwargCall = callee.kind === "Identifier" && callee.name === "fixnan";
  // `timeframe.in_seconds(timeframe=)`(C405, TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES 참조) — blanket
  // 거부 예외에 추가. from_seconds는 표에 없어(wild kwarg 실사용 0건) 계속 blanket 거부에 걸린다.
  // 이름/중복/위치·키워드 충돌 검증은 아래 timeframe.in_seconds 전용 분기가 수행한다.
  const isTimeframeInSecondsKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "timeframe" &&
    callee.attr === "in_seconds";
  // `timestamp(year=/month=/day=/hour=/minute=/second=/timezone=/dateString=)`(C406, next_hint(C405)
  // 1순위 — resolveTimestampKwargSlots 참조). nz와 마찬가지로 namespace 없는 bare Identifier 콜.
  // 이름/중복/위치·키워드 충돌/구멍/필수 인자 검증은 아래 timestamp 전용 분기가 수행한다.
  const isTimestampKwargCall = callee.kind === "Identifier" && callee.name === "timestamp";
  // `runtime.error(message=...)`/`runtime.warning(message=...)`(C472, RUNTIME_KWARG_PARAM_NAMES
  // 참조) — blanket 거부 예외에 추가. 이름/개수/위치·키워드 충돌 검증은 아래 namespace==="runtime"
  // 분기가 수행한다.
  const isRuntimeErrorKwargCall =
    callee.kind === "DotAccess" &&
    callee.obj.kind === "Identifier" &&
    callee.obj.name === "runtime" &&
    (callee.attr === "error" || callee.attr === "warning");
  // `obj.method(kw=val)`(C408, next_hint(C407) 1순위 — dispatchUdtMethodCall이 지금까지
  // expr.kwargs를 전혀 안 봐서 blanket 거부되던 gap). UDF 호출 kwargs(C396)와 동일 원리 — 이
  // method의 실제 top-level 함수는 사용자 Pine 소스 그대로의 매개변수 이름을 갖고 있어(pine2py도
  // method를 이름 그대로 flat 함수로 옮긴다) 완전한 오라클 대조가 원칙적으로 가능한 축(순수 정적
  // 인자 바인딩 확장이라 C396처럼 hand-verified E2E로 충분, 계산 시맨틱 신규 없음). 판별은 아래
  // (L~3140) 실제 dispatch 분기가 쓰는 것과 동일한 조건 — receiver가 UDT 인스턴스(Identifier obj)
  // 또는 array 원소 UDT(C354, obj가 CallExpr) 또는 중첩 필드 체이닝 UDT(C505, obj가 DotAccess)로
  // 확정되면 이 콜은 obj.method() 형태로 유일하게 해석 가능하다는 뜻이라 kwargs도 이 시점에는
  // 형태만으로 미리 허용해도 안전(method 이름 자체가 없으면 아래 dispatch 분기가 별도로 "없는
  // method" 에러를 낸다). C505: 이 gate를 아래 dispatch 분기와 다르게 두면(C137/C431 함정) DotAccess
  // 수신자의 kwargs 콜만 blanket 거부에 계속 걸려 위치 전용으로 남는다 — 반드시 나란히 갱신.
  const isUdtMethodKwargCall =
    callee.kind === "DotAccess" &&
    (callee.obj.kind === "Identifier" || callee.obj.kind === "CallExpr" || callee.obj.kind === "DotAccess") &&
    resolveUdtMethodReceiverType(callee.obj, prog, scope) !== undefined;
  if (
    expr.kwargs.length > 0 &&
    !isUdtConstructorCall &&
    !isUserFuncCall &&
    !isInputKwargsCall &&
    !isBareInputCall &&
    !isPlotCall &&
    !isDirectiveCall &&
    !isStrategyOrderCall &&
    !isRequestSecurityCall &&
    !isRequestSecurityLowerTfCall &&
    !isRequestFinancialCall &&
    !isRequestEarningsCall &&
    !isRequestDividendsOrSplitsCall &&
    !isColorNewCall &&
    !isColorFromGradientKwargCall &&
    !isNoopBuiltinCall &&
    !isDrawingCall &&
    !isDrawingMethodSugarKwargsCall &&
    !isStrategyRiskMaxIntradayFilledOrdersCall &&
    !isStrategyRiskThresholdCall &&
    !isTimeFuncCall &&
    !isTimeCallKwargCall &&
    !isArrayIdKwargCall &&
    !isStrategyCancelCall &&
    !isTickerKwargCall &&
    !isTaKwargCall &&
    !isStrKwargCall &&
    !isMathKwargCall &&
    !isNzKwargCall &&
    !isFixnanKwargCall &&
    !isTimeframeInSecondsKwargCall &&
    !isTimestampKwargCall &&
    !isRuntimeErrorKwargCall &&
    !isUdtMethodKwargCall
  ) {
    prog.errors.push(
      `keyword arguments ('${expr.kwargs[0]!.name}=...') are only supported in 'TypeName.new(...)' UDT constructor calls, user-defined function calls, 'obj.method(...)' UDT method calls, 'input.*'/bare 'input(...)' calls, 'plot(...)' calls, 'indicator(...)'/'strategy(...)'/'study(...)' calls, 'strategy.entry/order/exit/close/close_all/cancel(...)' calls, 'request.security(...)'/'request.security_lower_tf(...)'/'request.financial(...)'/'request.earnings(...)'/'request.dividends(...)'/'request.splits(...)' calls, hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/alert/alertcondition/max_bars_back/fill calls, 'array.*(id=...)' calls (size/get/set/push/pop/... — see analyzer/collections.ts ARRAY_KWARG_PARAM_NAMES), 'ticker.new/modify/renko(...)' calls, 'ta.sma/ema/rsi/highest/lowest/crossover/crossunder/change/cum/alma/pivotlow/atr/pivothigh(...)' calls, 'str.tostring(...)' calls, 'math.abs/round/sign(...)' calls, 'nz(...)' calls, 'fixnan(...)' calls, 'timeframe.in_seconds(...)' calls, 'timestamp(...)' calls, 'runtime.error/warning(...)' calls, 'time(...)'/'time_close(...)' calls, 'color.from_gradient(...)' calls, or label/line/box/table/polyline/linefill calls (L${expr.line}:${expr.col})`,
    );
  }
  // strategy() 지시어의 kwargs 값(default_qty_type=strategy.percent_of_equity 등)이 strategy.*
  // 상수를 참조할 수 있도록 isStrategy 플래그를 아래 kwargs 값 분석보다 먼저 세운다(C171) —
  // analyzer.ts의 strategy.* DotAccess 분기는 isStrategy 게이트를 요구하는데, 이 플래그의 기존
  // 설정 지점(아래 지시어 분기)은 kwargs 분석 뒤라 선언 문장 자신의 kwarg 값이 게이트에 걸렸다.
  // "선언이 소스에서 먼저" 규칙은 이 문장 자신이 곧 선언이라 훼손 없음(지시어 분기의 기존 설정과
  // 중복 — 무해).
  if (callee.kind === "Identifier" && callee.name === "strategy" && topLevel) {
    prog.isStrategy = true;
  }
  for (const kw of expr.kwargs) {
    // input.string/input.enum의 'options=[...]'(C258, corpus 최다빈도 실사용 — 드롭다운 선택지
    // 배열, TV 실제 문법)만 예외: 일반 표현식 위치의 튜플 리터럴은 analyzer.ts가 하드 에러로
    // 거부하지만(analyzeExpr TupleExpr 케이스, "함수 마지막 문장 튜플 반환 전용"), pine2py
    // wavealgo/builtins/input_funcs.py의 대응 함수들은 options를 값으로 전혀 소비하지 않는 순수
    // 통과 메타데이터라(python 직접 실행 확인) 이 좁은 위치에서만 TupleExpr 래퍼 노드 자체를
    // analyzeExpr에 넘기지 않고 원소만 개별 검증한다(래퍼가 아니라 원소가 걸리면 예: options=[1,
    // undeclaredVar] 같은 진짜 오류는 여전히 잡힌다). codegen(genCallExpr input.* 분기)이 이
    // kwarg를 애초에 방출하지 않아(항상 "undefined") 값 자체가 런타임에 등장하지 않는다 — 위치
    // 인자로 options를 넘기는 폼(`input.enum(defval, title, [...])`)은 corpus 실측 0건이라 범위 밖.
    if ((isInputKwargsCall || isBareInputCall) && kw.name === "options" && kw.value.kind === "TupleExpr") {
      for (const el of kw.value.elements) analyzeExpr(el, prog, scope, false);
      continue;
    }
    // fill(plot1=plot(...), plot2=hline(...))(C346, wild 실사용 — TV 공식 fill() 시그니처의
    // plot1=/plot2= 키워드 인자가 bare plot()/hline() 콜을 직접 받는 관용구, C209 대입 RHS
    // (analyzeControlFlowOrExpr allowPlotFamilyRhs)와 동일 이유의 kwarg-위치 자매 예외) — 그 콜
    // 자신만 topLevel=true로 분석, 다른 kwarg/함수는 기존과 동일하게 topLevel=false 유지.
    if (
      callee.kind === "Identifier" &&
      callee.name === "fill" &&
      (kw.name === "plot1" || kw.name === "plot2") &&
      kw.value.kind === "CallExpr" &&
      kw.value.callee.kind === "Identifier" &&
      (kw.value.callee.name === "plot" || kw.value.callee.name === "hline")
    ) {
      analyzeExpr(kw.value, prog, scope, true);
      continue;
    }
    // request.security(symbol=/timeframe=/expression=)(C409) — expression= 값이 ta.* 콜을 포함할
    // 수 있어(예: expression=ta.sma(close,5)) 이 범용 사전 분석이 그 값을 표준 analyzeCallExpr
    // 경로로 먼저 analyzeStatefulCall 등록해버리면, 아래 request.security 전용 분기가 buildSecurityExpr로
    // 만든 클론을 또 등록해 taSlotCount가 이중으로 소비된다(MEMORY.md C180과 동일 클래스의 새 사례).
    // resolveSecurityLeadArgs + 그 이후 로직이 symbol/timeframe/expression 값을 전담 분석하므로 여기서는
    // 건너뛴다.
    if (isRequestSecurityCall && SECURITY_LEAD_PARAM_NAMES.includes(kw.name as (typeof SECURITY_LEAD_PARAM_NAMES)[number])) {
      continue;
    }
    analyzeExpr(kw.value, prog, scope, false);
  }
  if (callee.kind === "Identifier") {
    if ((callee.name === "indicator" || callee.name === "strategy" || callee.name === "library" || callee.name === "study") && topLevel) {
      // 인자개수/이름/중복/위치-키워드 충돌 4종 검증(input.*/plot과 동일 3+1종 — plot과 달리
      // series 같은 "표 밖" 필수 실값 인자가 없어 maxArgs가 곧 paramNames.length). 검증 결과가
      // 전부 통과해도 값 자체는 어디에도 저장하지 않는다 — directive는 prog.directives.add(expr)
      // 등록만으로 충분(codegen.ts가 이 Set 멤버십만 보고 전체를 no-op 처리, title조차 안 뽑음).
      const paramNames = DIRECTIVE_PARAM_NAMES[callee.name]!;
      const maxArgs = paramNames.length;
      if (expr.args.length > maxArgs) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires 0~${maxArgs}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else {
        const paramIndex = new Map(paramNames.map((name, i) => [name, i]));
        const seenKwargNames = new Set<string>();
        for (const kw of expr.kwargs) {
          // dynamic_requests=/max_tables_count=(C283) — kwarg 전용 discard 허용(위
          // DIRECTIVE_META_KWARG_NAMES 주석 참조). library는 집합 조건 앞의 이름 판별로 제외.
          if ((callee.name === "indicator" || callee.name === "strategy") && DIRECTIVE_META_KWARG_NAMES.has(kw.name)) {
            if (seenKwargNames.has(kw.name)) {
              prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
            }
            seenKwargNames.add(kw.name);
            continue;
          }
          const idx = paramIndex.get(kw.name);
          if (idx === undefined) {
            prog.errors.push(`unknown argument name for '${callee.name}': '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (seenKwargNames.has(kw.name)) {
            prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
          seenKwargNames.add(kw.name);
        }
      }
      prog.directives.add(expr);
      // overlay (viz S0) — C164 default_qty_value 선례를 그대로 따르는 지시어 메타데이터 추출.
      // library()에는 overlay 파라미터가 없으므로 제외. 값이 BoolLiteral이 아니면 조용히 false로
      // 두는 대신 하드 에러 — 조용히 틀린 pane 배정은 조용한 오답이다(qty 선례와 동일 근거).
      // TV 문법상 overlay는 const bool이라 리터럴 외의 표현식은 애초에 유효 Pine이 아니다.
      if (callee.name !== "library") {
        const overlayExpr = directiveArgExpr(expr, paramNames, "overlay");
        if (overlayExpr !== undefined) {
          if (overlayExpr.kind === "BoolLiteral") {
            prog.overlay = overlayExpr.value;
          } else {
            prog.errors.push(
              `'${callee.name}' overlay argument must be a true/false literal (L${expr.line}:${expr.col})`,
            );
          }
        }
      }
      // strategy.* 사용(entry/close 콜 + long/position_size류 속성)의 선행 조건 플래그(C163) —
      // 단일 패스라 "선언이 사용보다 소스에서 먼저" 규칙이 자연히 강제된다(LIMITATIONS.md).
      if (callee.name === "strategy") {
        prog.isStrategy = true;
        // default_qty_value/pyramiding(C164) + initial_capital(C165) 메타데이터 추출 — 지시어
        // no-op 원칙은 유지하되(codegen은 directive 문장 자체를 여전히 no-op 처리) 브로커 상태
        // 초기화에 필요한 숫자만 뽑아 AnalyzedProgram에 싣는다(codegen이 프리앰블 `$.strategy.configure(...)` 1줄로
        // 소비 — 엔진 run()/Context 시그니처 변경 0). 값이 리터럴이 아니면(변수/input.*/식) 조용히
        // 버리는 대신 하드 에러 — qty가 기본값 1로 둔갑한 백테스트는 조용한 오답이다(LIMITATIONS.md).
        // default_qty_type은 여전히 파싱 후 버림(항상 fixed 계약 수로 해석 — LIMITATIONS.md).
        const dq = directiveArgExpr(expr, STRATEGY_PARAM_NAMES, "default_qty_value");
        if (dq !== undefined) {
          // C465: wild corpus 65건 재조사 결과 94%(61건)가 정확히 `default_qty_value=0`(양수만
          // 허용하던 원 결정이 이 리터럴까지 걸러냄) — 모든 entry/order 호출이 qty=를 명시적으로
          // 지정하고 default_qty_value는 그 fallback을 의도적으로 "미사용(0)"으로 고정하는 실전
          // 관용구. runtime(strategy.ts L1324)이 이미 qty<=0을 별도 no-op 가드로 처리하므로 0은
          // "조용한 오답"이 아니라 well-defined(해당 fallback이 실제로 쓰이면 그 주문만 무발동).
          // 음수/비-리터럴/미해석 식별자는 여전히 하드 에러(값 자체를 모르거나 의미 없는 입력).
          const dqVal = resolveDirectiveConstNumber(dq, prog);
          if (dqVal !== undefined && dqVal >= 0) {
            prog.strategyDefaultQty = dqVal;
          } else {
            prog.errors.push(
              `'strategy()' 'default_qty_value' argument only supports a number literal >= 0 (requires a compile-time constant) (L${expr.line}:${expr.col})`,
            );
          }
        }
        const pyr = directiveArgExpr(expr, STRATEGY_PARAM_NAMES, "pyramiding");
        if (pyr !== undefined) {
          const pyrVal = resolveDirectiveConstNumber(pyr, prog);
          if (pyrVal !== undefined && Number.isInteger(pyrVal) && pyrVal >= 0) {
            prog.strategyPyramiding = pyrVal;
          } else {
            prog.errors.push(
              `'strategy()' 'pyramiding' argument only supports an int literal >= 0 (requires a compile-time constant) (L${expr.line}:${expr.col})`,
            );
          }
        }
        // initial_capital(C165 셋째 슬라이스 — equity의 기저) — default_qty_value와 동일한 원칙:
        // 컴파일타임 상수만 추출, 미해석 식별자/식이면 하드 에러(기본값 100000으로 둔갑한 equity는
        // 조용한 오답). C764: 0 허용으로 완화 — equity = initialCapital + realizedPnl + openProfit는
        // 나눗셈 분모가 아니라(strategy.ts L490) 0도 well-defined, wild 실사용 확인(양수 전용이던
        // 원 결정이 `initial_capital=0` 3건을 걸러냄, default_qty_value=0(C465)과 동일 근거).
        const cap = directiveArgExpr(expr, STRATEGY_PARAM_NAMES, "initial_capital");
        if (cap !== undefined) {
          const capVal = resolveDirectiveConstNumber(cap, prog);
          if (capVal !== undefined && capVal >= 0) {
            prog.strategyInitialCapital = capVal;
          } else {
            prog.errors.push(
              `'strategy()' 'initial_capital' argument only supports a number literal >= 0 (requires a compile-time constant) (L${expr.line}:${expr.col})`,
            );
          }
        }
        // default_qty_type(C171 아홉째 슬라이스, cash는 C330) — strategy.fixed/percent_of_equity/
        // cash 상수(DotAccess) 또는 동치 문자열 리터럴만 허용(컴파일타임 확정 필요 — 위 세 인자와
        // 동일 원칙). fixed는 기존 동작(defaultQty=계약 수)이라 플래그 불변, percent_of_equity는
        // qty 생략 시 지분율 %로 해석(StrategyState.qtyIsPercent), cash는 qty 생략 시 통화 금액으로
        // 해석(StrategyState.qtyIsCash — equity 무관, 금액/체결가 환산. pine2py는 상수 문자열만
        // 있고 소비 로직이 없어 percent_of_equity와 동일하게 hand-verified, DIVERGENCES #74).
        const dqt = directiveArgExpr(expr, STRATEGY_PARAM_NAMES, "default_qty_type");
        if (dqt !== undefined) {
          let qtyType: string | null = null;
          if (
            dqt.kind === "DotAccess" &&
            dqt.obj.kind === "Identifier" &&
            dqt.obj.name === "strategy" &&
            (dqt.attr === "fixed" || dqt.attr === "percent_of_equity" || dqt.attr === "cash")
          ) {
            qtyType = dqt.attr;
          } else if (
            dqt.kind === "StringLiteral" &&
            (dqt.value === "fixed" || dqt.value === "percent_of_equity" || dqt.value === "cash")
          ) {
            qtyType = dqt.value;
          }
          if (qtyType === null) {
            prog.errors.push(
              `'strategy()' 'default_qty_type' argument only supports strategy.fixed/strategy.percent_of_equity/strategy.cash constants (or an equivalent string literal) (requires a compile-time constant) (L${expr.line}:${expr.col})`,
            );
          } else if (qtyType === "cash") {
            prog.strategyQtyIsCash = true;
          } else if (qtyType === "percent_of_equity") {
            prog.strategyQtyIsPercent = true;
          }
        }
        // currency(C332, next_hint(C331) 1순위) — strategy.account_currency가 읽는 컴파일타임
        // 문자열 소스(analyzer.ts prog.strategyCurrency 주석 참조). currency.XXX 상수(DotAccess) 또는
        // 동치 문자열 리터럴이면 그 값을 캡처, 그 외(변수/식)는 default_qty_value류와 달리 **하드
        // 에러가 아니라 조용히 discard**(기본값 "USD" 유지) — account_currency는 이 엔진에서 실제
        // 통화 환산/P&L 계산에 전혀 관여하지 않는 순수 표시·비교용 문자열이라(진짜 FX 변환 인프라
        // 부재, request.currency_rate와 동일 급) 틀린 기본값이 조용한 재무 오답으로 이어지는
        // default_qty_value/pyramiding/initial_capital의 위험도와 다르다(wild
        // 46e92d206cfa.pine `currency = base_currency`처럼 변수를 쓰는 실사용이 있어 하드 에러 시
        // 이 파일이 새로 막힘 — 실측 회귀로 발견, C97 "더 안전한 쪽을 기본값으로" 원칙 적용).
        const cur = directiveArgExpr(expr, STRATEGY_PARAM_NAMES, "currency");
        if (cur !== undefined) {
          if (cur.kind === "DotAccess" && cur.obj.kind === "Identifier" && cur.obj.name === "currency" && CURRENCY_CONSTANTS.has(cur.attr)) {
            prog.strategyCurrency = CURRENCY_CONSTANTS.get(cur.attr)!;
          } else if (cur.kind === "StringLiteral") {
            prog.strategyCurrency = cur.value;
          }
        }
      }
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    const func = prog.funcs.get(callee.name);
    if (func) {
      analyzeUserFuncCall(expr, func, prog, scope);
      return;
    }
    // method(receiver, ...) — 점 호출(obj.method(...))이 아니라 일반 함수 호출 형태로 method를
    // 부르는 것도 TV v5 진짜 문법이다(C267, corpus 1624ff60e8a0.pine `isPositive(ind)`). pine2py는
    // method를 top-level 함수로 컴파일해 두 호출 형태가 동일 코드를 가리킨다(소스 대조 확인) —
    // pine2js는 method를 타입명으로 mangle하므로(mangleMethodName, C124) 첫 인자의 UDT 타입을
    // resolveUdtObjectType(DotAccess 경로, line ~1539와 동일 헬퍼)으로 추론해 그 타입의 method
    // 맵에서 같은 이름을 재조회한다. 첫 인자가 아직 analyzeExpr을 안 거친 DotAccess 체이닝이면
    // (resolveUdtObjectType이 udtFieldAccessTypes 캐시에 의존) 이 조회는 실패하고 아래로 자연히
    // 폴백한다(corpus 근거 없는 확장 금지, C258 원칙 — 실사용은 단순 Identifier 인자뿐).
    if (expr.args.length > 0) {
      // C687: bare 콜은 receiver가 args[0]에 이미 포함 — 제공 값 개수 그대로 오버로드 선택
      // (lookupMethodOverload — 오버로드 없는 이름은 기존 base 직접 조회와 동일).
      const bareArgTotal = expr.args.length + expr.kwargs.length;
      const receiverType = resolveUdtObjectType(expr.args[0]!, prog, scope);
      if (receiverType !== undefined) {
        const methodInfo = lookupMethodOverload(prog, receiverType, callee.name, bareArgTotal, expr);
        if (methodInfo !== undefined) {
          prog.udtMethodCallTypes.set(expr, receiverType);
          analyzeUserFuncCall(expr, methodInfo, prog, scope);
          return;
        }
      }
      // 스칼라(float/int/bool/string/color) receiver extension method의 bare 호출(C525, wild
      // `method volAdj(int len) => ... \n volAdj(30)`류 — method 첫 매개변수가 UDT가 아니라
      // 스칼라 타입이면 위 resolveUdtObjectType은 항상 undefined라 이 분기가 못 잡는다). dot-call
      // 형태(C328, 이 파일 아래쪽 resolveScalarMethodInfo 분기)와 동일하게 receiver의 실제 타입을
      // 값 흐름으로 추적하지 않고 method 이름 하나로 5종 스칼라 base를 순회 매칭한다 — bare 형태는
      // receiver가 이미 expr.args[0]에 있어(dot-call처럼 callee.obj로 분리되지 않음) UDT bare-call과
      // 완전히 동일하게 analyzeUserFuncCall을 오프셋 없이 그대로 재사용할 수 있다는 점만 다르다.
      const scalarMatches = resolveScalarMethodInfo(callee.name, prog, bareArgTotal);
      if (scalarMatches.length === 1) {
        prog.udtMethodCallTypes.set(expr, scalarMatches[0]!.base);
        analyzeUserFuncCall(expr, scalarMatches[0]!.info, prog, scope);
        return;
      } else if (scalarMatches.length > 1) {
        prog.errors.push(
          `'${callee.name}' scalar receiver extension method is declared for multiple types (${scalarMatches.map((m) => m.base).join("/")}) — cannot determine which one at the call site (value-flow type tracking not supported) (L${expr.line}:${expr.col})`,
        );
        for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
        return;
      }
      // drawing 핸들(label/line/box/table/polyline/linefill) receiver extension method의 bare
      // 호출(C676, wild `method deleteit(box this)=>box.delete(this) \n method deleteit(line
      // this)=>line.delete(this) \n ... \n deleteit(element)`류, element는 array<box>/array<line>
      // for-in 루프 변수). drawing kind는 스칼라 5종과 달리 receiver 하나당 정확히 하나로 정적
      // 확정되므로(resolveDrawingReceiverKind, C232/C354 조합) 스칼라처럼 여러 base를 순회 매칭할
      // 필요 없이 바로 단일 조회.
      const drawingBareKind = resolveDrawingReceiverKind(expr.args[0]!, prog, scope);
      if (drawingBareKind !== null) {
        const drawingMethodInfo = lookupMethodOverload(prog, drawingBareKind, callee.name, bareArgTotal, expr);
        if (drawingMethodInfo !== undefined) {
          prog.udtMethodCallTypes.set(expr, drawingBareKind);
          analyzeUserFuncCall(expr, drawingMethodInfo, prog, scope);
          return;
        }
      }
    }
    if (callee.name === "nz") {
      // nz(value, replacement=0) — math.round 등과 동일한 stateless builtinCalls 패턴(C12/C13)이나,
      // namespace 없는 bare 콜이라 DotAccess 분기가 아니라 여기(Identifier 콜) dispatch에 붙는다.
      // 상태가 없으므로 ta.*처럼 조건부 블록을 제약할 이유가 없다(TA_REGISTRY 대상이 아님).
      // nz(source=/replacement=) kwargs(C405) — math.*(C404)와 동일한 위치/키워드 슬롯 병합 검증.
      if (expr.kwargs.length > 0) {
        const paramIndex = new Map(NZ_KWARG_PARAM_NAMES.map((name, i) => [name, i]));
        if (expr.args.length > NZ_KWARG_PARAM_NAMES.length) {
          prog.errors.push(
            `'nz' call argument count mismatch: requires ${NZ_KWARG_PARAM_NAMES.length} (${NZ_KWARG_PARAM_NAMES.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
          );
        }
        const seen = new Set<string>();
        for (let i = 0; i < expr.args.length && i < NZ_KWARG_PARAM_NAMES.length; i++) seen.add(NZ_KWARG_PARAM_NAMES[i]!);
        for (const kw of expr.kwargs) {
          const idx = paramIndex.get(kw.name);
          if (idx === undefined) {
            prog.errors.push(`unknown argument name for 'nz': '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (seen.has(kw.name)) {
            const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
            if (!isHarmlessArgDup(posArg, kw.value)) {
              prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else {
            seen.add(kw.name);
          }
          analyzeExpr(kw.value, prog, scope, false);
        }
        if (!seen.has(NZ_KWARG_PARAM_NAMES[0]!)) {
          prog.errors.push(`'nz' call requires argument '${NZ_KWARG_PARAM_NAMES[0]}' (L${expr.line}:${expr.col})`);
        }
      } else if (expr.args.length < 1 || expr.args.length > 2) {
        prog.errors.push(
          `'nz' call argument count mismatch: requires 1~2, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, "nz");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    if (callee.name === "na") {
      // na(x) 호출형(파서가 standalone na리터럴과 lookahead로 구분, parser.ts parsePrimary 참조) —
      // nz와 동일하게 namespace 없는 bare Identifier 콜 dispatch. 런타임 함수는 이미 존재
      // (runtime/numeric.ts na(), 지금까지는 `x == na` 재작성에만 쓰였다) — 그대로 재사용,
      // 신규 구현 불필요. UDF가 na라는 이름을 섀도잉하면 위 prog.funcs.get 분기가 이미 먼저
      // 가로챈다(동일 섀도잉 정책, nz와 동일).
      if (expr.args.length !== 1) {
        prog.errors.push(
          `'na' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, "na");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    // 타입캐스트 bare 콜: int(x)/float(x)/bool(x)/string(x) (TV v5 명시적 형변환, input.int류와는
    // 별개 — LIMITATIONS.md 잔여 스코프 (3), C207). pine2py wavealgo.core.pine_int/pine_float/
    // pine_bool/pine_str(python 직접 실행으로 확인) 전부 인자 정확히 1개만 받고 na를 그대로 na로
    // 통과시킨다(크래시 없음). string(x)는 pine2py 실측 결과 str.tostring(x)(format_str 생략)와
    // 완전히 동일한 값을 낸다(둘 다 wa.pine_str에 위임) — 별도 런타임 함수를 새로 만들지 않고 기존
    // "tostring" builtinCalls 경로를 그대로 재사용한다. 이 재사용 덕분에 C201의 isStaticIntExpr
    // 정수 포맷 판별도 string(5)류에 자동 적용돼 "5"(정확)를 낸다("5.0"이 아님).
    if (callee.name === "int" || callee.name === "float" || callee.name === "bool" || callee.name === "string") {
      if (expr.args.length !== 1) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      if (callee.name === "string") {
        if (expr.args.length >= 1 && isStaticIntExpr(expr.args[0]!, prog, scope)) {
          prog.tostringIntArgCalls.add(expr);
        }
        prog.builtinCalls.set(expr, "tostring");
      } else {
        prog.builtinCalls.set(expr, callee.name);
      }
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    // 타입캐스트 bare 콜: color(x[, transp]) (TV v5 color 형변환, C300 — wild 3위 클러스터 "알 수
    // 없는 함수 호출"의 새 1위, 69건 중 32건). pine2py에 대응 구현이 전혀 없어(python 직접 확인 —
    // wavealgo.builtins.core에 pine_color 없음, pine2wave/codegen.py IDENTIFIER_MAP/디스패치 어디에도
    // bare "color(" 처리 없음) time()(C299)과 동일한 오라클 구조적 불가 — hand-verified 신규 설계
    // (DIVERGENCES.md #113, "TV 미검증(가설)"). wild 소스 전수 샘플링(1,431건 호출) 결과 압도적
    // 다수(1,388건)가 color(na)이고, 나머지는 리터럴/변수/네임드 상수 1-인자 또는 (colorExpr, 40/70
    // 등 0~100 범위 정수) 2-인자 — TV v4 레거시 `color(colorvalue, transp)`가 v5 color.new()와
    // 동일한 함수임을 커뮤니티 통설로 채택, 별도 런타임 함수를 새로 만들지 않고 기존 "new"
    // builtinCalls(colorNew, color.new의 rtPath)를 그대로 재사용한다(C32 alias 원칙과 동일 결)만
    // 인자 위치가 달라 codegen에 전용 분기가 필요하다(colorCast로 등록, codegen.ts 참조).
    if (callee.name === "color") {
      if (expr.args.length < 1 || expr.args.length > 2) {
        prog.errors.push(
          `'color' call argument count mismatch: requires 1~2, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, "colorCast");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    // 타입캐스트 bare 콜: line(x)/label(x)/box(x)/table(x) (TV v5 drawing 타입 명시적 캐스트, C301 —
    // color(C300) 소멸 후 잔존 37-클러스터의 신규 1위, line 3/label 2/box 1/table 1건). wild 전체
    // 재그렙(주석/UDF 동명 선언/합성 전수-호출 나열 픽스처 제외 — 전부 `method line(...)`류 섀도잉
    // 또는 `// box()` 주석 또는 실행 불가능한 "모든 빌트인 이름을 그냥 나열"하는 파일) 결과 실제
    // 코드는 100%가 X(na) 형태 — `var line weeklyPivotLine = line(na)`처럼 아직 실제 핸들을 안 만든
    // drawing 변수를 선언할 때 쓰는 관용구(이후 `weeklyPivotLine := line.new(...)`로 실제 핸들 대입,
    // C232 DRAWING_METHODS `.new()`와는 별개의 bare 형). int/float/bool/string(C207)/color(C300)와
    // 달리 이 넷은 실제 값 변환이 없다(GOAL.md "drawing 객체는 no-op" — 핸들 자체가 이미 순수
    // 참조값) — na 리터럴이면 GOAL.md 참조형 na 규약대로 null로 낮추고, 그 외(코퍼스 실사용 전무하나
    // 이미 핸들을 쥔 변수를 그대로 캐스트하는 방어적 케이스 대비) 값은 변환 없이 그대로 통과시킨다
    // (별도 런타임 함수 불필요 — codegen.ts drawingCast 참조). UDF/method가 이 네 이름을 섀도잉하면
    // 위 prog.funcs.get 분기가 이미 먼저 가로챈다(nz/na/color와 동일 섀도잉 정책).
    if (callee.name === "line" || callee.name === "label" || callee.name === "box" || callee.name === "table") {
      if (expr.args.length !== 1) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, "drawingCast");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    // timestamp(...) — pine2py wavealgo.timestamp(*args)의 2-오버로드(C210) + dateString
    // 1-인자 3번째 오버로드(C289, wild 최다빈도 클러스터 259건): `timestamp(year,month,day
    // [,hour,minute,second])` / `timestamp(tz_str,year,month,day[,hour,minute,second])` /
    // `timestamp(dateString)`. 앞 둘은 int/float/bool/string(위)과 동일하게 순수 *args 시그니처라
    // kwargs가 없다(python 직접 실행으로 확인) — tz_str 오버로드 판별은 런타임(rt.timestamp)이
    // args[0]의 실제 타입(string 여부)으로 한다(컴파일타임에 값 타입을 항상 알 수 있는 건 아님 —
    // 변수로 전달된 tz 문자열도 지원). dateString 오버로드는 pine2py 자신이 구조적으로 지원하지
    // 못해(오라클 불가, LIMITATIONS.md C269) 컴파일타임에 StringLiteral로 확실히 판별 가능한
    // 경우만 허용 — 이래야 기존 `timestamp(2024)`(숫자 1개, 여전히 에러여야 함) 계약이 안 깨진다.
    // VERIFIED_SEMANTICS.md에 근거 없는 "TV 미검증(가설)" 구현(rt.timestamp 주석/DIVERGENCES.md
    // 참조) — plot류와 달리 순수 함수라 v5 topLevel 제약은 없다(코퍼스 실측: input.time(timestamp(...))
    // 등 식 내부/조건부 호출 정상).
    if (callee.name === "timestamp") {
      // timestamp(...) kwargs(C406, next_hint(C405) 1순위 — resolveTimestampKwargSlots 참조).
      // 이름/중복/위치·키워드 충돌 검증은 math.*/nz(C404/C405)와 동일 패턴이나, 슬롯 표 자체가
      // timezone 유무에 따라 동적으로 바뀌어(맨 앞 TIMESTAMP_WITH_TZ_SLOTS/WITHOUT_TZ_SLOTS 주석
      // 참조) 구멍 검증만으로는 "year/month/day가 애초에 한 번도 안 채워진" 경우(구멍 루프의 범위가
      // maxIdx보다 작은 인덱스는 아예 안 봄)를 못 잡는다 — 그래서 필수 3종(dateString 오버로드는
      // dateString 자신)을 별도로 명시 검증한다.
      if (expr.kwargs.length > 0) {
        const slots = resolveTimestampKwargSlots(expr);
        if (expr.args.length > slots.length) {
          prog.errors.push(
            `'timestamp' call argument count mismatch: requires at most ${slots.length} (${slots.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
          );
        }
        const seen = new Set<string>();
        for (let i = 0; i < expr.args.length && i < slots.length; i++) seen.add(slots[i]!);
        for (const kw of expr.kwargs) {
          const idx = slots.indexOf(kw.name);
          if (idx === -1) {
            prog.errors.push(`unknown argument name for 'timestamp': '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (idx < expr.args.length) {
            if (!isHarmlessArgDup(expr.args[idx], kw.value)) {
              prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else if (seen.has(kw.name)) {
            prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
          } else {
            seen.add(kw.name);
          }
          analyzeExpr(kw.value, prog, scope, false);
        }
        if (slots === TIMESTAMP_DATESTRING_SLOT) {
          const dateKw = expr.kwargs.find((kw) => kw.name === "dateString");
          if (dateKw !== undefined && dateKw.value.kind !== "StringLiteral") {
            prog.errors.push(
              `'timestamp' call 'dateString' argument only supports a compile-time string literal (L${expr.line}:${expr.col})`,
            );
          }
        } else {
          const maxIdx = seen.size === 0 ? -1 : Math.max(...Array.from(seen).map((n) => slots.indexOf(n)));
          for (let i = 0; i < maxIdx; i++) {
            if (!seen.has(slots[i]!)) {
              prog.errors.push(
                `'timestamp' call is missing argument '${slots[i]}' (a later argument was specified by name) (L${expr.line}:${expr.col})`,
              );
            }
          }
          for (const required of ["year", "month", "day"]) {
            if (!seen.has(required)) {
              prog.errors.push(`'timestamp' call requires argument '${required}' (L${expr.line}:${expr.col})`);
            }
          }
        }
      } else {
        const isDateStringLiteral = expr.args.length === 1 && expr.args[0]!.kind === "StringLiteral";
        if (!isDateStringLiteral && (expr.args.length < 3 || expr.args.length > 7)) {
          prog.errors.push(
            `'timestamp' call argument count mismatch: requires 1 (dateString literal) or 3~7, got ${expr.args.length} (L${expr.line}:${expr.col})`,
          );
        }
      }
      prog.builtinCalls.set(expr, "timestamp");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    if (NOOP_BUILTIN_TOPLEVEL.has(callee.name) || NOOP_BUILTIN_ANY.has(callee.name)) {
      // hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/alertcondition/
      // alert/max_bars_back(C208) — 위 NOOP_BUILTIN_* 주석 참조. 인자 개수만 대략 검증하고 값은
      // 전부 discard(GOAL.md "drawing 객체는 no-op"과 동일 원칙 — plot()과 달리 기록 채널 자체가
      // 없다). kwargs 값은 이미 이 함수 최상단 공통 루프(line ~350)가 analyzeExpr해뒀다.
      const arity = NOOP_BUILTIN_ARITY[callee.name]!;
      const total = expr.args.length + expr.kwargs.length;
      if (total < arity.min || total > arity.max) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires ${arity.min}~${arity.max}, got ${total} (L${expr.line}:${expr.col})`,
        );
      }
      // max_bars_back(C347, wild 최다빈도 서브패턴 — `calcSlope(source, length) =>\n
      // max_bars_back(source, 5000)`류 UDF 본문 무조건 위치 호출)만 예외: pine2py
      // codegen.py/analyzer.py 전수 확인 결과 이 함수는 위치 제약이 전혀 없는 순수 no-op
      // FUNC_MAP 항목(wa.max_bars_back, 런타임도 pass뿐)이라 plot()류(TV 공식 문서가 명시적으로
      // local scope 금지)와 달리 v5가 실제로 UDF 본문을 막는다는 근거가 없다 — TV 공식 문서
      // 직접 확인 불가(VERIFIED_SEMANTICS.md 미기재)라 "TV 미검증(가설)"로 pine2py 전례만 근거
      // 삼아 완화(DIVERGENCES 등재). scope.kind==="udf-body"는 UDF 본문의 바로 그 depth(항상 1,
      // 중첩 UDF 불가)만 가리켜 if/for 등 조건부로 한 번 더 감싸인 경우는 여전히 거부된다(그
      // 안쪽 scope.kind는 cond-body/loop-body). prog.stmtCalls 확인은 `x = max_bars_back(...)`처럼
      // 값 위치(VarDecl/Assignment RHS)로 쓰인 경우까지 함께 완화되는 걸 막는다 — 이 경우는
      // analyzeControlFlowOrExpr이 topLevel=false로 넘기면서도 scope.kind는 여전히 "udf-body"라
      // scope.kind 단독 조건으로는 걸러지지 않는다(문장 위치 여부는 stmtCalls만이 구분).
      const isUdfBodyMaxBarsBack =
        callee.name === "max_bars_back" && scope.kind === "udf-body" && prog.stmtCalls.has(expr);
      if (NOOP_BUILTIN_TOPLEVEL.has(callee.name) && !topLevel && !isUdfBodyMaxBarsBack) {
        prog.errors.push(
          `'${callee.name}' call is only supported at script top-level statement position (v5 constraint — cannot be called in local scope/UDF body/inside an expression): (L${expr.line}:${expr.col})`,
        );
      }
      prog.noopStmtCalls.add(expr);
      // viz S2 — bgcolor/barcolor/hline은 더 이상 순수 no-op이 아니다: 정적 인자는 메타데이터로
      // 승격하고, bgcolor/barcolor의 런타임 색은 plot(S1)과 같은 $.plotColors 채널에서 슬롯을
      // 받아 codegen의 noop 분기가 "문장 제거 + 색 기록만 방출"한다. 추출은 전부 best-effort
      // (리터럴이 아니면 TV 기본값/null — 커버리지 회귀 금지). 인자 분석은 기존 그대로(공통
      // kwargs 루프 + 아래 args 루프가 원래부터 분석) — 새로 시작되는 것은 색 표현식의 **실행**
      // 뿐이다(S1과 동일 클래스, corpus_diff 재실측 프로토콜 적용).
      if (VIZ_CAPTURE_NOOPS.has(callee.name) && topLevel) {
        const order = NOOP_POSITIONAL_ORDER[callee.name]!;
        const argOf = (name: string): Expr | undefined => {
          const idx = order.indexOf(name);
          if (idx >= 0 && idx < expr.args.length) return expr.args[idx];
          return expr.kwargs.find((k) => k.name === name)?.value;
        };
        const litNum = (name: string, dflt: number): number => {
          const a = argOf(name);
          return a !== undefined && a.kind === "NumberLiteral" ? a.value : dflt;
        };
        const litTitle = (): string | null => {
          const a = argOf("title");
          return a !== undefined && a.kind === "StringLiteral" ? a.value : null;
        };
        const litBool = (name: string): boolean => {
          const a = argOf(name);
          return a !== undefined && a.kind === "BoolLiteral" ? a.value : false;
        };
        // viz S3 헬퍼 3종 — 문자열 리터럴 / 네임스페이스 상수(attr 그대로) / 정적 색.
        const litStr = (name: string): string | null => {
          const a = argOf(name);
          return a !== undefined && a.kind === "StringLiteral" ? a.value : null;
        };
        const nsAttr = (name: string, allowed: ReadonlySet<string>, ns: string, dflt: string): string => {
          const a = argOf(name);
          return a !== undefined && a.kind === "DotAccess" && a.obj.kind === "Identifier" && a.obj.name === ns && allowed.has(a.attr)
            ? a.attr
            : dflt;
        };
        const staticColorOf = (name: string): string | null => {
          const a = argOf(name);
          if (a === undefined) return null;
          if (a.kind === "ColorLiteral") return a.value;
          if (a.kind === "DotAccess" && a.obj.kind === "Identifier" && a.obj.name === "color" && COLOR_CONSTANTS.has(a.attr)) {
            return COLOR_CONSTANTS.get(a.attr)!;
          }
          return null;
        };
        // $.vizSeries 슬롯 배정 + 기록 지시 등록. 인자가 아예 없으면(arity 에러 케이스) 슬롯만
        // 배정되고 기록이 없어 채널이 NaN으로 남는다 — 무해.
        const seriesWrite = (name: string, kind: "flag" | "num"): number => {
          const slot = prog.vizSeriesSlotCount;
          prog.vizSeriesSlotCount += 1;
          const a = argOf(name);
          if (a !== undefined) {
            const list = prog.noopSeriesWrites.get(expr) ?? [];
            list.push({ slot, expr: a, kind });
            prog.noopSeriesWrites.set(expr, list);
          }
          return slot;
        };
        const colorOf = (): { color: string | null; slot: number | null } => {
          const c = argOf("color");
          if (c === undefined) return { color: null, slot: null };
          if (c.kind === "ColorLiteral") return { color: c.value, slot: null };
          if (c.kind === "DotAccess" && c.obj.kind === "Identifier" && c.obj.name === "color" && COLOR_CONSTANTS.has(c.attr)) {
            return { color: COLOR_CONSTANTS.get(c.attr)!, slot: null };
          }
          // hline의 색은 TV상 const input — 런타임 채널을 열지 않고 정적 확정 실패 시 null.
          if (callee.name === "hline") return { color: null, slot: null };
          const slot = prog.plotColorSlotCount;
          prog.plotColorSlotCount += 1;
          prog.noopColorWrites.set(expr, { slot, expr: c });
          return { color: null, slot };
        };
        if (callee.name === "bgcolor") {
          const { color, slot } = colorOf();
          prog.bgcolorMeta.push({
            title: litTitle(), offset: litNum("offset", 0), forceOverlay: litBool("force_overlay"),
            color, colorSlot: slot,
          });
        } else if (callee.name === "barcolor") {
          const { color, slot } = colorOf();
          prog.barcolorMeta.push({ title: litTitle(), offset: litNum("offset", 0), color, colorSlot: slot });
        } else if (callee.name === "hline") {
          const { color } = colorOf();
          const ls = argOf("linestyle");
          const linestyle =
            ls !== undefined && ls.kind === "DotAccess" && ls.obj.kind === "Identifier" && ls.obj.name === "hline"
              ? (HLINE_STYLE_NAMES.get(ls.attr) ?? "solid")
              : "solid";
          const priceArg = argOf("price");
          prog.hlineMeta.push({
            title: litTitle(),
            price: priceArg !== undefined && priceArg.kind === "NumberLiteral" ? priceArg.value : null,
            color, linestyle, linewidth: litNum("linewidth", 1),
          });
          prog.hlineCallSlots.set(expr, prog.hlineMeta.length - 1);
        } else if (callee.name === "plotshape" || callee.name === "plotchar") {
          // viz S3 — 조건은 바별 0/1 채널, 색은 공유 색 풀. text/textcolor/size/location은 정적만.
          const { color, slot } = colorOf();
          const common = {
            title: litTitle(),
            location: nsAttr("location", LOCATION_NAMES, "location", "abovebar"),
            size: nsAttr("size", SIZE_NAMES, "size", "auto"),
            text: litStr("text"),
            textcolor: staticColorOf("textcolor"),
            offset: litNum("offset", 0),
            forceOverlay: litBool("force_overlay"),
            color,
            colorSlot: slot,
            conditionSlot: seriesWrite("series", "flag"),
          };
          if (callee.name === "plotshape") {
            prog.plotshapeMeta.push({ ...common, style: nsAttr("style", SHAPE_STYLE_NAMES, "shape", "xcross") });
          } else {
            const ch = argOf("char");
            prog.plotcharMeta.push({
              ...common,
              char: ch !== undefined && ch.kind === "StringLiteral" && ch.value !== "" ? ch.value : "★",
            });
          }
        } else if (callee.name === "plotarrow") {
          prog.plotarrowMeta.push({
            title: litTitle(),
            colorup: staticColorOf("colorup"),
            colordown: staticColorOf("colordown"),
            minheight: litNum("minheight", 5),
            maxheight: litNum("maxheight", 100),
            offset: litNum("offset", 0),
            forceOverlay: litBool("force_overlay"),
            seriesSlot: seriesWrite("series", "num"),
          });
        } else if (callee.name === "plotcandle" || callee.name === "plotbar") {
          const { color, slot } = colorOf();
          const candleMeta = {
            title: litTitle(),
            color,
            colorSlot: slot,
            wickcolor: callee.name === "plotcandle" ? staticColorOf("wickcolor") : null,
            bordercolor: callee.name === "plotcandle" ? staticColorOf("bordercolor") : null,
            forceOverlay: litBool("force_overlay"),
            openSlot: seriesWrite("open", "num"),
            highSlot: seriesWrite("high", "num"),
            lowSlot: seriesWrite("low", "num"),
            closeSlot: seriesWrite("close", "num"),
          };
          (callee.name === "plotcandle" ? prog.plotcandleMeta : prog.plotbarMeta).push(candleMeta);
        }
      }
      // viz S2b — fill() 캡처. 위 3종과 달리 아래 args 루프 **뒤**에서 해야 한다: 중첩
      // `fill(plot(a), plot(b))`의 안쪽 plot은 그 루프(C346 구제)가 분석해야 plotCallSlots에
      // 슬롯이 생기기 때문. 이 지연을 위해 여기서는 자리만 확보하고 실제 push는 아래에서.
      const captureFill = callee.name === "fill" && topLevel;
      // fill(plot(...), plot(...))/fill(hline(...), hline(...))(C346, wild 최다빈도 서브패턴 —
      // TV 공식 fill(plot1, plot2, ...) 시그니처가 두 plot/hline 핸들 위치 인자를 bare 콜로 직접
      // 받는 관용구, 위 kwargs 루프의 plot1=/plot2= 자매 예외와 동일 원칙) — args[0]/args[1]이
      // 정확히 bare plot()/hline() 콜일 때만 그 콜 자신을 topLevel=true로 분석.
      expr.args.forEach((arg, i) => {
        const isFillPlotHandleArg =
          callee.name === "fill" &&
          i < 2 &&
          arg.kind === "CallExpr" &&
          arg.callee.kind === "Identifier" &&
          (arg.callee.name === "plot" || arg.callee.name === "hline");
        analyzeExpr(arg, prog, scope, isFillPlotHandleArg);
      });
      if (captureFill) {
        // viz S2b — 두 핸들 인자를 정적으로 해석한다: (a) bare 중첩 콜은 방금 위 루프/공통
        // kwargs 루프가 슬롯을 배정했고, (b) 식별자는 uniqueTopEqVars(top-level 유일 '=' 바인딩,
        // 재대입 0 — 지시어 상수 치환과 동일한 안전 근거)를 거쳐 그 RHS 콜사이트로 도달한다.
        // 해석 실패는 null (best-effort — 에러 없음).
        const resolveRef = (pos: number, names: readonly string[]): { kind: "plot" | "hline"; index: number } | null => {
          let target: Expr | undefined =
            pos < expr.args.length ? expr.args[pos] : expr.kwargs.find((k) => names.includes(k.name))?.value;
          if (target !== undefined && target.kind === "Identifier") {
            target = prog.uniqueTopEqVars.get(target.name)?.value;
          }
          if (target !== undefined && target.kind === "CallExpr") {
            const p = prog.plotCallSlots.get(target);
            if (p !== undefined) return { kind: "plot", index: p };
            const h = prog.hlineCallSlots.get(target);
            if (h !== undefined) return { kind: "hline", index: h };
          }
          return null;
        };
        const fillColorArg =
          2 < expr.args.length ? expr.args[2] : expr.kwargs.find((k) => k.name === "color")?.value;
        let fillColor: string | null = null;
        let fillColorSlot: number | null = null;
        if (fillColorArg !== undefined) {
          if (fillColorArg.kind === "ColorLiteral") {
            fillColor = fillColorArg.value;
          } else if (
            fillColorArg.kind === "DotAccess" && fillColorArg.obj.kind === "Identifier" &&
            fillColorArg.obj.name === "color" && COLOR_CONSTANTS.has(fillColorArg.attr)
          ) {
            fillColor = COLOR_CONSTANTS.get(fillColorArg.attr)!;
          } else {
            fillColorSlot = prog.plotColorSlotCount;
            prog.plotColorSlotCount += 1;
            prog.noopColorWrites.set(expr, { slot: fillColorSlot, expr: fillColorArg });
          }
        }
        const fillTitleArg =
          3 < expr.args.length ? expr.args[3] : expr.kwargs.find((k) => k.name === "title")?.value;
        prog.fillMeta.push({
          a: resolveRef(0, ["plot1", "hline1"]),
          b: resolveRef(1, ["plot2", "hline2"]),
          color: fillColor,
          colorSlot: fillColorSlot,
          title: fillTitleArg !== undefined && fillTitleArg.kind === "StringLiteral" ? fillTitleArg.value : null,
        });
      }
      return;
    }
    if (callee.name === "input") {
      // bare `input(defval, title)` — pine2py any_input(C133), 타입 미지정 일반 입력. namespace
      // 없는 콜이라 위 input.int/float/...(DotAccess 분기)와 별개 지점이지만 파라미터 표는
      // "any" 키로 INPUT_PARAM_NAMES에 함께 있어 analyzeInputCall 공용 헬퍼를 그대로 재사용한다.
      analyzeInputCall(expr, "any", "input()", prog);
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    if (callee.name === "plot") {
      // bare `plot(series, title, color, linewidth, ...)`(C135 최초 2-인자 -> C159 kwargs 확장,
      // ROADMAP line 1962) — pine2py엔 대응 구현이 없어(context.plots 필드가 선언만 되고 아무도
      // 안 쓰는 죽은 스텁, Explore 조사로 확인) GOAL.md "plot은 Float64Array 수집 채널" 원칙에
      // 따라 pine2js가 처음부터 설계한다. title 이후 13종(color/linewidth/style/trackprice/
      // histbase/offset/join/editable/show_last/display/format/precision/force_overlay)은 렌더링
      // 전용이라 로직에서는 no-op(GOAL.md 사업 목적엔 불필요) — 여기서는 개수/이름/중복/위치·키워드
      // 충돌만 검증(input.* C132와 동일한 세 가지)하고 값 자체는 버린다(맨 아래
      // `for (const arg of expr.args) analyzeExpr(...)`가 이미 모든 위치 인자를, 이 함수 최상단
      // 공통 kwargs 루프가 이미 모든 키워드 인자를 부작용 검증용으로 analyzeExpr해뒀다 — 이 분기가
      // 새로 analyzeExpr할 필요는 없다). PLOT_PARAM_NAMES의 index i는 series(항상 위치 0)를 뺀
      // "series 다음" 순서라 실제 위치 인자 인덱스는 i+1.
      // C313: "series"도 이제 `series=` kwarg로 지정 가능(파서가 SERIES 토큰을 kwarg 이름
      // 자리에서 인식하도록 확장됨, wild 최다 클러스터 331/339건이 이 폼). series는 항상
      // position 0이라 다른 kwarg처럼 PLOT_PARAM_NAMES 표에 넣지 않고 별도 분기로 처리 —
      // hasSeriesKwarg가 true면 위치 인자 없이(args.length===0) series를 시작할 수 있다.
      const maxArgs = 1 + PLOT_PARAM_NAMES.length;
      const hasSeriesKwarg = expr.kwargs.some((kw) => kw.name === "series");
      if ((expr.args.length < 1 && !hasSeriesKwarg) || expr.args.length > maxArgs) {
        prog.errors.push(
          `'plot' call argument count mismatch: requires 1~${maxArgs}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else {
        const paramIndex = new Map(PLOT_PARAM_NAMES.map((name, i) => [name, i + 1]));
        const seenKwargNames = new Set<string>();
        for (const kw of expr.kwargs) {
          // "transp="(C283, wild 28건)는 v4 잔재로 초기 v5에서만 deprecated 허용되던 kwarg —
          // 현행 v5 시그니처에 위치 슬롯이 없어 PLOT_PARAM_NAMES에 넣으면 위치 매핑이 깨진다.
          // input.*의 메타데이터 kwarg와 동일하게 kwarg 전용 discard로만 허용(값은 어차피 렌더링
          // 전용이라 이 분기 전체가 버림).
          if (kw.name === "transp") {
            if (seenKwargNames.has(kw.name)) {
              prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
            }
            seenKwargNames.add(kw.name);
            continue;
          }
          // "linestyle="(C670, wild "네임스페이스 접근은 호출식만 지원" 클러스터 최다 서브그룹
          // 32건, 전량 //@version=6)는 TV v6에서 신규 추가된 plot() 전용 kwarg(hline()/vline()엔
          // v5부터 있었으나 plot()엔 없었음 — pine2py wavealgo/builtins/plot.py는 이 파라미터가
          // 없고 pine2wave/codegen.py IDENTIFIER_MAP에도 plot.linestyle_*가 없어 pine2py가
          // 못 따라간 v6 갭, TV 실측 대장 tv_verdict_v2.jsonl로 32/32 accept 확인). transp와
          // 동일하게 위치 슬롯이 없는 kwarg 전용 — 값은 렌더링 전용이라 discard.
          if (kw.name === "linestyle") {
            if (seenKwargNames.has(kw.name)) {
              prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
            }
            seenKwargNames.add(kw.name);
            continue;
          }
          // "series="(C313)는 position 0 자체라 PLOT_PARAM_NAMES(1부터 시작)에 없다 — 위치
          // 인자와 동시에 오면(expr.args.length>=1) 어느 쪽이 진짜 series인지 모호하므로 다른
          // named param과 동일하게 "위치/키워드 충돌"로 거부.
          if (kw.name === "series") {
            if (seenKwargNames.has(kw.name)) {
              prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
            } else if (expr.args.length >= 1) {
              prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
            seenKwargNames.add(kw.name);
            continue;
          }
          const idx = paramIndex.get(kw.name);
          if (idx === undefined) {
            prog.errors.push(`unknown argument name for 'plot': '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (seenKwargNames.has(kw.name)) {
            prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
          seenKwargNames.add(kw.name);
        }
      }
      // v5 제약: plot()은 local scope(if/for/while/switch 본문, 삼항/and·or lazy 위치, UDF 본문)
      // 안에서 호출 불가 — VERIFIED_SEMANTICS.md CONFIRMED("plot()은 if 블록 안에서 호출 불가").
      // ta.*의 firstForbiddenKind(cond-body/lazy-expr는 허용)와 달리 예외 없이 스크립트 최상위만
      // 허용한다 — topLevel은 이미 정확히 이 의미(scope.depth===0인 ExprStmt에서만 true, line
      // ~1080)라 별도 스코프 체인 워크가 필요 없다.
      if (!topLevel) {
        prog.errors.push(
          `'plot' call is only supported at script top-level statement position (v5 constraint — cannot be called in local scope/UDF body/inside an expression): (L${expr.line}:${expr.col})`,
        );
      } else {
        const slot = prog.plotTitles.length;
        // title은 위치(args[1]) 또는 키워드(title=) 둘 중 하나로 올 수 있다 — 위 검증에서 이미
        // 두 경로가 동시에 쓰이면 에러를 냈으므로 여기서는 "positional이 있으면 그것부터" 우선순위만
        // 정하면 충분하다(양쪽 다 없는 정상 케이스가 대다수, 에러 케이스는 값 하나만 있으면 됨).
        const titleArg = expr.args.length > 1 ? expr.args[1] : expr.kwargs.find((kw) => kw.name === "title")?.value;
        const title =
          titleArg !== undefined && titleArg.kind === "StringLiteral" && titleArg.value !== ""
            ? titleArg.value
            : `Plot ${slot}`;
        prog.plotTitles.push(title);
        prog.plotCallSlots.set(expr, slot);
        // viz S1 — 렌더링 kwargs를 더 이상 버리지 않는다. 정적(리터럴/plot.style_*/색 상수)은
        // PlotMeta로 승격하고, 색이 런타임 표현식이면 $.plotColors 슬롯을 배정해 codegen이
        // 바마다 기록하게 한다. 추출은 전부 best-effort: 리터럴이 아니면 에러 대신 TV 기본값 —
        // 지금까지 통과하던 스크립트가 메타데이터 때문에 떨어지는 커버리지 회귀는 금지
        // (S1 수용 기준: corpus/scripts 6669/6926 불변, 커밋 메시지에 재실측 기록).
        const plotArg = (name: string): { value: Expr; fromKwarg: boolean } | undefined => {
          const idx = PLOT_PARAM_NAMES.indexOf(name) + 1; // +1: 위치 0은 series
          if (idx >= 1 && idx < expr.args.length) return { value: expr.args[idx]!, fromKwarg: false };
          const kw = expr.kwargs.find((k) => k.name === name);
          return kw ? { value: kw.value, fromKwarg: true } : undefined;
        };
        const numOr = (name: string, dflt: number): number => {
          const a = plotArg(name);
          return a !== undefined && a.value.kind === "NumberLiteral" ? a.value.value : dflt;
        };
        const boolOr = (name: string, dflt: boolean): boolean => {
          const a = plotArg(name);
          return a !== undefined && a.value.kind === "BoolLiteral" ? a.value.value : dflt;
        };
        const styleArg = plotArg("style");
        const style =
          styleArg !== undefined &&
          styleArg.value.kind === "DotAccess" &&
          styleArg.value.obj.kind === "Identifier" &&
          styleArg.value.obj.name === "plot"
            ? (PLOT_STYLE_NAMES.get(styleArg.value.attr) ?? "line")
            : "line";
        const colorArg = plotArg("color");
        let staticColor: string | null = null;
        let colorSlot: number | null = null;
        if (colorArg !== undefined) {
          const c = colorArg.value;
          if (c.kind === "ColorLiteral") {
            staticColor = c.value;
          } else if (c.kind === "DotAccess" && c.obj.kind === "Identifier" && c.obj.name === "color" && COLOR_CONSTANTS.has(c.attr)) {
            staticColor = COLOR_CONSTANTS.get(c.attr)!;
          } else {
            colorSlot = prog.plotColorSlotCount;
            prog.plotColorSlotCount += 1;
            prog.plotColorExprs.set(expr, { slot: colorSlot, expr: c });
            // 분석은 여기서 하지 않는다: kwarg 값은 analyzeCallExpr 최상단 공통 kwargs 루프가,
            // 위치 인자는 이 분기 끝의 args 루프가 이미 analyzeExpr한다(둘 다 S1 이전부터 —
            // 슬롯은 원래 할당돼 있었고 실행만 없었다). S1의 시맨틱 이동은 분석이 아니라
            // **실행**이다: codegen이 이 표현식을 바마다 평가하기 시작한다(TV 정합 방향,
            // corpus_diff 재실측 프로토콜은 resin-viz-plan.md §4 — 실측 이동 0건).
          }
        }
        prog.plotMeta.push({
          style,
          linewidth: numOr("linewidth", 1),
          offset: numOr("offset", 0),
          histbase: numOr("histbase", 0),
          trackprice: boolOr("trackprice", false),
          forceOverlay: boolOr("force_overlay", false),
          color: staticColor,
          colorSlot,
        });
      }
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    const bareEntry = TA_REGISTRY[callee.name];
    if (bareEntry && bareEntry.dispatch === "bare") {
      analyzeStatefulCall(expr, callee.name, bareEntry, prog, scope);
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    if (TIME_FUNC_NAMES.has(callee.name)) {
      // year(time[, timezone])/month(time[, timezone])/.../hour(time[, timezone]) 함수-호출
      // 오버로드(C245, 2-인자 timezone 폼은 C326) — TIME_VAR_NAMES(C242)의 bare 식별자 형제.
      // stateless 순수 함수라 nz/na/timestamp와 동일하게 조건부/lazy 위치 제약이 없다. wild
      // 실사용은 위치 2-인자(175건, 압도적 다수)와 time=/timezone= 키워드 폼(2파일 4호출) 둘 다
      // 나타나 strategy.risk.max_intraday_loss/max_drawdown(C322)와 동일한 "이름별로 위치 또는
      // 키워드 중 하나" 해석이 필요하다.
      if (expr.args.length > 2) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires 1~2 (time_expr[, timezone]), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seenTimeFuncParams = new Set<string>();
      if (expr.args.length >= 1) seenTimeFuncParams.add("time");
      if (expr.args.length >= 2) seenTimeFuncParams.add("timezone");
      for (const kw of expr.kwargs) {
        if (kw.name !== "time" && kw.name !== "timezone") {
          prog.errors.push(`'${callee.name}' only supports keyword arguments 'time='/'timezone=': '${kw.name}=' (L${kw.line}:${kw.col})`);
        } else if (seenTimeFuncParams.has(kw.name)) {
          const posArg = kw.name === "time" ? expr.args[0] : expr.args[1];
          if (!isHarmlessArgDup(posArg, kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
        } else {
          seenTimeFuncParams.add(kw.name);
        }
      }
      if (!seenTimeFuncParams.has("time")) {
        prog.errors.push(`'${callee.name}' call requires a time argument (L${expr.line}:${expr.col})`);
      }
      prog.builtinCalls.set(expr, `datetime.${callee.name}`);
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
      return;
    }
    if (callee.name === "time" || callee.name === "time_close") {
      // time(timeframe[, session[, timezone]])(C299)/time_close(...)(C400, 각각 wild "알 수 없는
      // 함수 호출" 클러스터의 지배 함수 — bare 무인자 `time`/`time_close`(TIME_VAR_NAMES)과 별개인
      // 호출형). pine2py에 대응 구현이 전혀 없어(bare 변수 하나뿐) 오라클 구조적 불가 —
      // runtime/time.ts 헤더 참조로 hand-verified 설계(DIVERGENCES.md 'TV 미검증(가설)').
      // request.security류와 달리 다른 바 데이터를 참조하지 않는 순수 per-bar 계산이라 컴파일타임
      // tf 리터럴 제약이 불필요 — 인자 전부 임의 런타임 표현식을 그대로 analyzeExpr에 넘긴다
      // (nz/na/timestamp와 동일하게 조건부/lazy 위치 제약도 없음 — stateless 순수 함수).
      // timeframe=/session=/timezone=/bars_back= 키워드 폼(C475/C727, TIME_CALL_KWARG_PARAM_NAMES
      // 참조) — 위치 인자와 완전히 같은 순서(math.*(C404)/str.tostring(C403)류와 동일한 "위치/키워드
      // 슬롯 병합" 이름·중복·위치-키워드 충돌 검증). kwargs가 없는 기존 순수 위치 콜사이트는 이 분기
      // 자체를 안 타 기존 "1~4개 필요" 에러 메시지/동작이 그대로 유지된다(C129 원칙).
      if (expr.kwargs.length > 0) {
        if (expr.args.length > TIME_CALL_KWARG_PARAM_NAMES.length) {
          prog.errors.push(
            `'${callee.name}' call argument count mismatch: requires 1~4 (timeframe[, session[, timezone[, bars_back]]]), got ${expr.args.length} (L${expr.line}:${expr.col})`,
          );
        }
        const paramIndex = new Map(TIME_CALL_KWARG_PARAM_NAMES.map((name, i) => [name, i]));
        const seen = new Set<string>();
        for (let i = 0; i < expr.args.length && i < TIME_CALL_KWARG_PARAM_NAMES.length; i++) {
          seen.add(TIME_CALL_KWARG_PARAM_NAMES[i]!);
        }
        for (const kw of expr.kwargs) {
          const idx = paramIndex.get(kw.name);
          if (idx === undefined) {
            prog.errors.push(`'${callee.name}' only supports keyword arguments 'timeframe='/'session='/'timezone='/'bars_back=': '${kw.name}=' (L${kw.line}:${kw.col})`);
          } else if (seen.has(kw.name)) {
            const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
            if (!isHarmlessArgDup(posArg, kw.value)) {
              prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else {
            seen.add(kw.name);
          }
          analyzeExpr(kw.value, prog, scope, false);
        }
        if (!seen.has("timeframe")) {
          prog.errors.push(`'${callee.name}' call requires a 'timeframe' argument (L${expr.line}:${expr.col})`);
        }
      } else if (expr.args.length < 1 || expr.args.length > 4) {
        prog.errors.push(
          `'${callee.name}' call argument count mismatch: requires 1~4 (timeframe[, session[, timezone[, bars_back]]]), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, callee.name === "time" ? "time" : "timeClose");
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    prog.errors.push(`unknown function call: '${callee.name}' (L${expr.line}:${expr.col})`);
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    return;
  }

  // DotAccess callee: namespace.method(...)
  const namespace = callee.obj.kind === "Identifier" ? callee.obj.name : null;
  const method = callee.attr;
  // "ta"/"math" 둘 다 TA_REGISTRY 조회 대상(math.sum은 dispatch:"math") — 나머지 math.round류
  // (stateless)는 TA_REGISTRY에 없어 아래 else-if의 기존 builtinCalls 경로로 자연히 빠진다.
  // entry.dispatch가 실제 namespace 문자열과 정확히 일치해야만 유효(그냥 "ta"|"math" 중 하나이기만
  // 하면 통과시키면 `ta.sum`처럼 등록된 dispatch와 다른 namespace로도 호출을 허용해버리는 버그가 됨
  // — fixnan의 dispatch:"bare"가 ta.fixnan을 거부하는 것과 동일한 이유로 엄격 대응이 필요하다).
  const taEntry =
    namespace === "ta" || namespace === "math" ? TA_REGISTRY[method] : undefined;
  if (taEntry && taEntry.dispatch === namespace) {
    const taCallArity = taCallReturnArity(taEntry, expr.args.length);
    if (taCallArity !== undefined && !prog.tupleStateCalls.has(expr)) {
      // 다중 반환 TA를 표현식 위치(x = ta.macd(...), 인자 안 등)에서 호출 — codegen genCallExpr는
      // 스칼라 식을 기대하므로 튜플 디스트럭처링 문장의 값 위치에서만 허용한다
      // (analyzeTupleDestructure가 재귀 전에 tupleStateCalls로 표시 — TaRegistryEntry.returnArity 주석 참조).
      // C362: vwap는 3-인자 폼만 여기 걸린다(taCallReturnArity — 1/2-인자 스칼라 폼은 표현식 위치 합법).
      prog.errors.push(
        `'${taEntry.displayName}' returns ${taCallArity} values, so it can only be called as the value of a tuple destructuring ('[a, b, c] = ...') (L${expr.line}:${expr.col})`,
      );
      for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
      return;
    }
    analyzeStatefulCall(expr, method, taEntry, prog, scope);
  } else if (
    namespace === "math" &&
    (method === "round" ||
      method === "abs" ||
      method === "max" ||
      method === "min" ||
      method === "avg" ||
      method === "floor" ||
      method === "ceil" ||
      method === "sqrt" ||
      method === "pow" ||
      method === "log" ||
      method === "log10" ||
      method === "exp" ||
      method === "sign" ||
      method === "sin" ||
      method === "cos" ||
      method === "tan" ||
      method === "asin" ||
      method === "acos" ||
      method === "atan" ||
      method === "atan2" ||
      method === "todegrees" ||
      method === "toradians" ||
      method === "round_to_mintick" ||
      method === "clamp")
  ) {
    // math.round/abs/max/min/avg/floor/ceil/sqrt/pow/log/log10/exp/sign/sin/cos/tan/asin/acos/atan/
    // atan2/todegrees/toradians/round_to_mintick/clamp — 전부 순수 함수(바마다 독립 상태 없음)라 ta.*와
    // 달리 조건부 블록 안에서도 안전하게 호출 가능(HoistingPass 제약이 적용될 이유가 없음).
    // clamp(value, min, max)는 배치25 (3) 신규(runtime/numeric.ts clamp() 주석 참조) — pine2py에
    // 대응 구현이 없어 오라클 대조 불가, TV 공식 시그니처 그대로 위치 인자 정확히 3개 hand-verified.
    const mathKwargParamNames = MATH_KWARG_PARAM_NAMES[method];
    if (mathKwargParamNames !== undefined && expr.kwargs.length > 0) {
      // math.abs/round/sign(number=/precision=) kwargs(C404) — str.tostring(C403)/array.*(id=...)
      // (C382)와 동일한 "위치/키워드 슬롯 병합" 이름·중복·위치-키워드 충돌 검증. 필수 인자는 항상
      // 첫 슬롯('number') 하나뿐(round의 'precision'은 기존에도 선택 인자).
      const paramIndex = new Map(mathKwargParamNames.map((name, i) => [name, i]));
      if (expr.args.length > mathKwargParamNames.length) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires ${mathKwargParamNames.length} (${mathKwargParamNames.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seen = new Set<string>();
      for (let i = 0; i < expr.args.length && i < mathKwargParamNames.length; i++) seen.add(mathKwargParamNames[i]!);
      for (const kw of expr.kwargs) {
        const idx = paramIndex.get(kw.name);
        if (idx === undefined) {
          prog.errors.push(`unknown argument name for 'math.${method}': '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (seen.has(kw.name)) {
          const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
          if (!isHarmlessArgDup(posArg, kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
        } else {
          seen.add(kw.name);
        }
        analyzeExpr(kw.value, prog, scope, false);
      }
      if (!seen.has(mathKwargParamNames[0]!)) {
        prog.errors.push(`'math.${method}' call requires argument '${mathKwargParamNames[0]}' (L${expr.line}:${expr.col})`);
      }
    } else if (method === "round" || method === "round_to_mintick") {
      if (expr.args.length < 1 || expr.args.length > 2) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires 1~2, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else if (method === "max" || method === "min" || method === "avg") {
      // max/min/avg: pine2py도 Python 내장 max()/min()(max/min) 또는 *args(avg)에 그대로 위임해
      // 함수 자체는 인자 수 제약이 없지만, TV 실제 시그니처는 셋 다 "number0, number1, ..." 명명
      // 관례를 공유해 최소 2개를 요구한다(max/min은 C13에서 이미 이 하한을 채택 — avg도 동일 관례
      // 유추 적용, WebSearch 권한 없어 pine2py 소스만으로는 하한을 확인 불가함을 감안한 결정).
      if (expr.args.length < 2) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires at least 2, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else if (method === "pow" || method === "atan2") {
      // pow(base, exp)/atan2(y, x) — 둘 다 정확히 2개 인자.
      if (expr.args.length !== 2) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires 2, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else if (method === "clamp") {
      // clamp(value, min, max) — 정확히 3개 인자(TV 공식 시그니처, kwarg는 wild 근거 없어 미지원).
      if (expr.args.length !== 3) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires 3, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else {
      // abs/floor/ceil/sqrt/log/log10/exp/sign/sin/cos/tan/asin/acos/atan/todegrees/toradians —
      // 전부 단항.
      if (expr.args.length !== 1) {
        prog.errors.push(
          `'math.${method}' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    }
    prog.builtinCalls.set(expr, method);
  } else if (namespace === "str" && Object.prototype.hasOwnProperty.call(STR_REGISTRY, method)) {
    // str.* 19종(C76~112 완주) — analyzer/collections.ts의 analyzeStrCall 참조(인자 개수 검증 +
    // builtinCalls 등록, ROADMAP "컬렉션 네임스페이스 레지스트리화" 슬라이스 2/4). scope는
    // tostring의 isStaticIntExpr 판별에만 쓰인다(C201).
    analyzeStrCall(expr, method, prog, scope);
  } else if (
    namespace === "color" &&
    (method === "rgb" ||
      method === "new" ||
      method === "from_gradient" ||
      method === "r" ||
      method === "g" ||
      method === "b" ||
      method === "t")
  ) {
    // color.rgb/new/from_gradient(C78) + r/g/b/t(C311, wild "지원하지 않는 호출" 1위) — pine2py
    // wavealgo/builtins/color.py 소스 대조 결과 전부 순수 함수(상태 없음)라 str.*(C76/77)와 동일한
    // stateless builtinCalls 패턴을 namespace만 바꿔 재사용(새 디스패치 메커니즘 불필요). rgb/new는
    // 마지막 인자(transp)에 기본값이 있어 가변 인자 개수, from_gradient는 5개 고정, r/g/b/t는
    // 전부 단항(채널 추출 대상 색상 하나만 받음).
    if (method === "rgb") {
      if (expr.args.length < 3 || expr.args.length > 4) {
        prog.errors.push(
          `'color.rgb' call argument count mismatch: requires 3~4, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else if (method === "new") {
      // transp=(C371)/color=(C377, wild 실사용 11건 — color.new(color=..., transp=...) 형태) —
      // isColorNewCall이 blanket 거부 예외로 뺀 kwargs 형태. 'color'는 TV 공식 시그니처의 첫 위치
      // 인자 이름 그대로라(pine2py는 python 예약어 충돌로 color_val 개명 — 이 kwarg는 pine2py가
      // 크래시하는 구조적 오라클 불가 축, hand-verified) 값 kwarg(discard 아님, colorArg 슬롯에
      // 실제로 꽂힘). 'color=' 사용 시 필수 인자 개수 체크는 kwarg로 채워진 슬롯을 포함해야 한다.
      const hasColorKwarg = expr.kwargs.some((kw) => kw.name === "color");
      const effectiveArgCount = expr.args.length + (hasColorKwarg ? 1 : 0);
      if (effectiveArgCount < 1 || effectiveArgCount > 2) {
        prog.errors.push(
          `'color.new' call argument count mismatch: requires 1~2, got ${effectiveArgCount} (L${expr.line}:${expr.col})`,
        );
      }
      let transpFromKwarg = false;
      let colorFromKwarg = false;
      for (const kw of expr.kwargs) {
        if (kw.name === "transp") {
          if (expr.args.length >= 2) {
            if (!isHarmlessArgDup(expr.args[1], kw.value)) {
              prog.errors.push(`argument 'transp' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else if (transpFromKwarg) {
            prog.errors.push(`duplicate keyword argument 'transp' (L${kw.line}:${kw.col})`);
          } else {
            transpFromKwarg = true;
          }
        } else if (kw.name === "color") {
          if (expr.args.length >= 1) {
            if (!isHarmlessArgDup(expr.args[0], kw.value)) {
              prog.errors.push(`argument 'color' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else if (colorFromKwarg) {
            prog.errors.push(`duplicate keyword argument 'color' (L${kw.line}:${kw.col})`);
          } else {
            colorFromKwarg = true;
          }
        } else {
          prog.errors.push(
            `'color.new' only supports keyword arguments 'color='/'transp=': '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        }
      }
      for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
    } else if (method === "from_gradient") {
      // value=/bottom_value=/top_value=/bottom_color=/top_color= kwargs(C479, COLOR_KWARG_PARAM_NAMES
      // 참조) — math.abs/round/sign(C404)과 동일한 "위치/키워드 슬롯 병합" 이름·중복·위치-키워드
      // 충돌 검증. 5개 전부 필수(기본값 있는 rgb/new와 달리 requiredCount===paramNames.length).
      const paramNames = COLOR_KWARG_PARAM_NAMES["from_gradient"]!;
      if (expr.kwargs.length > 0) {
        const paramIndex = new Map(paramNames.map((name, i) => [name, i]));
        if (expr.args.length > paramNames.length) {
          prog.errors.push(
            `'color.from_gradient' call argument count mismatch: requires ${paramNames.length} (${paramNames.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
          );
        }
        const seen = new Set<string>();
        for (let i = 0; i < expr.args.length && i < paramNames.length; i++) seen.add(paramNames[i]!);
        for (const kw of expr.kwargs) {
          const idx = paramIndex.get(kw.name);
          if (idx === undefined) {
            prog.errors.push(`unknown argument name for 'color.from_gradient': '${kw.name}' (L${kw.line}:${kw.col})`);
          } else if (seen.has(kw.name)) {
            const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
            if (!isHarmlessArgDup(posArg, kw.value)) {
              prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
            }
          } else {
            seen.add(kw.name);
          }
          analyzeExpr(kw.value, prog, scope, false);
        }
        const missing = paramNames.filter((name) => !seen.has(name));
        if (missing.length > 0) {
          prog.errors.push(`'color.from_gradient' call requires all of the ${paramNames.join("/")} arguments (L${expr.line}:${expr.col})`);
        }
      } else if (expr.args.length !== paramNames.length) {
        prog.errors.push(
          `'color.from_gradient' call argument count mismatch: requires 5, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    } else {
      if (expr.args.length !== 1) {
        prog.errors.push(
          `'color.${method}' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    }
    prog.builtinCalls.set(expr, method);
  } else if (namespace === "timeframe" && (method === "in_seconds" || method === "from_seconds")) {
    // timeframe.in_seconds/from_seconds(ROADMAP P2 "barstate/session/syminfo/timeframe" 세 번째
    // 슬라이스) — pine2py codegen.py의 함수-이름 매핑 테이블(barstate.*/session.*/syminfo.*가 쓰는
    // DotAccess 전용 IDENTIFIER_MAP과는 별도 테이블, L1708-1710)이 이 둘을 `wa.timeframe_in_seconds`/
    // `wa.timeframe_from_seconds`(wavealgo/__init__.py)로 라우팅하는 진짜 stateless 함수 호출이다.
    // 둘 다 math.round류(C12/C13)와 동일한 builtinCalls 패턴을 쓰지만 시그니처는 다르다(C269 재확인):
    // in_seconds(timeframe: str = "")는 기본값 있는 선택 인자(생략 시 "" -> 항상 86400, 현재
    // 타임프레임 근사치) — timeframe.change(C235)와 동일한 "0~1개" 패턴인데 이전 사이클(C150 인근)
    // 주석이 "정확히 단항"이라 잘못 단정해 0-인자 호출을 corpus 아티팩트로 오분류시켰다(실측:
    // corpus/scripts/390cd5d7f5f3.pine). from_seconds(seconds: int)는 기본값이 없어 여전히 정확히
    // 1개 필요.
    // timeframe.in_seconds(timeframe=) kwarg(C405) — 이름 불일치 없는 단일 파라미터라 math.*(C404)와
    // 동일한 위치/키워드 슬롯 병합 검증을 그대로 재사용(일관성). from_seconds는 표 밖(blanket 거부
    // 예외에도 없음)이라 이 분기에 kwargs가 오면 안 되지만, 방어적으로 in_seconds만 게이트한다.
    if (method === "in_seconds" && expr.kwargs.length > 0) {
      const paramIndex = new Map(TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.map((name, i) => [name, i]));
      if (expr.args.length > TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.length) {
        prog.errors.push(
          `'timeframe.in_seconds' call argument count mismatch: requires ${TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.length} (${TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seen = new Set<string>();
      for (let i = 0; i < expr.args.length && i < TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.length; i++) {
        seen.add(TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES[i]!);
      }
      for (const kw of expr.kwargs) {
        const idx = paramIndex.get(kw.name);
        if (idx === undefined) {
          prog.errors.push(`unknown argument name for 'timeframe.in_seconds': '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (seen.has(kw.name)) {
          const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
          if (!isHarmlessArgDup(posArg, kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
        } else {
          seen.add(kw.name);
        }
        analyzeExpr(kw.value, prog, scope, false);
      }
      // timeframe 인자 자체가 선택 인자(생략 시 "")라 math.*/nz와 달리 필수 슬롯 검증 없음.
    } else {
      const minArgs = method === "in_seconds" ? 0 : 1;
      if (expr.args.length < minArgs || expr.args.length > 1) {
        const need = method === "in_seconds" ? "0~1" : "1";
        prog.errors.push(
          `'timeframe.${method}' call argument count mismatch: requires ${need}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    }
    prog.builtinCalls.set(expr, `timeframe.${method}`);
  } else if (namespace === "timeframe" && method === "change") {
    // timeframe.change(C235, ROADMAP P3 next_hint 1순위) — pine2py wavealgo/__init__.py L269
    // timeframe_change(timeframe='D')는 인자와 무관하게 항상 False 고정(주석: "백테스트 기본 모드:
    // 항상 False, 단일 타임프레임" — 실제 멀티 타임프레임 경계 감지는 미구현이라 진짜 stateful이
    // 아니라 상수 반환). in_seconds/from_seconds와 시그니처 형태(단항, 기본값 있는 선택 인자)만
    // 같아 minArgCount:0으로 0~1개 허용.
    if (expr.args.length > 1) {
      prog.errors.push(
        `'timeframe.change' call argument count mismatch: requires 0~1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "timeframe.change");
  } else if (namespace === "syminfo" && method === "ticker") {
    // syminfo.ticker(symbol)(신규, C430 — next_hint(C429): wild 2건 6c0c2a7c04ab.pine/
    // a22502c376a6.pine, 둘 다 `ticker1 = syminfo.ticker(sym1)` 형태). bare `syminfo.ticker`
    // 프로퍼티 접근(SYMINFO_STRING_PROPS, DotAccess 전용 컴파일타임 "" 폴딩)과는 별개 문법인
    // **호출형**(1-인자) — namespace가 같아도 CallExpr이라 이 분기가 별도로 필요하다. pine2py
    // Syminfo dataclass엔 bare ticker 필드만 있고 이 콜 형태 자체가 없어(wavealgo/builtins/
    // syminfo.py + pine2wave/codegen.py 전수 grep 0건, C429 확인) 오라클 대조 불가 — hand-verified
    // (TV 통설 기반, DIVERGENCES.md에 "TV 미검증(가설)"로 등재). wild 실사용 2건 전부 정확히
    // 1개 위치 인자(kwargs 없음, 두 파일 모두 label.new(text=)/문자열 접합 후 label.new에만
    // 흘러가는 drawing no-op 소비라 수치 영향 0).
    if (expr.args.length !== 1) {
      prog.errors.push(
        `'syminfo.ticker' call argument count mismatch: requires 1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "syminfo.ticker");
  } else if (
    namespace === "ticker" &&
    (method === "new" ||
      method === "standard" ||
      method === "modify" ||
      method === "heikinashi" ||
      method === "renko" ||
      method === "kagi" ||
      method === "linebreak" ||
      method === "pointfigure" ||
      method === "inherit")
  ) {
    // ticker.*(8종, C235 — ROADMAP P3 next_hint 1순위, corpus 실측 heikinashi 3 + new 3 + standard
    // 1, 나머지는 corpus 0건이나 pine2py wavealgo/__init__.py L228-265 전부가 동일한 trivial
    // 문자열 pass-through/접합이라 네임스페이스 전체를 한 번에 지원). 전부 인자 전체가 선택적
    // 기본값을 가진 pine2py 시그니처라 인자 개수는 상한만 검증(0개 호출도 유효 — 예: ticker.new()는
    // 빈 문자열 반환). inherit(9번째, C664 — 미지원호출 클러스터 실측 wild 2건, pine2py에 대응
    // 함수가 없어 hand-verified — runtime/ticker.ts 참조)만 위치 인자 2개 고정(TV 실제 시그니처가
    // from_tickerid/symbol 둘 다 필수라 다른 7종과 달리 선택 인자가 없음, wild 2건 전부 2-인자).
    const maxArgs: Record<string, number> = {
      new: 4,
      standard: 1,
      modify: 3,
      heikinashi: 1,
      renko: 4,
      kagi: 2,
      linebreak: 2,
      pointfigure: 5,
      inherit: 2,
    };
    // kwargs 검증(C385, TICKER_KWARG_PARAM_NAMES 참조) — new/modify/renko 3종만 이름표가 있다.
    // 나머지 5종(standard/heikinashi/kagi/linebreak/pointfigure)은 kwargs가 있으면 위 blanket 거부
    // (isTickerKwargCall이 이 3종만 예외로 등재)에서 이미 걸러져 이 분기에 kwargs를 들고 도달하지
    // 않는다 — 그래서 kwargParamNames가 undefined인 경우는 항상 기존 위치-인자-전용 상한 검증만
    // 수행하면 충분하다(array.*의 analyzeArrayCall과 동일한 "이름표 있을 때만 kwargs 분기" 구조).
    const kwargParamNames = TICKER_KWARG_PARAM_NAMES[method];
    if (kwargParamNames !== undefined && expr.kwargs.length > 0) {
      const paramIndex = new Map(kwargParamNames.map((name, i) => [name, i]));
      if (expr.args.length > kwargParamNames.length) {
        prog.errors.push(
          `'ticker.${method}' call argument count mismatch: at most ${kwargParamNames.length} (${kwargParamNames.join(", ")}), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seen = new Set<string>();
      for (let i = 0; i < expr.args.length && i < kwargParamNames.length; i++) seen.add(kwargParamNames[i]!);
      for (const kw of expr.kwargs) {
        const idx = paramIndex.get(kw.name);
        if (idx === undefined) {
          prog.errors.push(`unknown argument name for 'ticker.${method}': '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (seen.has(kw.name)) {
          const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
          if (!isHarmlessArgDup(posArg, kw.value)) {
            prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
          }
        } else {
          seen.add(kw.name);
        }
        analyzeExpr(kw.value, prog, scope, false);
      }
    } else if (expr.args.length > maxArgs[method]!) {
      prog.errors.push(
        `'ticker.${method}' call argument count mismatch: at most ${maxArgs[method]}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, `ticker.${method}`);
  } else if (
    namespace === "chart" &&
    (method === "is_standard" ||
      method === "is_heikinashi" ||
      method === "is_renko" ||
      method === "is_kagi" ||
      method === "is_linebreak" ||
      method === "is_pnf" ||
      method === "is_range")
  ) {
    // chart.is_standard/is_heikinashi/is_renko/is_kagi/is_linebreak/is_pnf/is_range(C239 —
    // ROADMAP P3 next_hint 1순위, corpus 실측 is_heikinashi 1 + is_standard 1). pine2py에 대응
    // 구현이 전혀 없어(codegen.py/wavealgo 전수 grep 0건) 오라클 불가 — TV 공식 문법상 인자
    // 없는 차트 타입 검사 술어라 전부 0-인자 고정. rt.chart.is_*(hand-verified, LIMITATIONS.md)로
    // is_standard=true/나머지=false 하드코딩.
    if (expr.args.length !== 0) {
      prog.errors.push(
        `'chart.${method}' call argument count mismatch: requires 0, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, `chart.${method}`);
  } else if (namespace === "request" && (method === "dividends" || method === "splits")) {
    // request.dividends/request.splits(C239 최초 구현, C398에서 kwargs 지원 추가 — next_hint(C397)
    // 1순위, wild 20건이 `request.dividends(syminfo.tickerid, dividends.gross, barmerge.gaps_on,
    // barmerge.lookahead_on, ignore_invalid_symbol=true)` 폼(+1건 gaps= 단독)). pine2py
    // wavealgo/__init__.py L122-128 request_splits/request_dividends(ticker=None, field=None,
    // gaps=False, lookahead=False, **kwargs)가 인자 전부 무시하고 항상 0.0을 반환하는 순수 스텁이라
    // (request.earnings/financial과 완전히 동일한 형태) literal port로 오라클 대조 가능. C397이
    // request.earnings에 적용한 것과 동일 원칙 — 반환값이 항상 상수라 이름/중복 검증만 하고 값은
    // discard(위치 슬롯 낮춤 불필요, codegen 범용 fallback 그대로 재사용, C211). 위치 인자 최대
    // 4개(ticker/field/gaps/lookahead, earnings/financial과 동일 시그니처 shape).
    const DIVIDENDS_SPLITS_PARAM_NAMES = ["ticker", "field", "gaps", "lookahead", "ignore_invalid_symbol"] as const;
    if (expr.args.length > 4) {
      prog.errors.push(
        `'request.${method}' call argument count mismatch: at most 4, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const seenDividendsSplitsKwargs = new Set<string>();
    for (const kw of expr.kwargs) {
      if (!DIVIDENDS_SPLITS_PARAM_NAMES.includes(kw.name as (typeof DIVIDENDS_SPLITS_PARAM_NAMES)[number])) {
        prog.errors.push(
          `'request.${method}' only supports keyword arguments '${DIVIDENDS_SPLITS_PARAM_NAMES.join("='/'")}=': '${kw.name}=' (L${kw.line}:${kw.col})`,
        );
      } else if (seenDividendsSplitsKwargs.has(kw.name)) {
        prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      }
      seenDividendsSplitsKwargs.add(kw.name);
      analyzeExpr(kw.value, prog, scope, false);
    }
    prog.builtinCalls.set(expr, `request.${method}`);
  } else if (namespace === "request" && method === "financial") {
    // request.financial(신규, C257 — corpus 실측 2건, 65306019fd7f.pine + ecb416ca8aa7.pine, 둘 다
    // `request.financial(syminfo.tickerid, "TOTAL_REVENUE", "FQ")` 3-인자 패턴). pine2py
    // wavealgo/__init__.py L118-120 request_financial(symbol=None, financial_id=None, period=None,
    // gaps=False, lookahead=False, **kwargs)이 인자 전부 무시하고 항상 NaN을 반환하는 순수 스텁이라
    // (dividends/splits, C239와 동일 원칙 — 이 스텁 자체가 오라클) literal port로 오라클 대조 가능.
    // 위치 인자 최대 5개(symbol/financial_id/period/gaps/lookahead, pine2py 시그니처 전부
    // 기본값 有 — 하한 없음, dividends/splits와 동일 원칙 재적용).
    // kwargs 슬라이스(C385, next_hint(C384) 1순위 — wild gate(220) 클러스터 재분포 2위, 순증 상한
    // 4건). wild 실측(corpus grep) 전량이 `ignore_invalid_symbol=true` 폼(pine2py 시그니처엔 없는
    // 이름이나 **kwargs로 흡수돼 무시됨) — 반환값이 항상 상수 NaN이라 이름/개수 검증만 하고 값은
    // 그대로 discard(위치 슬롯 낮춤 불필요, codegen 범용 fallback 그대로 재사용, C211).
    const FINANCIAL_PARAM_NAMES = ["symbol", "financial_id", "period", "gaps", "lookahead", "ignore_invalid_symbol"] as const;
    if (expr.args.length > 5) {
      prog.errors.push(
        `'request.financial' call argument count mismatch: at most 5, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const seenFinancialKwargs = new Set<string>();
    for (const kw of expr.kwargs) {
      if (!FINANCIAL_PARAM_NAMES.includes(kw.name as (typeof FINANCIAL_PARAM_NAMES)[number])) {
        prog.errors.push(
          `'request.financial' only supports keyword arguments '${FINANCIAL_PARAM_NAMES.join("='/'")}=': '${kw.name}=' (L${kw.line}:${kw.col})`,
        );
      } else if (seenFinancialKwargs.has(kw.name)) {
        prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      }
      seenFinancialKwargs.add(kw.name);
      analyzeExpr(kw.value, prog, scope, false);
    }
    prog.builtinCalls.set(expr, "request.financial");
  } else if (namespace === "request" && method === "earnings") {
    // request.earnings(신규, C397 — wild kwarg 블랑켓 잔여 94건 재세분류 1위, ignore_invalid_symbol=
    // 21건/gaps= 3건 = 24건). pine2py wavealgo/__init__.py L130-132 request_earnings(ticker=None,
    // field=None, gaps=False, lookahead=False, **kwargs)가 dividends/splits(C239)와 완전히 동일한
    // 형태의 순수 스텁(인자 전부 무시, 항상 0.0 반환) — literal port로 오라클 대조 가능. 위치 인자
    // 최대 4개(ticker/field/gaps/lookahead, dividends/splits와 동일 시그니처 shape).
    // kwargs는 request.financial(C385)과 동일 원칙 — 반환값이 항상 상수라 이름/중복 검증만 하고
    // 값은 그대로 discard(위치 슬롯 낮춤 불필요, codegen 범용 fallback 그대로 재사용, C211). wild
    // 실측 kwarg 이름: ticker=/field=/gaps=/lookahead=(pine2py 시그니처 그대로) +
    // ignore_invalid_symbol=(시그니처엔 없으나 **kwargs로 흡수돼 무시됨, financial과 동일 이유).
    const EARNINGS_PARAM_NAMES = ["ticker", "field", "gaps", "lookahead", "ignore_invalid_symbol"] as const;
    if (expr.args.length > 4) {
      prog.errors.push(
        `'request.earnings' call argument count mismatch: at most 4, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const seenEarningsKwargs = new Set<string>();
    for (const kw of expr.kwargs) {
      if (!EARNINGS_PARAM_NAMES.includes(kw.name as (typeof EARNINGS_PARAM_NAMES)[number])) {
        prog.errors.push(
          `'request.earnings' only supports keyword arguments '${EARNINGS_PARAM_NAMES.join("='/'")}=': '${kw.name}=' (L${kw.line}:${kw.col})`,
        );
      } else if (seenEarningsKwargs.has(kw.name)) {
        prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      }
      seenEarningsKwargs.add(kw.name);
      analyzeExpr(kw.value, prog, scope, false);
    }
    prog.builtinCalls.set(expr, "request.earnings");
  } else if (namespace === "request" && method === "quandl") {
    // request.quandl(신규, C310 — corpus 실측 2건). pine2py wavealgo/__init__.py L138-140
    // request_quandl(ticker=None, gaps=False, lookahead=False, **kwargs)이 인자 전부 무시하고
    // 항상 0.0을 반환하는 순수 스텁 — dividends/splits/financial(C239/C257)과 동일 원칙(스텁
    // 자체가 오라클). 위치 인자 최대 3개(ticker/gaps/lookahead, pine2py 시그니처 전부 기본값
    // 有 — 하한 없음, dividends/splits/financial과 동일 원칙 재적용).
    if (expr.args.length > 3) {
      prog.errors.push(
        `'request.quandl' call argument count mismatch: at most 3, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "request.quandl");
  } else if (namespace === "request" && method === "seed") {
    // request.seed(신규, C321 next_hint 1순위 — corpus 실측 8건, 전량 `request.seed(source, symbol,
    // expression)` 3-인자 위치 패턴(kwargs/4번째 ignore_invalid_symbol 실사용 0건, 5cafa76f552e.pine/
    // 6ae599175ff4.pine/41e8521a46ed.pine 등). pine2py에 대응 구현이 전혀 없음(wavealgo/codegen.py
    // 전수 grep 0건 — dividends/splits/financial/quandl과 달리 스텁조차 없음) — TV 공식 문법상 커뮤니티
    // 유지보수 "seed" 데이터셋(예: SEED_CRYPTO_SANTIMENT, SEED_myuser_data 등)을 조회하는 함수라 우리
    // 엔진의 단일 OHLCV 배치 리플레이 데이터 모델 자체에 이 데이터 소스가 없다 — financial/economic
    // (C257, pine2py 스텁이 이미 NaN 고정)과 동일한 "외부 데이터 부재 → NaN 고정" 원칙을 hand-verified로
    // 신규 적용(TV 미검증 가설, DIVERGENCES 등재 — pine2py 대조 자체가 불가능해 literal port 근거가 없음).
    // expression(3번째 인자)의 값 자체는 버리지만 부작용 보존을 위해 genExpr는 그대로 수행한다
    // (request.security_lower_tf, C310과 동일 관례) — narrow 표현식 제약은 불필요: request.security류의
    // HTF 캐싱 자체가 없어(symbol이 실존 데이터 소스가 아님) C180류 캐싱 함정이 처음부터 없다. 위치
    // 인자 3~4개(source/symbol/expression 필수 + ignore_invalid_symbol 선택).
    if (expr.args.length < 3 || expr.args.length > 4) {
      prog.errors.push(
        `'request.seed' call argument count mismatch: requires 3~4, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "request.seed");
  } else if (namespace === "request" && method === "currency_rate") {
    // request.currency_rate(신규, C321 — corpus 실측 2건, `request.currency_rate(from, to)`/
    // `request.currency_rate(syminfo.currency, strategy.account_currency)` 2-인자 패턴, kwargs/3번째
    // ignore_invalid_currency 실사용 0건). pine2py에 대응 구현 전혀 없음(financial/quandl과 달리
    // 스텁조차 없음, python grep 확인) — TV 공식 문서: "값을 계산할 수 없으면 na가 반환되거나,
    // ignore_invalid_currency 값에 따라 런타임 에러가 발생한다". 우리 엔진엔 실제 FX 환율 데이터
    // 소스가 없어 일반적인 경우엔 na가 TV와 정합하는 유일한 안전값이지만, from===to는 정의상 항상
    // 1.0(항등 변환, 외부 데이터 조회 자체가 불필요한 유일한 축)이라 hand-verified로 이 두 값만 분기
    // (TV 미검증 가설이지만 항등 케이스는 외부 검증 없이도 수학적으로 자명, DIVERGENCES 등재). 위치
    // 인자 2~3개(from/to 필수 + ignore_invalid_currency 선택).
    if (expr.args.length < 2 || expr.args.length > 3) {
      prog.errors.push(
        `'request.currency_rate' call argument count mismatch: requires 2~3, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "request.currency_rate");
  } else if (namespace === "request" && method === "security_lower_tf") {
    // request.security_lower_tf(신규, C310 — wild 3위 서브클러스터 14건). pine2py
    // wavealgo/__init__.py L103-113가 symbol/timeframe/context를 전부 무시하고(codegen.py
    // CONTEXT_FUNCS가 context=ctx를 얹어도 이 함수 시그니처엔 그 파라미터가 없어 **kwargs로
    // 흡수돼 버려짐, python 실측 확인) expression을 현재 바 값으로 평가해 원소 1개짜리 배열로
    // 감싸는 순수 스텁이다 — request.security(C174~182)의 실제 HTF 캐시 집계와 근본적으로
    // 다른 함수라 narrow 표현식 제약(bare series/ta.* 한정, C180)이 필요 없다: codegen이 이미
    // Series 산술을 스칼라로 낮추므로(GOAL.md ".get(0) 명시 생성") expression 인자는 임의
    // 표현식을 그대로 genExpr 허용. 위치 인자 최대 7개(symbol/timeframe/expression/
    // ignore_invalid_symbol/currency/ignore_invalid_timeframe/calc_bars_count, pine2py 시그니처
    // 전부 기본값 有).
    // kwargs 슬라이스(C381, next_hint(C380) 1순위 — wild gate(220) 클러스터 재분포 1위, 순증 상한
    // 8건). wild 실측(scratch/probe_seclowertf_kwargs.mjs)에 나온 이름만 큐레이션(C283 원칙):
    // symbol=/timeframe=/expression=/ignore_invalid_symbol=/ignore_invalid_timeframe=/
    // calc_bars_count= 6종 전부 실사용 확인(025aa36173f0.pine calc_bars_count=, 1b17dd6f8017.pine
    // ignore_invalid_timeframe=, 395803745923.pine 전체 키워드 폼(symbol=/timeframe=/expression=
    // 포함), 3e39357fefc7.pine ignore_invalid_symbol=). currency=(5번째 위치)는 wild 실사용 0건이라
    // 이번 슬라이스 kwarg 미지원 유지(위치 인자로는 계속 지원, blanket 거부 예외는 안 뺐지만 이름
    // 자체를 아래 화이트리스트에 안 넣어 자연 거부). codegen(genCallExpr request.security_lower_tf
    // 전용 분기)이 이 6개 이름을 pine2py 시그니처 순서 그대로 위치 슬롯(0/1/2/3/5/6, 4는 currency
    // 자리라 건너뜀)에 낮춘다 — strategy.entry류 KWARG_SLOTS와 동일 원리(C129, 값이 실제로 지정된
    // 가장 뒤쪽 슬롯까지만 채움).
    const LOWER_TF_PARAM_NAMES = [
      "symbol",
      "timeframe",
      "expression",
      "ignore_invalid_symbol",
      "ignore_invalid_timeframe",
      "calc_bars_count",
    ] as const;
    if (expr.args.length > 7) {
      prog.errors.push(
        `'request.security_lower_tf' call argument count mismatch: at most 7, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    } else {
      const paramIndex = new Map<string, number>([
        ["symbol", 0],
        ["timeframe", 1],
        ["expression", 2],
        ["ignore_invalid_symbol", 3],
        ["ignore_invalid_timeframe", 5],
        ["calc_bars_count", 6],
      ]);
      const seenLowerTfKwargs = new Set<string>();
      for (const kw of expr.kwargs) {
        const idx = paramIndex.get(kw.name);
        if (idx === undefined) {
          prog.errors.push(
            `'request.security_lower_tf' only supports keyword arguments '${LOWER_TF_PARAM_NAMES.join("='/'")}=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenLowerTfKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
          prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
        seenLowerTfKwargs.add(kw.name);
        analyzeExpr(kw.value, prog, scope, false);
      }
    }
    // C434: 튜플 디스트럭처 값 위치(`[a,b,...] = request.security_lower_tf(sym, tf, expr)`,
    // AnalyzedProgram.securityLowerTfTupleElemSlots/securityLowerTfBareUdfCallSlots 주석 참조) —
    // analyzeTupleDestructure가 미리 등록해뒀다(C432/C433과 동형 조회). 이 두 폼은 expression
    // 자리(args[2])가 일반 스칼라 표현식이 아니라(TupleExpr 리터럴/튜플 반환 UDF 콜) 아래 공용
    // 꼬리(`for (const arg of expr.args) analyzeExpr(...)`)가 그대로 훑으면 "이 위치에서 TupleExpr
    // 지원 안 함"/"튜플 반환 콜은 스칼라 위치에서 사용 불가"류 엉뚱한 에러로 떨어진다 — exprMatch류
    // (call-expr.ts request.security 분기)와 동일하게 여기서 즉시 return해 공용 꼬리를 피하고, symbol/
    // timeframe(및 나머지 위치 인자가 있다면 그것도)만 별도로 analyzeExpr한다.
    const lowerTfTupleElems = prog.securityLowerTfTupleElemSlots.get(expr);
    const lowerTfBareUdf = prog.securityLowerTfBareUdfCallSlots.get(expr);
    if (lowerTfTupleElems !== undefined || lowerTfBareUdf !== undefined) {
      expr.args.forEach((a, i) => {
        if (i === 2) return; // expression 인자 — 아래에서 별도 처리
        analyzeExpr(a, prog, scope, false);
      });
      if (lowerTfTupleElems !== undefined) {
        for (const el of lowerTfTupleElems) analyzeExpr(el, prog, scope, false);
      } else {
        analyzeExpr(lowerTfBareUdf!, prog, scope, false);
      }
      prog.builtinCalls.set(expr, "request.security_lower_tf");
      return;
    }
    prog.builtinCalls.set(expr, "request.security_lower_tf");
  } else if (
    namespace === "strategy" &&
    (method === "entry" ||
      method === "order" ||
      method === "exit" ||
      method === "close" ||
      method === "close_all" ||
      method === "cancel" ||
      method === "cancel_all")
  ) {
    // strategy.entry/close 첫 슬라이스(C163, ROADMAP "[hard] strategy.*") + cancel/cancel_all
    // (C166 넷째 슬라이스 — limit/stop 주문이 바를 넘어 이월되면서 취소 수단이 필요해진 묶음)
    // + exit 브래킷 청산(C167 다섯째 슬라이스) + close_all/qty= 부분 청산(C168 여섯째 슬라이스)
    // + order 넷팅 주문(C169 일곱째 슬라이스 — entry와 시그니처/kwargs 검증이 완전히 동일해
    // 한 분기에서 method 이름만 갈아끼움). ta.*(콜사이트별 상태 슬롯)와 달리 콜사이트별 상태가
    // 없고(전역 단일 브로커 상태 $.strategy를 뮤테이션) 신호 바에서만 호출되는 이벤트 구동이라
    // 조건부 블록 제약(firstForbiddenKind)을 적용하지 않는다 — `if 조건` 본문 안 호출이 오히려
    // 표준 사용 패턴. 반환값이 없어(void) 문장 위치(bare ExprStmt, 깊이 무관)만 허용 — plot의
    // topLevel(depth 0 한정)과 다른 축이라 prog.stmtCalls(analyzeStmt가 등록)로 판별한다. 나머지
    // strategy.*(convert_to_account 등)는 이 분기 조건에 안 걸려 아래 "지원하지 않는 호출" 기본
    // 에러로 자연 거부.
    // C771 — strategy() 선행 선언 불필요(wild tv_verdict 실측: `indicator()`뿐인 스크립트가
    // strategy.entry/exit/close 등을 그대로 호출해도 TV 컴파일 수용, analyzer.ts 주석 참조).
    if (!prog.stmtCalls.has(expr)) {
      prog.errors.push(
        `'strategy.${method}' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
      );
    } else if (method === "entry" || method === "order") {
      // entry(C163~C166)와 order(C169)는 TV 시그니처가 동일(id, direction[, qty] + qty=/limit=/
      // stop=/comment=)해 검증을 공유한다 — 에러 메시지의 method 이름만 갈린다(entry 쪽 기존
      // 메시지 문자열은 한 글자도 안 바뀜). 체결 시맨틱 차이(넷팅 vs 리버스/pyramiding)는 전부
      // 런타임(StrategyState.order) 축이라 analyzer/codegen은 대칭.
      // C423(wild argcount 클러스터 51건, next_hint(C422) 재클러스터링 파생): id/direction도
      // strategy.close의 id=(C293)와 동일하게 위치 또는 키워드 인자 중 하나로만 지정 가능 — wild
      // 실측 전량이 `strategy.entry(id="Long", direction=strategy.long, ...)`(0 positional) 또는
      // `strategy.entry("long", direction=strategy.long, when=...)`(id만 positional) 폼.
      const idKwarg = expr.kwargs.find((kw) => kw.name === "id");
      const directionKwarg = expr.kwargs.find((kw) => kw.name === "direction");
      if (
        expr.args.length > 3 ||
        (expr.args.length === 0 && idKwarg === undefined) ||
        (expr.args.length < 2 && directionKwarg === undefined)
      ) {
        prog.errors.push(
          `'strategy.${method}' call argument count mismatch: requires 0~3 (id, direction[, qty] — id/direction may also be specified as keyword arguments), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else if (expr.args.length >= 1 && idKwarg !== undefined && !isHarmlessArgDup(expr.args[0], idKwarg.value)) {
        prog.errors.push(`argument 'id' specified both positionally and as a keyword (L${idKwarg.line}:${idKwarg.col})`);
      } else if (
        expr.args.length >= 2 &&
        directionKwarg !== undefined &&
        !isHarmlessArgDup(expr.args[1], directionKwarg.value)
      ) {
        prog.errors.push(
          `argument 'direction' specified both positionally and as a keyword (L${directionKwarg.line}:${directionKwarg.col})`,
        );
      }
      // qty=/comment= kwargs(C164, comment= 값은 C173부터 실소비) + limit=/stop=(C166 — 지정가/
      // 역지정가 주문 해제, 키워드 전용: 위치 인자는 2~3개 유지라 positional limit/stop과의 충돌
      // 축 자체가 없다) + when=(C372, strategy.close의 when=(C293)과 동일 게이트 kwarg — pine2py
      // engine.py entry()/order() 둘 다 `when: bool = True`가 named parameter이고 함수 최상단
      // `if not when: return`으로 소비함을 python 소스로 확인, wild 최다 단일 kwarg 클러스터).
      // alert_message=(C374, wild named-list kwarg 클러스터 1위 — TV 시그니처엔 있으나 alert 팝업
      // 텍스트 치환용일 뿐 P&L/체결에 무관한 순수 표시값. pine2py engine.py entry()/order() 둘 다
      // **kwargs로 흡수·조용히 버림을 python 소스로 확인 — C147 원칙대로 파싱만 허용, codegen
      // KWARG_SLOTS에 슬롯을 안 줘 자연 discard(신규 상태/코드 0줄)). disable_alert=(C746, next_hint
      // (C745) "kwarg 상호배타 잔여" 재조사 — exit(C708)/close_all(C724)에 이미 이식된 alert 억제
      // 스위치의 entry/order판. alert_message=와 완전히 동일 축(P&L/체결가 무관 순수 표시 제어)이라
      // 같은 discard 메커니즘 재사용. oca_name= 등 주문 시맨틱을 바꾸는 나머지 TV 파라미터는
      // 파싱-후-버림이 조용한 오답이라 plot 렌더링 kwargs와 달리 하드 에러로 막는다(OCA 축은
      // ROADMAP 배치37 (4) 감독 승인 대기 — 임의 착수 금지). id=/direction=(C423)는 위 별도 블록이
      // 위치-키워드 중복/누락을 이미 검증했으므로 여기서는 허용 목록에만 추가.
      const seenEntryKwargs = new Set<string>();
      for (const kw of expr.kwargs) {
        if (
          kw.name !== "id" &&
          kw.name !== "direction" &&
          kw.name !== "qty" &&
          kw.name !== "comment" &&
          kw.name !== "limit" &&
          kw.name !== "stop" &&
          kw.name !== "when" &&
          kw.name !== "alert_message" &&
          kw.name !== "disable_alert"
        ) {
          prog.errors.push(
            `'strategy.${method}' only supports keyword arguments 'id='/'direction='/'qty='/'comment='/'limit='/'stop='/'when='/'alert_message='/'disable_alert=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenEntryKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (kw.name === "qty" && expr.args.length >= 3 && !isHarmlessArgDup(expr.args[2], kw.value)) {
          prog.errors.push(`argument 'qty' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
        seenEntryKwargs.add(kw.name);
      }
      prog.builtinCalls.set(expr, `strategy.${method}`);
    } else if (method === "exit") {
      // strategy.exit(id[, from_entry], limit=, stop=, trail_points=, trail_offset=, trail_price=) —
      // 브래킷 청산(C167, 트레일링 C170, 절대가 활성화 C178). TV 위치 인자 순서는 id, from_entry,
      // qty, ...이지만 qty(부분 청산)는 미구현이라 위치 인자는 1~2개로 제한. limit=/stop=은
      // entry(C166)와 동일하게 키워드 전용.
      // C723(배치37 지시 (1), wild "kwarg 상호배타 과잉검증" 29건 중 다수): 청산 조건 없음/trail_price
      // 단독/trail_offset 단독/trail_price+trail_points 동시/profit+limit 동시/loss+stop 동시를 막던
      // 6종 컴파일타임 하드 에러를 제거. runtime/strategy.ts의 exit()/exitFillPrice()를 다시 읽어보니
      // 이미 전부 NaN-우선순위 폴백으로 안전하게 흡수하고 있었다(하드 에러가 그 사실을 모르고 남아있던
      // 과잉검증, DIVERGENCES #70/#73/#79/#98 재검토): (1) limit/stop/trail_points/trail_price/profit/
      // loss가 전부 NaN이면 exit()가 등록 자체를 건너뛰는 조용한 no-op 가드가 이미 있음(L1145-1150).
      // (2) trail_price+trail_points 동시 지정 시 activation은 trail_price(우선), offset은
      // trail_points로 자연 분리(exitFillPrice L1655-1658, 상충이 아니라 서로 다른 역할). (3) trail_price
      // 단독(trail_offset/trail_points 둘 다 없음)은 offset이 NaN으로 남아 트레일링 축만 영구 비활성(다른
      // 청산 조건이 있으면 그쪽으로 청산, wild 표본 4건 전부 limit=/stop=/profit=과 병용). (4) trail_offset
      // 단독도 활성화 조건(trail_points/trail_price) 부재 시 hasTrail=false로 완전 비활성(no-op). (5)
      // profit/loss는 limit/stop과 같은 NaN-우선순위 폴백(exitFillPrice L1630-1638, limit/stop이 항상
      // 우선)이라 동시 지정도 상충이 아니라 단순 우선순위. 전부 hand-verified(TV 실측 미검증, DIVERGENCES
      // 갱신 필요) — 크래시/NaN 전파 없이 "일부 조건이 조용히 비활성"으로만 저하되는 안전한 근사.
      // profit=/loss= 등 나머지 주문 시맨틱 kwargs 자체의 화이트리스트 등재는 파싱-후-버림이 조용한
      // 오답이라 여전히 하드 에러(entry의 oca_name= 축과 동일 — oca_name=은 배치37 (a)의 별도 항목).
      // comment_loss=/comment_profit=(C375, hand-verified, wild named-list kwarg 클러스터 최다빈도
      // 51건)는 qty_percent=/alert_message=와 같은 축(청산 조건 아님 — 아래 hasExitCondition에서
      // 제외)이되 alert_message와 달리 순수 discard가 아니다: comment=는 이미 exitOrderComment/
      // closedtrades.exit_comment(C173)로 실소비되는 값이라 트리거별(stop/loss vs limit/profit)
      // 오버라이드도 실제 시맨틱으로 구현(runtime/strategy.ts exitFillKind 참조, MEMORY C147 원칙).
      // comment_trailing=(C673, hand-verified) — C375가 범위 밖으로 남겨둔 세 번째 축(TV 시그니처의
      // 트레일링 전용 comment 오버라이드, wild 12파일). exitFillKind==="profit"/"loss" 두 값만
      // 정의됐던 것에 순수 트레일링 체결(exitFillKind===null)용 오버라이드를 comment_loss/profit과
      // 동일한 "미지정(null)이면 comment=로 폴백" 규약으로 추가(runtime/strategy.ts 참조).
      // when=(C380) — pine2py wavealgo/strategy/engine.py exit(..., when: bool=True, **kwargs)가
      // when을 실제 named parameter로 받아 `if not when: return`로 함수 최상단에서 게이팅함을 python
      // 소스로 직접 재확인(L167). entry/order(C372)/close(C293)/close_all(C378)에 이미 이식된 것과
      // 동일한 설계를 exit에 마저 적용(청산 조건 아님 — hasExitCondition에서 제외, qty_percent=와
      // 동일 축).
      // alert_profit=/alert_loss=/disable_alert=(C708, batch35 kwarg화이트리스트(18→36) 재실측 —
      // wild 9건) — TV 실제 시그니처의 트리거별 alert 텍스트 오버라이드/알림 억제 파라미터. comment_
      // loss/profit(C375)과 이름은 비슷하나 그것과 달리 alert_message=(C374)와 완전히 동일한 축:
      // P&L/체결가/코멘트 등 어떤 값에도 영향 없는 순수 alert 팝업 표시값이라(disable_alert=은 그
      // 팝업 자체를 끄는 스위치) pine2py는 alert 시스템 자체가 없어 **kwargs로 흡수·discard되고,
      // pine2js도 파싱만 허용하고 KWARG_SLOTS(codegen.ts)에 슬롯을 안 줘 자연 discard(신규 상태/코드
      // 0줄, alert_message=와 동일 메커니즘).
      // C424(next_hint(C423) 1순위 재검증, MEMORY C63 원칙 — 착수 전 wild 표본을 실행 재확인한 결과
      // next_hint가 예상한 "qty 3번째 위치 인자"(2건, `strategy.exit("Bracket","LE1", q,
      // profit=tp, loss=sl)`류)는 소수였고, 실제 다수(wild argcount 클러스터 49건 중 47건)는
      // id(종종 from_entry도 함께)를 전부 키워드 인자로 주는 폼(`strategy.exit(id="LE", profit=...,
      // stop=...)`류) — entry/order(C423)의 id=/direction= 확장과 동일 축이 exit에는 아직 없었다.
      // id도 strategy.close의 id=(C293)와 동일하게 위치 또는 키워드 인자 중 하나로 지정 가능하도록
      // 확장 + qty도 3번째 위치 인자로 허용(exit의 런타임 시그니처 순서(id,from_entry,limit,stop,
      // qty,...)가 TV 위치 순서(id,from_entry,qty)와 달라 codegen에서 별도 재배치가 필요 — 아래).
      const idKwarg = expr.kwargs.find((kw) => kw.name === "id");
      if (expr.args.length > 3 || (expr.args.length === 0 && idKwarg === undefined)) {
        prog.errors.push(
          `'strategy.exit' call argument count mismatch: requires 0~3 (id[, from_entry[, qty]] — id may also be specified as a keyword argument), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else if (expr.args.length >= 1 && idKwarg !== undefined && !isHarmlessArgDup(expr.args[0], idKwarg.value)) {
        prog.errors.push(`argument 'id' specified both positionally and as a keyword (L${idKwarg.line}:${idKwarg.col})`);
      }
      const seenExitKwargs = new Set<string>();
      for (const kw of expr.kwargs) {
        if (
          kw.name !== "id" &&
          kw.name !== "from_entry" &&
          kw.name !== "limit" &&
          kw.name !== "stop" &&
          kw.name !== "trail_points" &&
          kw.name !== "trail_offset" &&
          kw.name !== "trail_price" &&
          kw.name !== "qty" &&
          kw.name !== "comment" &&
          kw.name !== "profit" &&
          kw.name !== "loss" &&
          kw.name !== "qty_percent" &&
          kw.name !== "alert_message" &&
          kw.name !== "comment_loss" &&
          kw.name !== "comment_profit" &&
          kw.name !== "comment_trailing" &&
          kw.name !== "when" &&
          kw.name !== "alert_profit" &&
          kw.name !== "alert_loss" &&
          kw.name !== "disable_alert"
        ) {
          prog.errors.push(
            `'strategy.exit' only supports keyword arguments 'id='/'from_entry='/'limit='/'stop='/'trail_points='/'trail_offset='/'trail_price='/'qty='/'comment='/'profit='/'loss='/'qty_percent='/'alert_message='/'comment_loss='/'comment_profit='/'comment_trailing='/'when='/'alert_profit='/'alert_loss='/'disable_alert=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenExitKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (kw.name === "from_entry" && expr.args.length >= 2 && !isHarmlessArgDup(expr.args[1], kw.value)) {
          prog.errors.push(`argument 'from_entry' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        } else if (kw.name === "qty" && expr.args.length >= 3 && !isHarmlessArgDup(expr.args[2], kw.value)) {
          prog.errors.push(`argument 'qty' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
        seenExitKwargs.add(kw.name);
      }
      prog.builtinCalls.set(expr, "strategy.exit");
    } else if (method === "close") {
      // C293(wild argcount 클러스터): id는 위치 인자 또는 'id=' 키워드 인자 중 정확히 하나로만
      // 지정 가능 — wild 실측(`strategy.close(id="Short", when=...)`) 전량이 named-arg 폼이고,
      // pine2py wavealgo/strategy/engine.py close(id="", comment="", when=True, **kwargs)도 id를
      // named parameter로 받아 이 폼을 지원함을 확인(TV 실제 시그니처가 위치 전용이 아니었을 뿐).
      // C345(wild argcount 클러스터 재조사, next_hint(C344) 1순위): 위치 인자 2번째 슬롯(comment)
      // 신규 지원 — wild 실측 2건(2809fd00b760.pine `strategy.close("buy", "closebuy-all",
      // qty_percent=100)`, 9fe2abd2e2d6.pine `strategy.close(42, f(close) ? "a" : "b")`) 모두
      // 2번째 위치 인자가 문자열/문자열식(comment)이고, pine2py close(id="", comment="", when=True,
      // **kwargs)의 위치 시그니처(id, comment, when)와 정합 — qty는 그 시그니처에 없어(kwargs로
      // 흡수·무시) 위치 슬롯일 수 없다. codegen에서 이 위치 comment를 런타임 comment 슬롯으로
      // 재배치해야 한다(런타임 StrategyState.close(id, qty, comment, when)는 슬롯 순서가 다름).
      const idKwarg = expr.kwargs.find((kw) => kw.name === "id");
      const commentKwarg = expr.kwargs.find((kw) => kw.name === "comment");
      if (expr.args.length > 2 || (expr.args.length === 0 && idKwarg === undefined)) {
        prog.errors.push(
          `'strategy.close' call argument count mismatch: requires 1~2 (entry id[, comment]), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else if (expr.args.length >= 1 && idKwarg !== undefined && !isHarmlessArgDup(expr.args[0], idKwarg.value)) {
        prog.errors.push(
          `argument 'id' specified both positionally and as a keyword (L${idKwarg.line}:${idKwarg.col})`,
        );
      } else if (
        expr.args.length === 2 &&
        commentKwarg !== undefined &&
        !isHarmlessArgDup(expr.args[1], commentKwarg.value)
      ) {
        prog.errors.push(
          `argument 'comment' specified both positionally and as a keyword (L${commentKwarg.line}:${commentKwarg.col})`,
        );
      }
      // qty=(C168 부분 청산) + comment=(C173부터 실소비) + when=(C293) + qty_percent=(C373,
      // exit()의 qty_percent와 동일 메커니즘 — qty 우선, 생략 시에만 콜타임 |posSize|*percent/100) +
      // immediately=(C379, hand-verified — "다음 바 open" 큐잉을 건너뛰고 이 바에서 즉시 체결,
      // pine2py는 **kwargs 흡수뿐이라 오라클 불가). 나머지 주문 시맨틱 kwargs는 조용한 오답 방지
      // 하드 에러(entry oca_name= 축과 동일).
      const seenCloseKwargs = new Set<string>();
      for (const kw of expr.kwargs) {
        if (
          kw.name !== "id" && kw.name !== "qty" && kw.name !== "comment" && kw.name !== "when" &&
          kw.name !== "qty_percent" && kw.name !== "alert_message" && kw.name !== "immediately"
        ) {
          prog.errors.push(
            `'strategy.close' only supports keyword arguments 'id='/'qty='/'comment='/'when='/'qty_percent='/'alert_message='/'immediately=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenCloseKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        }
        seenCloseKwargs.add(kw.name);
      }
      prog.builtinCalls.set(expr, "strategy.close");
    } else if (method === "close_all") {
      // strategy.close_all(C168) — id 무관 전량 마켓 청산. TV 시그니처(comment, alert_message,
      // immediately, disable_alert)는 전부 선택 인자라 위치 인자 0~1개(comment)로 제한하고, comment=/
      // alert_message=/when=/immediately=만 허용(C173부터 comment 실소비, alert_message는 C374 순수
      // 표시값 discard, when=(C378)은 entry/order(C372)/close(C293)와 동일한 실소비 게이트 — pine2py
      // wavealgo/strategy/engine.py `close_all(self, comment: str="", when: bool=True)`이 실제
      // named parameter로 받아 `if not when or self.position.is_flat: return`로 게이팅함을 python
      // 소스로 직접 재확인(C377 "순증 상한을 실측 없이 믿지 말 것" 원칙 적용 — scratch/
      // probe_c371_kwarg_cluster.mjs 재실행으로 wild 5건 재확인). immediately=(C379, hand-verified) —
      // pine2py close_all()은 **kwargs 자체가 없어 immediately=를 넘기면 구조적으로 크래시(오라클
      // 불가, C374 alert_message= 선례와 동일 갭) — wild 실측(corpus/wild/scripts_v56 grep) 전량이
      // immediately=true(디폴트 false를 명시할 이유가 없음)라 순수 discard는 조용한 오답이 확정적이라
      // 하드 에러 대신 실제 즉시체결 시맨틱으로 구현.
      // C724(배치37 (1) 잔여 1건, next_hint(C723)): disable_alert=는 exit()의 alert_profit=/alert_loss=/
      // disable_alert=(C708)와 완전히 동일한 축 — P&L/체결가 등 어떤 값에도 영향 없는 순수 alert 팝업
      // 억제 스위치. pine2py는 alert 시스템 자체가 없어 **kwargs로 흡수·discard되므로 exit()와 동일하게
      // 파싱만 허용하고 KWARG_SLOTS(codegen.ts)에 슬롯을 안 줘 자연 discard(신규 상태/코드 0줄).
      // C250: pine2py engine.py close_all(comment: str="") 시그니처가 comment를 그대로 첫 위치
      // 인자로 받으므로(corpus 실측: 4afee54bdc81.pine `strategy.close_all(cond ? "Exit" : na)`)
      // 위치 인자로도 지원 — request.security(C249)와 동일 원칙, comment가 유일한 위치 슬롯이라
      // codegen(KWARG_SLOTS close_all={comment:0, when:1, immediately:2})은 comment/when 무변경 +
      // immediately 신규 슬롯(alert_message는 슬롯 자체가 없어 자연 discard).
      // C467: pine2py engine.py 시그니처가 `close_all(self, comment: str="", when: bool=True)`로
      // when도 named parameter 2번째 슬롯이라(python 소스 재확인, 위 C377 인용과 동일 소스) 2번째
      // 위치 인자로도 지원(wild 실측 7건, e.g. `strategy.close_all('EOS', 'EOS', immediately=true)`,
      // `strategy.close_all(sellAlert,"Sell")` — codegen args 배열이 expr.args를 그대로 slot
      // 0/1에 매핑하는 범용 경로라 close/exit처럼 재배치 불필요, KWARG_SLOTS 표가 이미 이 2-위치
      // 폼을 전제하고 설계돼 있었음).
      if (expr.args.length > 2) {
        prog.errors.push(
          `'strategy.close_all' call argument count mismatch: requires 0~2 (comment, when), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seenCloseAllKwargs = new Set<string>();
      if (expr.args.length >= 1) {
        // 위치로 이미 채워진 comment(/when)를 먼저 등록 — 뒤이은 kwargs 루프가 `comment=`/`when=`과의
        // 동시 지정을 기존 "중복 지정" 에러 경로로 자연스럽게 잡아낸다(신규 분기 불필요, C249와 동일 재사용).
        seenCloseAllKwargs.add("comment");
      }
      if (expr.args.length >= 2) {
        seenCloseAllKwargs.add("when");
      }
      for (const kw of expr.kwargs) {
        if (
          kw.name !== "comment" &&
          kw.name !== "alert_message" &&
          kw.name !== "when" &&
          kw.name !== "immediately" &&
          kw.name !== "disable_alert"
        ) {
          prog.errors.push(
            `'strategy.close_all' only supports keyword arguments 'comment='/'alert_message='/'when='/'immediately='/'disable_alert=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenCloseAllKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        }
        seenCloseAllKwargs.add(kw.name);
      }
      prog.builtinCalls.set(expr, "strategy.close_all");
    } else if (method === "cancel") {
      // id(주문 id)는 위치 인자 또는 'id=' 키워드 인자 중 정확히 하나로만 지정 가능(C382, wild
      // 실측 f8629b966f24.pine 전량 `id='exit'+strategy.opentrades.entry_id(i)` 폼) — strategy.close의
      // id=(C293)와 동일 패턴. 이 wild 값 자체가 중첩 빌트인 콜을 포함해(entry/exit/close_all 등
      // 형제 kwargs 분기와 달리) kw.value를 명시적으로 analyzeExpr에 넘겨야 그 중첩 콜이
      // builtinCalls에 등록된다 — 안 그러면 codegen이 "등록 안 된 콜"로 실패한다.
      // when=(C708, batch35 kwarg화이트리스트 재실측 — wild 4건) — pine2py wavealgo/strategy/
      // engine.py cancel(self, id: str, when: bool = True)를 python 소스로 직접 재확인: when이 실제
      // named parameter이나 본문에 `if not when: return` 게이트가 없다(전량 무조건 취소 — engine.py
      // L259-266). 그런데 TV 공식 시그니처도 when=을 문서화된 조건 파라미터로 제공하고(entry/order/
      // close/close_all/exit과 동일 계열 명명 관례), 그 문서 의미(취소 조건)를 그대로 무시하면
      // when=false인데도 취소를 실행하는 조용한 오답이 되므로, pine2py의 미적용은 latent 버그로
      // 판단(MEMORY C2/C14급) — entry/order(C372)/close(C293)/close_all(C378)/exit(C380)에 이미
      // 이식된 것과 동일한 `if (!when) return` 게이트를 새로 구현(literal port 아닌 hand-verified).
      const idKwarg = expr.kwargs.find((kw) => kw.name === "id");
      if (expr.args.length > 1 || (expr.args.length === 0 && idKwarg === undefined)) {
        prog.errors.push(
          `'strategy.cancel' call argument count mismatch: requires 1 (order id), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      } else if (expr.args.length === 1 && idKwarg !== undefined && !isHarmlessArgDup(expr.args[0], idKwarg.value)) {
        prog.errors.push(`argument 'id' specified both positionally and as a keyword (L${idKwarg.line}:${idKwarg.col})`);
      }
      const seenCancelKwargs = new Set<string>();
      for (const kw of expr.kwargs) {
        if (kw.name !== "id" && kw.name !== "when") {
          prog.errors.push(
            `'strategy.cancel' only supports keyword arguments 'id='/'when=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenCancelKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        }
        seenCancelKwargs.add(kw.name);
        analyzeExpr(kw.value, prog, scope, false);
      }
      prog.builtinCalls.set(expr, "strategy.cancel");
    } else {
      if (expr.args.length !== 0) {
        prog.errors.push(
          `'strategy.cancel_all' call argument count mismatch: requires 0, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.builtinCalls.set(expr, "strategy.cancel_all");
    }
  } else if (namespace === "strategy" && method === "default_entry_qty") {
    // strategy.default_entry_qty(price)(C429, next_hint(C428) 최우선 3종 중 wild 실측 후 진짜
    // pine2py 갭으로 확정된 항목) — entry/order 위 void 전용 분기(entry/order/exit/close/close_all/
    // cancel/cancel_all)와 달리 이 콜은 **값을 반환**해 표현식 위치에서 쓰인다(wild 실사용:
    // `qty = strategy.default_entry_qty(close)` / `qty1 * strategy.default_entry_qty(close) / qtySum`)
    // — 그래서 위 stmtCalls(문장 위치 전용) 게이트를 적용하면 안 된다. pine2py wavealgo/strategy
    // 전수 grep 결과 대응 구현이 전혀 없어(engine.py에 default_entry_qty 자체가 없음) hand-verified
    // 신규 설계, "TV 미검증(가설)": entry()/order()의 qty 생략 시 실제로 쓰일 기본 수량을 그대로
    // 반환한다고 알려져 있다 — qty_type(percent_of_equity/cash)이면 price 인자로 환산(기존
    // runtime/strategy.ts autoQtyAt/autoQtyCashAt, entry/order의 qtyAuto 해석과 동일 산식 재사용),
    // fixed(기본)면 price 인자와 무관하게 defaultQty 그대로.
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (expr.args.length !== 1 || expr.kwargs.length > 0) {
      prog.errors.push(
        `'strategy.default_entry_qty' call argument count mismatch: requires 1 (price, positional only), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "strategy.default_entry_qty");
  } else if (namespace === "strategy" && (method === "convert_to_account" || method === "convert_to_symbol")) {
    // strategy.convert_to_account(value)/strategy.convert_to_symbol(value)(C763, wild "지원하지
    // 않는 호출" 클러스터 조사 중 발견 — 71c737f124fa/a13576d18571/920ce88077b5.pine) — TV 공식
    // 시맨틱은 전략 통화(strategy() currency=)와 계좌 통화(브로커 계좌 통화) 사이 실제 일별 FX
    // 환율로 값을 환산하나, pine2py에 대응 구현이 전혀 없고(wavealgo 전수 grep 0건) FX 레이트
    // 데이터 자체가 이 런타임에 없다 — default_entry_qty(C429)와 동일하게 값을 반환해 표현식
    // 위치에서 쓰인다. hand-verified 신규 설계, "TV 미검증(가설)": currency= 미지정(기본값,
    // wild 실사용 3건 전부 currency= 없음)이면 전략/계좌 통화가 동일해 두 함수 다 항등(입력값
    // 그대로 반환) — 이 단순화는 currency=가 실제로 계좌 통화와 다른 스크립트에서는 부정확하나
    // FX 데이터 부재로 회피 불가(LIMITATIONS 등재).
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (expr.args.length !== 1 || expr.kwargs.length > 0) {
      prog.errors.push(
        `'strategy.${method}' call argument count mismatch: requires 1 (value, positional only), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, `strategy.${method}`);
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    (callee.obj.attr === "closedtrades" || callee.obj.attr === "opentrades") &&
    STRATEGY_TRADE_ACCESSOR_METHODS[callee.obj.attr]!.has(method)
  ) {
    // strategy.closedtrades.<method>(index)/strategy.opentrades.<method>(index) — 트레이드 접근자
    // (C173 열한째 슬라이스 entry_comment/exit_comment → C308이 나머지 필드로 확장). 3-level
    // 체이닝(`strategy.<namespace>.<method>`)이라 위 namespace(=callee.obj.name, Identifier
    // 전제)로는 못 잡아 별도 분기가 필요하다 — `strategy.closedtrades`/`strategy.opentrades`는
    // STRATEGY_RUNTIME_PROPS의 프로퍼티 식이기도 하지만 여기서는 그 값을 평가하지 않고 callee
    // 모양만 패턴 매칭한다(맨 아래 `analyzeExpr(callee.obj, ...)`가 그 부분을 별도 value 위치로
    // 재귀해 STRATEGY_RUNTIME_PROPS 등록까지 하지만, 그 등록은 이 호출의 codegen과 무관한 부작용 —
    // codegen은 이 CallExpr 자체를 builtinCalls로 직접 낮춘다). 인자 개수 제약(1개, trade index)은
    // 두 네임스페이스 공통(STRATEGY_TRADE_ACCESSOR_METHODS 주석 참조 — 히스토리 미보유라 index
    // 유효성 자체는 런타임(runtime/strategy.ts)이 하드 에러로 검증, LIMITATIONS.md).
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (expr.args.length !== 1) {
      prog.errors.push(
        `'strategy.${callee.obj.attr}.${method}' call argument count mismatch: requires 1 (trade index), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, `strategy.${callee.obj.attr}.${method}`);
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "allow_entry_in"
  ) {
    // strategy.risk.allow_entry_in(value)(C309, next_hint 1순위 서브그룹) — 3-level 체이닝
    // (`strategy.risk.*`)이라 위 STRATEGY_TRADE_ACCESSOR_METHODS와 같은 이유로 별도 분기가
    // 필요하다. 단 "risk"는 STRATEGY_RUNTIME_PROPS에 등록된 유효 프로퍼티가 아니라(closedtrades/
    // opentrades와 다른 점) 아래 공용 꼬리의 `analyzeExpr(callee.obj, ...)` 재귀에 맡기면
    // "지원하지 않는 strategy 속성: 'strategy.risk'" 오답이 붙는다(MEMORY.md C173 pitfall) —
    // chart.point(C239)와 동일하게 인자만 직접 분석하고 즉시 return한다. pine2py에 대응 구현이
    // 전혀 없어(wavealgo/strategy 전체 grep 0건) hand-verified 신규 설계, "TV 미검증(가설)":
    // value가 허용 direction과 다르면 그 방향의 신규 진입은 열지 않고 이미 보유한 반대 방향
    // 포지션은 청산만 한다(entry 리버스를 취소가 아니라 "청산only"로 낮춤 — wild 코퍼스에 포함된
    // TV 공식 문서 발췌, 86e04be3ab6c.pine REMARKS: "it will be executed as a position-closing
    // order instead of a reversal"를 근거로 채택. 이 세션은 웹 접근이 없어 별도 1차 검증 불가,
    // DIVERGENCES 참조). max_intraday_filled_orders는 C320이 별도 분기로 이식(아래) — max_intraday_loss/
    // max_drawdown 나머지 2종은 equity 문턱값+cash/percent 타입 해석이 추가로 필요한 별개 축이라
    // 여전히 범위 밖(next_hint 인계, LIMITATIONS.md).
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (!prog.stmtCalls.has(expr)) {
      // entry/order/exit/close 계열(위 분기)과 동일한 반환값 없음 제약 — strategy.entry의
      // topLevel/stmtCalls 관례 그대로 재사용(주석 참조).
      prog.errors.push(
        `'strategy.risk.allow_entry_in' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
      );
    } else if (expr.args.length !== 1 || expr.kwargs.length > 0) {
      prog.errors.push(
        `'strategy.risk.allow_entry_in' call argument count mismatch: requires 1 (value, positional only), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "strategy.risk.allow_entry_in");
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "max_position_size"
  ) {
    // strategy.risk.max_position_size(value)(C324, next_hint(C323) 저비용 후보 재평가) —
    // allow_entry_in(위)과 동일한 3-level 체이닝 자리, 동일한 이유(MEMORY.md C173)로 인자만 직접
    // 분석하고 즉시 return한다. pine2py에 대응 구현 전혀 없음(wavealgo/strategy 전수 grep 0건,
    // PineTS docs/api-coverage도 Status 빈칸) — hand-verified 신규 설계, "TV 미검증(가설)": wild
    // 코퍼스 자신에 포함된 TV 문서 발췌(86e04be3ab6c.pine DESCRIPTION:: "Limits the maximum total
    // size of the position... quantity of new strategy.entry orders will be reduced if necessary
    // to prevent exceeding this limit.")가 근거 — 이 세션은 웹 접근이 없어 별도 1차 검증 불가,
    // DIVERGENCES 참조. allow_entry_in/max_intraday_filled_orders/max_drawdown/max_intraday_loss
    // 나머지 4형제와 달리 "전면 차단"이 아니라 "수량 축소" 게이트라 runtime/strategy.ts
    // processFills의 qty 계산 자체를 캡한다(별도 불리언 OR 게이트 재사용 불가). wild 실사용 2건
    // 전부 위치 인자 1개(value)뿐이고 qty_type(TV 시그니처의 2번째 인자) 실사용 0건이라 C283
    // 큐레이션 원칙대로 qty_type 미지원(항상 "수량 단위" 절대값으로 해석 — strategy.fixed 상당,
    // LIMITATIONS.md 등재).
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (!prog.stmtCalls.has(expr)) {
      prog.errors.push(
        `'strategy.risk.max_position_size' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
      );
    } else if (expr.args.length !== 1 || expr.kwargs.length > 0) {
      prog.errors.push(
        `'strategy.risk.max_position_size' call argument count mismatch: requires 1 (value, positional only), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "strategy.risk.max_position_size");
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "max_intraday_filled_orders"
  ) {
    // strategy.risk.max_intraday_filled_orders(count)(C320, wild "지원하지 않는 호출" 클러스터
    // next_hint 2순위 서브그룹) — allow_entry_in(위)과 동일한 3-level 체이닝 자리, 동일한 이유로
    // 인자만 직접 분석하고 즉시 return한다. pine2py에 대응 구현이 전혀 없어 hand-verified 신규
    // 설계, "TV 미검증(가설)": wild 코퍼스 자신에 포함된 TV 문서 발췌(86e04be3ab6c.pine
    // DESCRIPTION:: "stops new orders for the current day once the maximum allowed number of
    // filled orders (count) is reached", REMARKS:: "A market order to exit a current open
    // position is still allowed, even after the limit is reached.")가 근거 — 이 세션은 웹 접근이
    // 없어 별도 1차 검증 불가, DIVERGENCES 참조. wild 실사용에 `count=` 키워드 인자가 실제로
    // 나타나(8830cf208b52.pine) allow_entry_in과 달리 위치 인자 또는 `count=` 둘 다 허용한다
    // (alert_message 2번째 인자는 wild 실사용 0건이라 C283 큐레이션 원칙대로 미지원 유지 —
    // 예방적으로 넓히지 않음). max_intraday_loss/max_drawdown 나머지 2종은 범위 밖(위 주석 참조).
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (!prog.stmtCalls.has(expr)) {
      prog.errors.push(
        `'strategy.risk.max_intraday_filled_orders' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
      );
    } else {
      const validPositional = expr.args.length === 1 && expr.kwargs.length === 0;
      const validKwarg = expr.args.length === 0 && expr.kwargs.length === 1 && expr.kwargs[0]!.name === "count";
      if (!validPositional && !validKwarg) {
        prog.errors.push(
          `'strategy.risk.max_intraday_filled_orders' call argument count mismatch: requires 1 (count, positional or 'count='), got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
    }
    prog.builtinCalls.set(expr, "strategy.risk.max_intraday_filled_orders");
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "max_intraday_loss"
  ) {
    // strategy.risk.max_intraday_loss(value, type)(C322, next_hint 2순위 — LIMITATIONS.md C309
    // 체크리스트 완료) — 검증은 analyzeStrategyRiskThresholdCall 공유.
    analyzeStrategyRiskThresholdCall(expr, "strategy.risk.max_intraday_loss", prog, scope);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "max_drawdown"
  ) {
    // strategy.risk.max_drawdown(value, type)(C322) — max_intraday_loss와 동일 시그니처, 런타임
    // 의미만 다르다(runtime/strategy.ts updateDrawdown 참조 — 전체 실행 영구 vs 거래일 한정).
    analyzeStrategyRiskThresholdCall(expr, "strategy.risk.max_drawdown", prog, scope);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "strategy" &&
    callee.obj.attr === "risk" &&
    method === "max_cons_loss_days"
  ) {
    // strategy.risk.max_cons_loss_days(count)(C325, next_hint(C324) 신규 발견 — strategy.risk.* 6종
    // 중 마지막 미구현 형제) — allow_entry_in/max_position_size(위)과 동일한 3-level 체이닝 자리,
    // 동일한 이유(MEMORY.md C173)로 인자만 직접 분석하고 즉시 return한다. pine2py에 대응 구현 전혀
    // 없음(wavealgo/strategy 전수 grep 0건) — hand-verified 신규 설계, "TV 미검증(가설)": wild
    // 코퍼스 자신에 포함된 TV 문서 발췌(86e04be3ab6c.pine DESCRIPTION:: "A strategy-wide rule that
    // stops all trading (cancels pending orders, closes open positions) if the specified count of
    // consecutive days end with a loss.")가 근거 — 이 세션은 웹 접근이 없어 별도 1차 검증 불가,
    // DIVERGENCES 참조. wild 실사용 2건(975a339fc540.pine/8830cf208b52.pine) 전부 위치 인자 1개
    // (count)뿐이라 allow_entry_in/max_position_size와 동일하게 위치 인자 전용으로 구현(C283
    // 큐레이션 — max_intraday_filled_orders의 `count=` 키워드 지원은 예방적으로 확장하지 않음).
    // b5e6692da963.pine의 0-인자 호출(`strategy.risk.max_cons_loss_days()`)은 C295/C303류 API
    // 레퍼런스 나열 아티팩트(같은 파일에 `type[]`/`int[]` 등 타입 나열, 전 built-in을 인자 없이
    // 순서대로 찍은 문서 스텁)로 판정해 실사용 범위에서 제외.
    // C771 — strategy() 선행 선언 불필요(analyzer.ts strategy.* 단일 레벨 분기 주석 참조).
    if (!prog.stmtCalls.has(expr)) {
      prog.errors.push(
        `'strategy.risk.max_cons_loss_days' call is only supported in statement position (no return value — cannot be called in assignment/expression/argument position) (L${expr.line}:${expr.col})`,
      );
    } else if (expr.args.length !== 1 || expr.kwargs.length > 0) {
      prog.errors.push(
        `'strategy.risk.max_cons_loss_days' call argument count mismatch: requires 1 (count, positional only), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, "strategy.risk.max_cons_loss_days");
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    for (const kw of expr.kwargs) analyzeExpr(kw.value, prog, scope, false);
    return;
  } else if (
    callee.obj.kind === "DotAccess" &&
    callee.obj.obj.kind === "Identifier" &&
    callee.obj.obj.name === "chart" &&
    callee.obj.attr === "point" &&
    (method === "new" || method === "from_index" || method === "from_time" || method === "copy" || method === "now")
  ) {
    // chart.point.new/from_index/from_time/copy/now(corpus 10개 파일 실측, closedtrades와 동일한
    // 3-level 체이닝이라 위 namespace(Identifier 전제)로는 못 잡아 별도 분기가 필요) — pine2py
    // wavealgo chart_point_new 등은 전부 인자 전부 선택(기본값 존재)인 순수 함수라(runtime/drawing.ts
    // ChartPoint 주석 참조) input.*처럼 kwargs 이름 매핑까지는 하지 않고(corpus 전량 위치 인자만
    // 사용, 실측 0건) 위치 인자 개수 상한만 검증한다 — kwargs 사용은 함수 상단의 공용 blanket
    // 거부(이 콜 모양을 예외 목록에 안 넣었으므로 자동으로 걸림)에 맡기고 여기서 다시 검증하지
    // 않는다. "chart.point"는 이 3-level 콜 체인 밖에서는 값으로 쓰이지 않으므로(순수 타입 표기
    // 용도) 아래 공용 꼬리의 `analyzeExpr(callee.obj, ...)` 재귀(strategy.closedtrades처럼 그 부분이
    // 별도로 유효한 값 표현식이 아님)를 타면 "네임스페이스 접근은 호출식만 지원" 에러가 되므로,
    // 여기서 인자만 분석하고 즉시 return한다.
    const maxArgs = method === "new" ? 3 : method === "copy" || method === "now" ? 1 : 2;
    if (expr.args.length > maxArgs) {
      prog.errors.push(
        `'chart.point.${method}' call argument count mismatch: at most ${maxArgs}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, `chart.point.${method}`);
    for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
    return;
  } else if (
    namespace === "input" &&
    (method === "int" ||
      method === "float" ||
      method === "bool" ||
      method === "string" ||
      method === "color" ||
      method === "source" ||
      method === "symbol" ||
      method === "timeframe" ||
      method === "session" ||
      method === "price" ||
      method === "text_area" ||
      method === "time" ||
      method === "enum")
  ) {
    // input.int/float/bool/string(C131/C132) + color/source/symbol/timeframe/session/price/
    // text_area/time(C133) + enum(C134) — pine2py wavealgo/builtins/input_funcs.py의 대응 함수(각각
    // *_input)는 전부 defval을 그대로 반환하는 순수 함수라 math.*/color.*(C12/C78 이후 전례)와
    // 동일한 stateless builtinCalls 패턴을 그대로 재사용(새 디스패치 메커니즘 불필요, 새 8종도
    // bool/string과 동일한 2-파라미터 시그니처라 검증 로직 분기 불필요 — analyzeInputCall 공용
    // 헬퍼 재사용). "source"는 pine2py가 bar series도 받을 수 있지만(source_input defval: Any),
    // pine2js codegen은 BAR_SERIES_NAMES 식별자를 인자 자리에서도 항상 .get(0)으로 낮춰 스칼라로만
    // 도달한다(genIdentifier, C126 이후 컨테이너 저장 계열과 달리 이 클래스의 Series-leak이 원천
    // 불가 — input.ts 주석 참조). "enum"은 pine2py enum_input(defval, title, options, **kwargs)가
    // options도 그대로 반환값에 영향을 주지 않는 순수 통과 인자라(python 직접 실행으로 재확인)
    // analyzeInputCall 공용 헬퍼가 INPUT_PARAM_NAMES.enum(3개 이름표)만으로 인자개수/kwargs 검증을
    // 그대로 처리 — options의 타입(배열인지 등)은 pine2py도 검증하지 않아 여기서도 검증하지 않는다.
    // dot 뒤 ENUM 키워드 토큰이 DotAccess attr 위치에서 거부되던 문제(C133 발견)는 parser.ts의
    // KEYWORD_AS_ATTR로 이미 해결되어 이 지점엔 그 여파가 없다. rt.input.*는 codegen이
    // `$.inputs`(외부 오버라이드 dict)를 첫 인자로 암묵 주입해야 하므로(ta.vwma의 volume splice와
    // 동일한 원리, codegen.ts genCallExpr 참조) builtinCalls 값에 "input."로 시작하는 접두어를
    // 남겨 그 지점에서 식별한다(array.*/map.*/matrix.*가 이미 "namespace.method" 값을 쓰는 것과
    // 동일 관례).
    analyzeInputCall(expr, method, `input.${method}`, prog);
    // string/timeframe의 options(C292/C293, 위치 슬롯 신규 — 위 INPUT_PARAM_NAMES 주석 참조)가
    // 위치 인자로 대괄호 리터럴을 받으면(wild 최다빈도 실사용, `input.string(defval, title,
    // ["A","B"], ...)` / `input.timeframe(defval, title, ["1","5","D"])`) 아래 함수 끝의 공용
    // 트레일링 재귀가 이를 감싸지 않은 TupleExpr 그대로 analyzeExpr에 넘겨 "튜플 리터럴은 함수의
    // 마지막 문장" 하드 에러를 낸다 — kwarg 'options=[...]' 폼(C258)이 이미 쓰는 "래퍼는 건너뛰고
    // 원소만 개별 검증" 우회를 위치 인자 폼에도 그대로 적용해 여기서 직접 스윕하고 return(enum의
    // 위치 options는 corpus/wild 근거가 없어 기존 결정대로 계속 거부 — optionsIdx가 "string"/
    // "timeframe"에서만 계산돼 다른 method는 이 우회 대상이 아니다).
    {
      const optionsIdx =
        method === "string" || method === "timeframe" ? INPUT_PARAM_NAMES[method]!.indexOf("options") : -1;
      for (let i = 0; i < expr.args.length; i++) {
        const arg = expr.args[i]!;
        if (i === optionsIdx && arg.kind === "TupleExpr") {
          for (const el of arg.elements) analyzeExpr(el, prog, scope, false);
          continue;
        }
        analyzeExpr(arg, prog, scope, false);
      }
    }
    return;
  } else if (namespace === "array" && Object.prototype.hasOwnProperty.call(ARRAY_REGISTRY, method)) {
    // array.* 49종(C79~88 완주) — analyzer/collections.ts의 analyzeArrayCall 참조(인자 개수 검증 +
    // builtinCalls 등록, ROADMAP "컬렉션 네임스페이스 레지스트리화" 슬라이스 3/4). 뮤테이션 호이스팅
    // 대상 판별(codegen.ts MUTATING_ARRAY_BUILTINS)/생성자 판별(analyzeVarDecl의
    // isArrayConstructorCall)은 이 dispatch보다 이르거나 별도 지점이라 편입하지 않는다.
    analyzeArrayCall(expr, method, prog, scope);
  } else if (namespace === "map" && Object.prototype.hasOwnProperty.call(MAP_REGISTRY, method)) {
    // map.* 11종(C89 완주) — analyzer/collections.ts의 analyzeMapCall 참조(인자 개수 검증 +
    // builtinCalls 등록, ROADMAP "컬렉션 네임스페이스 레지스트리화" 슬라이스 1/4). new/copy(mapVars)/
    // keys/values(arrayVars) 생성자 추적은 이 분기보다 이른(var 선언 시점) 별도 지점이라 편입 안 함.
    analyzeMapCall(expr, method, prog);
  } else if (namespace === "matrix" && Object.prototype.hasOwnProperty.call(MATRIX_REGISTRY, method)) {
    // matrix.* 49종(C90~106 완주) — analyzer/collections.ts의 analyzeMatrixCall 참조(인자 개수
    // 검증 + builtinCalls 등록, ROADMAP "컬렉션 네임스페이스 레지스트리화" 슬라이스 4/4). matrixVars/
    // arrayVars 생성자 추적과 isMatrixMultCall(mult 전용 분기)은 이 dispatch보다 이르거나 별도
    // 지점이라 편입하지 않는다.
    analyzeMatrixCall(expr, method, prog);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveContainerExprKind(callee.obj, prog, scope) === "array" &&
    Object.prototype.hasOwnProperty.call(ARRAY_REGISTRY, method)
  ) {
    // method-call 스타일 array 콜(C222, Pine v5 sugar): `arr.push(x)` == `array.push(arr, x)` —
    // namespace가 리터럴 "array"가 아니라(위 분기가 이미 그 형태를 소비) 정적으로 array로 판별된
    // '=' 로컬/top-level var(resolveContainerExprKind, C216 for-in이 구축한 containerKindHints
    // 인프라 재사용 — 신규 스코프 체계 없음)이거나, UDT 인스턴스 필드가 array<T>로 선언된 단일
    // 레벨 DotAccess(C323, `id.d.unshift(x)`류 wild "?." 클러스터 — namespace는 이 경우 여전히
    // null이라 별도로 callee.obj.kind==="DotAccess" 게이트를 추가)이거나, 생성자 반환 콜을 var
    // 경유 없이 바로 체이닝한 CallExpr(C420, `str.split(a,b).get(1)`/`arr.slice(x,y).sum()`류 —
    // resolveContainerExprKind는 C417부터 이미 CallExpr을 판별하지만 이 게이트가 그 앞에서
    // callee.obj.kind==="DotAccess"만 통과시켜 원천 배제하고 있었다)일 때만 여기로 떨어진다. UDF/
    // method 매개변수로 직접 받은(필드가 아닌) array 수신자는 진짜 값 흐름 추적은 없지만, 명시
    // typeHint 또는 콜사이트 정적 스캔(paramContainerKinds, C492/C644/C647 — 인자가 top-level이든
    // *다른* 함수 본문 안 func-local var든 스캔)으로 종류가 확정되면 resolveContainerExprKind가
    // 그 결과를 인정한다. 그 스캔조차 실패하는 진짜 동적/모호 케이스만 여전히 아래 "지원하지 않는
    // 호출"로 거부됨(LIMITATIONS.md 참조). receiver(callee.obj)는 expr.args에 끼워 넣지 않고
    // 병렬 맵(methodCallReceivers)에만 등록 — analyzeArrayCall은 receiverOffset=1로 인자 개수만
    // 보정해서 받는다(expr.args 자체는 codegen까지 그대로 통과).
    analyzeArrayCall(expr, method, prog, scope, 1);
    prog.methodCallReceivers.set(expr, callee.obj);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveContainerExprKind(callee.obj, prog, scope) === "array" &&
    prog.funcs.get(mangleMethodName("array", method)) !== undefined
  ) {
    // 사용자 선언 array<T> extension method(C327, wild 실측 251건 -- `method flush(array<float>
    // this) => ...`류가 receiver.method() sugar로 호출됨). ARRAY_REGISTRY 내장 이름과 안 겹칠
    // 때만(위 분기가 내장을 먼저 소비) 여기로 떨어진다. dispatchUdtMethodCall이 array 분기와
    // 완전히 동일한 receiver 판별(resolveContainerExprKind)을 재사용하되, receiver를
    // methodCallReceivers가 아니라 udtMethodCallTypes 경로(codegen이 callee.obj를 그대로 첫
    // 인자로 방출)로 넘긴다 — 기존 UDT obj.method() 콜과 동일한 codegen 분기 재사용, codegen 변경
    // 0줄.
    // C687: 오버로드 선택은 receiver 몫 +1(dot-sugar) — 게이트의 base 존재 확인은 그대로 두고
    // (첫 선언이 항상 base 이름으로 남는다) 디스패치 대상만 콜사이트 인자 개수로 고른다.
    // C688: arity만으로 유일 선택이 안 되면(undefined — 등록 게이트상 전원이 서로 다른 원소
    // drawing kind를 가진 same-arity 쌍) receiver의 원소 kind(resolveArrayElemDrawingKind)로
    // 확정하고, 그 결정을 노드-캐시(methodOverloadResolutions)에 남겨 codegen이 재사용한다(C224 —
    // codegen은 scope 체인이 없어 재유도 불가). 판별 실패는 조용한 오답 대신 명시 에러(C394).
    const arrayDotArgTotal = 1 + expr.args.length + expr.kwargs.length;
    let arrayMethodInfo = lookupMethodOverload(prog, "array", method, arrayDotArgTotal, expr);
    if (arrayMethodInfo === undefined) {
      const recvElemKind = resolveArrayElemDrawingKind(callee.obj, prog, scope);
      const chosen = recvElemKind !== null ? lookupMethodOverload(prog, "array", method, arrayDotArgTotal, expr, recvElemKind) : undefined;
      if (chosen === undefined) {
        prog.errors.push(
          `multiple 'array.${method}' overloads declared with the same argument count — cannot determine the receiver's element type to choose one (L${expr.line}:${expr.col})`,
        );
        return;
      }
      prog.methodOverloadResolutions.set(expr, chosen.name);
      arrayMethodInfo = chosen;
    }
    dispatchUdtMethodCall(expr, "array", method, arrayMethodInfo, prog, scope);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveContainerExprKind(callee.obj, prog, scope) === "map" &&
    Object.prototype.hasOwnProperty.call(MAP_REGISTRY, method)
  ) {
    // method-call 스타일 map 콜(C222) — array 분기와 완전히 동일한 원칙(위 주석 참조), namespace만
    // "map"으로 판별된 경우(UDT 필드 map<K,V> 게이트 포함, C323).
    analyzeMapCall(expr, method, prog, 1);
    prog.methodCallReceivers.set(expr, callee.obj);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveContainerExprKind(callee.obj, prog, scope) === "map" &&
    prog.funcs.get(mangleMethodName("map", method)) !== undefined
  ) {
    // 사용자 선언 map<K,V> extension method(C327) — array 분기(위)와 완전히 동일한 원칙.
    dispatchUdtMethodCall(expr, "map", method, lookupMethodOverload(prog, "map", method, 1 + expr.args.length + expr.kwargs.length, expr)!, prog, scope);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveMatrixExprKind(callee.obj, prog, scope) &&
    Object.prototype.hasOwnProperty.call(MATRIX_REGISTRY, method)
  ) {
    // method-call 스타일 matrix 콜(C237, corpus 재스캔 실측 `m.det()`/`m.transpose()`/`m.rank()`/
    // `m.is_diagonal()`/`m.is_identity()`/`m.is_square()` — array/map sugar(C222, 위 두 분기)와
    // 완전히 동일한 원칙, receiver(callee.obj)가 정적으로 matrix로 판별된 '=' 로컬/top-level var
    // 또는 matrix를 반환하는 CallExpr 체이닝(C494, `m.mult(other).sum(q)`류 — resolveMatrixExprKind가
    // CallExpr을 인식하게 된 뒤로 callee.obj.kind==="CallExpr" 게이트 추가, array/map C420과 동일
    // 원칙)일 때만 여기로 떨어진다. UDF/method 매개변수로 받은 matrix 수신자는 array/map과 동일하게
    // 값 흐름 추적이 없어 여전히 "지원하지 않는 호출"로 거부됨.
    analyzeMatrixCall(expr, method, prog, 1);
    prog.methodCallReceivers.set(expr, callee.obj);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr") &&
    resolveMatrixExprKind(callee.obj, prog, scope) &&
    prog.funcs.get(mangleMethodName("matrix", method)) !== undefined
  ) {
    // 사용자 선언 matrix<T> extension method(C327, wild 최다빈도 -- `method str(matrix<float>
    // this) => ...`류) — array/map 분기(위)와 완전히 동일한 원칙, receiver 판별만
    // resolveMatrixExprKind로 matrix 전용.
    dispatchUdtMethodCall(expr, "matrix", method, lookupMethodOverload(prog, "matrix", method, 1 + expr.args.length + expr.kwargs.length, expr)!, prog, scope);
  } else if (
    namespace !== null &&
    Object.prototype.hasOwnProperty.call(DRAWING_METHODS, namespace) &&
    DRAWING_METHODS[namespace]!.has(method)
  ) {
    // label/line/box/table/polyline(신규) — array/map/matrix와 동일한 "namespace.method"
    // builtinCalls 관례(rt.ts가 중첩 네임스페이스로 그대로 받아 codegen 변경 불필요). 인자는
    // 함수 끝의 공용 부작용 재귀(`for (const arg of expr.args) analyzeExpr(...)`, 이 분기 아래)가
    // 처리하고 kwargs 값도 이미 위(함수 상단)에서 공통 분석됐다 — 이 분기는 등록만 하면 된다.
    prog.builtinCalls.set(expr, `${namespace}.${method}`);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr" || callee.obj.kind === "IndexAccess") &&
    isDrawingMethodSugarCall(callee.obj, method, prog, scope)
  ) {
    // method-call 스타일 drawing 콜(C232, ROADMAP P3 next_hint 1순위 — corpus 실측 lbl.set_text/
    // ln.set_color/b.set_lefttop/t.cell_set_text류) — array/map sugar(위 두 분기)와 완전히 동일한
    // 원칙, receiver(callee.obj)가 정적으로 label/line/box/table/polyline 핸들로 판별될 때만 여기로
    // 떨어진다(UDT 필드가 drawing 핸들 타입인 단일 레벨 DotAccess 포함, C323 — wild 실측
    // `graphic.pivotLine.delete()`류, namespace는 이 경우 null이라 array/map과 동일하게
    // callee.obj.kind==="DotAccess" 게이트 추가). C652: callee.obj.kind==="IndexAccess" 게이트 추가
    // (wild "?.delete" 잔여 — `(lab[1]).delete()`류, resolveDrawingHistoryIndexKind 참조).
    // builtinCalls 값은 리터럴 분기와 달리
    // "namespace.method"가 아니라 "resolveDrawingExprKind로 확정한 kind.method"(namespace 자신은
    // 그냥 변수 이름이라 kind가 아님). receiver는 array/map과 동일하게 methodCallReceivers 병렬
    // 맵에만 등록(expr.args에 끼워 넣지 않음, codegen.ts genCallExpr가 이 맵을 봐서 맨 앞에 인자로
    // 끼워 넣는다).
    // C354: callee.obj.kind==="CallExpr" 게이트 추가(wild "?.delete" 6건 — `boxes.shift().delete()`/
    // `tab.boxes.get(x).delete()`류, receiver가 array-elem-반환 콜 자체). resolveDrawingReceiverKind가
    // resolveDrawingExprKind와 resolveArrayGetElemDrawingKind(C353) 둘 다 시도하므로 이 kind 계산도
    // 그 조합 함수로 통일 — 아래 `!` 단언은 이 분기 진입 조건(isDrawingMethodSugarCall)이 이미 같은
    // 함수로 null이 아님을 보장했으므로 안전하다.
    const drawingKind = resolveDrawingReceiverKind(callee.obj, prog, scope)!;
    prog.builtinCalls.set(expr, `${drawingKind}.${method}`);
    prog.methodCallReceivers.set(expr, callee.obj);
  } else if (
    (namespace !== null || callee.obj.kind === "DotAccess" || callee.obj.kind === "CallExpr" || callee.obj.kind === "IndexAccess") &&
    resolveDrawingReceiverKind(callee.obj, prog, scope) !== null &&
    prog.funcs.get(mangleMethodName(resolveDrawingReceiverKind(callee.obj, prog, scope)!, method)) !== undefined
  ) {
    // 사용자 선언 drawing 핸들(label/line/box/table/polyline/linefill) extension method(C676,
    // array/map/matrix 사용자 extension 분기(위, C327)와 완전히 동일한 원칙) — 내장 DRAWING_METHODS
    // 이름과 안 겹칠 때만(위 두 drawing 분기가 내장을 먼저 소비) 여기로 떨어진다. wild 실측
    // `someLine.setLine(x1,y1,x2,y2)`류(`method setLine(line ln, ...) => ...`).
    // dispatchUdtMethodCall이 array/map/matrix 사용자 extension과 동일한 receiver 처리(codegen이
    // callee.obj를 그대로 첫 인자로 방출)를 재사용 — codegen 변경 0줄.
    const drawingExtKind = resolveDrawingReceiverKind(callee.obj, prog, scope)!;
    dispatchUdtMethodCall(expr, drawingExtKind, method, lookupMethodOverload(prog, drawingExtKind, method, 1 + expr.args.length + expr.kwargs.length, expr)!, prog, scope);
  } else if (namespace === "log" && (method === "info" || method === "warning" || method === "error")) {
    // log.info/warning/error(C231, corpus 실측 log.info 8/log.warning 2/log.error 2) — pine2py
    // wavealgo/__init__.py _LogNamespace.info/warning/error(message: str="", *args로 전부 순수
    // no-op) 이식. 인자는 message + 가변 포맷 인자(코퍼스 실측 `log.info("price: {0}", close)`류)라
    // 개수 상한만 넉넉히 잡는다(값 전부 discard라 str.format류 정밀 위치 검증 불필요). builtinCalls
    // 값은 array/map처럼 "log.info"가 아니라 flat 이름("logInfo" 등)이다 — "log"는 이미 rt.log(=
    // math.log)로 점유돼 있어 nested `rt.log.info` 방식이 math.log 콜러블 자체를 깨뜨리기 때문
    // (rt.ts log.ts import 주석 참조).
    // C298: 상한을 8에서 32로 상향 — wild 실사용(e4f672681b56.pine)이 message + 16개 포맷 치환
    // 인자(합 17개)를 씀을 확인, pine2py 시그니처 자체가 *args(진짜 무제한)라 8은 C231 당시
    // 근거 없이 좁게 잡은 값이었다(C290 NOOP_BUILTIN_ARITY 상한 상향과 동일 급 — 값 전부 discard라
    // 정확성 위험 0).
    if (expr.args.length > 32) {
      prog.errors.push(
        `'log.${method}' call argument count mismatch: requires 0~32, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, method === "info" ? "logInfo" : method === "warning" ? "logWarning" : "logError");
  } else if (namespace === "runtime" && (method === "error" || method === "warning")) {
    // runtime.error/warning(C231, corpus 실측 error 6) — pine2py wavealgo runtime_error(message)는
    // 실제로 Python RuntimeError를 던지고(TV 자신의 fatal 시맨틱 — GOAL.md "알려진 버그는 따르지
    // 않는다"의 적용 대상 아님, literal port), runtime_warning(message)은 stderr 출력만 하는 진짜
    // no-op(계산값 무관) — 인자는 pine2py 시그니처와 동일하게 message 1개 고정(가변 인자 아님).
    // C472: message=(RUNTIME_KWARG_PARAM_NAMES) 키워드 폼도 위치 인자와 완전히 동등하게 지원 —
    // timeframe.in_seconds(C405)와 동일한 단일 슬롯 위치/키워드 병합 검증.
    if (expr.kwargs.length > 0) {
      if (expr.args.length > RUNTIME_KWARG_PARAM_NAMES.length) {
        prog.errors.push(
          `'runtime.${method}' call argument count mismatch: requires 0~1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      const seenKwargNames = new Set<string>();
      for (const kw of expr.kwargs) {
        if (kw.name !== RUNTIME_KWARG_PARAM_NAMES[0]) {
          prog.errors.push(
            `'runtime.${method}' only supports keyword argument 'message=': '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
        } else if (seenKwargNames.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (expr.args.length >= 1 && !isHarmlessArgDup(expr.args[0], kw.value)) {
          prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
        }
        seenKwargNames.add(kw.name);
        analyzeExpr(kw.value, prog, scope, false);
      }
    } else if (expr.args.length > 1) {
      prog.errors.push(
        `'runtime.${method}' call argument count mismatch: requires 0~1, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.builtinCalls.set(expr, method === "error" ? "runtimeError" : "runtimeWarning");
  } else if (namespace !== null && method === "new" && prog.udtTypes.has(namespace)) {
    // `TypeName.new(...)` — 위치 인자 + 키워드 인자(`field=value`, C129) 혼합 지원. 위치 인자는
    // 필드 선언 순서대로 앞에서부터 채우고, 나머지 필드는 키워드 인자로 이름 지정 가능(pine2py
    // `_parse_args_kwargs`와 동일하게 위치/키워드 뒤섞기를 문법적으로 막지 않음 — Explore 조사로
    // 확인한 대로 pine2py 자신도 순서 제약이 없다). 누락된 필드는 codegen이 JS 기본 파라미터로
    // 채운다(genTypeDecl). pine2py는 알 수 없는 필드명/중복 지정을 정적으로 전혀 검증하지 않고
    // Python dataclass 생성자의 런타임 TypeError에 그대로 위임하는데(Explore 조사로 확인), 이건
    // "검증 없음"이 TV 의도라는 근거가 아니라 pine2py 자체의 구현 게으름일 뿐이라 GOAL.md "알려진
    // 버그는 따르지 않는다" 원칙을 적용해 pine2js는 이 세 가지를 analyze-time 하드 에러로 검증한다
    // (다른 모든 UDT 호출 검증과 동일하게 명확한 에러 메시지를 우선).
    const typeInfo = prog.udtTypes.get(namespace)!;
    if (expr.args.length > typeInfo.fields.length) {
      prog.errors.push(
        `'${namespace}.new' call argument count mismatch: at most ${typeInfo.fields.length}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    } else {
      const fieldIndex = new Map(typeInfo.fields.map((f, i) => [f.name, i]));
      const seenKwargNames = new Set<string>();
      for (const kw of expr.kwargs) {
        const idx = fieldIndex.get(kw.name);
        if (idx === undefined) {
          prog.errors.push(`unknown field for '${namespace}': '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (seenKwargNames.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
        } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
          prog.errors.push(
            `field '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`,
          );
        }
        seenKwargNames.add(kw.name);
      }
    }
    prog.udtConstructorCalls.set(expr, namespace);
  } else if (namespace !== null && method === "copy" && prog.udtTypes.has(namespace)) {
    // `TypeName.copy(instance)` — 정적 호출 폼(C645, wild "지원하지 않는 호출" 클러스터
    // traileringStatusType.copy(x)류 8건). 위 `TypeName.new(...)` 정적 생성자 분기와 나란한 대칭
    // 폼 — pine2py codegen.py `_gen_udt_copy`(raw_name.endswith(".copy") && _is_udt_type_name(prefix))가
    // 이 문법을 별도 케이스로 명시 처리해뒀음을 Explore로 확인(대문자 시작 = UDT 타입명 판별,
    // pine2js는 prog.udtTypes.has로 동일 판별). 아래(resolveUdtMethodReceiverType) 분기가 처리하는
    // 인스턴스 점호출 `obj.copy()`(C125)와는 인자 개수로 codegen이 구분한다(정적 폼은 인자 1개 =
    // 복사할 인스턴스, 점호출 폼은 인자 0개 — 두 폼 모두 udtCopyCallTypes에 등록). TV 1차 문서로
    // 직접 확인은 못 했음(웹 접근 없는 세션) — DIVERGENCES #197에 "TV 미검증(가설), pine2py 리터럴
    // 포트" 표기.
    if (expr.args.length !== 1) {
      prog.errors.push(
        `'${namespace}.copy' call argument count mismatch: requires 1 (instance to copy), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    prog.udtCopyCallTypes.set(expr, namespace);
  } else if (
    (namespace !== null || callee.obj.kind === "CallExpr" || callee.obj.kind === "DotAccess") &&
    resolveUdtMethodReceiverType(callee.obj, prog, scope) !== undefined
  ) {
    // UDT method 호출: obj.methodName(args) — 위의 모든 namespace 빌트인 분기가 전부 안 맞았고
    // obj가 UDT 인스턴스로 확정됐다는 뜻이므로 method 호출이 유일하게 남은 해석이다(obj가 단순
    // Identifier(namespace!==null)/array-elem-반환 콜(C354, 아래 참조)/중첩 필드 체이닝(C505,
    // 아래 참조) 세 형태를 지원).
    // C354: obj가 CallExpr(`allGaps.shift()`류, wild "?.delete" 클러스터의 UDT-array 축 —
    // resolveDrawingReceiverKind와 나란한 조합, resolveUdtMethodReceiverType 참조)이면
    // resolveArrayGetElemUdtType(C341, 원래 '=' 로컬 대입용 헬퍼)으로 원소 UDT 타입을 판별한다.
    // C505: obj가 DotAccess(`ctx._sma.next(src)`류, UDT 필드의 필드에 사용자 method 체이닝)이면
    // resolveUdtObjectType의 캐시-비의존 폴백(resolveUdtFieldTypeHint 재귀, index-access.ts)이
    // 원소 UDT 타입을 판별한다 — 이 게이트가 판별을 시도하는 시점엔 아래 공용 꼬리의
    // `analyzeExpr(callee.obj, ...)`가 아직 실행 전이라 캐시가 비어있는 게 정상.
    const typeName = resolveUdtMethodReceiverType(callee.obj, prog, scope)!;
    const methodInfo = lookupMethodOverload(prog, typeName, method, 1 + expr.args.length + expr.kwargs.length, expr);
    if (methodInfo === undefined && method === "copy") {
      // `obj.copy()` — 사용자 선언 method가 아니라 컴파일러가 자동 제공하는 얕은 복사
      // "내장 pseudo-method"(C125, DIVERGENCES.md #57). 사용자가 명시적으로 이름이 'copy'인
      // method를 선언했다면(methodInfo !== undefined) 그쪽이 항상 우선하고 이 분기는 타지 않는다.
      // pine2py의 obj.copy() 점 호출은 array/map과 같은 MAP_ARRAY_SHARED 디스패치로 잘못 떨어져
      // 런타임에 크래시하는 실제 버그(Explore 조사 + python 직접 실행으로 확인)라 GOAL.md "알려진
      // 버그는 따르지 않는다"를 적용해 TV가 의도한 대로 동작을 새로 구현한다. 상태 없는 순수 객체
      // spread(런타임 rt.udtCopy)라 funcCallSlots/scope.func 제약이 애초에 적용되지 않아 UDF/method
      // 본문 안에서도 자유롭게 호출 가능하다.
      if (expr.args.length !== 0) {
        prog.errors.push(
          `'${typeName}.copy' call argument count mismatch: requires 0, got ${expr.args.length} (L${expr.line}:${expr.col})`,
        );
      }
      prog.udtCopyCallTypes.set(expr, typeName);
    } else if (methodInfo === undefined) {
      prog.errors.push(`unknown method for '${typeName}': '${method}' (L${expr.line}:${expr.col})`);
    } else {
      // 사용자 선언 method 호출은 일반 UDF와 완전히 동일한 call-site별 slotBase 메커니즘
      // (funcCallSlots)으로 디스패치한다 — UDF/method 본문 안에서의 obj.method() 호출도 이제
      // analyzeUserFuncCall의 bare/dot 공유 원칙(C267[part2])과 동일하게 허용하고, 콜그래프 간선만
      // 기록해 detectRecursiveFuncCalls가 사이클(자기재귀 포함)만 별도로 거부하게 한다.
      dispatchUdtMethodCall(expr, typeName, method, methodInfo, prog, scope);
    }
  } else if (namespace === "request" && method === "security") {
    // request.security 첫 슬라이스(ROADMAP P2 [hard->분할] — C174가 분할 선언, C175가 0번째
    // 선행 작업(ctx.time 채널) 완료, C176). 동일 심볼 전용(symbol 인자는 검증 없이 버림 — pine2py도
    // 동일, security.py:105 docstring), tf는 컴파일타임 문자열 리터럴 전용(ta.* length 인자 관례와
    // 동형 — 집계 캐시가 Context 생성 시 1회 계산되므로 런타임 tf 변경은 그 캐시와 어긋나 하드 에러).
    // 둘째 슬라이스(C177): gaps=/lookahead= kwargs. 값은 컴파일타임 boolean(true/false 리터럴 또는
    // barmerge.gaps_on/gaps_off/lookahead_on/lookahead_off 상수)만 지원 — get()이 codegen 시점에
    // 리터럴로 확정돼야 바 루프 안 분기 없이 방출 가능(GOAL.md "bar loop 안 할당 제로"와 같은 결의
    // "불필요한 런타임 분기도 배제" 취지). **C249가 gaps/lookahead의 위치 인자 자리(4번째/5번째,
    // TV 실제 시그니처 순서)도 추가 지원** — DIVERGENCES.md #78(c)가 "TV 정합 여부 자체는 확신
    // 있음, 문법 지원 범위의 문제일 뿐 값 시맨틱과 무관"이라 명시해둔 스코프 결정을 넓힌 것(값
    // 시맨틱/resolveSecurityBooleanKwarg는 무변경, 문법만 확장). ignore_invalid_symbol/currency/
    // calc_bars_count(6번째 이후)는 여전히 범위 밖.
    // 셋째 슬라이스 서브슬라이스 3a(C180, ROADMAP 설계는 C179): expression 인자가 bare series가
    // 아니면 "좁은 표현식"인지 재시도한다 — C180 v1은 "정확히 1개의 ta.* 콜"이었고, C367이
    // buildSecurityExpr(확장 좁은 문법: ta 0~N개/파생가/정수 리터럴 히스토리/전역 유일 '=' 변수
    // 치환/input 스칼라 상수 — 함수 주석 참조)로 확장했다.
    if (expr.args.length > 5) {
      prog.errors.push(
        `'request.security' call argument count mismatch: requires 3~5 (symbol, timeframe, expression[, gaps[, lookahead]]) (gaps/lookahead supported positionally or as keywords, ignore_invalid_symbol/currency keyword-only — calc_bars_count not supported in this slice), got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    } else {
      const leadArgs = resolveSecurityLeadArgs(expr, prog);
      if (leadArgs !== null) {
      const { symbolArg, tfArg, seriesArg } = leadArgs;
      // C435: 빈 문자열 tf('')는 TV의 "차트 타임프레임" 관용구(wild에선 input.timeframe(defval='')가
      // 지배적 폼) — prog.chartTf(배치30 (1), C591부터 설정화. chartTf="D" 기본값에서는 이전
      // 하드코딩 "D"와 동일 출력)로 정규화해 명시적 chartTf 요청과 완전히 같은 집계 경로를 타게
      // 한다. C435 도입 시점(chartTf가 항상 "D"였던 때)엔 정규화 전에도 ''가 런타임
      // parseTfMinutes('')의 1440 폴백으로 떨어져 우연히 같은 값을 냈지만(scratch/
      // c435_empty_vs_D_equiv.mjs), chartTf가 "D" 아닌 값으로 설정되면 이 우연한 등가성은 깨진다 —
      // 그래서 이 명시적 정규화가 이제 진짜 동작을 결정한다("우연히 등가인 방어 폴백"에 기대지
      // 않고 의도('' = 차트 tf)를 securityTfs에 그대로 싣는다). securityTfConstGuards의 비교
      // 리터럴은 raw('') 그대로 둔다 — 그 가드는 런타임 입력 오버라이드 값과의 동일성 검사라
      // 사용자가 넣는 원시 문자열 기준이어야 한다(resolveSecurityTfLiteral 내부에서
      // constInfo.literal로 등록, 정규화 대상 아님).
      // C598: 아래 폴딩 시도(resolveSecurityTfLiteral)는 부분 성공(조건은 접고 분기에서 실패 등)
      // 중에도 securityTfConstGuards를 등록할 수 있다 — 전체 폴딩이 실패하고 이 콜사이트가 런타임
      // tf 경로(tfRuntimeExpr)로 흡수되면 그 freeze 가드는 "컴파일타임 고정 캐시" 전제가 사라져
      // 스퓨리어스 throw만 만든다. 시도 전 키를 스냅샷해 흡수 시 신규 등록분만 롤백한다(같은
      // 이름을 다른 콜사이트가 폴딩 소비하면 그 사이트의 자기 시도가 재등록 — 이름당 dedup은
      // `!has(name)` 가드라 순서 무관하게 안전).
      const guardKeysBeforeTfFold = new Set(prog.securityTfConstGuards.keys());
      const tfLiteralRaw = resolveSecurityTfLiteral(tfArg, prog, undefined, undefined, scope.func?.name ?? null);
      let tfLiteral = tfLiteralRaw === "" ? prog.chartTf : tfLiteralRaw;
      // C529: tf가 이 UDF 자신의 매개변수면 콜사이트별 리터럴 폴딩을 재시도 — 전부 같은 값이면
      // 고정 리터럴과 완전 동일 취급(콜사이트 전원이 같은 HTF 캐시 슬롯을 공유해도 순수 읽기라
      // 정확 — 기존 "UDF 안 고정 tf" 경로 그대로, 신규 기구 0). 서로 다르면 C453의 __secIdx 서수
      // 인프라를 재사용해 콜사이트별 독립 슬롯 블록을 배정한다(bare field/expression 경로는 C529,
      // 튜플 리터럴 expression은 C532 — bare 공유 캐시가 사이트별 연속 블록(slot+__secIdx)이 되고
      // expr 원소는 원소마다 자신의 연속 블록 + 사이트별 프리패스 스펙을 받는다, 아래 튜플 분기).
      let tfSiteLiterals: string[] | null = null;
      // 배치31 (b)-2, C600: tf-param 콜사이트별 해석이 "리터럴×런타임 혼합"이면 여기 실린다 —
      // 전부 리터럴이면 기존 C529 경로(uniform 붕괴/tfSiteLiterals) 그대로, Expr가 하나라도 섞이면
      // 각 사이트 슬롯이 개별 securityRuntimeTfSlots에 등록된다(수용 판정/소비는 아래 참조).
      let tfSiteMixed: (string | Expr)[] | null = null;
      if (tfLiteral === undefined) {
        // C624(next_hint(C623)): tf가 이 UDF 자신의 매개변수인데 이 함수를 호출하는 콜사이트가
        // 스크립트 전체에 0개(prepassIndexSingleCallSites의 전수 워크가 이름 매치 CallExpr을 하나도
        // 못 찾음 — funcAllCallSites에 그 이름의 엔트리 자체가 없음)면, 이 request.security 콜은
        // 코드상 존재하되 런타임에 절대 실행되지 않는 죽은 코드다(wild 실측: 131건 중 29건이 이
        // 형태, scratch/c624_tfparam_probe3.mjs). TV는 그래도 이 UDF 본문을 정적 타입체크해야 하고
        // pine2js도 GOAL.md 아키텍처상 이 함수를 여전히 codegen해야 하지만(도달 불가 코드 제거 없음),
        // 그 안의 tf 값이 실제로 어떤 값이어야 하는지는 절대 관측되지 않는다 — 임의의 컴파일타임
        // 리터럴(prog.chartTf, 다른 "무해한 플레이스홀더" 폴백과 동일 관례)로 접어 HTF 캐시 슬롯을
        // 등록해도 안전하다(그 슬롯은 프리앰블에서 1회 빌드될 뿐 읽는 코드 경로가 없음). 호출부가
        // 1개 이상이면(이 가드가 안 걸리면) 기존 resolveSecurityTfParamSiteValues 경로 그대로.
        if (tfArg.kind === "Identifier" && scope.func !== null && scope.func.paramNames.includes(tfArg.name)) {
          const deadSites = prog.funcAllCallSites.get(scope.func.name);
          if (deadSites === undefined || deadSites.length === 0) tfLiteral = prog.chartTf;
        }
      }
      if (tfLiteral === undefined) {
        const siteVals = resolveSecurityTfParamSiteValues(tfArg, prog, scope);
        if (siteVals !== null) {
          if (siteVals.every((v): v is string => typeof v === "string")) {
            if (new Set(siteVals).size === 1) tfLiteral = siteVals[0]!;
            else tfSiteLiterals = siteVals;
          } else {
            tfSiteMixed = siteVals;
          }
        }
      }
      const isBareSeries = seriesArg.kind === "Identifier" && BAR_SERIES_NAMES.has(seriesArg.name);
      const isTupleArg = seriesArg.kind === "TupleExpr";
      // 배치31 (a, C597)/(a)-2(C598)/(b)-1(C599): 컴파일타임 리터럴로 안 접히면 런타임 1회 확정
      // 경로(securityRuntimeTfSlots → codegen 프리앰블 rebuildSecurityCache)용 tf 트리를 "여기서는
      // 해석만" 한다 — C597/C598의 bare series 한정 게이트를 해제해 expression/튜플 콜사이트도
      // 소비할 수 있게 하되, 실제 소비 가능 판정(폼별)·하드 에러·freeze 가드 롤백은 아래 폼 확정
      // (tupleFields/exprMatch/passthrough) 이후의 tf 수용 판정 블록으로 미룬다. 문법을 "직접
      // input.* 콜 + resolveSecurityRuntimeTfString 좁은 치환 트리"로 좁힌 이유(타입 안전/회귀 0
      // 보장)는 C597 원 주석 그대로 — timeframe.multiplier(숫자)류 non-string 유입을 구조적으로
      // 차단하고, 기존 "still rejects ..." 테스트가 고정한 동적(bar series 조건) tf는 계속 거부한다.
      let tfRuntimeExpr: Expr | null = null;
      if (tfLiteral === undefined && tfSiteLiterals === null && tfSiteMixed === null) {
        // C600: C597 직접 input 콜/C598 치환 트리 이단 판정을 공용 헬퍼로 추출(tf-param 사이트별
        // 리졸버와 공유, 사본 발산 방지) — 동작은 기존 인라인 구현과 바이트 동등(헬퍼 주석 참조).
        tfRuntimeExpr = resolveSecurityRuntimeTfArg(tfArg, prog, scope.func?.name ?? null);
      }
      // C432: bare UDF 콜(analyzeTupleDestructure가 튜플 arity 일치를 이미 확인하고 등록해둠,
      // securityBareUdfCallSlots 주석 참조) — buildSecurityExpr 좁은 문법과 완전히 별개 경로라
      // isBareSeries/isTupleArg와 나란히 여기서 조회해 exprMatch 판정에서 제외한다.
      const bareUdfInner = prog.securityBareUdfCallSlots.get(expr);
      // C433: bare 다중 반환 ta.* 콜(analyzeTupleDestructure가 튜플 arity 일치를 이미 확인하고
      // tupleStateCalls에 내부 콜을 등록해둠, securityBareTaCallSlots 주석 참조) — bareUdfInner와
      // 나란히 exprMatch 판정에서 제외한다(자매 메커니즘, 등록 방식만 다름).
      const bareTaInner = prog.securityBareTaCallSlots.get(expr);
      // C436: 스칼라(비튜플) bare UDF 콜 — bareUdfInner(C432)의 TupleDestructure 전용 등록과 달리
      // 이 콜사이트는 TupleDestructure를 거치지 않으므로(단일 값 대입/식 위치) 여기서 직접 판별한다.
      // tupleArity===null(단일 반환)이 확정된(bodyAnalyzed) UDF만 대상 — forward-ref(아직
      // bodyAnalyzed=false)는 tupleArity가 잠정 null이라 오판 위험이 있어 대상 밖(C432 선례와 동일
      // "corpus 근거 0건은 범위 밖" 원칙, 미매치면 아래 generic buildSecurityExpr 에러로 정상 거부).
      // C442: seriesArg가 CallExpr 자신이 아니라 top-level '=' 유일 변수(uniqueTopEqVars)를 거쳐
      // 도달해도(`source = calc_source(...)` 뒤 `request.security(sym, tf, source)`, wild 실측
      // 23건 — var-subst:eq-value:udf-call(bare) 클러스터) 동일한 literal-passthrough 오라클
      // 근거(C432/C436 주석 — request_security._resolve_expression이 non-Series 값은 그대로 통과)가
      // 그대로 적용된다. 단 등록 값은 "치환 후 도달한 UDF CallExpr"가 아니라 seriesArg **자신**
      // (Identifier 그대로)이어야 한다 — `source`는 이미 자신의 top-level `source = calc_source(...)`
      // 대입문에서 analyzeExpr/genExpr가 정확히 1회 실행돼(funcCallSlots/taSlots 등 slotBase가 그
      // 대입문의 CallExpr 노드에 배정) 매 바 올바른 값을 들고 있다 — 그 값을 여기서 다시 읽는
      // 대신 치환된 CallExpr 노드를 재사용해 또 analyzeExpr/genExpr하면 같은 slotBase(같은 var/ta.*
      // 상태 슬롯)를 두 번째 콜사이트가 공유해 매 바 상태가 두 번 전진하는 조용한 오답이 된다
      // (MEMORY C180과 동일 클래스, 최소 재현으로 실측 확인 후 이 설계로 확정) — Identifier를 그대로
      // genExpr하면 이미 계산된 값을 한 번 더 읽기만 해 상태 이중 소비가 구조적으로 없다.
      const resolveSecurityScalarBareUdfSrc = (node: Expr): Expr => {
        let cursor = node;
        // C526: 이 request.security 콜 자신이 물리적으로 위치한 함수(scope.func?.name)에서 시작 —
        // 매개변수 섀도잉 가드(constVarShadowFuncs)용. uniqueTopEqVars 체인을 한 단계 따라가면
        // def.value는 항상 top-level '=' 값이라 스코프가 top-level로 리셋된다(다른 소비처와 동일 원칙).
        let cursorFuncName: string | null = scope.func?.name ?? null;
        // C564: 선언-후-사용 판정 기준선. request.security 콜 자신은 함수 본문(get_sec 등) 안에
        // 물리적으로 위치해 그 함수 정의 줄(expr.line)이 실행 순서와 무관할 수 있다 — 매개변수를
        // 유일 콜사이트의 실인자로 치환한 뒤에는(C452 callLine 갱신과 동일 원칙) 그 콜사이트 자신의
        // 줄로 기준을 옮겨야 이후 uniqueTopEqVars 체인이 올바른 "선언-후-사용"을 판정한다.
        let cursorLine = expr.line;
        // C542 패턴 재사용: top-level 변수 치환("v:")과 UDF 매개변수 치환("p:")을 별도 키스페이스로
        // 분리 — 매개변수 이름과 top-level 변수 이름이 우연히 같으면 공유 키스페이스가 안전한 치환을
        // 거짓 순환으로 오판할 수 있다(buildSecurityExprNode의 동일 버그, secParamMultiSiteGeneric 실측).
        const visitingScalarSubst = new Set<string>();
        while (
          cursor.kind === "Identifier" &&
          !BAR_SERIES_NAMES.has(cursor.name) &&
          !DERIVED_PRICE_NAMES.has(cursor.name)
        ) {
          // C526: 섀도잉 가드는 uniqueTopEqVars 치환 시도"만" 건너뛴다 — 전체 루프를 끊으면 안 된다.
          // 매개변수 이름이 top-level 변수와 우연히 같을 때(shadowedHere===true) 진짜 정답은 바로
          // 아래 매개변수 치환 분기이므로, 여기서 break하면 그 정답 경로 자체가 막힌다
          // (buildSecurityExprNode의 shadowedHere 처리와 동일 원칙 — C452 참조).
          const shadowedHere = cursorFuncName !== null && (prog.constVarShadowFuncs.get(cursor.name)?.has(cursorFuncName) ?? false);
          const vVisitKey = "v:" + cursor.name;
          const substDef = shadowedHere || visitingScalarSubst.has(vVisitKey) ? undefined : prog.uniqueTopEqVars.get(cursor.name);
          if (substDef !== undefined && substDef.line < cursorLine) {
            visitingScalarSubst.add(vVisitKey);
            cursor = substDef.value;
            cursorFuncName = null;
            continue;
          }
          // C564: 위 uniqueTopEqVars 치환이 안 걸리고(top-level 변수가 아니라 UDF 매개변수) 그
          // 매개변수가 속한 함수가 스크립트 전체에서 유일한 top-level 콜사이트(funcSingleCallSiteArgs,
          // C452와 동일 안전 근거)를 가지면 그 콜사이트의 실인자로 치환한다(wild
          // `f(exp)=>request.security(...,exp[1],...)`가 1곳에서만 호출되는 폼, C452 자매 축).
          const pVisitKey = "p:" + cursor.name;
          if (cursorFuncName !== null && !visitingScalarSubst.has(pVisitKey)) {
            const info = prog.funcs.get(cursorFuncName);
            const paramIdx = info !== undefined ? info.paramNames.indexOf(cursor.name) : -1;
            if (info !== undefined && paramIdx >= 0) {
              const call = prog.funcSingleCallSiteArgs.get(cursorFuncName);
              if (call !== undefined) {
                const paramName = info.paramNames[paramIdx]!;
                const argExpr = call.args[paramIdx] ?? call.kwargs.find((kw) => kw.name === paramName)?.value;
                if (argExpr !== undefined) {
                  visitingScalarSubst.add(pVisitKey);
                  cursor = argExpr;
                  cursorFuncName = null;
                  cursorLine = call.line;
                  continue;
                }
              }
            }
          }
          break;
        }
        return cursor;
      };
      let scalarBareUdfInner: Expr | undefined;
      if (!isTupleArg) {
        // C562: seriesArg가 `someUdf()[1]`/`data[isLive?1:0]`류(IndexAccess)이면 obj만 이 판정
        // 대상으로 삼는다(wild 실측 solo 4건, scratch/c562_*.mjs — obj가 top-level 식별자 치환 없이
        // 곧바로 CallExpr인 가장 단순한 형태만 우선 대상, C562 next_hint에 UDF-매개변수 치환 경유
        // 축은 별도 이월). index(리터럴/삼항/동적 오프셋 전부)는 여기서 검증하지 않는다 — 아래
        // scalarBareUdfInner에 원본 IndexAccess를 그대로(obj 대입 없이) 넘겨 표준
        // analyzeExpr/analyzeIndexAccess 경로를 그대로 타게 하므로, 오히려 narrow grammar의
        // 리터럴/삼항 제한보다 넓게(동적 오프셋 C228 포함) 자연히 지원된다.
        const resolveRoot = seriesArg.kind === "IndexAccess" ? seriesArg.obj : seriesArg;
        const resolvedSrc = resolveRoot.kind === "Identifier" ? resolveSecurityScalarBareUdfSrc(resolveRoot) : resolveRoot;
        if (resolvedSrc.kind === "CallExpr" && resolvedSrc.callee.kind === "Identifier") {
          const scalarBareUdfFunc = prog.funcs.get(resolvedSrc.callee.name);
          if (scalarBareUdfFunc !== undefined && scalarBareUdfFunc.bodyAnalyzed && scalarBareUdfFunc.tupleArity === null) {
            scalarBareUdfInner = seriesArg;
          }
        }
      }
      // C306: [a,b,...] = request.security(sym, tf, [e1,e2,...]) — 튜플 값 위치(tupleStateCalls,
      // analyzeTupleDestructure가 재귀 전에 등록, ta.macd와 동일 패턴)에서만 허용. 원소마다 bare
      // BAR_SERIES_NAMES 또는 스칼라 expression과 동일한 확장 좁은 문법(buildSecurityExpr, C367 —
      // C349b의 "정확히 1개 ta.* 콜"에서 확장). C367 수정: 이전 구현은 원소 검증엔 전체 트리를
      // 쓰면서 bodyExpr엔 찾은 ta.* 콜 노드만 등록해 `[ta.sma(close,2)+1, open]`의 `+1`이 조용히
      // 탈락하는 실제 버그였다(프리패스가 콜만 재계산) — 빌드된 원소 루트 전체를 bodyExpr로 쓰는
      // 것이 수정이다.
      type SecurityTupleFieldSpec =
        | { kind: "bare"; field: "open" | "high" | "low" | "close" | "volume" }
        | { kind: "expr"; el: Expr; built: SecurityExprBuild };
      let tupleFields: SecurityTupleFieldSpec[] | null = null;
      if (isTupleArg) {
        if (!prog.tupleStateCalls.has(expr)) {
          prog.errors.push(
            `'request.security' tuple-literal 'expression' argument is only supported as the value of a tuple destructuring ('[a, b] = ...') (L${expr.line}:${expr.col})`,
          );
        } else {
          const fields: SecurityTupleFieldSpec[] = [];
          let allOk = true;
          for (const el of seriesArg.elements) {
            if (el.kind === "Identifier" && BAR_SERIES_NAMES.has(el.name)) {
              fields.push({ kind: "bare", field: el.name as "open" | "high" | "low" | "close" | "volume" });
              continue;
            }
            const elBuilt = buildSecurityExpr(el, prog, expr.line, scope.func?.name ?? null, symbolArg, tfArg);
            if (elBuilt !== null) {
              fields.push({ kind: "expr", el, built: elBuilt });
            } else {
              allOk = false;
            }
          }
          if (allOk) {
            tupleFields = fields;
          } else {
            prog.errors.push(
              `'request.security' tuple-literal 'expression' argument elements each only support bare/derived series ('open'/'high'/'low'/'close'/'volume'/'hl2'/'hlc3'/'ohlc4'/'hlcc4')·TV built-in bar variables ('time'/'time_close'/'bar_index')·number/boolean/na literals·arithmetic (+ - * /)·integer-literal history ('close[1]'/'ta.sma(close,10)[1]' — any valid subexpression)·comparison (</>/<=/>=/==/!=)·logical (and/or/not)·ternary ('cond ? a : b' — in value/offset position)·ta.* calls (multiple/nested allowed)·nz() calls (1~2 positional arguments)·na() calls (1 argument)·fixnan() calls (1 argument)·math.* calls (positional only, abs/round/max/min/avg/floor/ceil/sqrt/pow/log/log10/exp/sign/trig·inverse trig/atan2/todegrees/toradians/round_to_mintick)·substitution of a globally unique top-level '=' variable (when its value fits this grammar, including input.int/float/bool scalar constants) — same extended narrow grammar as the scalar expression (other calls such as UDFs·multi-return TA·':=' reassigned variables are not implemented) (L${expr.line}:${expr.col})`,
            );
          }
        }
      }
      const exprMatch =
        isBareSeries || isTupleArg || bareUdfInner !== undefined || bareTaInner !== undefined || scalarBareUdfInner !== undefined
          ? null
          : buildSecurityExpr(seriesArg, prog, expr.line, scope.func?.name ?? null, symbolArg, tfArg);
      // C453: expression 인자가 bare UDF 매개변수이고 그 함수의 콜사이트가 2개 이상(전원 top-level,
      // 각 콜사이트가 이 매개변수 위치에 실인자를 실제로 전달)이면 — 지금 즉시 빌드하지 않고 메인
      // 루프 종료 후로 미룬다(processPendingSecurityParamExprs — 함수 뒤에 오는 콜사이트의 인자가
      // 참조하는 top-level 이름이 아직 등록 전일 수 있어 여기서 빌드하면 선언-후-사용 검사가
      // 오탐/누락된다). 콜사이트 1개는 기존 C452 인라인 치환(buildSecurityExprNode Identifier case,
      // exprMatch 경로)이 그대로 담당 — 이 후보 판정은 exprMatch===null(치환 실패)일 때만 의미가
      // 있으므로 아래 게이트에 exprMatch===null이 이미 걸려 있다.
      // C534: seriesArg가 `_src[1]`/`_src[barstate.isrealtime?1:0]`류(IndexAccess, obj=매개변수
      // Identifier)이면 obj만 매개변수 위치로 보고 index는 그대로 보존한다(wild 실측 IndexAccess
      // seriesArg 103건 중 obj=UDF 매개변수 다중 콜사이트 축이 다수, scratch/c534_probe4.mjs) —
      // 위 exprMatch가 이미 실패했으므로(IndexAccess obj=Identifier가 어떤 치환 경로로도 안 풀림)
      // 여기서 obj만 떼어 아래 판정에 태운다. index 자체는 콜사이트마다 다시 빌드하지 않고 원본
      // 그대로 재사용(processPendingSecurityParamExprs가 매 콜사이트에 합성 IndexAccess로 재조립) —
      // 이 index가 같은 함수의 다른 매개변수를 참조하면(funcName=null 전달이라) 그 식별자가 안 풀려
      // 빌드가 자연 실패하고 기존 generic 에러로 떨어진다(부분 지원 없음, 안전).
      const paramCandidate: Expr = seriesArg.kind === "IndexAccess" && seriesArg.obj.kind === "Identifier" ? seriesArg.obj : seriesArg;
      const indexWrap: { index: Expr; line: number; col: number } | null =
        seriesArg.kind === "IndexAccess" && seriesArg.obj.kind === "Identifier"
          ? { index: seriesArg.index, line: seriesArg.line, col: seriesArg.col }
          : null;
      let secParamMultiSite: { paramIdx: number; paramName: string; indexWrap: { index: Expr; line: number; col: number } | null } | null =
        null;
      // C563: 배치26 (1)(a) — 전 콜사이트의 실인자가 bare(단일 반환) UDF 콜(직접 CallExpr 또는
      // top-level 콜사이트 한정 uniqueTopEqVars 치환 도달)이면 per-site 좁은문법 빌드(HTF 프리패스)
      // 대상이 아니라 C436 passthrough의 다중 콜사이트판이다 — pine2py request_security
      // _resolve_expression은 OHLC(V) identity-match 외 값을 그대로 통과시키므로(C562 재확인) 이
      // request.security의 값은 콜사이트와 무관하게 "매개변수 자신"으로 균일 붕괴한다(C529 uniform
      // 원칙 — 매개변수는 콜사이트별 값을 이미 일반 UDF 인자 전달로 들고 있다). 슬롯/프리패스/
      // __secIdx가 전혀 필요 없어 in-func 콜사이트도 안전하게 허용된다(funcAllCallSites 주석의
      // 제외 사유 두 가지가 모두 소멸: 스코프 치환 불필요 + __secIdx 불필요). 최종 확정(피호출
      // UDF의 bodyAnalyzed/tupleArity 검사)은 다른 pending과 동일하게 메인 루프 종료 후
      // (processPendingSecurityParamExprs) — 함수 뒤에 선언되는 UDF는 이 시점에 tupleArity가 잠정
      // null이라 여기서 확정하면 오판한다(C436 forward-ref 제외 원칙과 동일 이유의 지연판).
      let secParamAllBareUdf: { paramIdx: number; paramName: string } | null = null;
      if (
        exprMatch === null &&
        !isBareSeries &&
        !isTupleArg &&
        bareUdfInner === undefined &&
        bareTaInner === undefined &&
        scalarBareUdfInner === undefined &&
        paramCandidate.kind === "Identifier" &&
        scope.func !== null
      ) {
        const paramIdx = scope.func.paramNames.indexOf(paramCandidate.name);
        const sites = prog.funcAllCallSites.get(scope.func.name);
        if (paramIdx >= 0 && sites !== undefined && sites.length >= 1) {
          const allSitesBareUdf =
            sites.length >= 2 &&
            sites.every((s) => {
              const argExpr = s.call.args[paramIdx] ?? s.call.kwargs.find((kw) => kw.name === paramCandidate.name)?.value;
              if (argExpr === undefined) return false;
              const root = resolveSecuritySiteArgBareUdfRoot(argExpr, s.inFuncName, s.call.line, prog);
              return root.kind === "CallExpr" && root.callee.kind === "Identifier" && prog.funcs.has(root.callee.name);
            });
          if (allSitesBareUdf) {
            secParamAllBareUdf = { paramIdx, paramName: paramCandidate.name };
          } else if (
            // C731(배치37 (3) 1차 슬라이스): in-func 콜사이트 허용 — pending 처리기가 실인자 빌드에
            // funcName=site.inFuncName을 넘기도록 확장됐다(C539 tf-param과 동일 원칙: C526 섀도잉
            // 가드가 실인자 자신의 함수로 정확히 걸리고, 그 함수의 매개변수 참조는 C452 유일
            // 콜사이트 치환이 이어서 해소하거나 자연 실패해 보수적으로 거부된다). __secIdx 배선은
            // CallExpr 노드 키라 콜사이트 위치 무관(C529 주석). 단일 top-level 콜사이트는 기존
            // C452 인라인(exprMatch)이 이미 시도·실패한 뒤라 제외(기존 동작/에러 보존) — 단일
            // in-func 콜사이트는 그 인라인이 구조적으로 못 다루던 갭이라 pending으로 새로 연다.
            (sites.length >= 2 || sites[0]!.inFuncName !== null) &&
            sites.every(
              (s) => (s.call.args[paramIdx] ?? s.call.kwargs.find((kw) => kw.name === paramCandidate.name)?.value) !== undefined,
            )
          ) {
            secParamMultiSite = { paramIdx, paramName: paramCandidate.name, indexWrap };
          }
        }
      }
      // C542: secParamMultiSite(paramCandidate가 bare Identifier/IndexAccess(Identifier)) 실패 후
      // 일반화 — seriesArg가 매개변수(들)를 서브트리 어딘가에 참조하는 임의 형태(wild 최다:
      // `ta.rsi(src, length)`류, src/length가 둘 다 매개변수)면 seriesArg 원본 전체를 후보로 삼는다.
      // secParamMultiSite가 이미 성립했으면(단일 매개변수 bare/IndexAccess 형태) 그 경로가 출력
      // 바이트를 그대로 보존해야 하므로 이 일반화 경로는 건너뛴다.
      let secParamMultiSiteGeneric: Expr | null = null;
      if (exprMatch === null && secParamMultiSite === null && secParamAllBareUdf === null && !isBareSeries && !isTupleArg && bareUdfInner === undefined && bareTaInner === undefined && scalarBareUdfInner === undefined && scope.func !== null) {
        const referenced = new Set<string>();
        collectSecurityExprIdentNames(seriesArg, referenced);
        const referencedParamIdxs = scope.func.paramNames
          .map((name, idx) => (referenced.has(name) ? idx : -1))
          .filter((idx) => idx >= 0);
        if (referencedParamIdxs.length > 0) {
          const sites = prog.funcAllCallSites.get(scope.func.name);
          const sitesProvideArgs =
            sites !== undefined &&
            sites.every(
              (s) =>
                referencedParamIdxs.every(
                  (pi) => (s.call.args[pi] ?? s.call.kwargs.find((kw) => kw.name === scope.func!.paramNames[pi])?.value) !== undefined,
                ),
            );
          if (
            sites !== undefined &&
            sitesProvideArgs &&
            // C731: in-func 콜사이트 허용(위 secParamMultiSite 주석 참조 — paramEnv 엔트리가
            // site.inFuncName을 담아 실인자 치환이 그 함수 스코프로 걷는다. root 자신의 비-매개변수
            // 식별자는 기존과 동일하게 funcName=null로 걷어 동작 불변). 단일 top-level 사이트는
            // 기존 인라인 경로 보존을 위해 계속 제외.
            (sites.length >= 2 || (sites.length === 1 && sites[0]!.inFuncName !== null))
          ) {
            secParamMultiSiteGeneric = seriesArg;
          } else if (
            // C739(배치37(3) 9차): 단일 top-level 콜사이트라도 seriesArg가 읽기-지점 오프셋 폴백
            // 형태(`bareSeries[매개변수 산술]`)면 pending으로 보낸다 — 이 지점은 인라인(C452/C564)
            // 실패 후(exprMatch === null)라 현재 무조건 에러였던 축이다(wild 84d597064e48:
            // `getDayIndexedHighLow(index)` 단일 사이트, 실인자가 ':=' var라 인라인 치환 불가).
            // pending 처리에서 실인자 빌드가 성공하면 기존 프리패스 그대로, 실패하면
            // processPendingSecurityParamExprs의 C739 폴백이 읽기-지점 오프셋으로 수용한다.
            sites !== undefined &&
            sites.length >= 1 &&
            sitesProvideArgs &&
            seriesArg.kind === "IndexAccess" &&
            seriesArg.obj.kind === "Identifier" &&
            BAR_SERIES_NAMES.has(seriesArg.obj.name) &&
            isSecurityUdfScopeOffsetExpr(seriesArg.index, scope.func.paramNames)
          ) {
            secParamMultiSiteGeneric = seriesArg;
          }
        }
      }
      // C742(배치37(3) 12차 — SAME sym+tf 체인 passthrough 폼): expression 트리가 "같은 symbol+tf의
      // 선행 request.security 콜(그 자신은 C436 scalar bare-UDF passthrough로 등록됨)을 값으로 담은
      // top-level '=' 변수"를 참조하는 형태(wild 9960631a4fe0 `bbwp = security(sym, i_tf, f_bbwp(...))`
      // 후 `security(sym, i_tf, cond ? ta.sma(bbwp,l) : ta.ema(bbwp,l))`). 좁은 문법(exprMatch)의
      // C616 체인 collapse는 이 변수를 내부 expression(f_bbwp 콜)으로 치환하지만 그 본문(for 루프)이
      // C516 인라인 밖이라 구조적으로 항상 실패한다. 그런데 내부 콜이 passthrough 폼이라는 것은 그
      // 변수가 이미 "메인 컨텍스트 매 바 값"(tf 완전 discard, C432/C436 pine2py 오라클 근거 —
      // request_security._resolve_expression은 eager 평가된 값을 그대로 통과)이라는 뜻이므로, 같은
      // symbol+tf인 바깥 콜의 expression 전체도 동일 근거로 메인 컨텍스트 평가+passthrough가 정합이다
      // (pine2py는 이 폼 전체를 정확히 이렇게 실행한다 — HTF 프리패스로 절반만 재계산하는 혼합이
      // 오히려 비정합). exprMatch 실패 "후"에만 폴백으로 시도해 기존 통과 경로(체인 인라인이 성공하는
      // psyll류 C737 HTF 트랙 포함)는 바이트 불변. 트리 게이트: (1) HTF 리플레이 의미를 갖는 리프
      // (bare/파생 시리즈·time/bar_index·시간 컴포넌트·timeframe.*)가 하나라도 있으면 거부(혼합 시맨틱
      // 차단 — 그런 트리는 기존 에러 유지), (2) 체인 참조가 최소 1개 있어야 발동(없으면 기존 에러
      // 그대로), (3) 콜은 ta./math. 레지스트리·nz/na/fixnan·단일반환 UDF(bodyAnalyzed, C436 forward-ref
      // 제외 원칙)만 — 중첩 request.* 직접 콜/기타 네임스페이스는 거부. 수용 시 C436 채널
      // (scalarBareUdfInner)에 그대로 태워 analyzeExpr/codegen genExpr 인라인 방출을 전부 재사용한다
      // (신규 codegen 0줄). DIVERGENCES #227.
      if (
        exprMatch === null &&
        !isBareSeries &&
        !isTupleArg &&
        bareUdfInner === undefined &&
        bareTaInner === undefined &&
        scalarBareUdfInner === undefined &&
        secParamMultiSite === null &&
        secParamAllBareUdf === null &&
        secParamMultiSiteGeneric === null
      ) {
        let chainRefFound = false;
        const walkChainedPassthrough = (n: Expr): boolean => {
          switch (n.kind) {
            case "NumberLiteral":
            case "BoolLiteral":
            case "NaLiteral":
            case "StringLiteral":
              return true;
            case "Identifier": {
              if (
                BAR_SERIES_NAMES.has(n.name) ||
                DERIVED_PRICE_NAMES.has(n.name) ||
                SECURITY_EXPR_TIME_BAR_NAMES.has(n.name) ||
                TIME_FUNC_NAMES.has(n.name)
              )
                return false;
              const resolved = resolveSecurityScalarBareUdfSrc(n);
              if (resolved.kind === "CallExpr") {
                const lead = tryResolveSecurityLeadArgsQuiet(resolved);
                if (lead !== null) {
                  // 선행 security 콜로 귀결 — 같은 symbol+tf(AST 구조 비교, C616 원칙) + passthrough
                  // 등록(C436 슬롯맵)일 때만 수용. 다른-tf/sym 체인(재론금지 축)이나 HTF 프리패스로
                  // 등록된 내부 콜(collapse 트랙 소관)은 보수적으로 전체 거부(기존 에러 유지).
                  if (
                    astExprEqual(symbolArg, lead.symbolArg) &&
                    astExprEqual(tfArg, lead.tfArg) &&
                    prog.securityScalarBareUdfCallSlots.has(resolved)
                  ) {
                    chainRefFound = true;
                    return true;
                  }
                  return false;
                }
              }
              return true;
            }
            case "BinOp":
              return walkChainedPassthrough(n.left) && walkChainedPassthrough(n.right);
            case "UnaryOp":
              return walkChainedPassthrough(n.operand);
            case "TernaryOp":
              return (
                walkChainedPassthrough(n.condition) && walkChainedPassthrough(n.trueExpr) && walkChainedPassthrough(n.falseExpr)
              );
            case "IndexAccess":
              return walkChainedPassthrough(n.obj) && walkChainedPassthrough(n.index);
            case "DotAccess":
              // timeframe.period/multiplier류는 HTF 컨텍스트 의미(C735/C736 outerTf 전환)가 있어
              // 메인 컨텍스트 읽기와 갈린다 — 거부. 그 외(syminfo.*/barstate.*/math.pi/UDT 필드)는
              // 메인 컨텍스트 값 그대로가 pine2py 정합이라 표준 analyzeExpr에 맡긴다.
              return !(n.obj.kind === "Identifier" && n.obj.name === "timeframe");
            case "CallExpr": {
              if (tryResolveSecurityLeadArgsQuiet(n) !== null) return false;
              const callee = n.callee;
              let calleeOk = false;
              if (callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && (callee.obj.name === "ta" || callee.obj.name === "math")) {
                calleeOk = true;
              } else if (callee.kind === "Identifier") {
                if (callee.name === "nz" || callee.name === "na" || callee.name === "fixnan") {
                  calleeOk = true;
                } else {
                  const fnInfo = prog.funcs.get(callee.name);
                  calleeOk = fnInfo !== undefined && fnInfo.bodyAnalyzed && fnInfo.tupleArity === null;
                }
              }
              if (!calleeOk) return false;
              for (const a of n.args) if (!walkChainedPassthrough(a)) return false;
              for (const kw of n.kwargs) if (!walkChainedPassthrough(kw.value)) return false;
              return true;
            }
            default:
              return false;
          }
        };
        if (walkChainedPassthrough(seriesArg) && chainRefFound) {
          scalarBareUdfInner = seriesArg;
        }
      }
      // 배치31 (b)-1, C599: tf 수용 판정(위 tfRuntimeExpr 해석 블록에서 이월) — 셋 중 하나면 수용:
      // (1) 컴파일타임 확정(tfLiteral/tfSiteLiterals — 기존 그대로), (2) 런타임 1회 확정 트리를
      // 소비할 수 있는 폼(bare/튜플 리터럴/exprMatch — 슬롯이 이 콜사이트 전용이라 프리앰블
      // rebuild가 정확. secParam* pending 폼은 콜사이트별 슬롯 블록 재설계가 필요한 다음 슬라이스라
      // 제외 — 기존 하드 에러 유지), (3) tf가 계산에서 완전히 discard되는 scalar passthrough 폼
      // (bareUdfInner/bareTaInner/scalarBareUdfInner — pine2py request_security._resolve_expression이
      // OHLC(V) identity 외 값을 그대로 통과시켜 tf가 결과에 전혀 안 실리는 C432/C436 오라클 근거.
      // tf 값이 어떤 형태(재대입 var/UDF 콜/switch-식)든 결과 불변이라 리터럴 요구 자체가 과잉 —
      // 단 tfArg의 부작용 분석(선언-전-사용 검출)은 각 등록 분기의 analyzeExpr(tfArg)가 기존대로
      // 수행한다). 수용 시 실패한 폴딩 시도의 신규 freeze 가드를 롤백한다(C598 — 이 콜사이트는
      // "컴파일타임 고정 캐시" 전제가 없어 가드가 스퓨리어스 throw만 만든다).
      const tfAvailable = tfLiteral !== undefined || tfSiteLiterals !== null;
      // 배치31 (b)-2, C600: tf-param 혼합 배열(tfSiteMixed)의 소비 가능 폼 — 직접 multiSite 3폼
      // (bare/튜플/exprMatch — C529/C532 사이트별 슬롯 블록의 각 슬롯을 securityRuntimeTfSlots로)과
      // pending secParam* 3폼(C453 큐가 이미 사이트별 슬롯 블록을 서수 1:1로 배정하므로 같은 혼합
      // 배열이 그대로 흐른다 — AllBareUdf passthrough는 tf 자체를 discard라 배열이 안 읽힘).
      // uniform tfRuntimeExpr(비-param)의 secParam* 조합은 wild 실사용 0건이라 계속 제외(C283).
      const tfSiteMixedConsumable =
        tfSiteMixed !== null &&
        (isBareSeries ||
          tupleFields !== null ||
          exprMatch !== null ||
          secParamMultiSite !== null ||
          secParamMultiSiteGeneric !== null ||
          secParamAllBareUdf !== null);
      const tfViaRuntime =
        (tfRuntimeExpr !== null && (isBareSeries || tupleFields !== null || exprMatch !== null)) || tfSiteMixedConsumable;
      const tfDiscarded = bareUdfInner !== undefined || bareTaInner !== undefined || scalarBareUdfInner !== undefined;
      if (!tfAvailable) {
        if (tfViaRuntime || tfDiscarded) {
          // C600: 혼합 배열이 슬롯 생성 폼에 소비되면 폴딩 성공 사이트의 freeze 가드는 정당
          // 소비라 유지한다(실패 시도분은 리졸버가 사이트 단위로 이미 롤백). 그 외(순수 런타임
          // tfRuntimeExpr/tf discard — AllBareUdf passthrough 포함: 슬롯을 안 만들어 freeze 전제
          // 소멸)는 기존 C598/C599대로 스냅샷 이후 신규 가드를 전량 롤백한다.
          const tfSiteMixedKeepsGuards =
            tfSiteMixed !== null &&
            (isBareSeries ||
              tupleFields !== null ||
              exprMatch !== null ||
              secParamMultiSite !== null ||
              secParamMultiSiteGeneric !== null);
          if (!tfSiteMixedKeepsGuards) {
            for (const k of prog.securityTfConstGuards.keys()) {
              if (!guardKeysBeforeTfFold.has(k)) prog.securityTfConstGuards.delete(k);
            }
          }
        } else {
          // 기존 에러 문자열은 바이트 단위로 보존한다(MEMORY.md "기존 테스트 assertion 완화/삭제
          // 금지" — analyzer.test.ts 30여 곳이 이 부분 문자열로 .includes() 매칭). 위에서 새로
          // 흡수한 폼만 여기 도달하지 않게 돼 에러 문구/발생 조건은 완전히 그대로다.
          prog.errors.push(
            `'request.security' 'timeframe' argument only supports a compile-time string literal (runtime tf changes conflict with the HTF aggregation cache) (L${expr.line}:${expr.col})`,
          );
        }
      }
      if (
        !isBareSeries &&
        !isTupleArg &&
        bareUdfInner === undefined &&
        bareTaInner === undefined &&
        scalarBareUdfInner === undefined &&
        exprMatch === null &&
        secParamMultiSite === null &&
        secParamAllBareUdf === null &&
        secParamMultiSiteGeneric === null
      ) {
        pushSecurityExprUnsupportedError(prog, expr);
      }
      // C533(C367 게이트 해제): ta.* 콜 포함 expression 폼도 UDF/method 본문 안에서 지원한다.
      // 문제였던 것은 프리패스가 top-level 함수로 방출되는데 UDF 스코프의 analyzeStatefulCall이
      // 함수-상대 슬롯(__taBase + n)을 배정해 프리패스 본문이 존재하지 않는 __taBase를 참조하는
      // ReferenceError였다(C367이 발견·차단) — 해법은 C453 processPendingSecurityParamExprs의
      // rootScope 등록과 동일하게 클론 ta 콜을 전역 taSlotCount 풀에서 배정하는 것(그 함수 주석
      // 참조). 클론 인자는 좁은 문법상 전부 콜사이트 불변(bare/파생 시리즈·리터럴·input 상수·전역
      // 유일 '=' 치환 — UDF 매개변수/로컬은 buildSecurityExpr가 거부)이라 top-level 등록이
      // 시맨틱상으로도 정확하다. 고정 tf면 전 콜사이트가 같은 HTF 캐시/프리패스를 공유해도 순수
      // 읽기라 정확(C529 uniform 붕괴와 동일 근거). distinct tf(tfSiteLiterals)면 같은 클론 ta
      // 슬롯을 N개 프리패스가 서로 다른 HTF 캐시 위에서 재실행해 incremental 상태가 오염되므로,
      // 사이트마다 buildSecurityExpr를 다시 돌려 독립 클론+독립 전역 슬롯을 배정한다(아래 각 분기).
      const taCloneRegScope = (() => {
        if (scope.func === null) return scope; // top-level: 기존 동작 그대로(조건부 위치 검사 포함)
        let root = scope;
        while (root.parent !== null) root = root.parent;
        return root; // analyze()의 top-level 스코프(func === null) — C453 rootScope와 동일 대상
      })();
      let gaps = false;
      let lookahead = false;
      let kwargsOk = true;
      const seenSecurityKwargs = new Set<string>();
      // gaps=/lookahead= 4번째/5번째 위치 인자(C249) — TV 실제 시그니처 순서 그대로, kwargs와
      // 동일한 resolveSecurityBooleanKwarg로 컴파일타임 boolean 확정. seenSecurityKwargs에 먼저
      // 등록해 뒤이은 kwargs 루프가 같은 이름의 중복 지정(위치+키워드 혼용 포함)을 잡아내게 한다.
      const SECURITY_POSITIONAL_NAMES = ["gaps", "lookahead"] as const;
      for (let i = 3; i < expr.args.length; i++) {
        const name = SECURITY_POSITIONAL_NAMES[i - 3]!;
        const posArg = expr.args[i]!;
        seenSecurityKwargs.add(name);
        const resolved = resolveSecurityBooleanKwarg(posArg, prog, undefined, undefined, scope.func?.name ?? null);
        if (resolved === undefined) {
          prog.errors.push(
            `'request.security' '${name}' positional argument value only supports a compile-time 'true'/'false' literal or a 'barmerge.*' constant (variables/expressions conflict with the HTF aggregation cache) (L${posArg.line}:${posArg.col})`,
          );
          kwargsOk = false;
          continue;
        }
        if (name === "gaps") gaps = resolved;
        else lookahead = resolved;
      }
      // ignore_invalid_symbol=/currency=(C376, wild named-list kwarg 클러스터 마지막 잔여 —
      // 순증 상한 17+9=26건). pine2py wavealgo/__init__.py request_security()(L85-100)를 python
      // 소스로 확인: 시그니처엔 named parameter로 있으나(**kwargs 흡수가 아님) 함수 본문이
      // context.security.get(symbol, timeframe, expression, gaps=, lookahead=)만 호출해 두 값
      // 모두 전혀 전달하지 않는다 — 즉 named parameter로 받되 본문에서 100% 미사용(alert_message류
      // **kwargs 흡수와 결과적으로 동일한 '오라클에도 안 보이는 순수 discard' 축). TV 실제 시맨틱상
      // ignore_invalid_symbol=은 대상 심볼이 무효할 때만 분기하는데 pine2js는 symbol 인자 자체를
      // 애초에 검증 없이 버리는 동일 심볼 전용 구현이라(C174) 그 분기가 구조적으로 발생하지 않고,
      // currency=는 통화 환산인데 pine2py에 환율 데이터/변환 로직 자체가 없어(hasattr 등 어떤
      // 대체 채널도 없음) 오라클이 구조적으로 불가(C176류)가 아니라 애초에 계산에 안 얽힌다 — 값
      // kwarg지만 gaps/lookahead(get()이 실제 소비)와 달리 comment=류 소비 채널이 전무해 MEMORY
      // C147 원칙대로 파싱만 허용하고 컴파일타임 boolean 제약 없이(resolveSecurityBooleanKwarg
      // 미적용) 그대로 버린다(codegen이 gaps/lookahead 외 어떤 kwarg도 읽지 않아 자연 discard,
      // 신규 codegen 코드 0줄).
      // calc_bars_count=(C708, batch35 kwarg화이트리스트 재실측 — wild 10건, 이 클러스터 최다빈도)
      // — pine2py wavealgo/__init__.py request_security(...) 시그니처를 python 소스로 직접 재확인:
      // `calc_bars_count=None`이 named parameter로 있으나 함수 본문 어디서도 참조 안 됨(context.
      // security.get() 호출도 gaps=/lookahead=만 넘김) — ignore_invalid_symbol/currency와 완전히
      // 동일한 "named parameter로 받되 100% 미사용" 축이라 같은 원칙으로 discard.
      for (const kw of expr.kwargs) {
        if (SECURITY_LEAD_PARAM_NAMES.includes(kw.name as (typeof SECURITY_LEAD_PARAM_NAMES)[number])) {
          continue; // symbol/timeframe/expression — resolveSecurityLeadArgs가 이미 소비/검증함
        }
        if (kw.name === "ignore_invalid_symbol" || kw.name === "currency" || kw.name === "calc_bars_count") {
          if (seenSecurityKwargs.has(kw.name)) {
            prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
            kwargsOk = false;
            continue;
          }
          seenSecurityKwargs.add(kw.name);
          continue;
        }
        if (kw.name !== "gaps" && kw.name !== "lookahead") {
          prog.errors.push(
            `'request.security' only supports keyword arguments 'gaps='/'lookahead='/'ignore_invalid_symbol='/'currency='/'calc_bars_count=' (this slice): '${kw.name}=' (L${kw.line}:${kw.col})`,
          );
          kwargsOk = false;
          continue;
        }
        if (seenSecurityKwargs.has(kw.name)) {
          prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
          kwargsOk = false;
          continue;
        }
        seenSecurityKwargs.add(kw.name);
        const resolved = resolveSecurityBooleanKwarg(kw.value, prog, undefined, undefined, scope.func?.name ?? null);
        if (resolved === undefined) {
          prog.errors.push(
            `'request.security' '${kw.name}=' value only supports a compile-time 'true'/'false' literal or a 'barmerge.*' constant (variables/expressions conflict with the HTF aggregation cache) (L${kw.line}:${kw.col})`,
          );
          kwargsOk = false;
          continue;
        }
        if (kw.name === "gaps") gaps = resolved;
        else lookahead = resolved;
      }
      // 배치31 (b)-1, C599: 게이트를 위 tf 수용 판정과 정확히 일치시킨다 — tfRuntimeExpr가 해석은
      // 됐지만 소비 불가한 폼(uniform 런타임 tf × secParam* pending)이면 게이트에 못 들어와 그
      // 분기의 tfLiteral! 참조가 구조적으로 안전하다(위 수용 판정이 그 조합에 이미 하드 에러를
      // push했다). (b)-2, C600: tf-param 혼합 배열(tfSiteMixed)은 tfSiteLiterals와 같은 자리로
      // 흐른다(tfSiteValues) — 사이트 슬롯 push만 pushSiteTf가 리터럴/런타임을 갈라 처리한다.
      const tfSiteValues: (string | Expr)[] | null = tfSiteLiterals ?? tfSiteMixed;
      // C600: 콜사이트별 tf 슬롯 push — 리터럴이면 기존 그대로, 런타임 트리면 자리표시(chartTf) +
      // securityRuntimeTfSlots 등록(C597 단일 슬롯 메커니즘의 사이트별 적용 — codegen 프리앰블이
      // 등록된 슬롯마다 $.rebuildSecurityCache(slot, tf)를 방출한다).
      const pushSiteTf = (v: string | Expr): void => {
        const siteSlot = prog.securityTfs.length;
        if (typeof v === "string") {
          prog.securityTfs.push(v);
        } else {
          prog.securityTfs.push(prog.chartTf);
          prog.securityRuntimeTfSlots.set(siteSlot, v);
        }
      };
      if (kwargsOk && (tfAvailable || tfViaRuntime || tfDiscarded)) {
        if (seriesArg.kind === "Identifier" && BAR_SERIES_NAMES.has(seriesArg.name)) {
          const slot = prog.securityTfs.length;
          if (tfSiteValues !== null) {
            // C529: 콜사이트별 tf 블록(slot..slot+N-1, funcAllCallSites 순서) — codegen이
            // `slot + __secIdx`로 읽는다(C453 서수 인프라 재사용, registerSecurityTfSiteOrdinals).
            for (const v of tfSiteValues) pushSiteTf(v);
            registerSecurityTfSiteOrdinals(prog, scope.func!);
            prog.securityCallSlots.set(expr, {
              slot,
              field: seriesArg.name as "open" | "high" | "low" | "close" | "volume",
              gaps,
              lookahead,
              multiSite: true,
            });
          } else if (tfRuntimeExpr !== null) {
            // 배치31 (a, C597): securityTfs[slot]은 Context 생성자가 무해하게 즉시 빌드할
            // 자리표시일 뿐(prog.chartTf) — codegen 프리앰블이 바 루프 시작 전 tfRuntimeExpr를
            // 정확히 1회 evaluate해 $.rebuildSecurityCache(slot, tf)로 실제 값을 덮어쓴다.
            prog.securityTfs.push(prog.chartTf);
            prog.securityRuntimeTfSlots.set(slot, tfRuntimeExpr);
            prog.securityCallSlots.set(expr, {
              slot,
              field: seriesArg.name as "open" | "high" | "low" | "close" | "volume",
              gaps,
              lookahead,
            });
          } else {
            prog.securityTfs.push(tfLiteral!);
            prog.securityCallSlots.set(expr, {
              slot,
              field: seriesArg.name as "open" | "high" | "low" | "close" | "volume",
              gaps,
              lookahead,
            });
          }
          // C409: symbol/timeframe이 키워드로 왔으면 expr.args가 비어(또는 짧아) 함수 끝의 공용
          // 부작용 재귀(`for (const arg of expr.args) analyzeExpr(...)`)가 이 값들을 못 본다 —
          // 위 tuple/exprMatch 분기의 명시적 analyzeExpr(symbolArg/tfArg) 호출과 동일하게 여기서도
          // 직접 분석(선언-전-사용 검출). 위치 인자로 왔을 때는 아래 공용 재귀와 중복 분석되지만
          // bare Identifier/리터럴 재분석은 무해(C366 원칙과 동일).
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
        } else if (tupleFields !== null) {
          // C306(all-bare) + C349b(mixed ta.* 원소): bare 원소는 개별 taSlots 배정이 필요 없어
          // 같은 symbol/tf/gaps/lookahead를 공유하는 slot 하나(HTF 캐시 하나)로 N개 필드를 전부
          // 읽는다(codegen이 $.taScratch[0..N-1]에 순서대로 기록, ta.macd와 동일 스크래치 패턴).
          // ta.* 콜 원소는 스칼라 exprMatch 분기와 동일하게 각자 독립된 slot(HTF 캐시 중복 fetch,
          // 위 AnalyzedProgram.securityTupleCallSlots 주석 참조)을 받아 securityExprCallSlots에
          // 등록한다 — 원소 순서가 곧 taScratch 기록 순서이므로 슬롯 배정도 원소 순회 순서 그대로.
          // exprMatch 분기와 동일한 이유로 즉시 return(공유 꼬리 재귀가 이 TupleExpr을 다시 훑으면
          // 일반 표현식 위치 TupleExpr 거부에 걸림 — analyzer.ts analyzeExpr TupleExpr case 참조).
          // C532: distinct-tf × 튜플 — C529 bare/expr multiSite의 튜플판. bare 필드 공유 캐시는
          // 콜사이트별 연속 슬롯 블록(slot..slot+S-1, funcAllCallSites 순서)이 되고, expr 원소는
          // 원소마다 자신의 연속 블록(base..base+S-1) + 사이트별 프리패스 스펙을 받는다(스펙은
          // C453의 securityParamExprPrepasses 배열을 그대로 재사용 — generateSecurityExprPreamble
          // 방출 변경 0줄. ta 콜 0개 원소는 bodyExpr/histReads가 tf와 무관·무상태라 같은 빌드
          // 결과를 S개 스펙이 공유해도 안전(C532 원래 설계). ta 콜 포함 원소(C533)는 같은 클론을
          // S개 프리패스가 서로 다른 HTF 캐시 위에서 재실행하면 incremental 상태가 오염되므로
          // 사이트마다 buildSecurityExpr를 다시 돌려 독립 클론을 만들고 그 클론 ta 콜을 전역
          // 슬롯(taCloneRegScope)으로 등록한다 — f.built 자신의 클론은 미등록 폐기(슬롯/이중등록
          // 부작용 없음, 노드-키 맵은 클론별로 물리적으로 분리). 읽기는 codegen securityTupleCall
          // 분기가 multiSite면 slot/base에 __secIdx를 더한다.
          if (tfSiteValues !== null) {
            // C600: 혼합 배열이면 pushSiteTf가 사이트 슬롯별로 리터럴/런타임(자리표시 +
            // securityRuntimeTfSlots)을 갈라 push한다 — 블록 구조/서수/프리패스 스펙은 C532 그대로.
            const slot = prog.securityTfs.length;
            for (const v of tfSiteValues) pushSiteTf(v);
            const resolvedFields: (
              | { kind: "bare"; field: "open" | "high" | "low" | "close" | "volume" }
              | { kind: "expr"; slot: number }
            )[] = [];
            for (const f of tupleFields) {
              if (f.kind === "bare") {
                resolvedFields.push({ kind: "bare", field: f.field });
              } else {
                const exprBase = prog.securityTfs.length;
                for (const v of tfSiteValues) {
                  const exprSlot = prog.securityTfs.length;
                  pushSiteTf(v);
                  // 동일 입력 재빌드라 실패 불가(f.built가 이미 성공한 결정적 함수 재호출) — C533.
                  let siteBuilt: SecurityExprBuild = f.built;
                  if (f.built.taCalls.length > 0) {
                    siteBuilt = buildSecurityExpr(f.el, prog, expr.line, scope.func?.name ?? null, symbolArg, tfArg)!;
                    for (const tc of siteBuilt.taCalls) analyzeStatefulCall(tc.taCall, tc.fn, tc.entry, prog, taCloneRegScope);
                  }
                  prog.securityParamExprPrepasses.push({
                    slot: exprSlot,
                    gaps,
                    lookahead,
                    bodyExpr: siteBuilt.bodyExpr,
                    histReads: siteBuilt.histReads,
                    varSlice: siteBuilt.varSlice,
                  });
                }
                resolvedFields.push({ kind: "expr", slot: exprBase });
              }
            }
            prog.securityTupleCallSlots.set(expr, { slot, fields: resolvedFields, gaps, lookahead, multiSite: true });
            registerSecurityTfSiteOrdinals(prog, scope.func!);
            prog.taScratchSize = Math.max(prog.taScratchSize, tupleFields.length);
            analyzeExpr(symbolArg, prog, scope, false);
            analyzeExpr(tfArg, prog, scope, false);
            return;
          }
          // 배치31 (b)-1, C599: tf가 런타임 1회 확정 트리면 자리표시(chartTf)로 밀고 슬롯을
          // securityRuntimeTfSlots에 등록한다(bare series C597 분기와 동일 메커니즘 — 프리앰블
          // rebuildSecurityCache가 바 루프/프리패스 시작 전에 실제 값으로 덮어쓴다. 튜플은 bare
          // 공유 슬롯 + expr 원소별 슬롯 전부가 같은 tf 트리를 각자 재평가하는데, 리프가 전부
          // 리터럴/input 콜(순수 읽기)이라 다중 평가가 안전하다).
          const slot = prog.securityTfs.length;
          prog.securityTfs.push(tfLiteral ?? prog.chartTf);
          if (tfRuntimeExpr !== null && tfLiteral === undefined) prog.securityRuntimeTfSlots.set(slot, tfRuntimeExpr);
          const resolvedFields: (
            | { kind: "bare"; field: "open" | "high" | "low" | "close" | "volume" }
            | { kind: "expr"; slot: number }
          )[] = [];
          for (const f of tupleFields) {
            if (f.kind === "bare") {
              resolvedFields.push({ kind: "bare", field: f.field });
            } else {
              // C367: 빌드된 클론 ta.* 콜 전부(0~N개)를 정식 등록하고, bodyExpr는 빌드된 원소
              // 루트 전체(산술 래퍼 포함 — 구 구현의 "+1 조용한 탈락" 버그 수정, 위 주석 참조).
              // key는 원소의 원본 Expr 노드(el) — 소스 위치가 달라 항상 유일(bodyExpr는 치환
              // 리프 공유로 겹칠 수 있어 key 부적격, AnalyzedProgram 주석 참조). 등록 스코프는
              // taCloneRegScope(C533) — UDF 본문이면 top-level 스코프로 강제해 전역 슬롯 배정
              // (프리패스는 top-level 방출, 고정 tf라 전 콜사이트 공유 캐시가 순수 읽기로 정확).
              for (const tc of f.built.taCalls) analyzeStatefulCall(tc.taCall, tc.fn, tc.entry, prog, taCloneRegScope);
              const exprSlot = prog.securityTfs.length;
              prog.securityTfs.push(tfLiteral ?? prog.chartTf);
              if (tfRuntimeExpr !== null && tfLiteral === undefined) prog.securityRuntimeTfSlots.set(exprSlot, tfRuntimeExpr);
              prog.securityExprCallSlots.set(f.el, {
                slot: exprSlot,
                gaps,
                lookahead,
                bodyExpr: f.built.bodyExpr,
                histReads: f.built.histReads,
                varSlice: f.built.varSlice,
              });
              resolvedFields.push({ kind: "expr", slot: exprSlot });
            }
          }
          prog.securityTupleCallSlots.set(expr, { slot, fields: resolvedFields, gaps, lookahead });
          prog.taScratchSize = Math.max(prog.taScratchSize, tupleFields.length);
          analyzeExpr(symbolArg, prog, scope, false);
          // C366: tf 인자도 bare 경로(공유 꼬리 재귀가 전 인자 분석)와 동일하게 부작용 분석한다 —
          // Identifier tf 변수의 선언-전-사용 검출이 목적(리터럴/DotAccess는 무해한 no-op 수준).
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (exprMatch !== null) {
          // 빌드된 클론 ta.* 콜 전부(C367: 0~N개)를 정식 등록(인자 개수/조건부 위치/length series
          // 검사 + taSlots 슬롯 배정 — 메인 타임프레임의 다른 ta.* 콜과 동일한 전역 taSlotCount
          // 풀에서 배정, 클론 노드라 물리적으로 절대 겹치지 않는다, 3a 설계 메모 "슬롯 오프셋"
          // 참조). 아래에서 즉시 return하는 이유: 이 분기를 안 타면 함수 맨 끝의 부작용 재귀
          // (`for (const arg of expr.args) analyzeExpr(...)`)가 seriesArg 서브트리를 일반
          // analyzeCallExpr 경로로 한 번 더 분석해 상태 슬롯이 이중 소비된다(MEMORY.md C180) —
          // symbol(args[0])만 그 재귀가 하던 것과 동일하게 별도로 분석해 기존 bare 경로와의
          // 부작용 동등성(미선언 식별자 검출 등)을 유지한다. bodyExpr는 빌드된 트리(치환/클론 반영).
          if (tfSiteValues !== null) {
            // C529: 콜사이트별 tf 블록 — ta 콜 0개면 bodyExpr/histReads가 콜사이트 무관·무상태라
            // 같은 빌드 결과를 N개 프리패스 스펙이 공유한다(방출은 슬롯별 독립 함수,
            // generateSecurityExprPreamble이 secCtx를 스펙마다 새로 만들어 안전). ta 콜 포함이면
            // (C533) 같은 클론을 N개 프리패스가 서로 다른 HTF 캐시 위에서 재실행해 incremental
            // 상태가 오염되므로 사이트마다 buildSecurityExpr를 다시 돌려 독립 클론+전역 슬롯
            // (taCloneRegScope)을 배정한다 — exprMatch 자신의 클론은 미등록 폐기(노드-키 맵은
            // 클론별 분리라 부작용 없음). 읽기는 C453과 완전히 동일한 securityParamExprCalls
            // (`base + __secIdx`) 경로라 codegen 변경 0줄. C600: 혼합 배열이면 pushSiteTf가 사이트
            // 슬롯별로 리터럴/런타임을 갈라 push한다(프리패스는 rebuild 이후 최종 캐시 위에서 돈다).
            const base = prog.securityTfs.length;
            for (const v of tfSiteValues) {
              const slot = prog.securityTfs.length;
              pushSiteTf(v);
              // 동일 입력 재빌드라 실패 불가(exprMatch가 이미 성공한 결정적 함수 재호출) — C533.
              let siteBuilt: SecurityExprBuild = exprMatch;
              if (exprMatch.taCalls.length > 0) {
                siteBuilt = buildSecurityExpr(seriesArg, prog, expr.line, scope.func?.name ?? null, symbolArg, tfArg)!;
                for (const tc of siteBuilt.taCalls) analyzeStatefulCall(tc.taCall, tc.fn, tc.entry, prog, taCloneRegScope);
              }
              prog.securityParamExprPrepasses.push({
                slot,
                gaps,
                lookahead,
                bodyExpr: siteBuilt.bodyExpr,
                histReads: siteBuilt.histReads,
                varSlice: siteBuilt.varSlice,
              });
            }
            prog.securityParamExprCalls.set(expr, { base, gaps, lookahead });
            registerSecurityTfSiteOrdinals(prog, scope.func!);
          } else {
            for (const tc of exprMatch.taCalls) analyzeStatefulCall(tc.taCall, tc.fn, tc.entry, prog, taCloneRegScope);
            const slot = prog.securityTfs.length;
            // 배치31 (b)-1, C599: 런타임 tf면 자리표시(chartTf) + securityRuntimeTfSlots 등록(bare
            // series C597 분기와 동일 메커니즘). codegen 프리앰블이 rebuildSecurityCache를
            // generateSecurityExprPreamble(__secExprN 프리패스)보다 먼저 방출하므로(codegen.ts
            // 주석 참조) 프리패스는 항상 최종 캐시 위에서 돈다 — ta 클론 슬롯은 고정 tf와 동일하게
            // ctx당 1회 프리패스 실행이라 incremental 상태 오염 축이 없다.
            prog.securityTfs.push(tfLiteral ?? prog.chartTf);
            if (tfRuntimeExpr !== null && tfLiteral === undefined) prog.securityRuntimeTfSlots.set(slot, tfRuntimeExpr);
            prog.securityExprCallSlots.set(expr, {
              slot,
              gaps,
              lookahead,
              bodyExpr: exprMatch.bodyExpr,
              histReads: exprMatch.histReads,
              varSlice: exprMatch.varSlice,
            });
          }
          analyzeExpr(symbolArg, prog, scope, false);
          // C366: 위 튜플 경로와 동일 — tf 인자 부작용 분석(선언-전-사용 검출) 대칭 유지.
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (bareUdfInner !== undefined) {
          // C432: securityBareUdfCallSlots 주석 참조 — HTF 슬롯/프리패스를 전혀 만들지 않는다.
          // symbol/tf(및 gaps/lookahead, 위에서 이미 파싱/검증됨)는 pine2py 오라클과 동일하게
          // 계산에서 완전히 discard되고, UDF 콜만 request.security 없이 그 자리에서 직접 호출된
          // 것과 동일하게 일반 analyzeExpr 경로(funcCallSlots/콜그래프 등록 전부 포함, 다른 위치의
          // 평범한 UDF 콜과 완전히 동일한 처리)로 분석한다. symbol/tf도 선언-전-사용 검출을 위해
          // analyzeExpr(무해한 부작용만, 값은 버려짐)로 분석(exprMatch/tupleFields 분기와 동일 원칙).
          analyzeExpr(bareUdfInner, prog, scope, false);
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (bareTaInner !== undefined) {
          // C433: securityBareTaCallSlots 주석 참조 — HTF 슬롯/프리패스를 전혀 만들지 않는다.
          // symbol/tf(및 gaps/lookahead, 위에서 이미 파싱/검증됨)는 pine2py 오라클과 동일하게
          // 계산에서 완전히 discard되고, 다중 반환 ta.* 콜만 request.security 없이 그 자리에서
          // 직접 호출된 것과 동일하게 표준 analyzeExpr 경로(ta dispatch, tupleStateCalls에 이미
          // 등록돼 있어 analyzeStatefulCall로 곧장 감 — 다른 위치의 평범한 `[m,s,h]=ta.macd(...)`
          // 튜플 디스트럭처와 완전히 동일한 처리)로 분석한다. bareUdfInner 분기와 동형.
          analyzeExpr(bareTaInner, prog, scope, false);
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (scalarBareUdfInner !== undefined) {
          // C436/C442: securityScalarBareUdfCallSlots 주석 참조 — HTF 슬롯/프리패스를 전혀 만들지
          // 않는다. bareUdfInner(C432)의 스칼라 자매 축 — symbol/tf(및 gaps/lookahead, 위에서 이미
          // 파싱/검증됨)는 pine2py 오라클과 동일하게 계산에서 완전히 discard된다. 직접 UDF 콜
          // 폼이면(scalarBareUdfInner===seriesArg가 CallExpr) request.security 없이 그 자리에서
          // 직접 호출된 것과 동일하게 일반 analyzeExpr 경로(funcCallSlots/콜그래프 등록 전부
          // 포함)로 분석 — var-subst 폼이면(scalarBareUdfInner가 Identifier) 그 변수는 이미 자신의
          // top-level 대입문에서 분석이 끝나 있어 여기 analyzeExpr는 순수 선언-전-사용 확인용
          // 부작용뿐(symbolArg/tfArg와 동일 원칙).
          prog.securityScalarBareUdfCallSlots.set(expr, scalarBareUdfInner);
          analyzeExpr(scalarBareUdfInner, prog, scope, false);
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (secParamAllBareUdf !== null) {
          // C563: 전 콜사이트 bare UDF 콜 — 값은 매개변수 자신으로 균일 붕괴(위 후보 판정 주석
          // 참조). 최종 확정(피호출 UDF tupleArity 검사)은 pending 처리로 지연하되, passthrough
          // 읽기 채널(매개변수 읽기 — indexWrap 폼이면 매개변수 히스토리 IndexAccess)은 지금 이
          // 스코프에서 정식 분석해 둔다 — pending 처리 시점엔 함수 스코프 체인이 소멸해 분석
          // 불가하고, 확정 실패 시 에러로 끝나는 파일이라 선분석 부작용은 무해하다. symbol/tf는
          // C436과 동일하게 계산에서 discard(부작용 분석만) 후 즉시 return(공유 꼬리 재귀의 이중
          // 분석 방지 — MEMORY C180).
          prog.securityParamExprPending.push({
            expr,
            funcName: scope.func!.name,
            paramIdx: secParamAllBareUdf.paramIdx,
            paramName: secParamAllBareUdf.paramName,
            indexWrap: null,
            paramSubstRoot: null,
            passthroughSeriesArg: seriesArg,
            tfLiteral: tfSiteValues ?? tfLiteral!,
            gaps,
            lookahead,
          });
          analyzeExpr(seriesArg, prog, scope, false);
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (secParamMultiSite !== null) {
          // C453: udf-param 다중 콜사이트 — 콜사이트 실인자 빌드/슬롯 배정은 메인 루프 종료 후
          // (processPendingSecurityParamExprs — 뒤에 오는 콜사이트 인자의 top-level 이름이 아직
          // 미등록일 수 있음). symbol/tf는 다른 분기와 동일하게 여기서 부작용 분석(선언-전-사용
          // 검출)하고 즉시 return(공유 꼬리 재귀의 이중 분석 방지 — MEMORY C180).
          prog.securityParamExprPending.push({
            expr,
            funcName: scope.func!.name,
            paramIdx: secParamMultiSite.paramIdx,
            paramName: secParamMultiSite.paramName,
            // C534: seriesArg가 `paramName[index]` 래핑이었으면 콜사이트별 합성 시 index를 그대로
            // 재사용(위 secParamMultiSite 판정 주석 참조) — bare 매개변수면 null(기존 동작 그대로).
            indexWrap: secParamMultiSite.indexWrap,
            paramSubstRoot: null,
            passthroughSeriesArg: null,
            // C529: tf도 이 UDF의 매개변수면 콜사이트별 배열(같은 funcAllCallSites 순서라
            // 큐 처리의 서수와 1:1) — 고정 리터럴이면 기존 그대로 string 하나. C600: 배열 원소가
            // 런타임 tf 트리(Expr)면 큐 처리가 그 서수 슬롯을 securityRuntimeTfSlots에 등록한다.
            tfLiteral: tfSiteValues ?? tfLiteral!,
            gaps,
            lookahead,
          });
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        } else if (secParamMultiSiteGeneric !== null) {
          // C542: 위 secParamMultiSite와 동일 지연 이유(선언-후-사용) — 콜사이트별 실인자 치환은
          // paramSubstRoot(seriesArg 원본)를 processPendingSecurityParamExprs가 buildSecurityExprNode의
          // paramEnv 메커니즘(C516)으로 재귀 빌드한다.
          prog.securityParamExprPending.push({
            expr,
            funcName: scope.func!.name,
            paramIdx: -1,
            paramName: "",
            indexWrap: null,
            paramSubstRoot: secParamMultiSiteGeneric,
            passthroughSeriesArg: null,
            tfLiteral: tfSiteValues ?? tfLiteral!,
            gaps,
            lookahead,
          });
          analyzeExpr(symbolArg, prog, scope, false);
          analyzeExpr(tfArg, prog, scope, false);
          return;
        }
      }
      }
    }
  } else if (resolveScalarMethodInfo(method, prog, 1 + expr.args.length + expr.kwargs.length).length > 0) {
    // 사용자 선언 스칼라(float/int/bool/string/color) receiver extension method(C328, wild 실측
    // 38건, `(high - low).normalize()`/`bullCss.tosolid()`/`longEntryMessage.tags()`류) — 위의
    // 모든 namespace 빌트인/컨테이너/UDT 분기가 전부 안 맞았을 때만 여기로 떨어지는 최종 폴백이다.
    // resolveContainerExprKind/resolveMatrixExprKind 같은 "수신자 종류 판별" 인프라가 스칼라엔
    // 없어(스칼라 var/식은 값 흐름 추적 없이 어떤 타입인지 알 수 없음) receiver(callee.obj)의 정적
    // 타입을 판별하지 않는다 — 대신 method 이름 하나로 5종 스칼라 base를 전부 순회해 매칭되는
    // 선언을 찾는다(resolveScalarMethodInfo). namespace가 null(괄호 산술식/리터럴 receiver, 예:
    // `(5.0).n()`)이든 임의의 식별자(namespace가 그냥 평범한 변수 이름)든 이 시점엔 이미 앞선 모든
    // 특정 namespace 분기가 소비하지 못했다는 뜻이라 별도 게이트가 필요 없다.
    const matches = resolveScalarMethodInfo(method, prog, 1 + expr.args.length + expr.kwargs.length);
    if (matches.length > 1) {
      // 서로 다른 스칼라 타입에 동명 method가 선언된 TV 컴파일타임 오버로드(wild 실측 2개 파일,
      // `method f(float/int/bool/string)`류) — receiver의 정확한 타입을 값 흐름 추적 없이는 알 수
      // 없어 조용한 오답 대신 명시적으로 거부한다(C327 컨테이너 다중 오버로드 정책과 동일 원칙).
      prog.errors.push(
        `'${method}' scalar receiver extension method is declared for multiple types (${matches.map((m) => m.base).join("/")}) — cannot determine which one at the call site (value-flow type tracking not supported) (L${expr.line}:${expr.col})`,
      );
    } else {
      dispatchUdtMethodCall(expr, matches[0]!.base, method, matches[0]!.info, prog, scope);
    }
  } else {
    prog.errors.push(`unsupported call: '${namespace ?? "?"}.${method}' (L${expr.line}:${expr.col})`);
  }
  if (callee.obj.kind !== "Identifier") {
    analyzeExpr(callee.obj, prog, scope, false);
  } else {
    // C728: Identifier receiver는 위 어느 분기가 처리했든(array/map/matrix/UDT method-sugar 등)
    // analyzeExpr을 안 타므로(위 skip) 중첩 top-level var(depth>0) 읽기가 codegen 시점에 슬롯을
    // 못 찾는 사각지대였다(genExpr Identifier case의 nestedVarReadSlots 조회가 비어 "알 수 없는
    // 식별자" internal 크래시 -- wild `if a\n var line[] lines=...\n...\nif b\n var line[]
    // lines=...\n...lines.push(...)`류, 서로소 형제 var가 이름을 공유해도 각 receiver는 자신의
    // 선언 스코프 자손에서만 등장하므로 이 단일 지점에서 한 번만 확정해도 무모호). analyzer.ts
    // resolveAmbiguousNestedVarDeclStmt/nestedVarReadSlots 주석 참조. C729(배치37(2) 2차 슬라이스):
    // var보다 가까운 '=' 섀도가 있으면(eqLocalShadowedVarReads 주석 참조) 그쪽으로 표시한다.
    const nestedKind = resolveNestedVarOrEqLocalKind(scope, callee.obj.name);
    if (nestedKind?.kind === "var") {
      prog.nestedVarReadSlots.set(callee.obj, prog.nestedVarDeclSlots.get(nestedKind.decl)!);
    } else if (nestedKind?.kind === "eq-local" && prog.varIndex.has(callee.obj.name)) {
      prog.eqLocalShadowedVarReads.add(callee.obj);
    }
  }
  for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);
}

// obj.method(args) 형태로 확정된 사용자 선언 method 호출의 공통 디스패치(C327) — receiver가
// UDT 인스턴스든(기존) array<T>/map<K,V>/matrix<T> 컨테이너(신규, typeName은
// resolveMethodReceiverTypeName이 접어준 base)든 동일한 로직: 콜그래프 간선 기록 + 인자 개수
// 검증(첫 매개변수는 receiver라 -1) + udtMethodCallTypes 등록(codegen이 이 맵 하나로 두 경우를
// 구분 없이 동일하게 처리, genExpr(callee.obj)가 receiver를 그대로 첫 인자로 방출) +
// funcCallSlots/funcTaBases 배정. analyzeUserFuncCall과 갈라진 이유는 receiver가 expr.args에
// 없어(callee.obj가 별도) 인자 개수 오프셋(-1)과 에러 메시지 형식('${typeName}.${method}')이
// 다르기 때문 — forward-reference 지연 배정(pendingFuncCallSlots)은 method가 prepass 대상이
// 아니라 항상 bodyAnalyzed=true라(analyzeMethodDecl 참조) 적용되지 않는다.
function dispatchUdtMethodCall(
  expr: CallExpr,
  typeName: string,
  method: string,
  methodInfo: FuncInfo,
  prog: AnalyzedProgram,
  scope: LexScope,
): void {
  if (scope.func !== null) {
    scope.func.calls.add(methodInfo.name);
  }
  const minArgs = methodInfo.requiredParamCount - 1;
  const maxArgs = methodInfo.paramNames.length - 1;
  if (expr.kwargs.length === 0) {
    // 순수 위치 호출 — 기존 그대로(메시지 문자열 보존, 기존 테스트 무수정 원칙).
    if (expr.args.length < minArgs || expr.args.length > maxArgs) {
      prog.errors.push(
        `'${typeName}.${method}' call argument count mismatch: requires ${minArgs}~${maxArgs}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
  } else {
    // C408: 키워드 인자 — receiver(paramNames[0])는 callee.obj로 이미 고정돼 expr.args/kwargs
    // 어느 쪽에도 나타나지 않으므로, 나머지 매개변수(paramNames[1..], "args 공간"에서는 인덱스가
    // 그대로 -1 오프셋)만 위치/키워드 뒤섞기 대상 — analyzeUserFuncCall(C396)과 완전히 동일한
    // 원리, 오프셋만 다르다. kwarg 값 자체는 이 함수 호출 전 공유 kwargs 루프(line ~1242)가 이미
    // analyzeExpr 완료.
    if (expr.args.length > maxArgs) {
      prog.errors.push(
        `'${typeName}.${method}' call argument count mismatch: at most ${maxArgs} positional arguments, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const paramIndex = new Map(methodInfo.paramNames.slice(1).map((name, i) => [name, i]));
    const seenKwargNames = new Set<string>();
    for (const kw of expr.kwargs) {
      const idx = paramIndex.get(kw.name);
      if (idx === undefined) {
        prog.errors.push(`unknown parameter name for '${typeName}.${method}': '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (seenKwargNames.has(kw.name)) {
        prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
        prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
      }
      seenKwargNames.add(kw.name);
    }
    // 기본값 없는 매개변수(receiver 제외 minArgs 범위 안, C565부터 선두 제약 없음)는 위치든
    // 키워드든 반드시 하나는 있어야 한다.
    for (let i = 0; i < minArgs; i++) {
      if (methodInfo.paramHasDefault[i + 1]) continue;
      if (i >= expr.args.length && !seenKwargNames.has(methodInfo.paramNames[i + 1]!)) {
        prog.errors.push(
          `'${typeName}.${method}' call is missing required parameter '${methodInfo.paramNames[i + 1]}' (L${expr.line}:${expr.col})`,
        );
      }
    }
  }
  prog.udtMethodCallTypes.set(expr, typeName);
  if (methodInfo.localVarSlots.length > 0) {
    prog.funcCallSlots.set(expr, prog.fnVarSlotCount);
    prog.fnVarSlotCount += methodInfo.localVarSlots.length;
  } else {
    prog.funcCallSlots.set(expr, 0);
  }
  if (methodInfo.localTaSlotCount > 0) {
    prog.funcTaBases.set(expr, prog.taSlotCount);
    prog.taSlotCount += methodInfo.localTaSlotCount;
  }
  allocateFuncHistSlots(expr, methodInfo, prog);
}

// UDF 호출: 인자 개수 검증 + (그 함수에 var/varip가 있으면) 이 콜사이트 전용 $.fnVars 슬롯
// 베이스를 새로 할당한다. 같은 함수를 부르는 서로 다른 콜사이트는 서로 다른 슬롯 베이스를 받으므로
// 함수 내부 var 상태가 콜사이트별로 완전히 독립된다(GOAL.md "slotBase/callSiteId 전파" —
// pine2py는 이름 문자열 하나로 모든 콜사이트가 공유해 버그가 있었음, MEMORY.md 참조).
// UDF 안에서 다른 UDF를 호출하는 것(중첩 콜)도 동일한 콜사이트별(AST 노드 키) 슬롯 배정으로 그대로
// 성립한다(C267[part2]) — slotBase는 "이 CallExpr이 소스 어디에 있는가"만으로 정해지는 컴파일타임
// 상수라 바깥 함수가 몇 번/어디서 호출되든 무관하게 독립적이다("중첩 전파" 합성이 필요하다는 이전
// 가정은 재검증 결과 틀렸음 — 스코프 체인이 아니라 AST 노드 자체가 키이므로 중첩 깊이와 무관).
// 단 재귀(직접 자기호출 + 상호 호출 사이클)는 정적 call-site 하나가 무한히 재사용돼야 해서 이
// 모델이 성립하지 않고, TV v5도 재귀 UDF를 지원하지 않으므로(pine2py는 재귀를 막지 않지만
// var 상태 자체가 이름 문자열 하나로 전역 공유돼 있어 재귀의 올바른 상태 시맨틱을 오라클로 검증할
// 수 없음, MEMORY.md C9) 콜그래프 사이클만 detectRecursiveFuncCalls(analyze() 메인 루프 종료 후)가
// 별도로 거부한다 — 여기서는 콜그래프 간선만 기록한다.
function analyzeUserFuncCall(expr: CallExpr, func: FuncInfo, prog: AnalyzedProgram, scope: LexScope): void {
  if (scope.func !== null) {
    scope.func.calls.add(func.name);
  }
  if (expr.kwargs.length === 0) {
    // 순수 위치 호출 — 기존 그대로(메시지 문자열 보존, 기존 테스트 무수정 원칙).
    if (expr.args.length < func.requiredParamCount || expr.args.length > func.paramNames.length) {
      prog.errors.push(
        `'${func.name}' call argument count mismatch: requires ${func.requiredParamCount}~${func.paramNames.length}, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
  } else {
    // C396: 키워드 인자 — 위치 인자는 매개변수 선언 순서대로 앞에서부터 채우고, 나머지는 이름으로
    // 지정(위치/키워드 뒤섞기 허용, UDT `.new()` C129와 동일 원칙 — TV v5는 UDF 호출도 named
    // argument를 지원하는 진짜 문법). kwarg 값 자체는 이 함수 호출 전 공유 kwargs 루프(라인 ~1106)가
    // 이미 analyzeExpr해뒀다.
    if (expr.args.length > func.paramNames.length) {
      prog.errors.push(
        `'${func.name}' call argument count mismatch: at most ${func.paramNames.length} positional arguments, got ${expr.args.length} (L${expr.line}:${expr.col})`,
      );
    }
    const paramIndex = new Map(func.paramNames.map((name, i) => [name, i]));
    const seenKwargNames = new Set<string>();
    for (const kw of expr.kwargs) {
      const idx = paramIndex.get(kw.name);
      if (idx === undefined) {
        prog.errors.push(`unknown parameter name for '${func.name}': '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (seenKwargNames.has(kw.name)) {
        prog.errors.push(`duplicate keyword argument '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (idx < expr.args.length && !isHarmlessArgDup(expr.args[idx], kw.value)) {
        prog.errors.push(`argument '${kw.name}' specified both positionally and as a keyword (L${kw.line}:${kw.col})`);
      }
      seenKwargNames.add(kw.name);
    }
    // 기본값 없는 매개변수(requiredParamCount 범위 안, C565부터 선두 제약 없음 — paramHasDefault로
    // 인덱스별 실제 필수 여부 판별)는 위치든 키워드든 반드시 하나는 있어야 한다.
    for (let i = 0; i < func.requiredParamCount; i++) {
      if (func.paramHasDefault[i]) continue;
      if (i >= expr.args.length && !seenKwargNames.has(func.paramNames[i]!)) {
        prog.errors.push(
          `'${func.name}' call is missing required parameter '${func.paramNames[i]}' (L${expr.line}:${expr.col})`,
        );
      }
    }
  }
  for (const arg of expr.args) analyzeExpr(arg, prog, scope, false);

  // C255: forward-reference 콜사이트(callee가 아직 본문 분석 전 — registerFuncSignature prepass가
  // 시그니처만 등록한 상태)는 localVarSlots.length/localTaSlotCount를 아직 몰라 슬롯 배정을
  // 지금 할 수 없다 — analyze() 메인 루프가 끝난 뒤(모든 top-level FuncDecl 본문이 분석 완료된
  // 시점) resolvePendingFuncCallSlots가 이 목록을 일괄 처리한다. 일반 콜(callee가 이미 본문까지
  // 분석된 경우, 압도적 다수)은 기존과 동일하게 여기서 즉시 배정한다.
  if (func.bodyAnalyzed) {
    allocateFuncCallSlots(expr, func, prog);
  } else {
    prog.pendingFuncCallSlots.push({ expr, func });
  }
}

function allocateFuncCallSlots(expr: CallExpr, func: FuncInfo, prog: AnalyzedProgram): void {
  if (func.localVarSlots.length > 0) {
    prog.funcCallSlots.set(expr, prog.fnVarSlotCount);
    prog.fnVarSlotCount += func.localVarSlots.length;
  } else {
    prog.funcCallSlots.set(expr, 0); // var 없는 함수 — slotBase는 codegen에서 참조되지 않음
  }
  if (func.localTaSlotCount > 0) {
    // 함수 본문에 stateful 콜(C162)이 있으면 이 콜사이트 전용 $.taSlots 베이스를 새로 할당한다 —
    // 위 fnVars slotBase와 동형인 ta 버전(GOAL.md "UDF의 var/TA 상태는 call-site별 독립"의 TA
    // 절반). localTaSlotCount === 0이면 등록하지 않아 함수 시그니처/콜사이트 출력이 기존과 한
    // 글자도 달라지지 않는다(genFuncDecl/genCallExpr의 __taBase 조건부 방출과 짝).
    prog.funcTaBases.set(expr, prog.taSlotCount);
    prog.taSlotCount += func.localTaSlotCount;
  }
  allocateFuncHistSlots(expr, func, prog);
}

// UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스): 함수 본문에
// 히스토리 인덱싱된 함수-내부 이름(FuncInfo.localHistSlots)이 있으면 이 콜사이트 전용 $.histSlots
// 베이스를 새로 할당한다 — funcTaBases(__taBase)와 정확히 동형인 hist 버전. localHistSlotCount===0
// 이면 등록하지 않아 함수 시그니처/콜사이트 출력이 기존과 한 글자도 달라지지 않는다
// (genFuncDecl/genCallExpr의 __histBase 조건부 방출과 짝). 함수-내부 var(localHistKinds "var")는
// 함수 본문이 아니라 top-level 바 종료 record 루프가 $.fnVars를 직접 읽어 기록하므로(FuncInfo.
// localHistKinds 주석 참조) 콜사이트별 절대 인덱스 쌍을 여기서 미리 계산해 쌓는다 — slotBase가
// 이 함수 직전에 같은 함수 기준으로 배정돼(funcCallSlots) 항상 존재한다.
function allocateFuncHistSlots(expr: CallExpr, func: FuncInfo, prog: AnalyzedProgram): void {
  if (func.localHistSlotCount > 0) {
    const histBase = prog.historySlotCount;
    prog.funcHistBases.set(expr, histBase);
    prog.historySlotCount += func.localHistSlotCount;
    const slotBase = prog.funcCallSlots.get(expr) ?? 0;
    for (const [name, relIdx] of func.localHistSlots) {
      if (func.localHistKinds.get(name) !== "var") continue;
      const varSlot = func.localVarIndex.get(name);
      if (varSlot === undefined) continue; // 발생 불가(localHistKinds "var"는 localVarIndex 등록 이름만)
      prog.funcHistVarRecords.push({ histIdx: histBase + relIdx, fnVarIdx: slotBase + varSlot });
    }
  }
  // UDF 본문 조건부 위치 stateful 콜 압축 히스토리 판(C672, FuncInfo.localCondCallHistSlots 주석
  // 참조) — 위와 동형이나 베이스가 condCallHistorySlotCount($.condCallHistSlots 물리 배열, C671)
  // 이고 var-kind 바 종료 record 목록이 없다(콜 자신이 유일한 값 발생원 — 항상 콜 위치 인라인
  // push, codegen genIndexAccess 참조). localCondHistSlotCount===0이면 등록하지 않아 함수
  // 시그니처/콜사이트 출력이 기존과 한 글자도 달라지지 않는다(genBaseParams `__condHistBase`와 짝).
  if (func.localCondHistSlotCount > 0) {
    prog.funcCondHistBases.set(expr, prog.condCallHistorySlotCount);
    prog.condCallHistorySlotCount += func.localCondHistSlotCount;
  }
  // UDF 본문 조건부 위치 drawing 생성자 콜 압축 히스토리 판(C701, FuncInfo.localCondCallRefHistSlots
  // 주석 참조) — 위 numeric 판과 완전히 동형이나 베이스가 condCallRefHistorySlotCount($.condCallRefHistSlots
  // 물리 배열, C700)다. localCondRefHistSlotCount===0이면 등록하지 않아 함수 시그니처/콜사이트 출력이
  // 기존과 한 글자도 달라지지 않는다(genBaseParams `__condRefHistBase`와 짝).
  if (func.localCondRefHistSlotCount > 0) {
    prog.funcCondRefHistBases.set(expr, prog.condCallRefHistorySlotCount);
    prog.condCallRefHistorySlotCount += func.localCondRefHistSlotCount;
  }
  // drawing 핸들 판(C541, FuncInfo.localRefHistSlots 주석 참조) — 위와 완전히 동형이나 베이스가
  // refHistorySlotCount(별도 카운터, $.refHistSlots 물리 배열)이고 var-kind 바 종료 record 목록도
  // funcRefHistVarRecords로 분리된다(codegen generateCode의 record 루프/`__refHistBase` 인자와 짝).
  if (func.localRefHistSlotCount > 0) {
    const refHistBase = prog.refHistorySlotCount;
    prog.funcRefHistBases.set(expr, refHistBase);
    prog.refHistorySlotCount += func.localRefHistSlotCount;
    const slotBase = prog.funcCallSlots.get(expr) ?? 0;
    for (const [name, relIdx] of func.localRefHistSlots) {
      if (func.localRefHistKinds.get(name) !== "var") continue;
      const varSlot = func.localVarIndex.get(name);
      if (varSlot === undefined) continue; // 발생 불가(localRefHistKinds "var"는 localVarIndex 등록 이름만)
      prog.funcRefHistVarRecords.push({ refHistIdx: refHistBase + relIdx, fnVarIdx: slotBase + varSlot });
    }
  }
}

// analyzer.ts analyze()가 메인 루프(모든 top-level 문장 analyzeStmt) 종료 직후 호출한다 — 그
// 시점엔 모든 top-level FuncDecl의 bodyAnalyzed가 true라 pendingFuncCallSlots에 쌓인 forward-ref
// 콜사이트도 안전하게 즉시 배정과 동일한 로직으로 슬롯을 받을 수 있다.
export function resolvePendingFuncCallSlots(prog: AnalyzedProgram): void {
  for (const { expr, func } of prog.pendingFuncCallSlots) {
    allocateFuncCallSlots(expr, func, prog);
  }
}

// C453: udf-param 다중 콜사이트 security expression 지연 처리(AnalyzedProgram.
// securityParamExprPending 주석 참조) — analyze() 메인 루프 종료 후 호출된다. 콜사이트마다 그
// 위치의 실인자를 좁은 문법으로 빌드해 연속 슬롯 블록(base + 서수)을 배정하고, body의
// request.security 노드는 securityParamExprCalls(base), 각 콜사이트는 funcSecIdxArgs(서수)에
// 등록한다. 하나라도 빌드에 실패하면 전체를 기존 generic 에러로 거부(부분 지원 시 미지원
// 콜사이트 경유 호출이 __secIdx 없이 들어와 조용한 오답 — 후보 판정과 동일 원칙).
// rootScope: ta 클론 등록용 top-level 스코프 — 프리패스는 top-level 함수로 방출되므로 클론
// 슬롯은 전역 taSlotCount 풀이어야 한다(함수-상대 __taBase 참조가 프리패스에 남으면
// ReferenceError — C367 exprHasTaInUdf가 막아온 바로 그 문제. 치환 인자는 전원 top-level
// 콜사이트에서 왔으므로 top-level 등록이 시맨틱상으로도 정확하다: TV의 "expression은 요청 tf
// 문맥에서 재평가"가 콜사이트별 독립 클론 + HTF 프리패스 재실행으로 재현된다).
// C563: 배치26 (1)(a) — request.security expression 인자가 UDF 매개변수(다중 콜사이트)일 때, 한
// 콜사이트의 실인자가 "bare(단일 반환) UDF 콜"에 도달하는지 판별하는 치환 리졸버.
// resolveSecurityScalarBareUdfSrc(C436/C442 인라인 경로)와 동일 원리의 콜사이트판 — top-level '='
// 유일 변수(uniqueTopEqVars) 체인만 따라가되, 선언-후-사용은 콜사이트 자신의 line 기준(C539 tf
// 리졸버와 동일 방향), in-func 콜사이트(siteFuncName !== null)는 그 함수 매개변수 섀도잉(C526
// constVarShadowFuncs)에 걸리면 치환을 멈춘다(함수-로컬 '=' 섀도잉은 prescanConstVars가 그 이름을
// uniqueTopEqVars에 애초에 안 올려 원천 불가 — resolveSecurityTfParamSiteLiterals C539 주석과 동일).
// 치환 한 단계를 지나면 cursor는 top-level '=' 값이라 함수 스코프가 리셋된다(cursorFuncName=null).
function resolveSecuritySiteArgBareUdfRoot(
  argExpr: Expr,
  siteFuncName: string | null,
  siteLine: number,
  prog: AnalyzedProgram,
): Expr {
  let cursor = argExpr;
  let cursorFuncName = siteFuncName;
  const visiting = new Set<string>();
  while (
    cursor.kind === "Identifier" &&
    !BAR_SERIES_NAMES.has(cursor.name) &&
    !DERIVED_PRICE_NAMES.has(cursor.name) &&
    !visiting.has(cursor.name)
  ) {
    if (cursorFuncName !== null && prog.constVarShadowFuncs.get(cursor.name)?.has(cursorFuncName)) break;
    const substDef = prog.uniqueTopEqVars.get(cursor.name);
    if (substDef === undefined || substDef.line >= siteLine) break;
    visiting.add(cursor.name);
    cursor = substDef.value;
    cursorFuncName = null;
  }
  return cursor;
}

export function processPendingSecurityParamExprs(prog: AnalyzedProgram, rootScope: LexScope): void {
  for (const pending of prog.securityParamExprPending) {
    const info = prog.funcs.get(pending.funcName);
    const sites = prog.funcAllCallSites.get(pending.funcName) ?? [];
    if (pending.passthroughSeriesArg !== null) {
      // C563: 전 콜사이트 bare UDF 콜 passthrough 균일 붕괴 — HTF 슬롯/프리패스/__secIdx 없이
      // request.security 노드를 C436 채널(securityScalarBareUdfCallSlots)로 등록만 한다(codegen이
      // 그 자리에서 매개변수 읽기를 그대로 방출 — 값 채널 분석은 등록 시점에 이미 완료). 여기서
      // 피호출 UDF의 tupleArity===null(단일 반환)을 최종 확정 — 등록 시점(본문 분석 중)엔 함수
      // 뒤에 선언된 UDF의 tupleArity가 잠정 null이라 확정 불가했던 검사다(bodyAnalyzed는 이
      // 시점엔 top-level FuncDecl 전체가 분석 완료라 정상 파일에서 항상 참). 실패 시 기존과
      // 동일한 좁은문법 에러(pushSecurityExprUnsupportedError 메시지 공유 원칙).
      const ok =
        info !== undefined &&
        sites.length >= 2 &&
        sites.every((site) => {
          const argExpr =
            site.call.args[pending.paramIdx] ?? site.call.kwargs.find((kw) => kw.name === pending.paramName)?.value;
          if (argExpr === undefined) return false;
          const root = resolveSecuritySiteArgBareUdfRoot(argExpr, site.inFuncName, site.call.line, prog);
          if (root.kind !== "CallExpr" || root.callee.kind !== "Identifier") return false;
          const calleeInfo = prog.funcs.get(root.callee.name);
          return calleeInfo !== undefined && calleeInfo.bodyAnalyzed && calleeInfo.tupleArity === null;
        });
      if (!ok) {
        pushSecurityExprUnsupportedError(prog, pending.expr);
        continue;
      }
      prog.securityScalarBareUdfCallSlots.set(pending.expr, pending.passthroughSeriesArg);
      continue;
    }
    // C731: 단일 in-func 콜사이트 pending(등록 게이트가 새로 연 축)도 처리 — sites.length >= 1.
    let builds: SecurityExprBuild[] | null = info !== undefined && sites.length >= 1 ? [] : null;
    // C616(chained-security-var): 이 pending.expr 자신(멀티 콜사이트 request.security)의 symbol/tf —
    // 아래 두 buildSecurityExprNode 호출에 outerSymbol/outerTf로 그대로 물려준다(무음 버전 사용:
    // pending 등록 자체가 이미 이 콜의 leadArgs가 유효했음을 전제하므로 실패해도 조용히 null).
    const pendingLead = tryResolveSecurityLeadArgsQuiet(pending.expr);
    if (builds !== null) {
      for (const site of sites) {
        // C731: in-func 콜사이트 허용(기존엔 여기서 무조건 거부). indexWrap 폼만 보수 가드 —
        // index 서브트리는 pending 함수 본문 스코프에 살지만 아래 합성 IndexAccess 빌드는 실인자
        // 스코프(site.inFuncName)로 걷는다. index에 스코프 민감 bare Identifier가 하나라도 있으면
        // 두 스코프의 이름 해석이 갈릴 수 있어 거부(wild 실측 이 관용구의 index는 전부 리터럴/
        // barstate 삼항 — 식별자 없음. top-level 콜사이트는 기존 funcName=null 빌드와 동작 동일).
        if (site.inFuncName !== null && pending.indexWrap !== null) {
          const idxIdents = new Set<string>();
          collectSecurityScopeSensitiveIdents(pending.indexWrap.index, idxIdents);
          if (idxIdents.size > 0) {
            builds = null;
            break;
          }
        }
        const taCalls: SecurityExprTaCallRef[] = [];
        const histReads: SecurityExprHistRead[] = [];
        let bodyExpr: Expr | null;
        if (pending.paramSubstRoot !== null) {
          // C542: seriesArg 원본(paramSubstRoot)이 매개변수(들)를 서브트리 어딘가에 참조 —
          // buildSecurityExprNode의 paramEnv 메커니즘(C516 UDF 인라인과 동일 경로)에 이 콜사이트의
          // 전 매개변수 -> 실인자 맵을 먹여 재귀 빌드한다(단일 매개변수 secParamMultiSite와 달리
          // "치환 대상 서브트리"를 미리 떼어내지 않고 seriesArg 전체를 그대로 재사용).
          // C731: 엔트리에 site.inFuncName 동봉 — 치환된 실인자는 그 함수 스코프로 걷는다(root
          // 자신의 비-매개변수 식별자는 기존과 동일하게 funcName=null — pending 함수 본문의
          // 로컬이 콜사이트 함수의 동명 로컬로 오해석되는 것을 구조적으로 차단).
          const paramEnv = new Map<string, SecurityParamEnvEntry>();
          for (let pi = 0; pi < info!.paramNames.length; pi++) {
            const pname = info!.paramNames[pi]!;
            const argExpr = site.call.args[pi] ?? site.call.kwargs.find((kw) => kw.name === pname)?.value;
            if (argExpr !== undefined) paramEnv.set(pname, { expr: argExpr, funcName: site.inFuncName });
          }
          bodyExpr = buildSecurityExprNode(pending.paramSubstRoot, prog, site.call.line, new Set(), taCalls, true, true, histReads, false, null, paramEnv, false, pendingLead?.symbolArg ?? null, pendingLead?.tfArg ?? null);
        } else {
          const argExpr =
            site.call.args[pending.paramIdx] ??
            site.call.kwargs.find((kw) => kw.name === pending.paramName)?.value;
          if (argExpr === undefined) {
            builds = null;
            break;
          }
          // C534: indexWrap이 있으면(원래 seriesArg가 `paramName[index]`) 이 콜사이트의 실인자를 그
          // 원본 index로 다시 감싼 합성 IndexAccess를 만들어 빌드한다 — buildSecurityExprNode의
          // 기존 IndexAccess case(bare-series obj 단축/히스토리 버퍼 등록/오프셋 재귀)를 그대로
          // 재사용(신규 로직 0줄, index 서브트리는 콜사이트 무관이라 원본 그대로 공유해도 안전).
          const buildRoot: Expr =
            pending.indexWrap === null
              ? argExpr
              : {
                  kind: "IndexAccess",
                  obj: argExpr,
                  index: pending.indexWrap.index,
                  line: pending.indexWrap.line,
                  col: pending.indexWrap.col,
                };
          // callLine은 콜사이트 자신의 줄(치환 인자의 "선언-후-사용" 판정 기준 — C452 인라인 치환과
          // 동일). funcName은 실인자가 물리적으로 속한 스코프(site.inFuncName — top-level이면 null로
          // 기존 동작 그대로, C731 in-func 사이트는 그 함수 이름이라 C526 섀도잉 가드/함수-로컬
          // 치환/C452가 정확한 스코프로 동작. indexWrap의 index는 pending 함수 스코프에 살지만 위
          // 스코프 민감 식별자 가드가 식별자 포함 index를 이미 거부했다).
          bodyExpr = buildSecurityExprNode(buildRoot, prog, site.call.line, new Set(), taCalls, true, true, histReads, false, site.inFuncName, null, false, pendingLead?.symbolArg ?? null, pendingLead?.tfArg ?? null);
        }
        if (bodyExpr === null) {
          builds = null;
          break;
        }
        // C738: pending 경로는 buildSecurityExprNode 직접 호출(슬라이스 ctx 비활성)이라 varSlice 없음.
        builds.push({ bodyExpr, taCalls, histReads, varSlice: null });
      }
    }
    if (builds === null) {
      // C739(배치37(3) 9차 — PARAM sole 리프): 콜사이트 치환 빌드가 실패한 pending 중
      // `bareSeries[매개변수 산술 오프셋]` 폼은 읽기-지점 오프셋으로 폴백 수용한다. HTF 캐시는
      // 오프셋과 무관한 순수 필드 배열이므로 프리패스/치환이 아예 불필요 — 매개변수는 콜사이트별
      // 값이 일반 UDF 인자 전달(JS 함수 인자)로 읽기 지점에 이미 실존하고, codegen이 원본 index를
      // 그 자리에서 genExpr해 rt.security.getFieldHtfOffset(htfIdx - offset 행 읽기, 리터럴
      // 프리패스 경로와 정확 동치 — runtime/security.ts 주석)으로 방출한다. 치환 경로가 실인자에
      // 루프 변수(`getReturn(monthOffset, -i)`, wild 5147b944d115)나 ':=' var(`var index` 실인자,
      // 84d597064e48)가 오면 구조적으로 실패하던 축이 통째로 소멸한다. 빌드 성공 pending은 기존
      // 프리패스 경로 그대로(출력 바이트 보존) — 이 폴백은 "실패 후"에만 도달한다. tf는 uniform
      // 컴파일타임 리터럴만(사이트별 배열/런타임 트리 조합은 wild 근거 없음 — C283). 오프셋
      // 식별자는 전원 매개변수(isSecurityUdfScopeOffsetExpr)라 선언-전-사용/스코프 문제가 구조적으로
      // 없고, chart-컨텍스트 스칼라만 담겨 읽기-지점 평가가 TV 문맥 전환과도 정합(헬퍼 주석 참조).
      const offsetRoot = pending.paramSubstRoot;
      if (
        offsetRoot !== null &&
        offsetRoot.kind === "IndexAccess" &&
        offsetRoot.obj.kind === "Identifier" &&
        BAR_SERIES_NAMES.has(offsetRoot.obj.name) &&
        info !== undefined &&
        isSecurityUdfScopeOffsetExpr(offsetRoot.index, info.paramNames) &&
        typeof pending.tfLiteral === "string"
      ) {
        const slot = prog.securityTfs.length;
        prog.securityTfs.push(pending.tfLiteral);
        prog.securityFieldOffsetCalls.set(pending.expr, {
          slot,
          field: offsetRoot.obj.name as "open" | "high" | "low" | "close" | "volume",
          gaps: pending.gaps,
          lookahead: pending.lookahead,
          offsetExpr: offsetRoot.index,
        });
        continue;
      }
      pushSecurityExprUnsupportedError(prog, pending.expr);
      continue;
    }
    const base = prog.securityTfs.length;
    builds.forEach((built, ordinal) => {
      // C529: tf도 UDF 매개변수였으면 콜사이트별로 접힌 값(같은 funcAllCallSites 순서라 이 서수와
      // 정확히 1:1) — 고정 리터럴이면 기존처럼 전 슬롯 동일 tf. C600: 혼합 배열의 런타임 트리(Expr)
      // 원소는 자리표시(chartTf) + securityRuntimeTfSlots 등록(codegen 프리앰블이 이 큐 처리 뒤에
      // 돌므로 rebuildSecurityCache 방출 타이밍은 직접 multiSite 경로와 동일).
      const tfv = typeof pending.tfLiteral === "string" ? pending.tfLiteral : pending.tfLiteral[ordinal]!;
      if (typeof tfv === "string") {
        prog.securityTfs.push(tfv);
      } else {
        prog.securityRuntimeTfSlots.set(prog.securityTfs.length, tfv);
        prog.securityTfs.push(prog.chartTf);
      }
      prog.securityParamExprPrepasses.push({
        slot: base + ordinal,
        gaps: pending.gaps,
        lookahead: pending.lookahead,
        bodyExpr: built.bodyExpr,
        histReads: built.histReads,
        varSlice: built.varSlice,
      });
      // 클론 ta.* 콜 정식 등록(인자 검증/전역 슬롯 배정) — exprMatch 경로와 동일하되 스코프만
      // top-level(위 함수 주석 참조).
      for (const tc of built.taCalls) analyzeStatefulCall(tc.taCall, tc.fn, tc.entry, prog, rootScope);
    });
    prog.securityParamExprCalls.set(pending.expr, { base, gaps: pending.gaps, lookahead: pending.lookahead });
    info!.hasSecParamCalls = true;
    // 서수 배정 — 같은 함수에 pending이 여러 개(본문에 해당 콜 2개 이상)면 같은 값으로 재설정될
    // 뿐이라 멱등이다.
    sites.forEach((site, ordinal) => prog.funcSecIdxArgs.set(site.call, ordinal));
  }
}

// C267[part2]: analyzeUserFuncCall이 채워둔 prog.funcs[*].calls 그래프(호출자 -> 피호출자 이름)에서
// 사이클(직접 자기재귀 포함)을 DFS 3-색 마킹으로 찾는다 — TV v5는 재귀 UDF를 지원하지 않으므로
// 정적 콜그래프가 사이클을 포함하면 그 사이클에 속한 모든 함수를 하드 에러로 거부한다. resolve
// PendingFuncCallSlots와 마찬가지로 analyze() 메인 루프(모든 top-level FuncDecl bodyAnalyzed 완료)
// 종료 후에만 안전하다 — 그 전엔 calls 집합이 아직 다 안 채워져 있을 수 있다.
export function detectRecursiveFuncCalls(prog: AnalyzedProgram): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const reported = new Set<string>();
  const path: string[] = [];

  function visit(name: string): void {
    const c = color.get(name) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      const startIdx = path.indexOf(name);
      const cycle = path.slice(startIdx === -1 ? 0 : startIdx).concat(name);
      for (const n of cycle) {
        if (reported.has(n)) continue;
        reported.add(n);
        prog.errors.push(`'${n}' function call has a recursive cycle (TV v5 does not support recursive UDFs): ${cycle.join(" -> ")}`);
      }
      return;
    }
    color.set(name, GRAY);
    path.push(name);
    const info = prog.funcs.get(name);
    if (info !== undefined) {
      for (const callee of info.calls) visit(callee);
    }
    path.pop();
    color.set(name, BLACK);
  }

  for (const name of prog.funcs.keys()) {
    if ((color.get(name) ?? WHITE) === WHITE) visit(name);
  }
}
