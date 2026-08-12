// 튜플-switch/if/삼항/리터럴 RHS의 원소별 컨테이너 kind 분기 합의 전파(C685, ROADMAP P4
// next_hint(C684) getHighBox 표본 잔여 2차 갭 — wild f766597c1eed.pine 등 getActivity 패턴군 10건:
// `[vol4hr, vol4hrArr] = switch \n cond => r4hrbars.tfDraw(...) \n => tfDrawLower(...)`(분기마다
// method/UDF 콜이 [float, array<float>] 튜플 반환) 뒤 `vol4hrArr.getActivity(vol4hr)`(array<float>
// 첫 매개변수 extension method)가 "지원하지 않는 호출"로 거부되던 것).
// FuncInfo.tupleElemContainerKinds(C649)는 bare UDF 콜 RHS(tupleUdfCalleeName 게이트)에서만
// scope.containerKindHints로 흘렀고 ctrlFlow 경로(switch/if/삼항/튜플리터럴)는 통째로 미배선 —
// TupleBranchValueResult에 elemContainerKinds(+분기 간 합의 실패 시 conflict 포이즈닝)를 스레딩해
// 해소. 부수로 UDF/method 본문 꼬리가 if/switch/삼항 튜플 반환일 때도 같은 결과를
// FuncInfo.tupleElemContainerKinds에 실어 "tupleArity 확정 == 원소 kind 확정" 불변식을 대칭 유지.
// 오라클 불가 축(컨테이너 핸들 튜플은 pine2py 함수 모드 관측 채널이 없음) — hand-verified E2E.

import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { run } from "../../src/runtime/engine";
import type { OHLCVData } from "../../src/runtime/context";

const DATA: OHLCVData = {
  open: [1, 2, 3],
  high: [2, 3, 4],
  low: [1, 2, 3],
  close: [2, 3, 4],
  volume: [1, 1, 1],
};

// 두 분기 공용: [float, array<float>] 튜플을 반환하는 var-stateful UDF 한 쌍.
const TUPLE_UDFS = [
  "f() =>",
  "    var a = array.new_float()",
  "    array.push(a, close)",
  "    [close, a]",
  "g() =>",
  "    var a = array.new_float()",
  "    array.push(a, open)",
  "    [open, a]",
];

describe("tuple ctrl-flow RHS element container-kind propagation (C685)", () => {
  it("accepts the exact wild idiom: switch with a scalar-receiver extension-method branch + a bare UDF default branch, then an array<float> extension method on the tuple target", () => {
    const result = transpile(
      [
        "method tfDraw(int tfDiff, bool show) =>",
        "    var volRolling = array.new_float()",
        "    array.push(volRolling, close + tfDiff)",
        "    [close, volRolling]",
        "tfDrawLower(bool show) =>",
        "    var volRolling = array.new_float()",
        "    array.push(volRolling, close * 2)",
        "    [open, volRolling]",
        "method getActivity(array<float> id, float id2) =>",
        "    id.size() > 0 ? array.sum(id) + id2 : id2",
        "var r4hrbars = 4",
        "[vol4hr, vol4hrArr] = switch",
        "    close > open => r4hrbars.tfDraw(true)",
        "    =>              tfDrawLower(true)",
        "plot(vol4hrArr.getActivity(vol4hr))",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts array method-call sugar on a switch-RHS tuple target when both branches are bare UDF calls", () => {
    const result = transpile(
      [...TUPLE_UDFS, "[v, arr] = switch", "    close > open => f()", "    =>              g()", "plot(arr.size())"].join(
        "\n",
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts array method-call sugar on an if-RHS tuple target", () => {
    const result = transpile(
      [
        ...TUPLE_UDFS,
        "[v, arr] = if close > open",
        "    f()",
        "else",
        "    g()",
        "plot(arr.size())",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts array method-call sugar on a ternary-RHS tuple target", () => {
    const result = transpile(
      [...TUPLE_UDFS, "[v, arr] = close > open ? f() : g()", "plot(arr.size())"].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts array method-call sugar on a direct tuple-literal RHS target (`[v, arr] = [close, array.new_float()]`)", () => {
    const result = transpile(
      ["[v, arr] = [close, array.new_float()]", "if close > open", "    arr.push(close)", "plot(arr.size())"].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("propagates a map container kind from switch branches (`m.put(...)` sugar on the tuple target)", () => {
    const result = transpile(
      [
        "fm() =>",
        "    var m = map.new<string, float>()",
        "    [close, m]",
        "gm() =>",
        "    var m = map.new<string, float>()",
        "    [open, m]",
        "[v, m] = switch",
        "    close > open => fm()",
        "    =>              gm()",
        'm.put("k", v)',
        'plot(m.size())',
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("does NOT register a hint when branch verdicts conflict (array vs map) — the sugar call stays rejected instead of misdispatching", () => {
    const result = transpile(
      [
        "[v, x] = close > open ? [close, array.new_float()] : [open, map.new<string, float>()]",
        "plot(x.size())",
      ].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("; ")).toContain("unsupported call");
  });

  it("a [na, na] fallback branch does not block the other branch's verdict (null merges, no conflict)", () => {
    const result = transpile(
      [...TUPLE_UDFS, "[v, arr] = close > open ? f() : [na, na]", "plot(arr.size())"].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("propagates through a nested if inside a switch case (resolveTupleValueBranchStmt recursion)", () => {
    const result = transpile(
      [
        ...TUPLE_UDFS,
        "[v, arr] = switch",
        "    close > 0 =>",
        "        if open > 0",
        "            f()",
        "        else",
        "            g()",
        "    => g()",
        "plot(arr.size())",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("carries the container kind through a UDF whose body TAIL is a switch tuple return, then out through the call-site destructure (FuncInfo.tupleElemContainerKinds symmetric wiring)", () => {
    const result = transpile(
      [
        ...TUPLE_UDFS,
        "getArrays() =>",
        "    switch",
        "        close > open => f()",
        "        =>              g()",
        "[v, arr] = getArrays()",
        "plot(arr.size())",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("computes the wild-mirror extension method values end-to-end (hand-verified: always-true branch accumulates close, sum + current)", () => {
    const result = transpile(
      [
        ...TUPLE_UDFS,
        "method total(array<float> id, float extra) =>",
        "    array.sum(id) + extra",
        "[v, arr] = switch",
        "    bar_index >= 0 => f()",
        "    =>                g()",
        "var float __obs_t = na",
        "__obs_t := arr.total(v)",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    // close = [2,3,4]: bar0 a=[2] → 2+2=4, bar1 a=[2,3] → 5+3=8, bar2 a=[2,3,4] → 9+4=13
    expect(bars.map((b) => b["var:__obs_t"])).toEqual([4, 8, 13]);
  });

  it("executes ternary-RHS with a [na, na] branch end-to-end (`arr.size()` grows only on the UDF branch bars)", () => {
    const result = transpile(
      [
        ...TUPLE_UDFS,
        "[v, arr] = bar_index >= 0 ? f() : [na, na]",
        "var float __obs_n = na",
        "__obs_n := arr.size()",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_n"])).toEqual([1, 2, 3]);
  });

  it("still rejects container sugar on a tuple target whose value gives no container verdict at all (pure numeric branches — regression guard)", () => {
    const result = transpile(
      [
        "[v, x] = switch",
        "    close > open => [close, 1.0]",
        "    =>              [open, 2.0]",
        "plot(x.size())",
      ].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("; ")).toContain("unsupported call");
  });
});
