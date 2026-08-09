// syminfo.ticker(symbol) — bare `syminfo.ticker` 프로퍼티(analyzer.ts SYMINFO_STRING_PROPS,
// 컴파일타임 "" 폴딩)와는 별개인 **호출형**(1-인자). pine2py Syminfo dataclass엔 bare ticker
// 필드만 있고 이 콜 형태 자체가 없어(wavealgo/builtins/syminfo.py + pine2wave/codegen.py 전수
// grep 0건, C429 확인) 오라클 대조 불가 — hand-verified. TV 통설(TV 미검증(가설),
// DIVERGENCES.md 참조): "EXCHANGE:TICKER" 형식 심볼 문자열에서 콜론 뒤 TICKER 부분만 추출해
// 반환, 콜론이 없으면 인자를 그대로 반환. string na = null 그대로 전파(GOAL.md na 3분할 규약).
export function ticker(symbol: string | null): string | null {
  if (symbol === null) return null;
  const idx = symbol.indexOf(":");
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}
