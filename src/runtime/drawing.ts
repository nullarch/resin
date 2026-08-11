// drawing 객체(label/line/box/table): GOAL.md "drawing 객체(label/line/box/table)는 no-op +
// 발생 카운트 기록" — pine2py wavealgo/__init__.py의 label_new/line_new/box_new/table_new(전부
// `{"type": ..., "id": id(args)}` dict 핸들 반환)를 그대로 이식(pine2py는 파이썬 `id()`로 메모리
// 주소 기반 유사-유일값을 쓰지만, pine2js는 진짜 생성 개수를 세는 단조 증가 카운터를 id로 써
// "발생 카운트 기록" 요구를 더 문자 그대로 만족한다 — 핸들 자체는 어디서도 값으로 소비되지 않는
// "죽은 채널"이라 이 차이는 관측 불가, MEMORY.md C200/plot 핸들 선례와 동일 성격).
// 나머지 전 setter/getter/delete/cell/merge_cells/clear 등은 값을 discard하는 순수 no-op
// (pine2py drawing_noop과 동형). polyline은 pine2py FUNC_MAP이 new/delete 둘 다 drawing_noop
// (진짜 핸들이 아님)으로 매핑해 이 no-op 하나로 충분 — 별도 생성자가 필요 없다.
//
// label/line/box의 get_x/get_y/get_text/get_x1.../get_price/get_left... (C572, LIMITATIONS C571
// 승계)는 위 "no-op" 원칙의 예외다 — set_*가 렌더링 부작용을 버려도 되는 순수 통보인 반면
// get_*는 스크립트가 반환값을 실제 계산에 쓰는 **query** 함수라 GOAL.md 렌더링-no-op 불변식이
// 적용되지 않는다(pine2py는 이마저 drawing_noop→None 하나로 뭉개는 latent 버그, wild
// `str.replace_all(label.get_text(h),...)`류가 그 None을 그대로 문자열 메서드에 흘려보내 pine2py
// 자신도 크래시할 것 — 오라클 불가, hand-verified 대체). 그래서 handle에 실제 mutable state를
// 실어 set_*가 쓰고 get_*가 읽는 진짜 accessor 쌍으로 구현한다. 미설정 필드의 기본값은 GOAL.md na
// 규약 그대로: 숫자 필드는 NaN, text(string) 필드는 null.
export interface DrawingHandle {
  readonly kind: string;
  readonly id: number;
  state: Record<string, number | string | null>;
}

// viz S4 — 생성 로그 한 건. state는 핸들의 live 참조라 이후 set_* 변이가 그대로 반영된다
// (스냅샷은 engine 조립부가 실행 종료 후에 뜬다).
export interface DrawingRecord {
  kind: string;
  id: number;
  bar: number;
  state: DrawingHandle["state"];
}

// viz S4 — 현재 실행 중인 Context의 드로잉 싱크. engine.compile()이 돌려주는 바 함수 래퍼가
// 매 호출 직전에 자기 Context로 설정하므로, 여러 Context를 번갈아 스트리밍해도 로그가 섞이지
// 않는다(JS 단일 스레드 + 바 함수 실행은 동기). 싱크가 없으면(러ntime 단위 테스트의 직접 호출)
// 로그 없이 기존 동작 그대로다.
interface DrawingSink {
  idx: number;
  drawingLog: DrawingRecord[];
}
let currentSink: DrawingSink | null = null;
export function setDrawingContext(sink: DrawingSink): void {
  currentSink = sink;
}

let nextDrawingId = 0;

function newHandle(kind: string): DrawingHandle {
  nextDrawingId += 1;
  const h: DrawingHandle = { kind, id: nextDrawingId, state: {} };
  if (currentSink !== null) {
    currentSink.drawingLog.push({ kind, id: h.id, bar: currentSink.idx, state: h.state });
  }
  return h;
}

function numArg(args: readonly unknown[], i: number): number {
  const v = args[i];
  return typeof v === "number" ? v : NaN;
}
function strArg(args: readonly unknown[], i: number): string | null {
  const v = args[i];
  return typeof v === "string" ? v : null;
}

