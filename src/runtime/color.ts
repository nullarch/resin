// color.* 네임스페이스(C78, C311). 상수 17종(aqua/black/.../yellow)은 analyzer가 컴파일타임에
// 문자열 리터럴로 접어(builtinStringConstants, math.pi류 패턴 재사용) 런타임 함수가 불필요 — 여기엔
// rgb/new/from_gradient/r/g/b/t 7개 함수가 존재. GOAL.md na 3분할 규약: color는 참조형이라 na = null.
// 색상 값 자체는 pine2py와 동일하게 "#RRGGBB"/"#RRGGBBAA" hex string으로 표현한다.

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.trunc(v)));
}

function toHex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}

// color.rgb(r, g, b, transp=0) — pine2py wavealgo/builtins/color.py의 `int(r)`는 r이 NaN이면
// Python ValueError로 크래시(가드 없음, python으로 직접 확인) — GOAL.md na 안전성 원칙에 따라
// r/g/b 중 하나라도 na(NaN)면 na(null, 참조형 반환)를 전파하기로 새로 결정(DIVERGENCES.md 신규).
// transp는 다르다: pine2py의 `if transp > 0`은 Python도 JS도 NaN 비교가 항상 False라 transp가
// NaN이어도 크래시 없이 "투명도 없음" 분기로 자연히 빠진다(literal port, 별도 가드 불필요 — python
// 사전 확인: `float('nan') > 0` == False).
export function rgb(r: number, g: number, b: number, transp: number = 0): string | null {
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  const rr = clampByte(r);
  const gg = clampByte(g);
  const bb = clampByte(b);
  if (transp > 0) {
    const alpha = clampByte(255 * (1 - transp / 100));
    return `#${toHex2(rr)}${toHex2(gg)}${toHex2(bb)}${toHex2(alpha)}`;
  }
  return `#${toHex2(rr)}${toHex2(gg)}${toHex2(bb)}`;
}

// color.new(colorVal, transp=0) — pine2py: `if not color_val or not isinstance(...): return
// color_val`은 이미 na(빈 문자열도 포함)를 안전하게 그대로 통과시키는 가드라 literal port(na 새로
// 결정할 필요 없음, str.* contains류와 달리 pine2py 자체가 이미 안전). export 이름은 colorNew —
// `new`는 JS 예약어라 함수 선언 식별자로 쓸 수 없어(프로퍼티 접근 `rt.new`는 유효) rt.ts에서
// `new: colorNew`로 매핑한다.
export function colorNew(colorVal: string | null, transp: number = 0): string | null {
  if (colorVal === null || colorVal === "") return colorVal;
  const base = colorVal.length >= 7 ? colorVal.slice(0, 7) : colorVal;
  if (transp > 0) {
    const alpha = clampByte(255 * (1 - transp / 100));
    return `${base}${toHex2(alpha)}`;
  }
  return base;
}

// pine2py _parse_hex literal port — 길이 부족/na면 (0,0,0) 폴백(pine2py의 방어적 가드 그대로).
function parseHex(colorStr: string | null): [number, number, number] {
  if (!colorStr || colorStr.length < 7) return [0, 0, 0];
  return [
    parseInt(colorStr.slice(1, 3), 16),
    parseInt(colorStr.slice(3, 5), 16),
    parseInt(colorStr.slice(5, 7), 16),
  ];
}

// color.from_gradient(value, bottomValue, topValue, bottomColor, topColor) — pine2py literal port.
// value가 na이거나 topValue===bottomValue면 bottomColor 그대로. bottomValue/topValue 자체가 na인
// 극단(둘 다 na면 `==` 비교가 False라 else로 빠져 t가 NaN/NaN=NaN이 되는 pine2py 자체의 크래시 유발
// 극단 케이스)은 GOAL.md na 안전성 원칙에 따라 t가 NaN이면 na(null)를 반환하도록 추가 가드.
export function from_gradient(
  value: number,
  bottomValue: number,
  topValue: number,
  bottomColor: string | null,
  topColor: string | null,
): string | null {
  if (Number.isNaN(value) || topValue === bottomValue) return bottomColor;
  const tRaw = (value - bottomValue) / (topValue - bottomValue);
  if (Number.isNaN(tRaw)) return null;
  const t = Math.max(0, Math.min(1, tRaw));
  const [br, bg, bb] = parseHex(bottomColor);
  const [tr, tg, tb] = parseHex(topColor);
  const r = Math.trunc(br + (tr - br) * t);
  const g = Math.trunc(bg + (tg - bg) * t);
  const b = Math.trunc(bb + (tb - bb) * t);
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

// color.r/g/b/t(color)(C311, wild "지원하지 않는 호출" 클러스터 1위, 18건) — TV 색상 채널 추출
// (RGB 성분 + 투명도). pine2py에 대응 구현이 전혀 없다(wavealgo/builtins/color.py 전체에 r/g/b/t
// 추출 함수 부재, docs/pinescript_visualization_reference.md 776-784행이 스스로 "codegen +
// wavealgo 모두 미구현"이라 명시) — hand-verified 신규 설계(DIVERGENCES.md #118, "TV 미검증(가설)").
// r/g/b는 위 rgb()가 만드는 hex 인코딩의 순수 역연산(단순 hex 파싱), t(transparency)는 rgb()의
// `alpha = clampByte(255*(1-transp/100))` 인코딩의 역함수(transp = round((1-alpha/255)*100)) —
// 정수 라운드트립을 손 계산으로 검증(transp=50 -> alpha=127(트렁케이션) -> 역산 50.196... ->
// round 50, transp=0/100 양끝도 정확히 원값으로 복귀). alpha 바이트가 없는 6자리 문자열(rgb()의
// transp<=0 분기)은 불투명(alpha=255, t=0)으로 해석. na 안전성: 인자가 유효한 hex 문자열이
// 아니면(null은 물론 어떤 값이든) 크래시 없이 na로 흡수한다(반환 타입이 float라 na=NaN, colorNew의
// "na를 그대로 통과"보다 넓은 `typeof !== "string"` 가드로 방어 범위 확장) — `var color x = na`
// 미초기화가 NaN으로 남는 별개 사전조건 위반(LIMITATIONS.md C311)은 codegen.ts genValueCode가
// isUdtReferenceFieldType을 재사용하도록 고쳐 이번 사이클에 해소됨, 이 가드는 여전히 유효한
// 방어선으로 남는다.
function parseColorChannels(colorVal: unknown): [number, number, number, number] | null {
  if (typeof colorVal !== "string" || colorVal.length < 7) return null;
  const rr = parseInt(colorVal.slice(1, 3), 16);
  const gg = parseInt(colorVal.slice(3, 5), 16);
  const bb = parseInt(colorVal.slice(5, 7), 16);
  const alpha = colorVal.length >= 9 ? parseInt(colorVal.slice(7, 9), 16) : 255;
  return [rr, gg, bb, alpha];
}

export function colorR(colorVal: unknown): number {
  const parsed = parseColorChannels(colorVal);
  return parsed === null ? NaN : parsed[0];
}

export function colorG(colorVal: unknown): number {
  const parsed = parseColorChannels(colorVal);
  return parsed === null ? NaN : parsed[1];
}

export function colorB(colorVal: unknown): number {
  const parsed = parseColorChannels(colorVal);
  return parsed === null ? NaN : parsed[2];
}

export function colorT(colorVal: unknown): number {
  const parsed = parseColorChannels(colorVal);
  return parsed === null ? NaN : Math.round((1 - parsed[3] / 255) * 100);
}
