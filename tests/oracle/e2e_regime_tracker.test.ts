// oracle/cases/e2e_regime_tracker.pine: 패턴: 제어흐름 조합 / var+loop 누적 / enum+switch /
// map·array CRUD (ROADMAP P3 HARDEN, "패턴: 실전 지표 재현"의 후속 카테고리). 개별 조각은 전부
// 기존 오라클로 검증돼 있고, 이 케이스는 그 조각들의 "조합"이 bar-to-bar 상태 전이에서 golden과
// 갈리지 않는지가 목적.
//
// 신규 발견(오라클 무효 사례, DIVERGENCES.md #86): pine2py의 `pine_fn(ctx)`는 호출마다(=바마다)
// `class Direction(Enum): ...`을 함수 본문 안에서 새로 정의한다(codegen.py가 enum 선언을
// 함수-로컬 클래스로 방출) -- Python Enum은 신원(identity) 비교라 바마다 다시 만들어진 클래스의
// 멤버는 "같은 이름"이어도 이전 바에 `ctx.set_var`로 저장해둔 (이전 클래스의) 멤버와 `==`가 항상
// False다. `var Direction prevDir = ...`처럼 enum 타입 var를 다음 바에서 다시 읽어(`ctx.get_var`)
// 이번 바의 `dir`(이번 바 클래스의 인스턴스)과 비교하면 논리적으로 같은 값이어도 항상 불일치로
// 나온다 -- pine2py로 python 직접 실행해 재현 확인(streak가 bar0 이후 전부 1에 고정, prevDir가
// 매 바 dir를 "이미 따라잡은" 상태로만 관측됨). 이건 TV 시맨틱이 아니라 "함수 호출마다 클래스를
// 새로 만드는" pine2py 구현의 순수 아티팩트(GOAL.md "알려진 버그는 따르지 않는다" 적용 대상) --
// pine2js는 enum 멤버를 문자열 리터럴("EnumName.Member")로 낮춰 이런 신원 문제 자체가 없다.
// __obs_streak/__obs_streak 채널은 표준 compareToGolden에서 제외하고, 정상 동작을 가정한 손 계산
// 기대값(엔진이 var enum을 바마다 올바르게 영속시킨다면 나와야 하는 값)과 직접 대조한다. 나머지
// 6개 __obs 채널(count_up/down/flat, window_size/last, up_in_window)은 전부 "이번 바 안에서만"
// enum을 비교하는 경로(switch dispatch)라 이 버그의 영향을 받지 않아 표준 골든 비교가 유효하다.
//
// 컨테이너형 var 채널(var:counts, var:window)은 map_basic.pine/e2e_zigzag.pine과 같은 이유로
// bar-by-bar 골든 비교 대상에서 제외한다 -- gen_oracle.py의 observed()가 ctx._var_state의 값을
// 참조로만 캡처해(list/dict는 매 바 같은 객체를 in-place로 mutate) golden.bars[i]["var:window"]가
// 전부 "마지막 바 시점의 최종 상태"로 동일하게 찍힌다(직접 diff로 확인). __obs_ 스칼라 미러 채널은
// 값으로 복사되므로 이 문제가 없다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_regime_tracker";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const GOLDEN_SAFE_KEYS = [
  "var:__obs_count_up",
  "var:__obs_count_down",
  "var:__obs_count_flat",
  "var:__obs_window_size",
  "var:__obs_window_last",
  "var:__obs_up_in_window",
];

// dir 분류 시퀀스(diff=close-close[1], bar0은 na->두 비교 모두 falsy->else(flat)로 자연 낙하):
// [flat, up, up, down, up, up, up, down, up, up] -- sample10.json close=[101,102,103,102,104,
// 105,106,105,107,108]로 직접 손 계산, golden의 var:dir/누적 count 채널과 이미 일치 확인됨.
// streak: 직전 바의 dir와 비교해 같으면 +1, 다르면 1로 리셋(정상 영속 가정 하의 손 계산).
const EXPECTED_STREAK = [1, 1, 2, 1, 1, 2, 3, 1, 1, 2];