// viz S4 — 생성자 공용의 선택 필드 캡처: 위치에 실제 값이 있을 때만 state에 싣는다
// (undefined 패딩·미전달은 건너뜀 — get_*의 "미설정 = NaN/null" 규약 유지).
function captureOpt(h: DrawingHandle, args: readonly unknown[], fields: ReadonlyArray<[string, number, "num" | "str"]>): void {
  for (const [name, idx, t] of fields) {
    if (idx < args.length && args[idx] !== undefined) {
      h.state[name] = t === "num" ? numArg(args, idx) : strArg(args, idx);
    }
  }
}

// label.new(x, y, text, ...) — x/y series int/float(필수), text series string(기본 "").
// viz S4: 표시용 파라미터(DRAWING_STATE_PARAM_NAMES "label.new" 순서)도 캡처한다.
export function newLabel(...args: unknown[]): DrawingHandle {
  const h = newHandle("label");
  h.state.x = numArg(args, 0);
  h.state.y = numArg(args, 1);
  h.state.text = args.length > 2 ? strArg(args, 2) : "";
  captureOpt(h, args, [
    ["xloc", 3, "str"], ["yloc", 4, "str"], ["color", 5, "str"], ["style", 6, "str"],
    ["textcolor", 7, "str"], ["size", 8, "str"], ["textalign", 9, "str"], ["tooltip", 10, "str"],
  ]);
  return h;
}
// line.new(x1, y1, x2, y2, ...) — 전부 series int/float 필수(기본값 없음).
export function newLine(...args: unknown[]): DrawingHandle {
  const h = newHandle("line");
  h.state.x1 = numArg(args, 0);
  h.state.y1 = numArg(args, 1);
  h.state.x2 = numArg(args, 2);
  h.state.y2 = numArg(args, 3);
  captureOpt(h, args, [
    ["xloc", 4, "str"], ["extend", 5, "str"], ["color", 6, "str"], ["style", 7, "str"], ["width", 8, "num"],
  ]);
  return h;
}
// box.new(left, top, right, bottom, ...) — 전부 series int/float 필수(기본값 없음).
export function newBox(...args: unknown[]): DrawingHandle {
  const h = newHandle("box");
  h.state.left = numArg(args, 0);
  h.state.top = numArg(args, 1);
  h.state.right = numArg(args, 2);
  h.state.bottom = numArg(args, 3);
  captureOpt(h, args, [
    ["border_color", 4, "str"], ["border_width", 5, "num"], ["border_style", 6, "str"],
    ["extend", 7, "str"], ["xloc", 8, "str"], ["bgcolor", 9, "str"], ["text", 10, "str"],
  ]);
  return h;
}
export function newTable(...args: unknown[]): DrawingHandle {
  const h = newHandle("table");
  captureOpt(h, args, [
    ["position", 0, "str"], ["columns", 1, "num"], ["rows", 2, "num"], ["bgcolor", 3, "str"],
    ["frame_color", 4, "str"], ["frame_width", 5, "num"], ["border_color", 6, "str"], ["border_width", 7, "num"],
  ]);
  return h;
}

export function drawingNoop(..._args: unknown[]): undefined {
  return undefined;
}

// --- label/line/box get_*/set_* 실 accessor (C572) ---
// handle이 na일 수 있다 — (a) null(삭제된 뒤 참조, 조건부로 생성 안 된 채 사용) (b) NaN(array.get()
// 범위밖 접근이 numeric/generic 배열 공용 rt.array.get을 그대로 재사용해 항상 NaN을 반환, array.ts
// 참조 — box/label 원소 array라도 "값이 없다"의 sentinel은 NaN이지 null이 아니다). isHandle이
// "진짜 object"만 인정해 두 경우 전부 걸러낸다 — get_*는 GOAL.md na 규약대로 NaN/null을 돌려주고,
// set_*는 조용히 discard한다(런타임 크래시 방지, 기존 drawingNoop과 동일한 "값 discard" 관례).
function isHandle(h: unknown): h is DrawingHandle {
  return typeof h === "object" && h !== null;
}
function numField(h: unknown, field: string): number {
  if (!isHandle(h)) return NaN;
  const v = h.state[field];
  return typeof v === "number" ? v : NaN;
}
function strField(h: unknown, field: string): string | null {
  if (!isHandle(h)) return null;
  const v = h.state[field];
  return typeof v === "string" ? v : null;
}
function setNumField(h: unknown, field: string, value: number): undefined {
  if (isHandle(h)) h.state[field] = value;
  return undefined;
}
function setStrField(h: unknown, field: string, value: string | null): undefined {
  if (isHandle(h)) h.state[field] = value;
  return undefined;
}
// viz S4 — 표시용 setter 승격: drawingNoop이던 set_color/set_style류가 이제 state에 쓴다
// (생성 로그가 최종 상태를 노출하므로 표시 속성 변이도 관측 대상이다). 값 타입은 느슨하게
// 받아 문자열/숫자만 싣고 그 외(na 등)는 null로 낮춘다.
export function setDisplayField(field: string): (h: unknown, v: unknown) => undefined {
  return (h: unknown, v: unknown): undefined => {
    if (isHandle(h)) h.state[field] = typeof v === "number" || typeof v === "string" ? v : null;
    return undefined;
  };
}

