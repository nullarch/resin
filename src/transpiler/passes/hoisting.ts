// TransformPasses(Hoisting) 단계. GOAL.md 5단계 파이프라인(Lexer→Parser→Analyzer→
// TransformPasses→CodeGen)의 자리를 명시적으로 유지한다. 조건부 stateful call(if/for 안의
// var/ta 상태) 2-level 호이스팅은 P2 ROADMAP 항목 — 이번 최소 수직 슬라이스는 분기 자체가
// 없으므로 no-op 통과만 수행한다.

import type { AnalyzedProgram } from "../analyzer";

export function hoist(program: AnalyzedProgram): AnalyzedProgram {
  return program;
}
