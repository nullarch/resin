// compareToGolden(): oracle/golden/*.json (pine2py 산출)과 JS 파이프라인 결과를 바별로 비교.
// 허용 오차: |a-b| <= 1e-9 + 1e-9*max(|a|,|b|). 양쪽 NaN이면 PASS, 한쪽만 NaN이면 FAIL.
// (CLAUDE.md STEP 5 비교 기준)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OHLCVData } from "../../src/runtime/context";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GOLDEN_DIR = join(ROOT, "oracle", "golden");
const DATA_DIR = join(ROOT, "oracle", "data");

type Sentinel = number | string;

export interface GoldenCase {
  ok: boolean;
  data: string;
  bars: Record<string, Sentinel>[];
  finalVarState: Record<string, Sentinel>;
}

export function loadGolden(name: string): GoldenCase {
  const path = join(GOLDEN_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as GoldenCase;
}

export function loadOracleData(name: string): OHLCVData {
  let path = join(DATA_DIR, `${name}.json`);
  if (!existsSync(path)) path = join(DATA_DIR, "sample10.json");
  return JSON.parse(readFileSync(path, "utf-8")) as OHLCVData;
}

export function decodeSentinel(v: Sentinel): number {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  return v as number;
}

export function nearlyEqual(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  // a===b 단락 평가: 동일 부호 Infinity끼리는 a-b가 Infinity-Infinity=NaN이 돼 아래 tol 비교가
  // 항상 false로 깨진다(str.tonumber("Infinity") 오라클 케이스, C87에서 최초로 실제 Infinity 값이
  // 오라클에 등장하며 발견 — GOAL.md 안전 연산 원칙상 그동안 유한값만 흘렀던 기존 케이스들은 이
  // 분기 추가로 동작이 바뀌지 않는다: a===b면 기존 공식도 이미 abs(a-b)=0<=tol로 true였음).
  if (a === b) return true;
  const tol = 1e-9 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tol;
}

// onlyKeys: 지정하면 골든 바의 이 키들만 비교한다(기본은 전체 키 비교, 기존 호출부 전부 그대로
// 동작). UDF 내부 var(예: udf_single_var.pine의 'total')는 pine2py의 ctx._var_state 스냅샷에는
// 잡히지만, pine2js는 설계상 그 상태를 콜사이트별 $.fnVars에 격리해 top-level var:<name> 채널로
// 노출하지 않는다(의도된 격리 — GOAL.md slotBase 전파). 그런 케이스는 __obs_* 채널만 골라 비교한다.
export function compareToGolden(actualBars: Record<string, number>[], golden: GoldenCase, onlyKeys?: string[]): void {
  if (!golden.ok) {
    throw new Error("golden case is not ok (오라클 자체가 transpile/runtime 에러 기록)");
  }
  if (actualBars.length !== golden.bars.length) {
    throw new Error(`bar 개수 불일치: actual=${actualBars.length} golden=${golden.bars.length}`);
  }
  for (let i = 0; i < golden.bars.length; i++) {
    const expectedBar = golden.bars[i]!;
    const actualBar = actualBars[i]!;
    const keys = onlyKeys ?? Object.keys(expectedBar);
    for (const key of keys) {
      const expected = decodeSentinel(expectedBar[key]!);
      const actual = actualBar[key];
      if (actual === undefined) {
        throw new Error(`bar ${i}: actual 출력에 '${key}' 키가 없음`);
      }
      if (!nearlyEqual(actual, expected)) {
        throw new Error(`bar ${i} key '${key}': actual=${actual} expected=${expected}`);
      }
    }
  }
}

// compareStringToGolden(): string 반환 빌트인(str.lower/upper/trim/replace_all/substring/repeat 등,
// C77) 전용 — compareToGolden/decodeSentinel/nearlyEqual은 numeric 전용 설계라(golden.ts 상단 주석,
// C76 발견) 문자열 값에는 그대로 못 쓴다. 오차 허용치 없이 정확히 일치해야 하며, "NaN"/"Infinity"류
// 숫자 센티널 디코딩을 거치지 않는다(문자열 값이 우연히 그 리터럴과 같아도 그대로 문자열로 비교).
export function compareStringToGolden(
  actualBars: Record<string, string | null>[],
  golden: GoldenCase,
  onlyKeys?: string[],
): void {
  if (!golden.ok) {
    throw new Error("golden case is not ok (오라클 자체가 transpile/runtime 에러 기록)");
  }
  if (actualBars.length !== golden.bars.length) {
    throw new Error(`bar 개수 불일치: actual=${actualBars.length} golden=${golden.bars.length}`);
  }
  for (let i = 0; i < golden.bars.length; i++) {
    const expectedBar = golden.bars[i]!;
    const actualBar = actualBars[i]!;
    const keys = onlyKeys ?? Object.keys(expectedBar);
    for (const key of keys) {
      const expected = expectedBar[key] as string | null;
      const actual = actualBar[key];
      if (actual === undefined) {
        throw new Error(`bar ${i}: actual 출력에 '${key}' 키가 없음`);
      }
      if (actual !== expected) {
        throw new Error(`bar ${i} key '${key}': actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
      }
    }
  }
}