export function labelGetX(h: unknown): number {
  return numField(h, "x");
}
export function labelGetY(h: unknown): number {
  return numField(h, "y");
}
export function labelGetText(h: unknown): string | null {
  return strField(h, "text");
}
export function labelSetX(h: unknown, x: number): undefined {
  return setNumField(h, "x", x);
}
export function labelSetY(h: unknown, y: number): undefined {
  return setNumField(h, "y", y);
}
export function labelSetXy(h: unknown, x: number, y: number): undefined {
  setNumField(h, "x", x);
  return setNumField(h, "y", y);
}
export function labelSetText(h: unknown, text: string | null): undefined {
  return setStrField(h, "text", text);
}

export function lineGetX1(h: unknown): number {
  return numField(h, "x1");
}
export function lineGetY1(h: unknown): number {
  return numField(h, "y1");
}
export function lineGetX2(h: unknown): number {
  return numField(h, "x2");
}
export function lineGetY2(h: unknown): number {
  return numField(h, "y2");
}
// line.get_price(id, x) — (x1,y1)-(x2,y2) 직선을 bar_index x로 선형보간(TV "가상의 연장선" 시맨틱,
// pine2py는 drawing_noop→None이라 오라클 불가, hand-verified). x1===x2(수직선)면 0/0 나눗셈이
// 자연히 NaN으로 떨어져 GOAL.md na 안전 원칙과 그대로 합치.
export function lineGetPrice(h: unknown, x: number): number {
  const x1 = numField(h, "x1");
  const y1 = numField(h, "y1");
  const x2 = numField(h, "x2");
  const y2 = numField(h, "y2");
  return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
}
export function lineSetX1(h: unknown, x1: number): undefined {
  return setNumField(h, "x1", x1);
}
export function lineSetY1(h: unknown, y1: number): undefined {
  return setNumField(h, "y1", y1);
}
export function lineSetX2(h: unknown, x2: number): undefined {
  return setNumField(h, "x2", x2);
}
export function lineSetY2(h: unknown, y2: number): undefined {
  return setNumField(h, "y2", y2);
}
export function lineSetXy1(h: unknown, x1: number, y1: number): undefined {
  setNumField(h, "x1", x1);
  return setNumField(h, "y1", y1);
}
export function lineSetXy2(h: unknown, x2: number, y2: number): undefined {
  setNumField(h, "x2", x2);
  return setNumField(h, "y2", y2);
}
// set_first_point/set_second_point(id, point) — point는 ChartPoint({time,index,price}). xloc이
// bar_index/bar_time 어느 쪽이든 실사용 wild는 index 축이 절대다수라 index를 우선하고, index가
// 없을 때만 time으로 폴백(둘 다 없으면 NaN — GOAL.md na 규약).
function chartPointX(point: ChartPoint | null | undefined): number {
  if (point == null) return NaN;
  if (point.index !== null) return point.index;
  if (point.time !== null) return point.time;
  return NaN;
}
function chartPointY(point: ChartPoint | null | undefined): number {
  return point != null && point.price !== null ? point.price : NaN;
}
export function lineSetFirstPoint(h: unknown, point: ChartPoint | null | undefined): undefined {
  setNumField(h, "x1", chartPointX(point));
  return setNumField(h, "y1", chartPointY(point));
}
export function lineSetSecondPoint(h: unknown, point: ChartPoint | null | undefined): undefined {
  setNumField(h, "x2", chartPointX(point));
  return setNumField(h, "y2", chartPointY(point));
}

