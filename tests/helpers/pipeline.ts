// runPipeline(): 오라클 골든 비교 테스트가 쓰는 전체 파이프라인 헬퍼
// (transpile -> compile -> bar 루프 실행). ROADMAP P0 "tests/helpers" 항목.

import { transpile } from "../../src/transpiler/pipeline";
import { run, type RunResult } from "../../src/runtime/engine";
import type { OHLCVData } from "../../src/runtime/context";

export function runPipeline(
  source: string,
  data: OHLCVData,
  inputs: Record<string, unknown> = {},
  options?: { chartTf?: string },
): RunResult {
  const result = transpile(source, options);
  if (!result.ok) {
    throw new Error(`transpile failed: ${result.errors.join("; ")}`);
  }
  return run(
    result.code,
    result.varSlots,
    result.taSlotCount,
    data,
    result.fnVarSlotCount,
    result.historySlotCount,
    result.taScratchSize,
    inputs,
    result.plotTitles,
    result.securityTfs,
    result.refHistorySlotCount,
    result.condCallHistorySlotCount,
    result.condCallRefHistorySlotCount,
  );
}
