// 트랜스파일 파이프라인 오케스트레이션: Lexer -> Parser -> Analyzer -> TransformPasses(Hoisting)
// -> CodeGen. GOAL.md의 5단계 아키텍처 불변 원칙을 그대로 노출한다.

import { analyze, type AnalyzeOptions } from "./analyzer";
import { generateCode } from "./codegen";
import { hoist } from "./passes/hoisting";
import { ParseError, parse } from "./parser";

export interface TranspileOk {
  ok: true;
  code: string;
  varSlots: string[];
  taSlotCount: number;
  fnVarSlotCount: number;
  historySlotCount: number;
  taScratchSize: number; // 다중 반환 TA용 공유 스크래치 배열 크기 (없으면 0 — Context.taScratch 참조)
  plotTitles: string[]; // slot 순서대로 plot() 콜사이트 title (C135, engine.ts run()의 plotTitles 인자로 스레딩)
  securityTfs: string[]; // slot 순서대로 request.security() 콜사이트의 컴파일타임 tf 문자열 (engine.ts run()의 securityTfs 인자로 스레딩)
  refHistorySlotCount: number; // $.refHistSlots 배열 전체 크기 (배치25 (1), drawing 핸들 '=' 로컬 히스토리)
  condCallHistorySlotCount: number; // $.condCallHistSlots 배열 전체 크기 (C671, 조건부 위치 stateful 콜 압축 히스토리)
  condCallRefHistorySlotCount: number; // $.condCallRefHistSlots 배열 전체 크기 (C700, drawing 생성자 콜 인라인 히스토리 압축 인덱스)
  isStrategy: boolean; // top-level strategy() 지시어 유무 (배치28 (2), corpus_scan --exec 성과 요약 덤프가 strategy 스크립트만 골라내는 데 사용)
}

export interface TranspileErr {
  ok: false;
  errors: string[];
}

export type TranspileResult = TranspileOk | TranspileErr;

export function transpile(source: string, options?: AnalyzeOptions): TranspileResult {
  let script;
  try {
    script = parse(source);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, errors: [e.message] };
    throw e;
  }

  const analyzed = hoist(analyze(script, options));
  if (analyzed.errors.length > 0) {
    return { ok: false, errors: analyzed.errors };
  }

  const code = generateCode(analyzed);
  return {
    ok: true,
    code,
    varSlots: analyzed.varSlots,
    taSlotCount: analyzed.taSlotCount,
    fnVarSlotCount: analyzed.fnVarSlotCount,
    historySlotCount: analyzed.historySlotCount,
    taScratchSize: analyzed.taScratchSize,
    plotTitles: analyzed.plotTitles,
    securityTfs: analyzed.securityTfs,
    refHistorySlotCount: analyzed.refHistorySlotCount,
    condCallHistorySlotCount: analyzed.condCallHistorySlotCount,
    condCallRefHistorySlotCount: analyzed.condCallRefHistorySlotCount,
    isStrategy: analyzed.isStrategy,
  };
}