export function boxGetLeft(h: unknown): number {
  return numField(h, "left");
}
export function boxGetRight(h: unknown): number {
  return numField(h, "right");
}
export function boxGetTop(h: unknown): number {
  return numField(h, "top");
}
export function boxGetBottom(h: unknown): number {
  return numField(h, "bottom");
}
export function boxSetLeft(h: unknown, left: number): undefined {
  return setNumField(h, "left", left);
}
export function boxSetRight(h: unknown, right: number): undefined {
  return setNumField(h, "right", right);
}
export function boxSetTop(h: unknown, top: number): undefined {
  return setNumField(h, "top", top);
}
export function boxSetBottom(h: unknown, bottom: number): undefined {
  return setNumField(h, "bottom", bottom);
}
export function boxSetLefttop(h: unknown, left: number, top: number): undefined {
  setNumField(h, "left", left);
  return setNumField(h, "top", top);
}
export function boxSetRightbottom(h: unknown, right: number, bottom: number): undefined {
  setNumField(h, "right", right);
  return setNumField(h, "bottom", bottom);
}
// set_top_left_point/set_bottom_right_point(id, point) — line.set_first_point/set_second_point의
// box 대응 짝(C619, next_hint(C618)). pine2py FUNC_MAP에 대응 함수가 없어(오라클 불가) chartPointX/Y
// 헬퍼를 그대로 재사용한 hand-verified 이식: point의 x축(index 우선, time 폴백)을 left/right에,
// price를 top/bottom에 쓴다.
export function boxSetTopLeftPoint(h: unknown, point: ChartPoint | null | undefined): undefined {
  setNumField(h, "left", chartPointX(point));
  return setNumField(h, "top", chartPointY(point));
}
export function boxSetBottomRightPoint(h: unknown, point: ChartPoint | null | undefined): undefined {
  setNumField(h, "right", chartPointX(point));
  return setNumField(h, "bottom", chartPointY(point));
}

// chart.point.new/from_index/from_time/copy/now(corpus 실측 10개 파일) — drawing 핸들과 달리 이건
// 진짜 값 타입(pine2py wavealgo chart_point_new 등이 {"time","index","price"} dict를 반환하고
// line.set_first_point/polyline.new 같은 소비처에 값으로 전달됨, no-op 카운터가 아님). GOAL.md
// na 참조형 규약 대신 pine2py 그대로: 인자가 "생략"됐을 때만(JS에선 undefined) None 기본값 자리를
// 채우고, 명시적 `na`(NaN)는 그대로 통과시킨다(pine2py도 na 리터럴을 항상 float('nan')으로 컴파일해
// 실제 None 분기를 타지 않음, MEMORY.md C110). 기본값은 함수마다 pine2py 시그니처와 동일.
export interface ChartPoint {
  time: number | null;
  index: number | null;
  price: number | null;
}

export function chartPointNew(time?: number, index?: number, price?: number): ChartPoint {
  return { time: time ?? null, index: index ?? null, price: price ?? null };
}

export function chartPointFromIndex(index = 0, price = 0.0): ChartPoint {
  return { time: null, index, price };
}

export function chartPointFromTime(time = 0, price = 0.0): ChartPoint {
  return { time, index: null, price };
}

export function chartPointNow(price = 0.0): ChartPoint {
  return { time: null, index: null, price };
}

export function chartPointCopy(point?: ChartPoint | null): ChartPoint {
  // pine2py chart_point_copy(point=None)은 point가 정말 None(인자 생략)일 때만 기본 dict를 반환하고,
  // 그 외(예: chart.point.copy(na) — na가 float('nan')으로 컴파일돼 None이 아님)엔 `dict(point)`가
  // non-dict(nan)를 순회하려다 TypeError로 크래시한다(GOAL.md "알려진 버그는 따르지 않는다" 적용 —
  // corpus 미실측이라 hand-verified 대상, DIVERGENCES 참조). pine2js는 object가 아닌 모든 입력을
  // 균일하게 "point 없음"으로 취급해 크래시 없이 기본값을 반환한다.
  if (point === undefined || point === null || typeof point !== "object") {
    return { time: null, index: null, price: null };
  }
  return { time: point.time, index: point.index, price: point.price };
}
