// array<UDT> 원소 접근(array.get/pop/shift/first/last/remove, C341) 뒤 '=' 로컬의 UDT 필드 읽기 --
// wild "네임스페이스 접근은 호출식만 지원" 클러스터 장꼬리(`ob = array.get(activeOBs, i)` 뒤
// `ob.isBullish`류). analyzer.ts의 resolveArrayGetElemUdtType/arrayUdtElemType(analyzer/udt-types.ts)
// 신규 구현 검증. 캐너니컬 `array.get`/`array.pop` 채널은 oracle/cases/udt_array_elem_field.pine이
// pine2py와 바별 대조하므로 여기서는 (a) method-call sugar `container.get(idx)` -- pine2py 자신의
// latent 버그(UDT 원소 배열에서만 idx 정수를 그대로 반환)로 오라클 불가라 hand-verified, (b) 나머지
// 원소-반환 메서드(shift/first/last/remove)의 최소 스모크, (c) UDF 매개변수 경유(값 흐름 추적
// 없음, 여전히 범위 밖)가 여전히 거부되는 회귀 가드, (d) 명시 `array<UDT>` typeHint 없는 컨테이너
// (`array.new<UDT>()` 생성자 콜 자체에서 구조 판별, C355 — 과거엔 이 typeHint 부재가 거부 사유였으나
// parser.ts DotAccess.genericElemType 보존으로 해소됨, LIMITATIONS.md C341 갱신 참조), (e) 매개변수
// 자신엔 타입힌트가 전혀 없어도 top-level 콜사이트 인자로 array<UDT> 원소 타입을 역추론하는
// paramArrayElemUdtTypes(C469, wild `findLevel(levels, ...) => ... array.get(levels, i).price`류
// — 스칼라 UDT 버전 paramUdtTypes/prepassInferParamUdtTypesFromCallSites의 array 자매 메커니즘).

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

function udtSource(body: string): string {
  return ["type OrderBlock", "    float top", "    float bottom", "    bool isBullish", body].join("\n");
}

