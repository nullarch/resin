// 생성된 코드에 `new Function('$', 'rt', code)`의 두 번째 인자로 전달되는 런타임 헬퍼 묶음.

import * as ta from "./ta";
import * as array from "./array";
import * as mapFns from "./map";
import * as matrixFns from "./matrix";
import { na, pineNot, pineLt, pineGt, pineLe, pineGe, pineAnd, pineOr, pineEq, pineNeq, pineDiv, pineMod, idiv, round, round_to_mintick, abs, max, min, clamp, avg, floor, ceil, sqrt, pow, log, log10, exp, sign, sin, cos, tan, asin, acos, atan, atan2, todegrees, toradians, nz, concat, udtCopy, int, float, bool, timestamp, barIndexHistory, histConst } from "./numeric";
import { histGet, secHistGet, refHistGet } from "./series";
import { length, contains, startswith, endswith, pos, lower, upper, trim, replace_all, replace, substring, repeat, tostring, tonumber, split, match, format, format_number, format_time } from "./str";
import { rgb, colorNew, from_gradient, colorR, colorG, colorB, colorT, vizColor } from "./color";
import * as inputFns from "./input";
import { in_seconds, from_seconds, change as timeframeChange } from "./timeframe";
import * as tickerFns from "./ticker";
import * as securityFns from "./security";
import * as requestFns from "./request";
import {
  newLabel,
  newLine,
  newBox,
  newTable,
  drawingNoop,
  chartPointNew,
  chartPointFromIndex,
  chartPointFromTime,
  chartPointCopy,
  chartPointNow,
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
  lineSetY1,
  lineSetX2,
  lineSetY2,
  lineSetXy1,
  lineSetXy2,
  lineSetFirstPoint,
  lineSetSecondPoint,
  boxGetLeft,
  boxGetRight,
  boxGetTop,
  boxGetBottom,
  boxSetLeft,
  boxSetRight,
  boxSetTop,
  boxSetBottom,
  boxSetLefttop,
  boxSetRightbottom,
  boxSetTopLeftPoint,
  boxSetBottomRightPoint,
} from "./drawing";
import { logInfo, logWarning, logError, runtimeWarning, runtimeError } from "./log";
import * as datetimeFns from "./datetime";
import * as chartTypeFns from "./chart";
import * as timeFns from "./time";
import * as syminfoFns from "./syminfo";

