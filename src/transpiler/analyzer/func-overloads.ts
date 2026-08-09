// arity-disjoint 함수 오버로드 해소 prepass (C686, wild tv_verdict_v2 "이름이 이미 다른 선언과
// 충돌함" 클러스터 — TV v5는 같은 이름의 UDF를 시그니처가 다르면 오버로드로 수용한다. 실측 대장
// accept 19파일이 arity만으로 안전 구분 가능한 서브셋).
//
// 설계(ROADMAP C681 스케치의 "prog.funcs 다중화" 대신 AST 사전 개명으로 단순화): analyze()의
// 다른 모든 prepass(prescanConstVars 포함)보다 먼저 실행되어, 같은 이름의 top-level FuncDecl이
// 2개 이상이고 위치 인자 개수 범위 [requiredParamCount, params.length]가 전부 서로소일 때만
//   (1) 두 번째 이후 선언의 이름을 `name$ov$k`(k=2,3,...)로 개명하고
//   (2) 전체 스크립트의 해당 이름 CallExpr 콜사이트를 인자 개수(위치+키워드 합)로 매칭해 재배선한다.
// 이후 파이프라인 전체(name-keyed 소비처 73곳 포함)는 처음부터 서로 다른 이름의 독립 함수만
// 보게 되어 FuncInfo/슬롯/콜사이트 메커니즘 변경이 0이다.
//
// `$`는 렉서 식별자 문자([A-Za-z0-9_])가 아니라 사용자 이름과 절대 충돌하지 않고,
// mangleMethodName("Type$method")은 `$`가 정확히 1개라 `$ov$`(2개)와도 충돌하지 않는다.
// 부작용: analyzer.ts C678 dead-code 플레이스홀더 가드는 이름의 `$`를 method 판별자로 쓰므로
// 개명된 오버로드는 그 폴백에서 보수적으로 제외된다(에러가 에러로 남을 뿐 조용한 오답 없음).
//
// 안전 게이트(오판 방지 — C394 "틀린 추측보다 기회 손실이 안전" 원칙):
// - arity 범위가 하나라도 겹치면(같은 arity 재선언 포함) 이름 전체를 건드리지 않는다 — 기존
//   registerFuncSignature의 "이름이 이미 다른 선언과 충돌함" 하드 에러가 그대로 발동한다(TV의
//   같은-arity 오버로드는 인자 "타입" 디스패치가 필요해 별도 축, ROADMAP 참조).
// - 같은 이름의 MethodDecl이 공존하면 건드리지 않는다 — bare method 콜(callee가 Identifier인데
//   analyzer가 첫 인자 타입으로 method dispatch하는 형태, C676)의 수신자 판별과 인자 개수 매칭이
//   상호작용하면 method로 가야 할 콜을 FuncDecl 오버로드로 잘못 재배선할 수 있다.
// - 어느 범위에도 안 맞는 콜사이트는 개명하지 않는다 — 첫 선언이 표준 arity 에러를 담당한다.
//
// pine2py는 동명 UDF를 Python def 재정의(마지막 선언이 조용히 승리)로 내려 오디스패치하는 latent
// 버그라 오라클 대조 불가 — hand-verified E2E로 검증(DIVERGENCES 참조).

import type { CallExpr, FuncDecl, Script } from "../ast";

// registerFuncSignature와 동일한 계산: required = 기본값 없는 마지막 매개변수의 1-기반 인덱스
// (C565부터 기본값 위치 선두 제약 없음), max = 전체 매개변수 수.
function arityRange(decl: FuncDecl): [number, number] {
  let required = 0;
  decl.params.forEach((p, i) => {
    if (p.default === null) required = i + 1;
  });
  return [required, decl.params.length];
}

function pairwiseDisjoint(ranges: [number, number][]): boolean {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i]![0] <= ranges[j]![1] && ranges[j]![0] <= ranges[i]![1]) return false;
    }
  }
  return true;
}

export function resolveArityDisjointOverloads(script: Script): void {
  const funcDecls = new Map<string, FuncDecl[]>();
  const methodNames = new Set<string>();
  for (const stmt of script.body) {
    if (stmt.kind === "FuncDecl") {
      const list = funcDecls.get(stmt.name);
      if (list === undefined) funcDecls.set(stmt.name, [stmt]);
      else list.push(stmt);
    } else if (stmt.kind === "MethodDecl") {
      methodNames.add(stmt.name);
    }
  }

  const overloadSets = new Map<string, { decls: FuncDecl[]; ranges: [number, number][] }>();
  for (const [name, decls] of funcDecls) {
    if (decls.length < 2 || methodNames.has(name)) continue;
    const ranges = decls.map(arityRange);
    if (!pairwiseDisjoint(ranges)) continue;
    overloadSets.set(name, { decls, ranges });
  }
  if (overloadSets.size === 0) return;

  // 선언 개명 — 첫 선언은 원래 이름 유지(어느 범위에도 안 맞는 콜사이트의 에러 귀속처).
  for (const [name, { decls }] of overloadSets) {
    for (let i = 1; i < decls.length; i++) {
      decls[i]!.name = `${name}$ov$${i + 1}`;
    }
  }

  // 콜사이트 재배선 — 제네릭 프로퍼티 전수 순회(prepassIndexSingleCallSites와 동일 원칙:
  // kind 화이트리스트 없이 모든 서브트리를 훑어 새 문법이 CallExpr을 어디에 박아도 놓치지 않는다.
  // FuncDecl 본문 안 콜사이트도 포함 — 오버로드끼리의 상호 호출도 같은 규칙으로 재배선된다).
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const n = node as { kind?: string } & Record<string, unknown>;
    if (n.kind === "CallExpr") {
      const call = n as unknown as CallExpr;
      if (call.callee.kind === "Identifier") {
        const set = overloadSets.get(call.callee.name);
        if (set !== undefined) {
          const total = call.args.length + call.kwargs.length;
          for (let i = 1; i < set.decls.length; i++) {
            const [min, max] = set.ranges[i]!;
            if (total >= min && total <= max) {
              call.callee.name = set.decls[i]!.name;
              break;
            }
          }
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "kind" || key === "line" || key === "col") continue;
      walk(n[key]);
    }
  };
  walk(script.body);
}