describe("array<UDT> element field access (C341)", () => {
  it("resolves a method-call sugar `container.get(idx)` element's UDT field (hand-verified — pine2py's own .get() sugar returns the raw index for UDT-element arrays, not the element, so this channel can't be oracle-compared)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "secondBlock = obs.get(1)",
        "var float __obs_bottom = na",
        "__obs_bottom := secondBlock.bottom",
        "var bool __obs_bull = na",
        "__obs_bull := secondBlock.isBullish",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([1.5, 1.5, 1.5]);
    expect(bars.map((b) => b["var:__obs_bull"])).toEqual([false, false, false]);
  });

  it("resolves array.shift(container)/array.first(container)/array.last(container) element UDT fields (hand-verified structural smoke)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "    array.push(obs, OrderBlock.new(3.0, 2.5, true))",
        "firstEl = array.first(obs)",
        "lastEl = array.last(obs)",
        "var float __obs_first_top = na",
        "__obs_first_top := firstEl.top",
        "var float __obs_last_top = na",
        "__obs_last_top := lastEl.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_first_top"])).toEqual([1.0, 1.0, 1.0]);
    expect(bars.map((b) => b["var:__obs_last_top"])).toEqual([3.0, 3.0, 3.0]);
  });

  it("resolves array.remove(container, idx) element UDT field (hand-verified structural smoke)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "var float __obs_removed_top = na",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "    removed = array.remove(obs, 0)",
        "    __obs_removed_top := removed.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_removed_top"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("resolves field access on an element from a container without an explicit array<UDT> typeHint (C355 — array.new<UDT>() alone now preserves T via parser.ts DotAccess.genericElemType, closing the gap C341 left open)", () => {
    const source = udtSource(
      [
        "var obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "first = array.get(obs, 0)",
        "var float __obs = na",
        "__obs := first.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("still rejects field access on a value returned from a UDF (no static container type, out of scope for this slice)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "f() =>",
        "    array.get(obs, 0)",
        "x = f()",
        "var float __obs = na",
        "__obs := x.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/namespace access supported only as a call expression/);
  });

  it("does not spuriously tag a plain (non-UDT) array.get() result, leaving existing scalar behavior unchanged", () => {
    const source = [
      "var array<float> nums = array.new<float>()",
      "array.push(nums, 10.0)",
      "x = array.get(nums, 0)",
      "var float __obs = na",
      "__obs := x + 1.0",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([11.0, 11.0, 11.0]);
  });

  // C390: 위 테스트들은 전부 method-call sugar 결과를 '=' 로컬에 먼저 담은 뒤(`secondBlock = obs.get(1)`)
  // 필드를 읽었다 -- wild `sequence.first().dir`/`sequence.get(1).dir`류(63e13818950a.pine)는 그 중간
  // '=' 로컬 없이 필드를 바로 체이닝한다. analyzer.ts의 analyzeExpr(DotAccess) 케이스가
  // resolveUdtObjectType(Identifier/DotAccess만 인정)만 호출해 obj가 CallExpr이면 그대로 "네임스페이스
  // 접근은 호출식만 지원"으로 낙하하던 갭 -- call-expr.ts의 resolveUdtMethodReceiverType(C354, method
  // 호출 수신자 판별용)과 동일한 resolveUdtObjectType ?? resolveArrayGetElemUdtType 조합을 필드 읽기
  // 소비처에도 적용해 해소.
  it("resolves field access chained directly on a method-call sugar element-returning call, with no intermediate '=' local (C390 -- `obs.first().top`, the wild `sequence.first().dir` idiom)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "var float __obs_first_top = na",
        "__obs_first_top := obs.first().top",
        "var bool __obs_last_bull = na",
        "__obs_last_bull := obs.last().isBullish",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_first_top"])).toEqual([1.0, 1.0, 1.0]);
    expect(bars.map((b) => b["var:__obs_last_bull"])).toEqual([false, false, false]);
  });

  it("resolves field access chained directly on `container.get(idx).field` (C390, method-call sugar with an argument)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "var float __obs_bottom = na",
        "__obs_bottom := obs.get(1).bottom",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([1.5, 1.5, 1.5]);
  });

  it("resolves field access chained directly on the canonical `array.get(container, idx).field` form as well (C390, not just method-call sugar)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "var float __obs = na",
        "__obs := array.get(obs, 0).top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("still rejects field access chained directly on a UDF call result (`f().top`, no static array-elem structure -- C390 extends only array.get/pop/shift/first/last/remove receivers, not arbitrary UDF calls)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "f() =>",
        "    array.get(obs, 0)",
        "var float __obs = na",
        "__obs := f().top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/namespace access supported only as a call expression/);
  });

  // C393: 위 테스트는 전부 컨테이너 자체가 top-level `var array<OrderBlock> obs = ...`였다. wild
  // `perI5Best = array.new<Pattern>()`(if 블록 안 '=' 로컬, var 아님) 뒤 `c = array.get(perI5Best,
  // i)` \ `c.valid`류(d0f27a38bea5.pine)는 resolveArrayElemUdtType이 top-level var 전용
  // prog.arrayElemUdtType만 조회해 '=' 로컬 컨테이너의 원소 타입을 못 찾아 막혔다(analyzer.ts
  // 기존 주석이 명시적으로 "'=' 로컬 컨테이너 자체의 원소 타입은 여전히 대상 밖"이라 적어둔 문서화된
  // 갭). scope 체인 전용 arrayElemUdtKindHints(udtKindHints/containerKindHints와 나란한 C224 패턴)
  // 신설로 해소 -- UDF 로컬을 포함해 어느 깊이의 '=' 로컬 컨테이너에도 동일하게 적용된다(udtKindHints가
  // 원래 스코프 게이트 없는 전역 메커니즘이라는 C387의 관찰과 동일 축).
  it("resolves field access on an element retrieved from an eq-local (non-var) array<UDT> container declared at top level (C393)", () => {
    const source = udtSource(
      [
        "obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "c = array.get(obs, 1)",
        "var float __obs_bottom = na",
        "__obs_bottom := c.bottom",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([1.5, 1.5, 1.5]);
  });

  it("resolves field access on an eq-local array<UDT> container declared inside a nested block, retrieved by another eq-local inside a further-nested for loop (C393, the exact wild d0f27a38bea5.pine idiom)", () => {
    const source = udtSource(
      [
        "var int barN = 0",
        "barN := barN + 1",
        "var bool __hit = na",
        "__hit := false",
        "if barN >= 1",
        "    obs = array.new<OrderBlock>()",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    for i = 0 to array.size(obs) - 1",
        "        c = array.get(obs, i)",
        "        if c.isBullish",
        "            __hit := true",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__hit"])).toEqual([true, true, true]);
  });

  it("resolves field access on an eq-local array<UDT> container declared inside a UDF body (scope-chain hint applies regardless of func-local depth, same as udtKindHints/containerKindHints)", () => {
    const source = udtSource(
      [
        "f() =>",
        "    inner = array.new<OrderBlock>()",
        "    array.push(inner, OrderBlock.new(9.0, 4.0, true))",
        "    c = array.get(inner, 0)",
        "    c.top",
        "var float __obs = na",
        "__obs := f()",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([9.0, 9.0, 9.0]);
  });

  it("resolves field access when the eq-local container carries an explicit `array<UDT>` type hint instead of relying on the array.new<UDT>() generic form (C393, both feed arrayElemUdtKindHints)", () => {
    const source = udtSource(
      [
        "array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "c = array.get(obs, 0)",
        "var float __obs = na",
        "__obs := c.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("does not spuriously tag a plain (non-UDT) eq-local array.get() result, leaving existing scalar behavior unchanged (C393, eq-local version of the existing var regression guard)", () => {
    const source = ["nums = array.new<float>()", "array.push(nums, 10.0)", "x = array.get(nums, 0)", "var float __obs = na", "__obs := x + 1.0"].join(
      "\n",
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([11.0, 11.0, 11.0]);
  });

  it("still rejects field access when the eq-local container's value comes from a UDF call (no static array.new<T>() constructor structure, still out of scope)", () => {
    const source = udtSource(
      [
        "makeArr() =>",
        "    array.new<OrderBlock>()",
        "obs = makeArr()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "c = array.get(obs, 0)",
        "var float __obs = na",
        "__obs := c.top",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/namespace access supported only as a call expression/);
  });

  // C457: 위 테스트들은 컨테이너 자체가 array.new<UDT>() 생성자 콜로 만들어졌다. wild
  // `sorted_levels = array.copy(sr_levels)`(0c7cfcfd19a8.pine, func-local '=' 로컬이 top-level
  // var array<UDT>를 array.copy()로 복사)류는 copy()가 ARRAY_CONSTRUCTOR_METHODS에 있어
  // isArrayConstructorCall은 이미 array로 인정했지만 arrayUdtConstructorElemType이 new_generic
  // 전용이라 원소 UDT 타입 전파가 끊겨(level1.strength 접근 실패) 있었다 -- resolveArrayElemUdtType
  // 재사용으로 canonical `array.copy(container)`/method-sugar `container.copy()` 둘 다 container의
  // 이미 확정된 원소 타입을 그대로 물려받도록 수정.
  it("propagates array<UDT> element type through canonical array.copy(container) (C457, wild sorted_levels idiom)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "copied = array.copy(obs)",
        "var float __obs_bottom = na",
        "for i = 0 to array.size(copied) - 1",
        "    el = array.get(copied, i)",
        "    if el.isBullish",
        "        __obs_bottom := el.bottom",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([0.5, 0.5, 0.5]);
  });

  it("propagates array<UDT> element type through method-call sugar container.copy() inside a UDF body (C457, exact wild 0c7cfcfd19a8.pine idiom: func-local copy of a top-level var array<UDT>, sorted/compared via nested-loop bubble sort)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, false))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, true))",
        "sortObs() =>",
        "    sorted = obs.copy()",
        "    for i = 0 to array.size(sorted) - 1",
        "        for j = 0 to array.size(sorted) - 2",
        "            level1 = array.get(sorted, j)",
        "            level2 = array.get(sorted, j + 1)",
        "            if level1.isBullish and not level2.isBullish",
        "                array.set(sorted, j, level2)",
        "                array.set(sorted, j + 1, level1)",
        "    array.get(sorted, 0).top",
        "var float __obs_top = na",
        "__obs_top := sortObs()",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    // obs[0]=(top=1.0, isBullish=false), obs[1]=(top=2.0, isBullish=true) -- swap condition
    // (level1.isBullish and not level2.isBullish) is false at j=0 (false and true), so no swap
    // happens and sorted[0] stays obs[0] (top=1.0). The point of this test is that sorted[0].top
    // resolves to a numeric UDT field at all (elem UDT type propagated through .copy()), not the
    // sort outcome itself.
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("does not spuriously tag a plain (non-UDT) array.copy() result, leaving existing scalar behavior unchanged (C457 regression guard)", () => {
    const source = [
      "var array<float> nums = array.new<float>()",
      "array.push(nums, 10.0)",
      "copied = array.copy(nums)",
      "x = array.get(copied, 0)",
      "var float __obs = na",
      "__obs := x + 1.0",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([11.0, 11.0, 11.0]);
  });

  // C458: 위 테스트들은 컨테이너 자체가 array.new<UDT>()/.copy()로 만들어진 값을 직접(또는 aliased
  // Identifier로) 담은 '=' 로컬이었다. wild 0c7cfcfd19a8.pine의 `broken_levels = check_level_breaks()`
  // (check_level_breaks가 UDF이고 본문 마지막 문장이 bare Identifier로 array<UDT> 로컬을 반환)류는
  // isArrayConstructorCall/arrayUdtConstructorElemType 둘 다 `value.callee.kind==="DotAccess"`만
  // 인정해 bare UDF 콜(`callee.kind==="Identifier"`)엔 애초에 도달조차 못 했다(C457이 해소한 것은
  // "이미 array로 인정된 컨테이너의 원소타입 전파" 축, 이건 "UDF 반환값 자체가 array로 인정되는지"
  // 축이라 별개). FuncInfo.returnArrayElemUdtType(returnUdtType의 배열 버전, C253과 나란한 구조)
  // 신설로 해소.
  it("propagates array<UDT> element type through a bare UDF call whose body returns an array<UDT> local by bare Identifier (C458, exact wild 0c7cfcfd19a8.pine idiom: `broken_levels = check_level_breaks()`)", () => {
    const source = udtSource(
      [
        "getBrokenLevels() =>",
        "    broken = array.new<OrderBlock>()",
        "    array.push(broken, OrderBlock.new(1.0, 0.5, true))",
        "    broken",
        "result = getBrokenLevels()",
        "var float __obs_top = na",
        "__obs_top := array.get(result, 0).top",
      ].join("\n"),
    );
    const transpileResult = transpile(source);
    expect(transpileResult.ok).toBe(true);
    if (!transpileResult.ok) return;
    const { bars } = run(transpileResult.code, transpileResult.varSlots, transpileResult.taSlotCount, DATA, transpileResult.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("propagates array<UDT> element type through a bare UDF call whose last statement is an Assignment-tail bare identifier (var-less '=' re-alias, not a bare ExprStmt, C705 next_hint(C704))", () => {
    const source = udtSource(
      [
        "getBrokenLevels() =>",
        "    broken = array.new<OrderBlock>()",
        "    array.push(broken, OrderBlock.new(1.0, 0.5, true))",
        "    out = broken",
        "result = getBrokenLevels()",
        "var float __obs_top = na",
        "__obs_top := array.get(result, 0).top",
      ].join("\n"),
    );
    const transpileResult = transpile(source);
    expect(transpileResult.ok).toBe(true);
    if (!transpileResult.ok) return;
    const { bars } = run(transpileResult.code, transpileResult.varSlots, transpileResult.taSlotCount, DATA, transpileResult.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("propagates array<UDT> element type when the UDF's last statement is an if/else choosing between two same-typed array<UDT> locals (C458, IfStmt branch of inferReturnStmtArrayElemUdtType mirroring the existing single-UDT inferReturnStmtUdtType recursion)", () => {
    const source = udtSource(
      [
        "pickList(useA) =>",
        "    listA = array.new<OrderBlock>()",
        "    array.push(listA, OrderBlock.new(1.0, 0.5, true))",
        "    listB = array.new<OrderBlock>()",
        "    array.push(listB, OrderBlock.new(9.0, 4.0, false))",
        "    if useA",
        "        listA",
        "    else",
        "        listB",
        "chosen = pickList(true)",
        "var float __obs_top = na",
        "__obs_top := array.get(chosen, 0).top",
      ].join("\n"),
    );
    const transpileResult = transpile(source);
    expect(transpileResult.ok).toBe(true);
    if (!transpileResult.ok) return;
    const { bars } = run(transpileResult.code, transpileResult.varSlots, transpileResult.taSlotCount, DATA, transpileResult.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("does not spuriously tag a bare UDF call returning a plain (non-UDT) array, leaving existing behavior unchanged (C458 regression guard)", () => {
    const source = [
      "getNums() =>",
      "    nums = array.new<float>()",
      "    array.push(nums, 10.0)",
      "    nums",
      "result = getNums()",
      "var float __obs = na",
      "__obs := array.get(result, 0) + 1.0",
    ].join("\n");
    const transpileResult = transpile(source);
    expect(transpileResult.ok).toBe(true);
    if (!transpileResult.ok) return;
    const { bars } = run(transpileResult.code, transpileResult.varSlots, transpileResult.taSlotCount, DATA, transpileResult.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([11.0, 11.0, 11.0]);
  });

  // C469: 위 테스트들의 컨테이너는 전부 array.new<UDT>()/.copy() 같은 "값 자체"에서 원소 타입이
  // 나왔다. wild `findLevel(levels, price, isSupport) => ... lvl = array.get(levels, i) ...
  // lvl.price`류(3f0302e5cb2f.pine)는 매개변수 levels 자신에 타입힌트가 전혀 없고, 유일한 단서는
  // 그 함수가 top-level에서 실제로 어떤 array<UDT> 인자로 호출되는가뿐이다 — 기존 paramUdtTypes
  // (스칼라 UDT 인자 역추론, prepassInferParamUdtTypesFromCallSites)의 array<UDT> 버전을
  // paramArrayElemUdtTypes로 신설, resolveArrayElemUdtType의 매개변수 조회 분기에 폴백으로 추가.
  it("infers an untyped UDF parameter's array<UDT> element type from a top-level call site passing a typed container (C469, the exact wild findLevel(levels, ...) idiom)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "var int barN = 0",
        "barN := barN + 1",
        "if barN == 1",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "findFirstBullish(levels) =>",
        "    result = 0.0",
        "    for i = 0 to array.size(levels) - 1",
        "        lvl = array.get(levels, i)",
        "        if lvl.isBullish",
        "            result := lvl.top",
        "    result",
        "var float __obs_found = na",
        "__obs_found := findFirstBullish(obs)",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_found"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("infers the parameter's array<UDT> element type even when the top-level container uses the array.new<UDT>() generic form without an explicit array<UDT> typeHint (C469, mirrors C355's typeHint-optional channel)", () => {
    const source = udtSource(
      [
        "obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(3.0, 1.0, true))",
        "sumTops(levels) =>",
        "    lvl = array.get(levels, 0)",
        "    lvl.top",
        "var float __obs = na",
        "__obs := sumTops(obs)",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([3.0, 3.0, 3.0]);
  });

  it("does not spuriously tag a plain (non-UDT) array parameter, leaving existing scalar behavior unchanged (C469 regression guard)", () => {
    const source = [
      "var array<float> nums = array.new<float>()",
      "array.push(nums, 10.0)",
      "sumAll(vals) =>",
      "    array.get(vals, 0)",
      "var float __obs = na",
      "__obs := sumAll(nums) + 1.0",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([11.0, 11.0, 11.0]);
  });

  it("leaves an explicit param typeHint (C415) untouched — call-site inference never overrides a parameter that already declares its own array<UDT> type", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "readTop(array<OrderBlock> levels) =>",
        "    array.get(levels, 0).top",
        "var float __obs = na",
        "__obs := readTop(obs)",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([1.0, 1.0, 1.0]);
  });

  it("still rejects when the same parameter slot receives two different top-level array<UDT> element types across call sites (ambiguous — safer to leave unresolved than guess, same principle as the existing scalar paramUdtTypes ambiguity gate)", () => {
    const source = [
      "type A",
      "    float x",
      "type B",
      "    float y",
      "var array<A> as_ = array.new<A>()",
      "var array<B> bs_ = array.new<B>()",
      "array.push(as_, A.new(1.0))",
      "array.push(bs_, B.new(2.0))",
      "readFirst(levels) =>",
      "    array.get(levels, 0)",
      "a = readFirst(as_)",
      "b = readFirst(bs_)",
      "var float __obs = na",
      "__obs := a.x",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/namespace access supported only as a call expression/);
  });

  it("still rejects field access when the array<UDT> container reaches the callee only transitively through another function's own untyped parameter (C469 documents this as a remaining gap, exact wild 3c1081fa6ee1.pine idiom — the call-site scan never enters FuncDecl bodies, so `outer(topLevelArr) => inner(topLevelArr)` isn't traced)", () => {
    const source = udtSource(
      [
        "var array<OrderBlock> obs = array.new<OrderBlock>()",
        "array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "inner(levels) =>",
        "    array.get(levels, 0).top",
        "outer(levels) =>",
        "    inner(levels)",
        "var float __obs = na",
        "__obs := outer(obs)",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/namespace access supported only as a call expression/);
  });

  // C491: 위 테스트들의 UDF 반환 array<UDT>는 전부 array.get()/array.copy() 등 CallExpr 경유로
  // 한 번 더 꺼낸 뒤 필드를 읽었다. wild 05bfea84f824.pine L296의
  // `for [i, v] in f_getAllPairCombinations(...)`는 이터러블 자리에 '=' 로컬 대입 없이 bare UDF
  // 콜이 직접 온다 — resolveContainerExprKind는 이미 isArrayConstructorCall의 bare UDF 분기(C458)로
  // kind="array"를 반환해 for-in 자체는 통과했지만, analyzeForInStmt가 루프 변수 UDT 힌트를 얻으려
  // 호출하는 resolveArrayElemUdtType(target=이터러블 자신)이 Identifier/DotAccess만 처리해 CallExpr
  // 이터러블은 그대로 null로 떨어져 v.field 접근이 거부됐다. resolveArrayElemUdtType에 CallExpr
  // 분기(FuncInfo.returnArrayElemUdtType 재조회, isArrayConstructorCall과 동일 원칙) 추가로 해소.
  it("resolves a for-in tuple destructure loop var's UDT field when the iterable is a bare UDF call with no intermediate '=' local (C491, exact wild f_getAllPairCombinations(...) idiom)", () => {
    const source = udtSource(
      [
        "getBlocks() =>",
        "    obs = array.new<OrderBlock>()",
        "    array.push(obs, OrderBlock.new(1.0, 0.5, true))",
        "    array.push(obs, OrderBlock.new(2.0, 1.5, false))",
        "    obs",
        "var float __obs_bottom = na",
        "for [i, v] in getBlocks()",
        "    if v.isBullish",
        "        __obs_bottom := v.bottom",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([0.5, 0.5, 0.5]);
  });

  it("also dispatches a user-declared UDT method-call sugar on the loop var for the same bare-UDF-call iterable (C491, udtKindHints registration is shared by field reads and method-call sugar alike)", () => {
    const source = [
      "type OrderBlock",
      "    float top",
      "    float bottom",
      "    bool isBullish",
      "method describe(OrderBlock this) =>",
      "    this.top",
      "getBlocks() =>",
      "    obs = array.new<OrderBlock>()",
      "    array.push(obs, OrderBlock.new(7.0, 0.5, true))",
      "    obs",
      "var float __obs_top = na",
      "for v in getBlocks()",
      "    __obs_top := v.describe()",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([7.0, 7.0, 7.0]);
  });

  it("now accepts a for-in loop over a bare UDF call returning a plain (non-UDT) array (C651 FuncInfo.returnContainerKind — the C491 regression guard's gap is now closed for this channel too, was previously rejected, see C651 in PROGRESS.md)", () => {
    const source = [
      "getNums() =>",
      "    nums = array.new<float>()",
      "    array.push(nums, 10.0)",
      "    array.push(nums, 20.0)",
      "    nums",
      "var float __obs = na",
      "for [i, v] in getNums()",
      "    __obs := v + i",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([21.0, 21.0, 21.0]);
  });
});

// map<K, UDT> element field access (C502) -- resolveArrayGetElemDrawingKind(C500)가 이미 갖춘
// map<K, drawing> 분기의 정확한 UDT 대칭. ROADMAP P4 next_hint(C501)이 조사한 "?." 잔여 싱글턴 중
// avg/get 2건(wild `data.get(key).v.avg()`류 -- map<K, UDT> UDT 필드에서 값을 꺼내자마자 그 UDT의
// 필드를 체이닝)이 resolveArrayGetElemUdtType(array 전용)에 map 분기가 없어 거부되던 것을
// mapValueUdtElemType(udt-types.ts) 신설 + resolveMapValueUdtType(analyzer.ts) 신설로 해소.
// map은 array와 달리 '=' 로컬/top-level var의 값 타입 추적 인프라가 없어 C500과 동일하게 UDT 필드
// typeHint 경로만 지원한다(현재 wild 근거가 이 형태뿐).
describe("map<K, UDT> element field access (C502)", () => {
  function holderSource(body: string): string {
    return [
      "type OrderBlock",
      "    float top",
      "    float bottom",
      "    bool isBullish",
      "type Holder",
      "    map<string, OrderBlock> obs",
      body,
    ].join("\n");
  }

  it("resolves field access chained directly on the method-call sugar map<K,UDT> UDT-field extraction (`holder.obs.get(key).field`, no intermediate '=' local, the wild data.get(key).v idiom)", () => {
    const source = holderSource(
      [
        'var Holder h = Holder.new(map.new<string, OrderBlock>())',
        "if bar_index == 0",
        '    map.put(h.obs, "a", OrderBlock.new(1.0, 0.5, true))',
        "var float __obs_bottom = na",
        '__obs_bottom := h.obs.get("a").bottom',
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_bottom"])).toEqual([0.5, 0.5, 0.5]);
  });

  it("resolves field access chained directly on the canonical `map.get(container, key).field` form as well (mirrors the method-call sugar form)", () => {
    const source = holderSource(
      [
        'var Holder h = Holder.new(map.new<string, OrderBlock>())',
        "if bar_index == 0",
        '    map.put(h.obs, "a", OrderBlock.new(2.0, 1.5, false))',
        "var float __obs_top = na",
        '__obs_top := map.get(h.obs, "a").top',
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([2.0, 2.0, 2.0]);
  });

  it("also dispatches a user-declared UDT method-call sugar on the map<K,UDT>-extracted value (resolveArrayGetElemUdtType's second consumer, call-expr.ts resolveUdtMethodReceiverType)", () => {
    const source = [
      "type OrderBlock",
      "    float top",
      "    float bottom",
      "    bool isBullish",
      "method describe(OrderBlock this) =>",
      "    this.top",
      "type Holder",
      "    map<string, OrderBlock> obs",
      'var Holder h = Holder.new(map.new<string, OrderBlock>())',
      "if bar_index == 0",
      '    map.put(h.obs, "a", OrderBlock.new(7.0, 0.5, true))',
      "var float __obs_top = na",
      '__obs_top := h.obs.get("a").describe()',
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_top"])).toEqual([7.0, 7.0, 7.0]);
  });

  it("kind-checks the extracted map value's UDT: a field that doesn't exist on the map's value UDT still errors (no spurious universal match)", () => {
    const source = holderSource(
      [
        'var Holder h = Holder.new(map.new<string, OrderBlock>())',
        "if bar_index == 0",
        '    map.put(h.obs, "a", OrderBlock.new(1.0, 0.5, true))',
        "var float __obs = na",
        '__obs := h.obs.get("a").nonexistent',
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/field not found on/);
  });

  it("leaves a plain (non-UDT) map<K,V> value extraction unaffected (no regression, mirrors the C500 drawing sibling's equivalent guard)", () => {
    const source = ["var m = map.new<string, float>()", 'map.put(m, "k", 5.0)', 'x = m.get("k")', "y = x + 1.0"].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain('var x = rt.map.get($.vars[0], "k");');
    expect(result.code).toContain("var y = (x + 1.0);");
  });
});

// func-local `var` array<UDT> 원소 필드 접근(C638, wild "네임스페이스 접근은 호출식만 지원"
// objKind=CallExpr 축 -- `var preValues [] valArr = array.from(preValues.new(...), ...)`가 method
// 본문 안에 있으면 이후 `valArr.get(5).plTime`이 원소 타입을 못 찾아 거부됐다). top-level var
// (prog.arrayElemUdtType)/'=' 로컬(scope.arrayElemUdtKindHints, 위 C393 describe 블록 참조 -- '='
// 로컬은 함수 본문 안에서도 이미 지원됨)/매개변수(paramArrayElemUdtTypes, C469) 세 저장처는 이미
// 있었지만 func-local `var` 선언 자체(FuncInfo.localVarUdtTypes와 나란한 새 localVarArrayElemUdtTypes)만
// 빠져 있던 3-way 비대칭 -- resolveArrayElemUdtType의 Identifier 분기에 새 폴백만 추가, 새 판별
// 로직 없음.
describe("func-local var array<UDT> element field access (C638)", () => {
  function funcUdtSource(body: string): string {
    return ["type Gap", "    float plTime", "    float other", body].join("\n");
  }

  it("resolves a method-call sugar `container.get(idx)` element's UDT field on a func-local var array<UDT> (the exact wild `var preValues [] valArr = array.from(...)` idiom inside a method body)", () => {
    const source = funcUdtSource(
      [
        "f() =>",
        "    var Gap [] arr = array.from(Gap.new(1.0, 0.0), Gap.new(2.0, 0.0))",
        "    arr.get(1).plTime",
        "var float __obs = na",
        "__obs := f()",
      ].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([2.0, 2.0, 2.0]);
  });

  it("resolves the canonical `array.get(container, idx).field` form on a func-local var array<UDT> as well", () => {
    const source = funcUdtSource(
      ["f() =>", "    var Gap [] arr = array.from(Gap.new(1.0, 0.0))", "    array.get(arr, 0).plTime"].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });

  it("resolves the element's UDT field when the func-local var uses an explicit array<UDT> typeHint instead of the bracket-suffix shorthand", () => {
    const source = funcUdtSource(
      ["f() =>", "    var array<Gap> arr = array.from(Gap.new(1.0, 0.0))", "    arr.get(0).plTime"].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });

  it("does not spuriously tag a plain (non-UDT) func-local var array, leaving existing scalar behavior unchanged (C638 regression guard)", () => {
    const source = ["f() =>", "    var float[] arr = array.from(1.0, 2.0)", "    x = arr.get(0)", "    x + 1.0"].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });
});

// top-level '=' 로컬 matrix<UDT> 원소 필드 접근(C638, 위 func-local var 축과 같은 objKind=CallExpr
// 클러스터의 세 번째 축 -- wild `symbolMat = matrix.new<values>(2, 40)` 후
// `symbolMat.get(0, i).symbolData`류). matrixUdtConstructorElemType(C618)은 지금까지
// top-level `var` 전용 prog.matrixElemUdtType만 채웠고 '=' 로컬(top-level 포함) matrix 컨테이너의
// 원소 타입 추적 자체가 없었다(analyzer.ts 기존 주석이 명시적으로 "과욕 금지"로 미룬 축) -- array의
// arrayElemUdtKindHints와 동일한 scope 체인 전용 matrixElemUdtKindHints 신설로 대칭 해소.
describe("top-level '=' local matrix<UDT> element field access (C638)", () => {
  function matrixUdtSource(body: string): string {
    return ["type Cell", "    float symbolData", "    float other", body].join("\n");
  }

  it("resolves a method-call sugar `container.get(row, col)` element's UDT field on a top-level '=' local matrix<UDT> (the exact wild symbolMat idiom, no `var`)", () => {
    const source = matrixUdtSource(
      ["m = matrix.new<Cell>(1, 1, Cell.new(3.0, 0.0))", "var float __obs = na", "__obs := m.get(0, 0).symbolData"].join("\n"),
    );
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs"])).toEqual([3.0, 3.0, 3.0]);
  });

  it("resolves the canonical `matrix.get(container, row, col).field` form on a top-level '=' local matrix<UDT> as well", () => {
    const source = matrixUdtSource(["m = matrix.new<Cell>(1, 1, Cell.new(3.0, 0.0))", "x = matrix.get(m, 0, 0).symbolData"].join("\n"));
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });

  it("does not spuriously tag a plain (non-UDT) '=' local matrix element, leaving existing scalar behavior unchanged (C638 regression guard)", () => {
    const source = ["m = matrix.new<float>(1, 1, 0.0)", "x = m.get(0, 0)", "y = x + 1.0"].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });

  it("still resolves the existing top-level `var` matrix<UDT> channel unaffected (C618 regression guard, prog.matrixElemUdtType still checked alongside the new scope-chain hint)", () => {
    const source = matrixUdtSource(["var m = matrix.new<Cell>(1, 1, Cell.new(3.0, 0.0))", "x = m.get(0, 0).symbolData"].join("\n"));
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });
});

// bare UDF 호출에 중간 변수 없이 곧바로 필드를 체이닝하는 실행 검증(C638, analyzer 레벨 게이트
// 테스트는 tests/unit/analyzer.test.ts의 "Analyzer UDF-returned UDT field access with no
// intermediate local (C638)" describe 블록 참조 -- 그 파일은 transpile/run을 임포트하지 않아
// 실행 검증은 여기 배치).
describe("bare UDF-call direct-chain field access, execution (C638)", () => {
  it("resolves the direct-chain field read to the same value a '=' local indirection would produce", () => {
    const source = [
      "type Gap",
      "    float pivot_upper",
      "getGap() =>",
      "    Gap.new(close)",
      "var float __obs_direct = na",
      "__obs_direct := getGap().pivot_upper",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bars } = run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
    expect(bars.map((b) => b["var:__obs_direct"])).toEqual(DATA.close);
  });
});
