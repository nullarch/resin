// chart.is_standard/is_heikinashi/is_renko/is_kagi/is_linebreak/is_pnf/is_range — pine2py에
// 대응 구현이 전혀 없어(codegen.py/wavealgo 전수 grep 0건) 오라클 검증 불가. 이 엔진은 배치
// 리플레이 백테스트 엔진이라 메인 차트에 heikin-ashi/renko/kagi/line break/point&figure/range
// 합성 바 변환을 실제로 적용하지 않는다(ticker.*(C235)가 이미 같은 이유로 이 변환들을 문자열
// pass-through로 축소한 것과 동일한 전제) — 즉 로드된 심볼은 항상 "표준" 차트이므로 is_standard
// 만 true, 나머지 chart.is_* 전 계열은 false가 TV 정의상 유일한 합리적 값(hand-verified,
// PROGRESS.md C238 next_hint / LIMITATIONS.md 참조).

export function is_standard(): boolean {
  return true;
}

export function is_heikinashi(): boolean {
  return false;
}

export function is_renko(): boolean {
  return false;
}

export function is_kagi(): boolean {
  return false;
}

export function is_linebreak(): boolean {
  return false;
}

export function is_pnf(): boolean {
  return false;
}

export function is_range(): boolean {
  return false;
}
