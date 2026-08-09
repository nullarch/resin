// 바 실행 엔진: transpile()이 만든 2-layer 모듈(프리앰블 + `return function () {...}`)을
// 컴파일하고, ctx당 프리앰블을 1회만 실행해 얻은 per-bar 함수를 바별로 호출한다(ROADMAP P2-0
// "codegen 2-layer 출력" — UDF 함수 선언/상수가 매 바 재생성되지 않는다). 매 바 var 슬롯
// 스냅샷을 `var:<name>` 채널로 수집한다 (oracle golden의 bars[] 포맷과 동일 - gen_oracle.py 참조).

import { Context, type OHLCVData } from "./context";
import { rt } from "./rt";

export type BarSnapshot = Record<string, number>;

export interface PlotResult {
  title: string;
  values: number[];
}

export interface RunResult {
  bars: BarSnapshot[];
  finalVarState: BarSnapshot;
  plots: PlotResult[];
}

// 모듈 코드를 팩토리로 컴파일해 "ctx를 받아 per-bar 함수를 돌려주는" 인스턴스화 함수를 반환한다.
// 팩토리 호출(= 프리앰블 실행)은 ctx당 정확히 1회 — 반환된 per-bar 함수만 매 바 호출할 것.
export function compile(code: string): (ctx: Context) => () => void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("$", "rt", code) as (ctx: Context, runtime: typeof rt) => () => void;
  return (ctx: Context) => {
    const barFn = factory(ctx, rt);
    if (typeof barFn !== "function") {
      throw new Error("컴파일된 모듈이 per-bar 함수를 반환하지 않음 (2-layer 출력 형식이 아닌 코드)");
    }
    return barFn;
  };
}

export function run(
  code: string,
  varSlots: string[],
  taSlotCount: number,
  data: OHLCVData,
  fnVarSlotCount: number = 0,
  historySlotCount: number = 0,
  taScratchSize: number = 0,
  inputs: Record<string, unknown> = {},
  plotTitles: string[] = [],
  securityTfs: string[] = [],
  refHistorySlotCount: number = 0,
  condCallHistorySlotCount: number = 0,
  condCallRefHistorySlotCount: number = 0,
): RunResult {
  const ctx = new Context(
    data,
    varSlots.length,
    taSlotCount,
    fnVarSlotCount,
    historySlotCount,
    taScratchSize,
    inputs,
    plotTitles.length,
    securityTfs,
    refHistorySlotCount,
    condCallHistorySlotCount,
    condCallRefHistorySlotCount,
  );
  const barFn = compile(code)(ctx);
  const bars: BarSnapshot[] = [];

  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    barFn();
    const snap: BarSnapshot = {};
    for (let s = 0; s < varSlots.length; s++) {
      snap[`var:${varSlots[s]}`] = ctx.vars[s] as number;
    }
    bars.push(snap);
  }

  const finalVarState: BarSnapshot = {};
  for (let s = 0; s < varSlots.length; s++) {
    finalVarState[varSlots[s]!] = ctx.vars[s] as number;
  }

  const plots: PlotResult[] = plotTitles.map((title, i) => ({ title, values: ctx.plots[i]!.toArray() }));

  return { bars, finalVarState, plots };
}