describe("oracle: e2e_regime_tracker (control-flow combo: var+loop / enum+switch / map·array CRUD)", () => {
  it("matches the pine2py golden bar-by-bar for the 6 safe scalar channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, GOLDEN_SAFE_KEYS);
  });

  it("computes the correct up/down/flat classification sequence via the map counters", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // bar0: close[1]이 na라 diff도 na -> 두 비교 모두 falsy -> flat. 이후 실제 diff 부호를 그대로 반영.
    const expectedUp = [0, 1, 2, 2, 3, 4, 5, 5, 6, 7];
    const expectedDown = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2];
    const expectedFlat = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < 10; i++) {
      expect(result.bars[i]!["var:__obs_count_up"]).toBe(expectedUp[i]);
      expect(result.bars[i]!["var:__obs_count_down"]).toBe(expectedDown[i]);
      expect(result.bars[i]!["var:__obs_count_flat"]).toBe(expectedFlat[i]);
    }
  });

  it("streak matches the hand-computed sequence (oracle invalid for this channel -- DIVERGENCES #86)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < 10; i++) {
      expect(result.bars[i]!["var:__obs_streak"]).toBe(EXPECTED_STREAK[i]);
    }
    expect(result.finalVarState.streak).toBe(2);
  });

  it("rolling window (capacity 3) grows then holds size 3, tracking the last-pushed direction code", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const expectedSize = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3];
    const expectedLast = [0, 1, 1, -1, 1, 1, 1, -1, 1, 1];
    const expectedUpInWindow = [0, 1, 2, 2, 2, 2, 3, 2, 2, 2];
    for (let i = 0; i < 10; i++) {
      expect(result.bars[i]!["var:__obs_window_size"]).toBe(expectedSize[i]);
      expect(result.bars[i]!["var:__obs_window_last"]).toBe(expectedLast[i]);
      expect(result.bars[i]!["var:__obs_up_in_window"]).toBe(expectedUpInWindow[i]);
    }
  });

  it("matches the pine2py golden final var state for the 6 safe scalar channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_count_up", "__obs_count_down", "__obs_count_flat", "__obs_window_size", "__obs_window_last", "__obs_up_in_window"]) {
      expect(result.finalVarState[key]).toBeCloseTo(golden.finalVarState[key] as number, 9);
    }
  });

  it("counts sum to the total bar count every bar (up+down+flat partition is exhaustive)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < 10; i++) {
      const sum =
        (result.bars[i]!["var:__obs_count_up"] as number) +
        (result.bars[i]!["var:__obs_count_down"] as number) +
        (result.bars[i]!["var:__obs_count_flat"] as number);
      expect(sum).toBe(i + 1);
    }
  });

  it("up_in_window never exceeds window_size (loop-scanned subset invariant)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_up_in_window"] as number).toBeLessThanOrEqual(bar["var:__obs_window_size"] as number);
    }
  });

  it("window_size never exceeds the capacity of 3 (push+shift gate holds every bar)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_window_size"] as number).toBeLessThanOrEqual(3);
    }
  });

  it("window_last is always exactly -1, 0, or 1 (direction-code sanity bound)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect([-1, 0, 1]).toContain(bar["var:__obs_window_last"]);
    }
  });

  it("streak resets to exactly 1 on every direction change and only grows on repeats", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 1; i < 10; i++) {
      const prev = result.bars[i - 1]!["var:__obs_streak"] as number;
      const cur = result.bars[i]!["var:__obs_streak"] as number;
      expect(cur === 1 || cur === prev + 1).toBe(true);
    }
  });

  it("emits exactly 2 plots with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["Streak", "UpInWindow"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_streak / __obs_up_in_window mirrors bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < result.bars.length; i++) {
      expect(result.plots[0]!.values[i]).toBe(result.bars[i]!["var:__obs_streak"]);
      expect(result.plots[1]!.values[i]).toBe(result.bars[i]!["var:__obs_up_in_window"]);
    }
  });

  it("is deterministic across repeated runs of the same composed pipeline", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const first = runPipeline(source, data);
    const second = runPipeline(source, data);

    expect(second.bars).toEqual(first.bars);
    expect(second.finalVarState).toEqual(first.finalVarState);
  });
});
