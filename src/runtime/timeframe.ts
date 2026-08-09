// timeframe.in_seconds/from_seconds — pine2py wavealgo/__init__.py의 timeframe_in_seconds/
// timeframe_from_seconds를 literal port(codegen.py 함수-이름 매핑 테이블이 실제로 라우팅하는
// 대상, wavealgo/builtins/timeframe.py Timeframe.in_seconds/from_seconds staticmethod와는 로직이
// 다른 별개 구현 — analyzer/call-expr.ts 주석 참조).

// Python `int(s)`와 동일한 엄격 정수 파싱(부호 허용, 앞뒤 공백 허용, 소수점/그 외 문자 불허) —
// JS parseInt는 "12abc"도 12로 관대하게 파싱해 Python ValueError 폴백 분기를 놓치므로 정규식으로
// 먼저 유효성을 확인한다.
function pyParseInt(s: string): number | null {
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

export function in_seconds(timeframe?: string): number {
  if (!timeframe) return 86400; // default: 1 day
  const tf = timeframe.toUpperCase();
  if (tf === "D") return 86400;
  if (tf === "W") return 604800;
  if (tf === "M") return 2592000; // 30 days
  const minutes = pyParseInt(timeframe);
  if (minutes !== null) return minutes * 60;
  return 86400;
}

// timeframe.change — pine2py wavealgo/__init__.py L269 timeframe_change(timeframe='D')는 인자와
// 무관하게 항상 False 고정(주석: "백테스트 기본 모드: 항상 False, 단일 타임프레임" — 실제 멀티
// 타임프레임 경계 감지는 Context에서 이전/현재 바의 타임프레임 경계를 비교해야 하나 미구현).
export function change(_timeframe: string = "D"): boolean {
  return false;
}

export function from_seconds(seconds: number): string {
  if (seconds <= 0) return "D";
  if (seconds < 60) {
    const rounded = Math.ceil(seconds / 5) * 5;
    return `${rounded}S`;
  }
  if (seconds < 86400) {
    return String(Math.ceil(seconds / 60));
  }
  if (seconds <= 604800 * 52) {
    if (seconds % 604800 === 0) {
      const weeks = seconds / 604800;
      return `${weeks}W`;
    }
    const days = Math.ceil(seconds / 86400);
    return `${days}D`;
  }
  return "12M";
}