export const rt = {
  // viz S1/S2 — 동적 색 채널 기록 직전 정규화(na/NaN → null). codegen이
  // `$.plotColors[k][$.idx] = rt.vizColor(<expr>)` 형태로만 소비한다.
  vizColor,
  ta,
  // array.*는 str.*류 flat export가 아니라 rt.ta처럼 중첩 네임스페이스로 조립한다(C79) —
  // get/set/size 같은 범용 이름이 향후 map.*/matrix.*의 동명 메서드와 flat 네임스페이스에서
  // 충돌하는 것을 원천 차단(builtinCalls 값에 "array.get"처럼 점 경로를 그대로 담아
  // codegen의 `rt.${name}(...)` 범용 방출이 무변경으로 중첩 경로를 낸다).
  array,
  // map.*(C89)도 동일한 중첩 네임스페이스 원칙 — get/size/remove/clear/copy가 array와 이름이
  // 겹친다(ROADMAP이 예고한 그대로). "new"는 JS 예약어라 함수 선언 식별자로 쓸 수 없어(프로퍼티
  // 접근 `rt.map.new`는 유효, color.new(C78)의 colorNew와 동일 사정) map.ts는 `newMap`으로
  // export하고 여기서 `new: mapFns.newMap`으로 매핑한다.
  map: {
    new: mapFns.newMap,
    put: mapFns.put,
    get: mapFns.get,
    remove: mapFns.remove,
    contains: mapFns.contains,
    keys: mapFns.keys,
    values: mapFns.values,
    size: mapFns.size,
    clear: mapFns.clear,
    copy: mapFns.copy,
    put_all: mapFns.put_all,
  },
  // matrix.*(C90 첫 슬라이스: new/get/set/rows/columns/elements_count + C91 두 번째 슬라이스:
  // row/col) — array/map과 동일한 중첩 네임스페이스 원칙(get/set이 array/map과 이름이 겹침).
  // "new"는 map과 동일한 이유로 matrix.ts가 `newMatrix`로 export하고 여기서 매핑한다.
  matrix: {
    new: matrixFns.newMatrix,
    get: matrixFns.get,
    set: matrixFns.set,
    rows: matrixFns.rows,
    columns: matrixFns.columns,
    elements_count: matrixFns.elements_count,
    row: matrixFns.row,
    col: matrixFns.col,
    add_row: matrixFns.add_row,
    add_col: matrixFns.add_col,
    remove_row: matrixFns.remove_row,
    remove_col: matrixFns.remove_col,
    swap_rows: matrixFns.swap_rows,
    swap_columns: matrixFns.swap_columns,
    // copy/fill/concat/submatrix/reshape/reverse/sort/diff(C93, 네 번째 슬라이스) — "copy"는
    // map.copy(mapFns.copy)와 이름이 겹치지만 서로 다른 중첩 네임스페이스(rt.matrix.copy vs
    // rt.map.copy)라 충돌 없음(map.*/matrix.*의 get/set 이미 실증한 원칙 재확인).
    copy: matrixFns.copy,
    fill: matrixFns.fill,
    concat: matrixFns.concat,
    submatrix: matrixFns.submatrix,
    reshape: matrixFns.reshape,
    reverse: matrixFns.reverse,
    sort: matrixFns.sort,
    diff: matrixFns.diff,
    // is_square/is_symmetric/is_antisymmetric/is_diagonal/is_antidiagonal/is_identity/
    // is_triangular/is_stochastic/is_binary/is_zero(C94, 다섯 번째 슬라이스) — 순수 read-only
    // 술어 10종, 새 상태/뮤테이션 없음(matrix.ts 주석 참조).
    is_square: matrixFns.is_square,
    is_symmetric: matrixFns.is_symmetric,
    is_antisymmetric: matrixFns.is_antisymmetric,
    is_diagonal: matrixFns.is_diagonal,
    is_antidiagonal: matrixFns.is_antidiagonal,
    is_identity: matrixFns.is_identity,
    is_triangular: matrixFns.is_triangular,
    is_stochastic: matrixFns.is_stochastic,
    is_binary: matrixFns.is_binary,
    is_zero: matrixFns.is_zero,
    // sum/avg/min/max/median/mode(C95, 여섯 번째 슬라이스) — array.sum/avg/min/max/median/mode와
    // 이름이 겹치지만 rt.array와 별개 네임스페이스라 충돌 없음(get/set/copy가 이미 실증한 원칙).
    sum: matrixFns.sum,
    avg: matrixFns.avg,
    min: matrixFns.min,
    max: matrixFns.max,
    median: matrixFns.median,
    mode: matrixFns.mode,
    // transpose(C96, 일곱 번째 슬라이스 — 행렬 대수 11종의 첫 항목).
    transpose: matrixFns.transpose,
    // mult(C97, 여덟 번째 슬라이스 — 행렬 대수 11종의 두 번째 항목).
    mult: matrixFns.mult,
    // det(C98, 아홉 번째 슬라이스 — 행렬 대수 11종의 세 번째 항목).
    det: matrixFns.det,
    // trace(C99, 열 번째 슬라이스 — 행렬 대수 11종의 네 번째 항목).
    trace: matrixFns.trace,
    // inv(C100, 열한 번째 슬라이스 — 행렬 대수 11종의 다섯 번째 항목).
    inv: matrixFns.inv,
    // rank(C101, 열두 번째 슬라이스 — 행렬 대수 11종의 여섯 번째 항목).
    rank: matrixFns.rank,
    // pow(C102, 열세 번째 슬라이스 — 행렬 대수 11종의 일곱 번째 항목).
    pow: matrixFns.pow,
    // kron(C103, 열네 번째 슬라이스 — 행렬 대수 11종의 여덟 번째 항목).
    kron: matrixFns.kron,
    // pinv(C104, 열다섯 번째 슬라이스 — 행렬 대수 11종의 아홉 번째 항목).
    pinv: matrixFns.pinv,
    // eigenvalues(C105, 열여섯 번째 슬라이스 — 행렬 대수 11종의 열 번째 항목).
    eigenvalues: matrixFns.eigenvalues,
    // eigenvectors(C106, 열일곱 번째이자 마지막 슬라이스 — 행렬 대수 11종의 열한 번째 항목, matrix.* 49/49 완주).
    eigenvectors: matrixFns.eigenvectors,
  },
  na,
  pineNot,
  pineLt,
  pineGt,
  pineLe,
  pineGe,
  pineAnd,
  pineOr,
  // C812: '=='/'!=' — 히스토리 슬롯을 왕복한 bool(1/0)과 원시 boolean의 동치 판정(numeric.ts
  // pineEq 주석, pineAnd/pineOr의 C449와 같은 계열).
  pineEq,
  pineNeq,
  pineDiv,
  pineMod,
  idiv,
  barIndexHistory,
  histConst,
  histGet,
  secHistGet,
  refHistGet,
  round,
  round_to_mintick,
  abs,
  max,
  min,
  clamp,
  avg,
  floor,
  ceil,
  sqrt,
  pow,
  log,
  log10,
  exp,
  sign,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  todegrees,
  toradians,
  nz,
  concat,
  udtCopy,
  int,
  float,
  bool,
  timestamp,
  length,
  contains,
  startswith,
  endswith,
  pos,
  lower,
  upper,
  trim,
  replace_all,
  replace,
  substring,
  repeat,
  tostring,
  tonumber,
  split,
  match,
  format,
  format_number,
  format_time,
  rgb,
  new: colorNew,
  from_gradient,
  // color.r/g/b/t(C311) — 채널 추출 4종. rt.new와 동일한 "export 이름과 rt 프로퍼티 키를 분리"
  // 기법(color.ts 함수명은 서술적으로, rt 키만 짧은 method 이름과 일치시켜 codegen 범용
  // `rt.${builtinName}(...)` 방출이 무변경으로 통하게 한다).
  r: colorR,
  g: colorG,
  b: colorB,
  t: colorT,
  fixnan: ta.fixnan,
  // log.info/warning/error + runtime.error/warning(C231) — flat 이름(logInfo 등)을 쓰는 이유는
  // "log"가 이미 math.log(위 `log,` 항목, 문자열 그대로 rt.log)로 점유돼 있어 array/map/matrix처럼
  // `log: { info, warning, error }` 중첩 네임스페이스를 쓰면 math.log의 콜러블 rt.log(x) 자체가
  // 깨지기 때문이다(log.ts 주석 참조) — analyzer/call-expr.ts가 builtinCalls에 이 flat 이름을
  // 그대로 등록해 codegen의 범용 `rt.${name}(...)` 방출이 무변경으로 통한다.
  logInfo,
  logWarning,
  logError,
  runtimeWarning,
  runtimeError,
  // input.*(C131 int/float/bool/string + C133 나머지 8종 + bare input(), array/map/matrix와
  // 동일한 중첩 네임스페이스 원칙(input.ts 주석 참조, 코드젠은 $.inputs를 첫 인자로 암묵 주입 —
  // ta.vwma의 volume splice와 동일한 패턴, codegen.ts genCallExpr 참조).
  input: {
    int: inputFns.int,
    float: inputFns.float,
    bool: inputFns.bool,
    string: inputFns.string,
    color: inputFns.color,
    source: inputFns.source,
    symbol: inputFns.symbol,
    timeframe: inputFns.timeframe,
    session: inputFns.session,
    price: inputFns.price,
    text_area: inputFns.text_area,
    time: inputFns.time,
    any: inputFns.any,
    enum: inputFns.enumInput,
  },
  // time(timeframe[, session[, timezone]])(C299) — bare `time` 변수($.barTimeMs, TIME_VAR_NAMES)와
  // 별개인 호출형. codegen이 이 콜을 위해 전용 분기로 `$.barTimeMs`를 첫 인자로 암묵 주입하므로
  // (genCallExpr "time" 분기 참조, array/map처럼 범용 `rt.${name}(...)` 방출을 그대로 타지 않음)
  // 여기 등록은 그 전용 분기가 참조하는 rt.time.resolve 하나뿐이다. resolveClose(C400)는
  // time_close(timeframe[, session[, timezone]])의 동일 원리 형제(genCallExpr "timeClose" 분기).
  time: {
    resolve: timeFns.resolve,
    resolveClose: timeFns.resolveClose,
  },
  // timeframe.in_seconds/from_seconds(ROADMAP P2 세 번째 슬라이스) — array/map/matrix/input과 동일한
  // 중첩 네임스페이스 원칙(builtinCalls 값이 "timeframe.in_seconds"라 codegen의 범용
  // `rt.${name}(...)` 방출이 자동으로 이 중첩 경로를 낸다, 새 codegen 분기 불필요).
  timeframe: {
    in_seconds,
    from_seconds,
    change: timeframeChange,
  },
  // syminfo.ticker(symbol) 호출형(신규, C430) — bare syminfo.ticker(analyzer.ts
  // SYMINFO_STRING_PROPS 컴파일타임 폴딩)와 별개인 값-반환 콜. builtinCalls 값이
  // "syminfo.ticker"라 codegen의 범용 `rt.${name}(...)` 방출이 자동으로 이 중첩 경로를 낸다.
  syminfo: {
    ticker: syminfoFns.ticker,
  },
  // ticker.*(8종, C235 — ROADMAP P3 next_hint 1순위) — array/map/matrix/input/timeframe과 동일한
  // 중첩 네임스페이스 원칙(builtinCalls 값이 "ticker.new"처럼 점 경로라 codegen의 범용
  // `rt.${name}(...)` 방출이 자동으로 이 중첩 경로를 낸다, 새 codegen 분기 불필요). "new"는 예약어라
  // 모듈 함수명은 newTicker(label.new -> newLabel과 동일한 회피), 객체 키만 "new".
  ticker: {
    new: tickerFns.newTicker,
    standard: tickerFns.standard,
    modify: tickerFns.modify,
    heikinashi: tickerFns.heikinashi,
    renko: tickerFns.renko,
    kagi: tickerFns.kagi,
    linebreak: tickerFns.linebreak,
    pointfigure: tickerFns.pointfigure,
    inherit: tickerFns.inherit,
  },
  // request.dividends/request.splits(신규, C239 next_hint 1순위) — array/map/ticker와 동일한
  // 중첩 네임스페이스 원칙(builtinCalls 값이 "request.dividends"처럼 점 경로라 codegen의 범용
  // `rt.${name}(...)` 방출이 자동으로 이 중첩 경로를 낸다, 새 codegen 분기 불필요). request.security는
  // 커스텀 codegen 경로(아래 security 키)라 이 객체와 무충돌.
  request: {
    dividends: requestFns.dividends,
    splits: requestFns.splits,
    earnings: requestFns.earnings,
    financial: requestFns.financial,
    quandl: requestFns.quandl,
    security_lower_tf: requestFns.securityLowerTf,
    seed: requestFns.seed,
    currency_rate: requestFns.currencyRate,
  },
  // request.security 첫 슬라이스(ROADMAP P2 [hard->분할]) — Context 생성 시 콜사이트별로 이미
  // 선계산된 $.securityCache[slot]를 매 바 O(1) lookup(security.ts get() 참조). 새 중첩 네임스페이스
  // 원칙은 그대로(get이 array/map/matrix와 이름이 겹치지만 rt.security로 격리돼 무충돌).
  security: {
    get: securityFns.get,
    // request.security 셋째 슬라이스 서브슬라이스 3c(C182) — 표현식 콜사이트(3a/3b) 전용, 3b의
    // HTF 프리패스 함수가 만든 $.securityExprCache[slot]을 barMap+gaps+lookahead로 lookup.
    getFromArray: securityFns.getFromArray,
    // request.security(...)[N](C448) — 그 콜 결과 자체에 대한 top-level 히스토리 인덱싱.
    // securityCache/securityExprCache가 이미 전체 바 범위로 집계돼 있어 $.idx-offset 재조회로 충분
    // (get/getFromArray에 trunc+음수 가드를 씌운 래퍼, index-access.ts analyzeIndexAccess 주석 참조).
    getHist: securityFns.getHist,
    getFromArrayHist: securityFns.getFromArrayHist,
    // C739: bare 필드 + 요청 tf 문맥 런타임 오프셋(HTF 행 단위) — security.ts 주석 참조.
    getFieldHtfOffset: securityFns.getFieldHtfOffset,
  },
  // label/line/box/table/polyline(신규, corpus 93개 파일 실측) — array/map/matrix/input과 동일한
  // 중첩 네임스페이스 원칙(builtinCalls 값이 "label.set_text"처럼 점 경로라 codegen의 범용
  // `rt.${name}(...)` 방출이 자동으로 이 중첩 경로를 낸다, 새 codegen 분기 불필요). new만 실제
  // 핸들을 만들고(drawing.ts) 나머지 전부는 같은 drawingNoop 하나를 공유(값이 전부 discard되므로
  // 메서드별 구현을 따로 둘 이유가 없다 — pine2py도 이 전부를 단일 drawing_noop 함수로 묶었다).
  label: {
    new: newLabel,
    delete: drawingNoop,
    copy: drawingNoop,
    set_x: labelSetX,
    set_y: labelSetY,
    set_xy: labelSetXy,
    set_text: labelSetText,
    set_color: drawingNoop,
    set_textcolor: drawingNoop,
    set_size: drawingNoop,
    set_style: drawingNoop,
    set_textalign: drawingNoop,
    set_tooltip: drawingNoop,
    set_xloc: drawingNoop,
    set_yloc: drawingNoop,
    set_point: drawingNoop,
    set_text_font_family: drawingNoop,
    get_x: labelGetX,
    get_y: labelGetY,
    get_text: labelGetText,
  },
  line: {
    new: newLine,
    delete: drawingNoop,
    copy: drawingNoop,
    set_x1: lineSetX1,
    set_y1: lineSetY1,
    set_x2: lineSetX2,
    set_y2: lineSetY2,
    set_xy1: lineSetXy1,
    set_xy2: lineSetXy2,
    set_color: drawingNoop,
    set_width: drawingNoop,
    set_style: drawingNoop,
    set_extend: drawingNoop,
    set_xloc: drawingNoop,
    set_first_point: lineSetFirstPoint,
    set_second_point: lineSetSecondPoint,
    get_x1: lineGetX1,
    get_y1: lineGetY1,
    get_x2: lineGetX2,
    get_y2: lineGetY2,
    get_price: lineGetPrice,
  },
  box: {
    new: newBox,
    delete: drawingNoop,
    copy: drawingNoop,
    set_left: boxSetLeft,
    set_right: boxSetRight,
    set_top: boxSetTop,
    set_bottom: boxSetBottom,
    set_lefttop: boxSetLefttop,
    set_rightbottom: boxSetRightbottom,
    set_top_left_point: boxSetTopLeftPoint,
    set_bottom_right_point: boxSetBottomRightPoint,
    set_bgcolor: drawingNoop,
    set_border_color: drawingNoop,
    set_border_width: drawingNoop,
    set_border_style: drawingNoop,
    set_extend: drawingNoop,
    set_text: drawingNoop,
    set_text_color: drawingNoop,
    set_text_size: drawingNoop,
    set_text_halign: drawingNoop,
    set_text_valign: drawingNoop,
    set_text_wrap: drawingNoop,
    set_text_font_family: drawingNoop,
    get_left: boxGetLeft,
    get_right: boxGetRight,
    get_top: boxGetTop,
    get_bottom: boxGetBottom,
  },
  table: {
    new: newTable,
    cell: drawingNoop,
    delete: drawingNoop,
    set_bgcolor: drawingNoop,
    set_border_color: drawingNoop,
    set_border_width: drawingNoop,
    set_position: drawingNoop,
    set_frame_color: drawingNoop,
    set_frame_width: drawingNoop,
    cell_set_text: drawingNoop,
    cell_set_bgcolor: drawingNoop,
    cell_set_text_color: drawingNoop,
    cell_set_text_size: drawingNoop,
    cell_set_height: drawingNoop,
    cell_set_width: drawingNoop,
    cell_set_tooltip: drawingNoop,
    cell_set_text_halign: drawingNoop,
    cell_set_text_valign: drawingNoop,
    cell_set_text_font_family: drawingNoop,
    merge_cells: drawingNoop,
    clear: drawingNoop,
  },
  // polyline.new도 pine2py FUNC_MAP에서 delete와 동일하게 drawing_noop(핸들 아님, literal port).
  polyline: {
    new: drawingNoop,
    delete: drawingNoop,
  },
  // linefill(C238, ROADMAP P3 next_hint 1순위) — pine2py FUNC_MAP(codegen.py L1650-1655)이 new
  // 포함 5종 전부 drawing_noop(polyline과 동일하게 진짜 핸들이 아님, literal port).
  linefill: {
    new: drawingNoop,
    delete: drawingNoop,
    set_color: drawingNoop,
    get_line1: drawingNoop,
    get_line2: drawingNoop,
  },
  // chart.point.*(신규, corpus 10개 파일 실측) — label/line 등과 달리 no-op 핸들이 아니라 진짜 값
  // (drawing.ts ChartPoint 주석 참조). builtinCalls 값이 "chart.point.new"처럼 점 두 개짜리 경로라
  // codegen의 범용 `rt.${name}(...)` 방출이 이 3-level 중첩도 그대로 낸다(새 codegen 분기 불필요).
  chart: {
    point: {
      new: chartPointNew,
      from_index: chartPointFromIndex,
      from_time: chartPointFromTime,
      copy: chartPointCopy,
      now: chartPointNow,
    },
    // chart.is_standard/is_heikinashi/is_renko/is_kagi/is_linebreak/is_pnf/is_range(C239 — ROADMAP
    // P3 next_hint 1순위, pine2py 대응 구현 0건이라 hand-verified). "point"와 형제 키라 builtinCalls
    // 값이 "chart.is_standard"처럼 점 하나짜리 경로 — codegen의 범용 `rt.${name}(...)` 방출이
    // chart.point.*(점 두 개)와 마찬가지로 자동으로 이 중첩 경로를 낸다(새 codegen 분기 불필요).
    is_standard: chartTypeFns.is_standard,
    is_heikinashi: chartTypeFns.is_heikinashi,
    is_renko: chartTypeFns.is_renko,
    is_kagi: chartTypeFns.is_kagi,
    is_linebreak: chartTypeFns.is_linebreak,
    is_pnf: chartTypeFns.is_pnf,
    is_range: chartTypeFns.is_range,
  },
  // TV 시각 변수(hour/year/dayofweek/time_tradingday, C242 — ROADMAP P3 next_hint 1순위)의
  // 파생 계산 전용 네임스페이스. genIdentifier가 "hour"/"year" 같은 bare 식별자를
  // `rt.datetime.hour($.barTimeMs)`로 직결 방출한다(datetime.ts 주석 참조 — pine2py
  // _datetime_component/time_tradingday 리터럴 포트, UTC 고정).
  datetime: {
    year: datetimeFns.year,
    month: datetimeFns.month,
    dayofmonth: datetimeFns.dayofmonth,
    dayofweek: datetimeFns.dayofweek,
    hour: datetimeFns.hour,
    minute: datetimeFns.minute,
    second: datetimeFns.second,
    weekofyear: datetimeFns.weekofyear,
    tradingDayStart: datetimeFns.tradingDayStart,
  },
};
export type Rt = typeof rt;
