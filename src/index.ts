// 공개 API 표면 (ROADMAP 배치49 (4-a), C821에서 동결).
//
// 여기 나열된 것만이 외부 소비자에게 지원되는 표면이다. src/ 아래의 다른 export는 전부 내부
// 구현이며(런타임 헬퍼 ta/numeric/str/drawing/color..., 트랜스파일러 단계 lexer/parser 내부
// /analyzer/codegen) 예고 없이 바뀔 수 있다 — 그 심볼들은 unit 테스트가 직접 import해 검증할
// 뿐, 공개면이 아니다.
//
// 이 목록은 추측이 아니라 실제 콜사이트에서 역산했다: scripts/*.mjs(corpus_scan / corpus_exec_worker
// / perf_bench / perf_profile — 이 리포에서 트랜스파일러를 "외부에서 구동하는" 유일한 소비자
// 대역)가 `await import("../src/...")`로 실제로 꺼내 쓰는 심볼 집합 + 그 심볼을 타입 수준에서
// 소비하는 데 필요한 타입. 근거와 각 항목의 역할은 API.md, 정합 가드는
// tests/unit/public_api_surface.test.ts (scripts/ 실제 import를 매번 재스캔해 대조한다).
//
// 표면을 바꾸려면: 이 파일 + API.md + 그 가드 테스트를 함께 갱신할 것(하나만 고치면 레드).

export const VERSION = "0.0.1";

// --- 트랜스파일 (Pine 소스 -> JS 모듈 코드) ---
export { transpile } from "./transpiler/pipeline";
export type { TranspileErr, TranspileOk, TranspileResult } from "./transpiler/pipeline";
export type { AnalyzeOptions } from "./transpiler/analyzer";

// parse()는 corpus_scan.mjs가 실패 진단(트랜스파일 에러가 파스 단계인지 분석 단계인지 가르기)에
// 쓰는 하위 진입점. ParseError는 콜사이트가 import하지는 않지만 parse()가 경계 밖으로 던지는
// 값이라 계약의 일부로 공개면에 포함한다(transpile()은 이걸 잡아 TranspileErr로 바꾼다).
export { ParseError, parse } from "./transpiler/parser";

// --- 실행 (JS 모듈 코드 -> 바별 실행) ---
// run(): 한 방에 끝나는 경로(오라클/E2E 하네스가 쓰는 형태).
// compile() + new Context(): 바 루프를 호출측이 직접 돌리는 경로(스트리밍 관측이 필요한
// corpus_exec_worker/perf_bench가 쓴다). 둘 다 지원 표면이다.
export { compile, run } from "./runtime/engine";
export type { BarSnapshot, PlotResult, RunResult } from "./runtime/engine";
export { Context } from "./runtime/context";
export type { OHLCVData } from "./runtime/context";

// 생성 코드가 `new Function("$", "rt", code)`의 두 번째 인자로 받는 런타임 네임스페이스
// (GOAL.md 기술 스택 절). compile()을 쓰면 직접 만질 일이 없고, 팩토리를 손으로 만들어
// 실행하는 소비자(perf_profile)만 필요하다.
export { rt } from "./runtime/rt";

// 실행 중 스크립트가 runtime.error()로 자기중단할 때 던져지는 타입 — 소비자가 "엔진 버그"와
// "스크립트가 의도적으로 멈춤"을 갈라야 해서 공개면에 있다(corpus_exec_worker의 selfhalt 분류).
export { PineRuntimeHaltError } from "./runtime/log";

// Series/StrategyState는 값으로 생성할 일이 없고(Context가 만들어 준다) 타입으로만 필요하다
// — ctx.close.get(0) / ctx.strategy.posSize 같은 읽기를 타입 체크하기 위한 것이라 type-only.
export type { Series } from "./runtime/series";
export type { StrategyState } from "./runtime/strategy";
