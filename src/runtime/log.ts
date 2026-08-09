// log.info/warning/error + runtime.error/warning(C231, corpus 최다빈도 '지원하지 않는 호출'
// 클러스터 — log.info 8/runtime.error 6) — pine2py wavealgo/__init__.py 대조 결과 이 5종은
// 시맨틱이 균일하지 않다: _LogNamespace.info/warning/error는 전부 `pass`뿐인 순수 no-op이고
// runtime_warning도 stderr 출력만 하는 진짜 no-op(계산값 무관)이지만, runtime_error(message)는
// 실제로 `raise RuntimeError(...)`를 던진다(python 소스 직접 확인) — 이건 pine2py의 버그가 아니라
// TV 자신의 의도된 시맨틱(runtime.error()는 스크립트를 fatal하게 중단시키는 함수)이라 GOAL.md
// "알려진 버그는 따르지 않는다"의 적용 대상이 아니고 literal port 대상이다. engine.ts의 run()
// bar loop는 별도 try/catch가 없어(engine.ts 확인) 이 throw가 그대로 run() 호출자까지 전파돼
// 그 실행 전체가 버려진다 — TV의 "스크립트 전체 무효화"와 같은 효과.
export function logInfo(..._args: unknown[]): undefined {
  return undefined;
}

export function logWarning(..._args: unknown[]): undefined {
  return undefined;
}

export function logError(..._args: unknown[]): undefined {
  return undefined;
}

export function runtimeWarning(..._args: unknown[]): undefined {
  return undefined;
}

// exec 게이트(corpus_exec_worker.mjs, 배치28 (3))가 "pine2js 크래시"와 "스크립트 자신의 의도된
// 중단"을 구분하려면 던져지는 에러의 클래스로 판별해야 한다(메시지 접두어 문자열 비교는 취약) —
// runtimeError()만 이 서브클래스를 쓰고 그 외 어떤 런타임 경로도 이 클래스를 던지지 않는다.
export class PineRuntimeHaltError extends Error {}

export function runtimeError(message = ""): never {
  throw new PineRuntimeHaltError(`PineScript runtime error: ${message}`);
}
