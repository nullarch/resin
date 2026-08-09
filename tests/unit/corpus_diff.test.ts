// corpus differential 리플레이: tools/py_oracle/gen_corpus_golden.py가 corpus/scripts/*.pine
// 중 안전한 서브셋(strategy/UDF/request.security 제외, 커스텀 data 없음)에 plot() 인자를
// var float __obs_plotN 미러로 자동 계측해 만든 corpus/diff/{instrumented,golden}/<hash>.*를
// pine2js 파이프라인으로 재실행해 pine2py 골든과 바별 1e-9 대조한다(GOAL.md 수용 기준 #2).
// 6,926개 전체가 아니라 tests/test_full_pipeline.py 유래 서브셋의 표본(1단계 C200: 200개 ->
// 2단계 C202: 1000개 -> 3단계 C204: 2000개 -> 4단계 C282: 3000개로 확장, --limit=3000 재실행,
// C281의 gen_corpus_golden.py O(n^2) 수정 후 5.7초) -- corpus/diff/manifest.json.stats에
// 제외 사유별 카운트가 남아있다. 나머지 source_file(183개 조각, 12개 파일)은 C204가 하네스 규약을
// 조사한 결과 8개 파일 176개 조각이 순수 codegen 문자열 검사 테스트(Runtime()/.execute()/
// run_pipeline() 실행 경로 자체가 파일 전체에 0건)라 실행 기반 값 대조 오라클로 편입 불가로 결론
// (LIMITATIONS.md 참조) -- 여전히 범위 밖.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, nearlyEqual } from "../helpers/golden";
import type { OHLCVData } from "../../src/runtime/context";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIFF_DIR = join(ROOT, "corpus", "diff");
const INSTR_DIR = join(DIFF_DIR, "instrumented");
const GOLDEN_DIR = join(DIFF_DIR, "golden");

interface DiffEntry {
  hash: string;
  source_file: string;
  source_line: number;
  obs_count: number;
}

interface DiffManifest {
  stats: Record<string, number>;
  entries: DiffEntry[];
}

interface CorpusGolden {
  ok: boolean;
  data: string;
  bars: Record<string, number | string>[];
  finalVarState: Record<string, number | string>;
}

function loadManifest(): DiffManifest {
  return JSON.parse(readFileSync(join(DIFF_DIR, "manifest.json"), "utf-8"));
}

function loadData(): OHLCVData {
  return JSON.parse(readFileSync(join(DIFF_DIR, "data.json"), "utf-8"));
}

// golden 채널이 스칼라(number/boolean, 또는 NaN/Infinity 센티널)로 비교 가능한지 판정.
// pine2py enc()는 array/UDT 인스턴스를 각각 JSON 배열/Python repr 문자열로 낮추는데, 이 두 경우는
// pine2js가 그 값을 var:<name> 채널에 어떻게 노출하든(예: UDT는 "[object Object]") 수치 비교가
// 애초에 의미 없다(harness 설계 한계이지 트랜스파일러 정확성과 무관) -- 그런 채널은 비교 대상에서
// 제외한다. __obs_plotN(우리가 계측한 plot 인자 미러)은 항상 스칼라라 이 필터에 안 걸린다.
function isComparableGoldenValue(v: unknown): boolean {
  if (typeof v === "number" || typeof v === "boolean") return true;
  return v === "NaN" || v === "Infinity" || v === "-Infinity";
}

interface ReplayOutcome {
  hash: string;
  status: "matched" | "mismatch" | "transpile_fail" | "runtime_fail" | "no_comparable_key";
  detail?: string;
}

function replayOne(entry: DiffEntry, data: OHLCVData): ReplayOutcome {
  const source = readFileSync(join(INSTR_DIR, `${entry.hash}.pine`), "utf-8");
  const golden: CorpusGolden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${entry.hash}.json`), "utf-8"));

  let result;
  try {
    result = runPipeline(source, data);
  } catch (e) {
    return { hash: entry.hash, status: "transpile_fail", detail: e instanceof Error ? e.message : String(e) };
  }

  if (result.bars.length !== golden.bars.length) {
    return { hash: entry.hash, status: "runtime_fail", detail: `bar count ${result.bars.length} != ${golden.bars.length}` };
  }

  const firstGoldenBar = golden.bars[0] ?? {};
  const actualKeys = new Set(Object.keys(result.bars[0] ?? {}));
  const comparableKeys = Object.keys(firstGoldenBar).filter(
    (k) => actualKeys.has(k) && isComparableGoldenValue(firstGoldenBar[k]),
  );
  // obs_count(계측된 __obs_plotN 개수)만큼은 반드시 스칼라로 겹쳐야 한다 -- 안 겹치면 계측
  // 자체가 무효(테스트 설계 버그)이므로 별도 상태로 구분해 조용히 매칭 취급하지 않는다.
  if (comparableKeys.length === 0) {
    return { hash: entry.hash, status: "no_comparable_key" };
  }

  for (let i = 0; i < golden.bars.length; i++) {
    const expectedBar = golden.bars[i]!;
    const actualBar = result.bars[i]!;
    for (const key of comparableKeys) {
      const expected = decodeSentinel(expectedBar[key] as number | string);
      const actual = actualBar[key];
      if (actual === undefined || !nearlyEqual(actual, expected)) {
        return {
          hash: entry.hash,
          status: "mismatch",
          detail: `bar ${i} key '${key}': actual=${actual} expected=${expected}`,
        };
      }
    }
  }
  return { hash: entry.hash, status: "matched" };
}

describe("corpus diff: sample bar-by-bar replay against pine2py golden", () => {
  it("golden fixtures exist for the sampled entries (gen_corpus_golden.py has been run)", () => {
    const manifest = loadManifest();
    expect(manifest.entries.length).toBeGreaterThan(0);
    const goldenFiles = new Set(readdirSync(GOLDEN_DIR));
    for (const entry of manifest.entries) {
      expect(goldenFiles.has(`${entry.hash}.json`), `missing golden for ${entry.hash}`).toBe(true);
    }
  });

  it("replays the sampled subset and matches the observed baseline (regression floor, not a target)", () => {
    // C277: 2000건 replay는 단독 실행 ~0.9s이지만 전체 스위트 병렬 워커 부하에서 vitest 기본
    // 5000ms 타임아웃을 실제로 친 사례가 있었다(C276 STEP 6 관찰, 코드 결함 아닌 워커 경합 플레이크)
    // -- C278에서 이 파일 국소 오버라이드를 vitest.config.ts 전역 testTimeout으로 승격(같은 클래스가
    // corpus.test.ts에도 재발할 조짐을 실측해 파일별 패치보다 전역 기본값이 낫다고 판단).
    const manifest = loadManifest();
    const data = loadData();
    const outcomes = manifest.entries.map((e) => replayOne(e, data));

    const byStatus = (s: ReplayOutcome["status"]) => outcomes.filter((o) => o.status === s);
    const matched = byStatus("matched");
    const mismatched = byStatus("mismatch");
    const transpileFailed = byStatus("transpile_fail");
    const runtimeFailed = byStatus("runtime_fail");
    const noComparable = byStatus("no_comparable_key");

    // 2026-07-23 C202 실측(1000개 표본, --limit=1000): matched 471, mismatch 56, transpile_fail 472,
    // runtime_fail 0, no_comparable_key 1 -- 56건 전수 triage 결과와 신규 발견 1건(array.sort_indices/
    // sort order 문자열 리터럴, C203이 이미 수정 완료)은 이 파일의 git 이력(C202/C203 커밋 메시지)에
    // 보존.
    // 2026-07-23 C204 실측(2000개 표본으로 확장, --limit=2000 재실행, C202 대비 2배): matched 942,
    // mismatch 120, transpile_fail 937, runtime_fail 0, no_comparable_key 1. 1000개 표본은 2000개
    // 표본의 접두부(같은 manifest 순서, 기존 golden은 재사용)라 C202가 이미 triage한 56건은 전부
    // 그대로 포함된다 -- 신규로 늘어난 mismatch만 전수 triage(소스 패턴 자동 분류 + 미분류 잔여
    // 개별 pine2py 직접 실행 트레이스, 큰 버킷은 스팟체크 3건):
    // 자동 분류(패턴 태그, 한 mismatch가 여러 태그에 걸칠 수 있음): atr/tr 90, 삼항+ta.* 77,
    // math.max/min na 전파(DIVERGENCES #2, 인자 순서에 따라 na가 조용히 사라짐) 18, ta.stdev류
    // 정밀도(C114) 16, squeeze 계열 불리언(C188) 6, supertrend 4, kc 3, array.from 바 시리즈 저장
    // (MEMORY C121/C126과 동일 클래스) 2, var 자기 히스토리(DIVERGENCES #6) 1, tostring/join(C109) 1.
    // 잔여 미분류 8건 전수를 개별 확인(4건은 정확히 C202가 이미 문서화한 것과 동일 hash -- 1000개
    // 표본과 100% 겹치는 접두부라 당연함: UDT bare series #121/nested if-expr scope/문자열 이스케이프
    // 재해석 C109/if-분기 조건부 stateful "호출된 바에서만 전진" C64. 나머지 4건은 이번에 처음 표본에
    // 들어온 신규 발견이나 전부 기존 클래스의 새 발현일 뿐 신규 divergence 아님): (1) 463bb1ff3535 --
    // UDT 생성자 필드(`Container.new(close,1)`)가 bare series를 그대로 저장하는 기존 C121 클래스의
    // 다른 스크립트 재확인. (2) 5d4a47b5820d -- `"line1\nline2\ttab"`의 `\t`가 pine2py의 생성된
    // Python 소스에서 재해석돼 str.length가 16(pine2js, \t는 core 4종 밖이라 raw 2글자 유지) vs
    // 15(pine2py, tab 1글자로 축약)로 갈리는 기존 C109 클래스의 새 이스케이프 문자 재확인. (3)
    // 5df6dce5f07e -- map.put이 bare series를 그대로 저장하는 기존 map.put(#29) 클래스(array.sum이
    // 빈 valid-list에서 0을 반환해 `numKeys>0 ? sumVals/numKeys : 0.0`이 항상 0이 되는 pine2py
    // latent 버그). (4) 7842bd1e028a -- 동일 map.put(#29) 클래스가 array.avg 채널에서 재확인(빈
    // valid-list는 avg에서 NaN 반환). 큰 버킷(atr/tr, 삼항+ta.*) 스팟체크 3건도 전부 기존 ATR 1바
    // 워밍업 시프트(DIVERGENCES #8/#9/#10)가 직접 값 비교/비교 기반 삼항 분기 선택/가중합으로
    // 전파되는 패턴 확인, 신규 축 없음. **결론: 2배 확장에서 신규 divergence 클래스 0건** --
    // math.max/min na 전파(DIVERGENCES #2)가 corpus에서 처음 실측 트리거된 것이 유일한 "처음 보는
    // 조합"이었으나 이미 기존 문서(DIVERGENCES.md #2)에 사전 등재돼 있던 alias였을 뿐 신규 발견은
    // 아니다.
    // 2026-07-23 C207(int()/float()/bool()/string() bare 타입캐스트 신규 구현) 재실측: 이 서브셋
    // 자체는 표본 확장(--limit) 없이 그대로인데도, 이 스크립트들이 bare float()/string() 등을 써서
    // transpile 자체가 안 되던 게 이제 성공하면서 매트릭스가 전부 움직였다 -- transpile_fail
    // 937->864(-73, 새로 transpile 성공), matched 942->1013(+71), mismatch 120->122(+2). 늘어난
    // mismatch 2건을 개별 pine2py 직접 실행 대조로 확인(git stash로 새 codegen만 잠깐 제거 -> 이
    // 2개 hash만 신규임을 diff로 확정 후 원인 추적): (1) 3a1b046a6638(`float(barN)`는 JS Number가
    // 애초에 int/float를 구분 안 해 항등이라 그 자체는 무관 -- 실제 원인은 `period`를 정하는
    // `atrVal>5.0 ? .. : atrVal>3.0 ? .. : ..` 삼항이 `nz(ta.atr(3),1.0)`을 참조해, 기존에 이미
    // 문서화된 ATR 워밍업 시프트(DIVERGENCES #8)가 삼항 분기 선택을 바꾸고 그 결과가
    // math.sin(...period) 인자로 증폭 전파됨 -- atr/tr 클래스의 새 발현). (2)
    // 4edfa92c90b9(`if priceUp == volUp`가 bar 0의 `close>close[1]`/`volume>volume[1]`(둘 다
    // warmup NaN)에 좌우 -- VERIFIED_SEMANTICS.md OPEN "비교 연산자 na 시맨틱"에 따라 pine2js는
    // NaN을 그대로 전파해 `==` 비교가 false로 갈리지만 pine2py는 Python `nan>x`가 False라
    // `False==False`가 True로 분기 선택 자체가 갈림 -- if-분기 조건부 stateful 콜과 무관한 순수
    // 비교 na 클래스지만 동일 OPEN 축). 둘 다 int()/float()/bool()/string() 자체의 새 버그가
    // 아니라 기존에 이미 알려진 두 divergence 축(#8 ATR 워밍업 / 비교 na OPEN 가설)이 이번에 처음
    // 표본에 편입된 스크립트에서 새로 트리거된 것 -- C202/C204 선례와 동일 패턴. 아래 바닥선은
    // "이 숫자 밑으로 떨어지면 회귀"라는 방지선이지, 목표치가 아니다.
    // 2026-07-23 C208(hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/
    // alertcondition/alert/max_bars_back no-op 빌트인 신규 구현, corpus 스캔 최다빈도 '알 수 없는
    // 함수 호출' 대응) 재실측: transpile_fail 864->848(-16, 새로 transpile 성공), matched
    // 1013->1029(+16), mismatch 122(불변) -- 새로 풀린 16개 스크립트 전부 matched로 갈려 신규
    // mismatch/divergence 0건(이 함수군이 순수 no-op이라 수치 결과에 영향을 줄 수 없는 구조상
    // 당연한 결과 — C207의 int/float/bool/string처럼 실제 계산 로직이 아니므로 새 divergence 축이
    // 생길 여지 자체가 없음).
    // 2026-07-23 C209(fill() 신규 구현 + plot()/hline()의 대입-RHS 지원) 재실측: transpile_fail
    // 848->843(-5, 새로 transpile 성공), matched 1029->1034(+5), mismatch 122(불변) -- fill() 역시
    // 순수 no-op이라 새로 풀린 5개 스크립트 전부 matched로 갈림, 신규 divergence 0건(C208과 동일 근거).
    // (C210의 timestamp()는 이 서브셋에 timestamp( 호출 스크립트가 없어 매트릭스 무변화.)
    // 2026-07-23 C211(label/line/box/table/polyline 드로잉 객체 신규 구현) 재실측: transpile_fail
    // 843->827(-16, 새로 transpile 성공), matched 1034->1050(+16), mismatch 122(불변) -- 이 5개
    // 네임스페이스도 전부 no-op(값이 discard되는 dead channel)이라 수치 결과에 영향을 줄 수 없는
    // 구조상 당연한 결과, 새로 풀린 16개 스크립트 전부 matched로 갈려 신규 divergence 0건(C208/C209와
    // 동일 근거).
    // 2026-07-23 C212(파서: `TYPE name = expr` var 없는 타입 힌트 신규 로컬 선언 지원 신규) 재실측:
    // transpile_fail 827->735(-92, 새로 transpile 성공), matched 1050->1140(+90), mismatch
    // 122->124(+2). 늘어난 mismatch 2건을 git stash로 새 codegen만 잠깐 제거 -> 신규 hash 2개
    // (44ff96751731/7df0904e188e)만 정확히 특정한 뒤 개별 소스 확인: 둘 다 `float atrVal =
    // nz(ta.atr(3), 1.0)`(이번에 새로 파싱 가능해진 타입 힌트 로컬)을 공유하는 스크립트로, 이미
    // 문서화된 ATR 워밍업 시프트(DIVERGENCES #8, atr/tr 클래스 -- C204/C207이 이미 반복 확인한
    // 축)가 math.max/삼항 분기/곱셈으로 전파되는 새 발현일 뿐 신규 divergence 0건(C207의
    // 3a1b046a6638/4edfa92c90b9 triage와 동일 패턴 -- 이번 기능 자체의 새 버그가 아니라 파서 갭
    // 해소가 이 기존 클래스를 처음 표본에 편입시킨 것).
    // 2026-07-23 C213(파서: `TYPE[] name = expr` 대괄호-접미 배열 타입 shorthand 신규 지원) 재실측:
    // transpile_fail 735->593(-142, 새로 transpile 성공), matched 1140->1272(+132), mismatch
    // 124->134(+10). 늘어난 mismatch 10건을 git stash로 새 파서 분기만 잠깐 제거 -> 신규 hash 10개
    // (027b48b668d4/0c839d3f9a00/225ab63c3e32/24d8908f6dc2/257c8e32fbda/25e813591f89/
    // 34df499d50e3/4e2c96200e75/561b99e2f57e/580426704f1c)만 정확히 특정한 뒤 개별 소스 확인 --
    // 전부 기존 클래스의 새 발현(신규 divergence 축 0개): (1) 027b48b668d4만 처음 보는 **새
    // 발현지**(같은 클래스는 기존 등재)로 DIVERGENCES.md #90 신규 -- `array.fill(arr, close, ..)`가
    // pine2py에서 bare series를 스칼라화 없이 그대로 저장해(array.py의 push/set/unshift/insert만
    // `_scalar()` 가드가 있고 fill은 없음, python 직접 실행으로 확인) 저장된 Series가 이후
    // array.avg/sum/min/max의 `_valid_nums` 판정에서 영구 배제되는 map.put(#29)/matrix.set(#30)/
    // UDT 생성자(#53)와 동일 계열의 latent 버그 -- 이 특정 조합(`float[]` shorthand로 선언한 array에
    // bare series를 fill)이 파서 갭 때문에 지금까지 표본에 못 들어왔을 뿐. 나머지 9건은 기존
    // 클래스의 재확인: atr/tr 워밍업 시프트(#8, 0c839d3f9a00/225ab63c3e32/24d8908f6dc2/
    // 257c8e32fbda/34df499d50e3/561b99e2f57e/580426704f1c 7건 -- maxScore/minScore running
    // tracker 오차 또는 atr 비교 기반 분기 선택 갈림), math.max/min na 전파 순서 의존성(#2,
    // 4e2c96200e75 -- python `max(0.0, nan)`=0.0/`max(nan, 0.0)`=nan 인자 순서 의존 확인),
    // 비교 연산자 na 시맨틱 OPEN 가설(VERIFIED_SEMANTICS.md, 25e813591f89 -- `isBull==wasBull`이
    // bar0 워밍업 NaN 비교에서 pine2js=na 전파/pine2py=Python `nan>x`=False 분기 선택 갈림, C207의
    // 4edfa92c90b9 triage와 동일 패턴). 전부 파서 자체의 새 버그가 아니라 대괄호 shorthand 지원이
    // 이 기존 클래스들을 쓰는 스크립트를 처음 표본에 편입시킨 결과.
    // 2026-07-23 C216(analyzer/codegen: for-in 루프 array+map 실구현, C215 파서 슬라이스의 후속)
    // 재실측: transpile_fail 593->491(-102, 새로 transpile 성공), matched 1272->1365(+93), mismatch
    // 134->143(+9). 늘어난 mismatch 9건을 git stash로 새 analyzer/codegen/ast만 잠깐 제거 ->
    // 신규 hash 9개(158f6709a828/193c5f88d998/1b05a7e0f7bf/2513107ac14c/28bb39545d87/505eb2f1e1f4/
    // 54640bfecade/5570da7e3944/5b8db5989c54)만 정확히 특정한 뒤 개별 소스 확인 -- **9건 전부**
    // `for [k, v] in <map>`으로 map 값(그 중 ta.atr(3) 또는 ta.atr(3)/ta.sma(ta.atr(3),5) 파생값
    // 포함)을 합산/비교하는 스크립트로, 전부 기존에 이미 반복 문서화된 atr/tr 워밍업 시프트
    // 클래스(DIVERGENCES #8, C204/C207/C213이 이미 여러 번 확인한 축)의 새 발현일 뿐 신규
    // divergence 0건(scratch 트레이스로 193c5f88d998 직접 확인: bar2에서 pine2js atr=6/pine2py
    // atr=1.0(nz fallback, 아직 NaN) 갈림 -> `ret<0`이면 `total=atr`뿐이라 그 갈림이 그대로 총합에
    // 전파; 28bb39545d87은 `ta.atr(3) > ta.sma(ta.atr(3),5)` 비교가 워밍업 갈림으로 bar7부터 분기
    // 선택 자체가 바뀌는 동일 클래스의 비교-기반 변형). for-in 자체(루프 구조/map 순회/합산)는
    // 정상 -- map 값이 결국 ta.atr 파생이라는 corpus 우연(atr을 map에 담아 리스크 스코어를 합산하는
    // 관용구가 이 표본에 흔함)이지 for-in 구현의 새 버그가 아니다. 아래 바닥선은 "이 숫자 밑으로
    // 떨어지면 회귀"라는 방지선이지, 목표치가 아니다.
    // 2026-07-23 C220(파서: 파서/analyzer 공용 bare `na(x)` 함수 호출 신규 지원 — 이전엔 standalone
    // na 리터럴만 파싱되고 `na(x)`는 parsePostfix의 "호출 가능한 대상이 아님" ParseError였다) 재실측:
    // transpile_fail 490->358(-132, 새로 transpile 성공), matched 1366->1489(+123), mismatch
    // 143->152(+9). 늘어난 mismatch 9건을 git stash(src/transpiler/parser.ts+analyzer/call-expr.ts만)로
    // 신규 hash 9개(036573632710/114f38593ad8/125c48a900ee/13fafa3fde32/18878730a311/1b88eb6a45f0/
    // 4e4458c3fb98/5a9e1f5b7d2f/5c03420c01c4)를 정확히 특정한 뒤 개별 소스 확인 -- **9건 전부**
    // 기존 클래스의 새 발현일 뿐 신규 divergence 0건: 8건(036573632710/114f38593ad8/125c48a900ee/
    // 13fafa3fde32/18878730a311/1b88eb6a45f0/4e4458c3fb98/5c03420c01c4)은 전부 `ta.atr(...)`를 직접
    // 쓰는 스크립트로 이미 여러 사이클(C204/C207/C213/C216)이 반복 확인한 ATR/RMA 워밍업 시프트
    // 클래스(DIVERGENCES #8) -- 036573632710을 pine2py 직접 실행으로 스팟체크: atrPeriod=5일 때
    // pine2py trailStop은 bar5까지 NaN 유지 후 bar5에서 94.4로 확정되는데 pine2js는 bar4에서 이미
    // 95로 확정돼(atr가 한 바 일찍 non-NaN) na(trailStop) 삼항 분기 선택이 그 한 바 앞에서 갈린다.
    // 나머지 1건(5a9e1f5b7d2f, Heikin-Ashi)은 `haOpen := (nz(haOpen[1]) + nz(haClose[1])) / 2`처럼
    // 같은 문장 안에서 자기 히스토리를 읽고 그 결과로 재대입하는 패턴 -- 기존 var 히스토리 기록
    // 타이밍 클래스(DIVERGENCES #6)와 정확히 일치(pine2py 직접 실행으로 스팟체크: bar1에서
    // haOpen[1]을 0.0으로 읽어 haOpen이 0.0으로 확정되는 pine2py 자체의 히스토리 기록 버그, TV
    // 정합은 pine2js 쪽). na(x) 자체(rt.na — 이미 `x == na` 재작성에 쓰이던 기존 함수 재사용, 신규
    // 오라클 na_basic.pine으로 별도 검증 완료)의 새 버그가 아니라 파서 갭 해소가 ATR 워밍업/var
    // 히스토리 타이밍이라는 두 기존 클래스를 쓰는 스크립트를 처음 표본에 편입시킨 결과 -- C207/C212/
    // C213/C216과 동일 패턴.
    // 2026-07-23 C221(파서: `array.new<TYPE>(...)` 제네릭 타입 인자 콜사이트 라우팅 신규 -- C220
    // next_hint 1순위) 재실측: transpile_fail 358->341(-17, 새로 transpile 성공), matched
    // 1489->1506(+17), mismatch 152(불변). git stash로 새 parser.ts만 잠깐 제거해 mismatch 152개
    // hash 집합을 before/after 정확히 대조 -- **신규/해소 0건, 두 집합이 완전히 동일**(늘어난
    // transpile_fail->matched 17건 전부 mismatch 없이 곧바로 matched로 전환, array.new<TYPE>
    // 자체는 값 계산이 아니라 순수 파서 라우팅이라 이 결과가 구조적으로 당연함).
    // 2026-07-23 C222(analyzer/codegen: method-call 스타일 array/map 콜 `arr.push(x)`/`m.put(k,v)`
    // == `array.push(arr,x)`/`map.put(m,k,v)` 신규 지원 -- C220 next_hint 1순위, resolveContainerExprKind로
    // C216 containerKindHints 인프라 재사용, 신규 스코프 체계 없음) 재실측: transpile_fail
    // 341->326(-15, 새로 transpile 성공), matched 1506->1520(+14), mismatch 152->153(+1). 늘어난
    // mismatch 1건을 git stash로 새 analyzer/codegen만 잠깐 제거 -> 신규 hash 1개(49812f986c10)만
    // 정확히 특정한 뒤 상세 대조(bar/key 단위 actual/expected 로그) -- 그 mismatch는
    // `m.put("sma1", nz(sma1))`/`array.push(arr, close)` 등 이번에 신규 지원한 method-call 채널이
    // 아니라 **var:sqzOn(bar 4)**, 즉 `nz(atr_)`(ta.atr(5))가 낀 삼항성 비교식이 워밍업 경계
    // (length=5, bar4)에서 갈리는 기존 ATR/RMA 워밍업 시프트 클래스(DIVERGENCES #8, 이 파일이 C204/
    // C207/C213/C216/C220에서 반복 확인해온 축과 동일 서명 -- TR 수동 계산으로 bar4가 정확히 RMA
    // 시드 경계임을 재확인)의 새 발현일 뿐 -- 이 스크립트가 method-call 스타일 map.put 때문에 파서
    // 갭이 풀려 처음 표본에 편입된 것이지, map/array 값 자체(m_sz/arr_med 등)는 전부 정확히 일치.
    // **결론: method-call 스타일 array/map 콜 자체의 새 divergence 0건**.
    // 2026-07-23 C224(analyzer/codegen: '=' 로컬 UDT 인스턴스 추적 -- `p = Bar.new(...)` 후
    // `p.field` 읽기/쓰기, C223 next_hint 1순위) 재실측: transpile_fail 326->317(-9, 새로 transpile
    // 성공), matched 1520->1528(+8), mismatch 153->154(+1). git stash로 새 analyzer/codegen만 잠깐
    // 제거해 mismatch hash 집합을 before/after 대조 -- 신규 1건(4f8201a8430f)만 정확히 특정.
    // 소스(`current = PriceLevel.new(close, "bar")`처럼 UDT 생성자에 bare `close`를 직접 넘기는
    // '=' 로컬)를 확인한 결과 새 기능 자체의 버그가 아니라 이미 문서화된 UDT 생성자 bare-series
    // 저장 latent 버그(DIVERGENCES.md #53, C121 -- pine2py가 `_scalar()` 가드 없이 Series 참조를
    // 필드에 그대로 저장)의 새 발현: golden의 `var:best`가 `price=Series(...)`를 담고 있어
    // `__obs_plot0`이 바마다 "그 시점의 close"로 계속 바뀌지만(103/104/102/105/107/106, close와
    // 완전히 동일한 패턴), pine2js는 GOAL.md "Series 산술은 scalar" 원칙대로 대입 시점에 이미
    // `.get(0)`으로 스냅샷해 올바른 러닝 맥스(103/104/104/105/107/107)를 낸다 -- 이 갈림이 '='
    // 로컬 UDT 지원이 이 패턴을 쓰는 스크립트를 처음 표본에 편입시킨 결과일 뿐, 이 채널의 정답은
    // pine2js 쪽(udt_basic.pine이 이미 같은 이유로 이 채널을 오라클 비교에서 제외해둔 것과 동일
    // 근거). **결론: '=' 로컬 UDT 지원 자체의 새 divergence 0건**.
    // 2026-07-23 C226(#RRGGBB/#RRGGBBAA 색상 리터럴(ColorLiteral) 신규 지원, corpus.test.ts C226
    // 주석 참조) 재실측: transpile_fail 317->307(-10, 새로 transpile 성공), matched 1528->1538(+10),
    // mismatch 154(불변) -- 새로 풀린 10건 전부 mismatch 없이 곧바로 matched로 전환(color 리터럴은
    // pine2py도 동일한 hex string으로 codegen해 값 갈림 여지 자체가 없는 순수 문법 게이트였음).
    // 2026-07-23 C227(TA_REGISTRY.change/kc/kcw에 minArgCount 신설 -- ta.change(source) 1-인자 생략형
    // (length 기본값 1)/ta.kc·ta.kcw(source,length,mult) 3-인자 생략형(useTrueRange 기본값 true),
    // 둘 다 math.random(C120)과 동일한 minArgCount 패턴, ROADMAP P3 next_hint 1순위) 재실측:
    // transpile_fail 307->300(-7, 새로 transpile 성공), matched 1538->1541(+3), mismatch 154->158(+4).
    // 늘어난 mismatch 4건(1f43d0a9db73/208ba7f835f9/52eed9c48cba/75355fc37c30)을 git stash로 새
    // analyzer/codegen/runtime만 잠깐 제거해 diff로 정확히 특정 -- 전부 "BB KC Squeeze"/"Squeeze"/
    // "KCW"/"KC Pos" 패턴으로 `ta.kc(source, length, mult)` 3-인자 생략형(useTrueRange 기본값 true)을
    // 쓰는 스크립트이고, 4건 전부 bar4(length=5 워밍업 경계, 정확히 length-1)에서 갈린다: pine2js는
    // kc의 ta.atr 기반 range가 워밍업 off-by-one 없이(DIVERGENCES.md #9) bar4에 이미 유효값을 내지만,
    // pine2py kc.py는 atr 자신의 이미 문서화된 워밍업 지연(#8)이 kc의 공유 NaN 게이트로 새어나가
    // bar4까지 (nan,nan,nan)을 반환한다 -- 이 스크립트들이 이번에 처음 3-인자 생략형으로 transpile에
    // 성공해 표본에 편입된 것일 뿐, kc/kcw 인자 생략 지원 자체의 새 버그가 아니라 기존
    // DIVERGENCES #9(useTrueRange=true 워밍업 shift, oracle/cases/ta_kc_kcw.pine·
    // tests/oracle/ta_kc_kcw.test.ts가 이미 hand-verified로 확정해둔 축)의 새 발현이다(C222/C224/C226과
    // 동일한 "새 call form이 기존 divergence 클래스를 쓰는 스크립트를 처음 표본에 편입시킨다" 패턴).
    // **결론: minArgCount 확장 자체의 새 divergence 0건**.
    // 2026-07-23 C228(index-access.ts analyzeIndexAccess -- bar series/파생 가격의 동적(런타임)
    // 히스토리 오프셋 `high[i]`(i가 for 루프 카운터 등 비-리터럴 int 표현식) 신규 지원, ROADMAP P3
    // next_hint 1순위 "corpus 클러스터링 재스캔"이 찾아낸 최다빈도 갭 -- corpus 실측 174건 중 170건이
    // 이 형태) 재실측: transpile_fail 300->239(-61, 새로 transpile 성공), matched 1541->1601(+60),
    // mismatch 158->159(+1). git stash로 신규 analyzer/codegen/runtime 4파일만 잠깐 제거해 diff로
    // 신규 mismatch를 정확히 1건(43047ef4fa9a)만 특정(제거된 mismatch 0건 -- 순수 추가만). 소스가
    // `atrVal = nz(ta.atr(5), 1.0)` + `if spread > atrVal`로 분기하는 스크립트이고 bar4(length=5
    // 워밍업 경계, 정확히 length-1)에서만 갈린다: pine2js atr(RMA 스트리밍)는 bar4에 이미 유효값을
    // 내 spread(5)>atrVal이 false로 판정되지만, pine2py atr.py는 이미 문서화된 워밍업 지연(#8, 항상
    // 한 바 늦음)이 남아 있어 bar4에 여전히 NaN -> nz가 1.0으로 대체해 spread(5)>1.0이 true로 판정 --
    // 분기가 갈려 momentum 델타가 다르고(+0.5 vs +1.0) 그 오프셋이 이후 바까지 누적 전파된다(spread
    // 자체는 bar4 포함 전 구간 정확히 일치 -- 새 동적 오프셋 기능 자체는 버그 없음). C222/C224/C227과
    // 동일한 "새 call form이 기존 DIVERGENCES #8 워밍업 클래스를 쓰는 스크립트를 처음 표본에
    // 편입시킨다" 패턴 -- **결론: 동적 히스토리 오프셋 자체의 새 divergence 0건**.
    // 2026-07-23 C229(chart.point.new/from_index/from_time/copy/now 신규 지원 -- strategy.
    // closedtrades.*(C173)와 동일한 3-level 체이닝 별도 분기, ROADMAP P3 next_hint 1순위 "'지원하지
    // 않는 호출' 100건 함수명별 재클러스터링"이 찾아낸 최다빈도 단일 네임스페이스, corpus 10개 파일
    // 실측) 재실측: transpile_fail 239->236(-3), matched 1601->1603(+2), mismatch 159->160(+1).
    // 신규 mismatch 1건(2ece174f9366) triage 결과 기존 divergence 클래스가 아니라 **신규 발견** --
    // pine2py core.na()의 `hasattr(value,'get')` duck-typing이 chart.point.new()가 반환하는 plain
    // dict의 내장 `.get()` 메서드와 충돌해 `na(방금 만든 chart.point)`를 항상 True로 오판(python
    // 직접 실행으로 확인: `{"time":0,...}.get(0) is None` -> True). pine2js rt.na는 이런 duck-typing
    // 경로가 없어 정확히 na가 아니라고 답함 -- GOAL.md "알려진 버그는 따르지 않는다" 적용,
    // DIVERGENCES.md #93 신규 등재. **결론: chart.point.* 신규 지원 자체의 새 버그 0건**.
    // 2026-07-23 C231(log.info/log.warning/log.error/runtime.error/runtime.warning 신규 지원) 재실측:
    // transpile_fail 236->234(-2, 새로 transpile 성공), matched 1603->1605(+2), mismatch 160(불변).
    // 새로 성공한 2건(7468213d546c/4b4ad219ccd1) 전부 matched로 편입 -- 신규 mismatch 0건(log.*/
    // runtime.warning은 순수 no-op이라 계산값에 애초에 관여하지 않고, runtime.error도 이 두 파일
    // 에선 조건부 분기 안에 있어 이 표본 데이터로는 호출되지 않음). **결론: 이번 지원 자체의 새
    // divergence 0건**.
    // 2026-07-23 C241(map.get(m, key, default) 3-인자 폼 신규 지원, corpus.test.ts C241 주석 참조)
    // 재실측: transpile_fail 225->155(-70, 새로 transpile 성공), matched 1614->1676(+62),
    // mismatch 160->168(+8). git stash로 신규 analyzer/runtime 2파일만 잠깐 제거해 before/after
    // hash 집합을 대조 -- 새 mismatch 8건 전부 fixedMismatch 0건(순수 추가만). 8건
    // (229409570216/277e45a9f451/2969ad7fe9fa/37407fc839c3/481402ef172b/52b00c43e640/
    // 555550006c19/8015f7c7ad5f) 소스를 직접 확인한 결과 전부 `atr = ta.atr(3)`(또는
    // `nz(ta.atr(3), 1.0)`)류를 map.put/map.get으로 감싸 스칼라 파라미터로 재사용하는 패턴이고,
    // mismatch가 나는 바 인덱스가 하나같이 그 길이의 워밍업 경계(length-1, ta.atr(3)->bar2,
    // ta.sma(rng/tp,5)->bar4, ta.atr(3)의 sma(5) 합성 체인->bar7)와 정확히 일치 -- map.get 자체는
    // 두 사례(37407fc839c3의 `map.get(curr,"close",close)`처럼 매 바 값이 갱신되는 var map 왕복
    // 포함)에서 키가 항상 이미 존재해 default 인자가 실제로 소비되지 않았음을 소스 대조로 확인
    // (default 로직 자체는 관여하지 않음). 즉 새 기능이 처음 표본에 편입시킨 스크립트들이 기존
    // DIVERGENCES.md #8(ta.atr 워밍업 지연)/#9(kc 합성 체인)를 그대로 트리거한 것일 뿐 --
    // C222/C224/C227/C228/C229가 반복 확인해온 "새 call form이 기존 divergence 클래스를 쓰는
    // 스크립트를 처음 표본에 편입시킨다" 패턴의 재발. **결론: map.get 3-인자 지원 자체의 새
    // divergence 0건.**
    // 2026-07-23 C246(analyzer.ts analyzeIfStmt: 최초 if 조건은 kind:"condition"을 더 이상 push하지
    // 않음 -- elif/switch-case/while과 달리 형제 분기 매치 여부와 무관하게 무조건 1회 평가되므로
    // cond-body와 동형, corpus 재클러스터링이 찾아낸 최다빈도 갭 92건 중 86건이 이 패턴) 재실측:
    // transpile_fail 153->137(-16, 새로 transpile 성공), matched 1678->1692(+14), mismatch
    // 168->170(+2). git stash로 analyzer.ts/codegen.ts만 잠깐 제거 -> 신규 hash 2개(688e17a468bd/
    // 751030f158ff) 정확히 특정(제거된 mismatch 0건 -- 순수 추가만). 둘 다 개별 확인 결과 기존
    // DIVERGENCES.md #8(ATR 1바 워밍업 지연) 클래스의 새 발현일 뿐: (1) 688e17a468bd -- bar2(atr
    // length=3의 length-1 워밍업 경계)에서 upper=nz(smaVal)+nz(atrVal)*mult가 pine2js=112(atr=6,
    // SMA-seed라 bar2에 이미 유효) vs pine2py=103(atr 워밍업 지연으로 bar2에 여전히 nan -> nz가
    // 0으로 대체) -- if-조건 안 stateful 콜과 무관하게 그 콜이 처음 표본에 들어온 스크립트에서
    // 흔한 ATR 클래스가 트리거된 것(if ta.crossover(close, smaVal) 자체는 관측 채널과 무관한 별도
    // crossCount 변수만 갱신). (2) 751030f158ff -- 중첩 if(`else if rsi<60 and rsi>30 { if atr>0 {
    // entry:=-1 } }`) 안 atr>0 판정이 동일 워밍업 경계에서 pine2js=true(atr=6)/pine2py=false(atr=nan,
    // Python nan>0=False)로 분기 선택 자체가 갈림(entry actual=-1 vs expected=0) -- 이 스크립트의
    // 다른 if 조건(`if atr > 0 and volume > ta.sma(volume, 5)`)에 있는 and-우변 stateful 콜은 bar2에
    // 도달조차 안 하는 반대쪽 분기(close>sma3 true 분기)라 이번 mismatch와 무관, C246이 새로 여는
    // "if 조건 안 and/or 우변 stateful 콜의 eager 호이스팅(pine2py는 Python 네이티브 lazy and/or라
    // 단락 평가로 상태가 안 전진 — DIVERGENCES.md #97, C66/#12와 동일 축의 조건-위치 확장)" 클래스는
    // 이 2000개 표본에서 아직 트리거된 사례가 없다(향후 표본 확장 시 재확인 대상으로 남겨둠).
    // **결론: 최초 if 조건 stateful 콜 허용 자체의 새 divergence 0건** -- 늘어난 mismatch 2건 전부
    // 기존 ATR 워밍업 클래스가 새로 transpile 가능해진 스크립트에서 처음 표본에 편입된 것.
    // 2026-07-23 C248(괄호 없는 ta.tr/ta.wad/ta.accdist/ta.wvad/ta.iii/ta.obv/ta.pvt/ta.nvi/ta.pvi
    // 9종 bare 암묵 호출 신규 지원) 재실측: transpile_fail 137->134(-3, 새로 transpile 성공),
    // matched 1692->1695(+3), mismatch 170(불변). git stash로 parser.ts만 잠깐 제거해 mismatch
    // hash 집합을 정렬 비교(diff) -- before/after **완전히 동일한 170개 집합**(신규/소실 0건),
    // 새로 풀린 3개 스크립트 전부 matched로 직행해 신규 divergence 0건(C208/C209/C211류 no-op
    // 성격은 아니지만 이 9종은 explicit-call형(`ta.tr()`)이 이미 오라클로 값 산식까지 검증된
    // 함수라 문법(괄호 유무)만 desugar하는 순수 파서 변경이므로 값 계산 경로 자체는 무변화 --
    // 새 divergence 축이 생길 여지가 구조적으로 없음).
    // 2026-07-24 C282 실측(3000개 표본으로 확장, --limit=3000 재실행, C204 대비 1.5배 -- C281이
    // gen_corpus_golden.py find_enclosing_function O(entries*tree_size) 성능 버그를 고쳐 재생성이
    // 5.7초로 안전해진 뒤 첫 확장): matched 2570, mismatch 252, transpile_fail 177, runtime_fail 0,
    // no_comparable_key 1. **부수 실측**: 2000개 구간(기존 entries의 hash 집합)만 따로 집계하면
    // matched 1706/mismatch 170/transpile_fail 123 -- C248이 마지막으로 갱신한 바닥선(1695/170/134)
    // 보다 이미 개선돼 있었다(C249~C274의 transpile 갭 해소가 diff 표본에도 반영됐지만 바닥선은
    // floor라 테스트가 계속 그린이어서 아무도 재실측하지 않았음). 즉 이번 floor 이동분 중 +11
    // matched/-11 transpile_fail은 표본 확장이 아니라 그간의 누적 개선분이다. 신규 1000건의
    // 기여는 matched +864 / mismatch +82 / transpile_fail +54. 늘어난 mismatch 82건 전수 triage
    // (소스 패턴 자동 분류 + 코어 태그 없는 14건 개별 확인 + 지배 버킷 스팟체크 3건 + pine2py
    // 직접 실행 트레이스 2건): (1) ATR/TR/RMA 워밍업 시프트(DIVERGENCES #8/#9/#10) 59건 --
    // mismatch bar 분포(bar2=39/bar4=16/bar7=9)가 length 3/5/합성 체인의 워밍업 경계(length-1)와
    // 정확히 일치, 스팟체크 3건 전부 ta.atr(3). (2) 비교/논리 na OPEN 가설(VERIFIED_SEMANTICS.md,
    // `NaN>x`를 pine2js는 na 전파/Python은 False -- `(a>b)==(c>d)` 재비교 C188 포함) 4건:
    // 829a702d129d/8ba5074a053c/b7ec01d562cc/94632c74a78c. (3) math.max/min Python 내장 위임의
    // nan 스왈로(DIVERGENCES #2, min(100.0, nan)이 100.0을 반환) 4건: a1e21b6005bc(pine2py 직접
    // 트레이스로 확정 -- 양쪽 다 Python `nan != 0`=True와 동형 분기를 타지만 최종 clamp에서만
    // 갈림)/a6ab882dee80/a939f856a682/9fe905edbb07(변형: python 직접 실행으로 `max(0.0, Series)`가
    // Series 객체 자체를 반환함을 확인 -- DIVERGENCES #104 신규 등재, 발현지만 새로움). (4) UDT
    // 생성자/필드 bare-series 저장(#53, C121 계열) 4건: 8fcf54959cb6/9dee30f7e713/ac26fe16819e/
    // 96b27475d6da. (5) var 자기 히스토리 기록 타이밍(#6) 1건: 8fed4e80ea00. (6) 삼항 lazy 분기
    // stateful 상태 갭(#12/C66 -- pine2py는 taken 분기만 상태 전진, pine2js eager 호이스팅이 TV
    // 정합) 1건: a7644bd3d69c. (7) str.tostring int/float 구분(C200, LIMITATIONS) 1건:
    // 8a906df0646b. (8) nz(value, replacement)의 replacement가 bare Series로 통과돼 crossover
    // per-call 히스토리를 어긋나게 하는 pine2py 스칼라-가드-부재 계열의 새 발현지 1건:
    // a85b910e33fa(pine2py 직접 트레이스로 crossover가 한 번도 발화하지 않음을 확인 -- TV 정합은
    // bar2 발화인 pine2js 쪽, DIVERGENCES #103 신규 등재). 나머지는 (1)~(3)의 다중 태그 중복.
    // **결론: 1.5배 확장에서 신규 divergence 클래스 0건** -- 새 발현지 2곳(#103/#104)은 기존
    // "pine2py 스칼라 가드 부재" 계열의 새 통과 경로일 뿐. 아래 바닥선은 "이 숫자 밑으로
    // 떨어지면 회귀"라는 방지선이지, 목표치가 아니다.
    // 2026-07-25 C363(top-level '=' 로컬 히스토리 x[n] n>=1 신규 지원, ROADMAP P4 "wild 최우선
    // [hard]: 로컬 히스토리" (a)슬라이스) 재실측: 변경 전 실제값(matched 2572/mismatch 252/
    // transpile_fail 175 -- C282 이후 누적 개선분이 floor에 미반영 상태였음, MEMORY.md C332
    // 원칙대로 별도 기록)에서 matched 2625(+53)/mismatch 255(+3)/transpile_fail 119(-56) --
    // 56개 스크립트가 새로 transpile 가능해져 53건은 matched로 직행, 3건만 mismatch. 늘어난
    // mismatch 3건 전수 확인: (1) 1caad14d05de -- `close>sma3 and close[1]<=sma3[1]`(sma3가 top-
    // level '=' 로컬). pine2py 직접 재실행(scratch/probe_c363_tradenum.py)으로 `sma3[1]` 읽기를
    // and-체인 밖으로 미리 끌어내면(=매 바 강제 실행) golden 자체가 바뀜을 확인 -- ctx.param()의
    // inline push가 Python 네이티브 and의 short-circuit으로 일부 바에서 스킵되는 게 원인(기존
    // DIVERGENCES #6 "사용자 var 히스토리 기록 타이밍"의 신규 트리거 방식, '=' 로컬로 처음 확장).
    // (2) 68733bab99ec -- `na(haOpen) ? A : (nz(haOpen[1])+nz(haClose[1]))/2`(haClose가 '=' 로컬).
    // 동일 축의 삼항 미선택-분기 변형(A 분기가 선택되는 바엔 B 안의 haClose[1] 읽기 자체가
    // 실행 안 돼 push 스킵). (3) 6c868bb68347 -- 수제 Supertrend(atr_val = ta.atr(...) 뒤
    // atr_val[1]/upper_band[1]/lower_band[1] 누적 상태 전이) -- 기존 DIVERGENCES #10(ta.supertrend,
    // atr #8 워밍업 1바 시프트가 밴드/방향 전환 전체로 누적 전파)과 정확히 동형 구조, '=' 로컬
    // 히스토리 지원으로 이 수제 재구현이 처음 transpile 가능해지며 노출된 것 뿐 신규 클래스 아님.
    // **결론: 신규 divergence 클래스 0건** -- (1)(2)는 기존 #6을 '=' 로컬 축으로 확장한
    // DIVERGENCES.md 갱신, (3)은 기존 #10의 재발현. pine2js 쪽이 TV 정합(VERIFIED_SEMANTICS
    // "and/or 양변 모두 평가"/#8 O(1) RMA)이므로 세 건 다 오라클 제외 대상, 코드 수정 아님.
    // 2026-07-25 C365(histSlot 대상 동적 오프셋 게이트 완화, ROADMAP P4 🔴🔴 (c)) 재실측:
    // matched 2625→2631(+6)/mismatch 255→256(+1)/transpile_fail 119→112(-7) -- 7개 스크립트가
    // 새로 transpile 가능해져 6건은 matched 직행, 1건만 mismatch. 늘어난 1건(1f07acc72632,
    // scratch 전/후 리플레이 diff로 "이전 mismatch 255건 전부 불변 + matched→mismatch 강등 0건"
    // 확인) 원인 확정: `for i = 0 to 2 \n if close[i] > sma3[i] ...`(sma3가 ta.sma를 담은 '='
    // 로컬, 조건부 분기 안 루프에서 동적 오프셋 읽기). pine2py 직접 재실행(scratch/
    // c365_py_triage2.py)으로 ctx.param()의 `len<=idx면 push` catch-up이 같은 바 안 다중 읽기
    // (루프 3회×조건식 2회)마다 반복 발동해 param 히스토리가 "오늘 값 사본"으로 오염됨을 확인
    // (bar3에서 sma3[2]가 TV-정합 na가 아닌 오늘 값 103.67로 보여 result 2 -- pine2js는 바 확정값
    // record라 sma3[1]=103.0/sma3[2]=워밍업 na로 result 1이 TV 정합). 기존 DIVERGENCES #6
    // (ctx.param 읽기 시점 push)의 신규 트리거 방식(같은 바 다중 읽기 catch-up 오염)일 뿐 신규
    // divergence 클래스 아님 -- DIVERGENCES.md #6에 C365 확장 기록, 코드 수정 아님.
    // 2026-07-25 C369(top-level 튜플 디스트럭처 로컬 히스토리) 재실측: matched 2631→2640(+9)/
    // mismatch 256(집합 hash 단위 전/후 diff로 완전 동일 확인)/transpile_fail 112→103(-9) --
    // 새로 transpile 가능해진 9건 전부 matched 직행, 신규 divergence 0건. 바닥선을 개선치로 갱신.
    // 2026-07-31 C509(ta.pivothigh/pivotlow 2-인자 source-omit 오버로드 신규 지원) 재실측(변경
    // 전 실제값 matched 2641/mismatch 256/transpile_fail 102 -- C369 이후 누적 개선분이 floor에
    // 미반영 상태였음, MEMORY.md C332 원칙대로 별도 기록): git stash로 src만 잠깐 제거해 전/후
    // per-hash 상태를 직접 diff(scratch/c509_diff_by_hash.mjs)한 결과 정확히 2개 hash만 변화 --
    // 61be4b82e338.pine(transpile_fail->matched)/9a40852d7217.pine(transpile_fail->mismatch).
    // 후자의 원인: pine2py pivot.py가 `ta.pivothigh(3, 3)`을 source=3(상수)/right=기본값5로
    // 오바인딩하는 latent 버그(source 스니핑이 highest/lowest와 달리 없음) -- pine2js는 TV 정합
    // (암묵 high, right=3)이라 정당한 divergence(DIVERGENCES #167 신규 등재). 신규 divergence
    // 클래스 1건, 버그 아님 -- 바닥선을 관측치(matched 2642/mismatch 257/transpile_fail 100)로 갱신.
    // 2026-08-01 C548(ta.sma series length — TA_REGISTRY.seriesLengthOk 확장, smaVarLen) 재실측:
    // 전/후 per-hash diff(scratch/c548_diff_before.json vs c548_diff_after.json, c509_diff_by_hash.mjs
    // 재사용)로 정확히 11개 hash만 변화, matched->강등 0건. transpile_fail 98->87(-11, sma
    // series-length 하드 에러가 유일 블로커였던 파일 전부 신규 transpile), matched 2644->2649(+5,
    // length가 이 데이터에서 값이 상수로 퇴화하는 파일들), mismatch 257->263(+6). 늘어난 6건
    // (1e94cbe822dc/3af309ac0f51/4736c6a8b27f/4c84c643b5aa/64feccd2d559/b72f4b6097a0) 전수 triage:
    // 전부 loop-body 반복 호출(for-in map/array, for p=3 to 5) 또는 바마다 변하는 adaptive length로
    // ta.sma를 부르는 스크립트인데, pine2py wavealgo/ta/sma.py는 (a) 첫 성공 호출의 length로
    // 윈도우 크기를 영구 고정한 채 "현재 length"로 나누고(직접 실행 실측: len=[3,3,4,5,2,...]에서
    // "2개 합/3" 같은 무의미한 값) (b) 같은 바 반복 호출마다 window.pop/append가 일어나 상태가
    // 바당 여러 칸 전진하는(context.param 덮어쓰기 보호가 sma 상태엔 없음) 두 latent 버그를 갖고
    // 있어 골든 자체가 오염돼 있다(DIVERGENCES #179) — 골든 expected에 63.8/78/84.2 등 close가
    // ~100대인 데이터에서 산술평균으로 불가능한 값이 그 증거이고, pine2js actual은 손으로 재계산한
    // TV 정의("현재 length바 평균")와 전부 일치(4c84c643b5aa bar5: actual 106.0=(105+107+106)/3,
    // 1e94cbe822dc bar4: actual 104.2=최근 5바 평균). 4736c6a8b27f의 bar2 갈림만 별개로 기존
    // DIVERGENCES #8(ATR 워밍업 시프트)이 adaptive period 선택에 전파된 기존 클래스 재발현.
    // **결론: 신규 divergence 클래스 1건(#179, pine2py sma 고정-윈도우/같은-바 다중 전진 — 버그
    // 아님, pine2js가 TV 정합)** — 바닥선을 관측치로 갱신.
    // 2026-08-01 C574(str.match 반환형을 pine2py bool에서 TV 정합 string으로 정정, DIVERGENCES
    // #44 확정) 재실측: git stash로 src/runtime/str.ts만 전/후 격리해 mismatch 해시 집합을 직접
    // diff한 결과 정확히 1건(8a9f603ccf7a) 신규 추가, matched->강등 0건. 원인: 이 파일이
    // `var bool m = str.match("hello123", "\d+")`(pine2py 자신의 test_full_pipeline.py 픽스처와
    // 동일 관용구, DIVERGENCES #44 인용문 그 자체) — pine2py golden은 true(bool)인데 pine2js는
    // 이제 TV 정합 문자열 "123"을 내 nearlyEqual이 실패. 신규 divergence 클래스 아님(#44의 재발현),
    // 코드 버그 아님 — 바닥선을 관측치(mismatch 264)로 갱신.
    // 2026-08-02 C614(멀티라인 미종료 문자열 리터럴 지원, DIVERGENCES #192): 전/후 hash diff(git
    // stash로 lexer.ts만 격리, scratch/c509_diff_by_hash.mjs 재사용) 결과 정확히 2건(37667f717b25/
    // c0a73802713e) matched->mismatch. 둘 다 pine2py 자신의 "MultiLine"/"StrFull" 명명 테스트
    // 픽스처로 `header + "\n" + body`류 실제 줄바꿈 문자열 연결을 테스트하는데, pine2py
    // `_read_string`도 pine2js 기존 구현과 동일하게 줄 단위 한정이라 그 자신의 픽스처 의도조차
    // 못 살리는 latent 버그(#192에 상세) — pine2js가 이제 TV 정합으로 올바르게 이어 파싱해 골든과
    // 갈린다. 신규 divergence 클래스 1건(버그 아님, pine2py 오라클 오염) — 바닥선을 관측치(matched
    // 2648/mismatch 266)로 갱신.
    // 2026-08-04 C771(strategy.* 네임스페이스가 strategy() 선행 선언 없이도 유효 — wild tv_verdict
    // 실측, analyzer.ts/call-expr.ts 주석 참조): 00cab43c721c.pine(`indicator("DotAccess Strategy")
    // \n var int dir_ = strategy.long`)이 기존 하드 에러(transpile_fail)에서 새로 transpile 가능해짐.
    // 단 golden의 dir_ 값이 문자열 "long"(숫자/불리언 아님)이라 isComparableGoldenValue가 걸러
    // no_comparable_key로 착지(mismatch/matched 어느 쪽도 아님, 정확성과 무관한 harness 스칼라-only
    // 설계 한계) — transpileFailed -1/noComparable +1로 정확히 상쇄, 바닥선을 관측치로 갱신.
    expect(matched.length).toBeGreaterThanOrEqual(2648);
    expect(mismatched.length).toBeLessThanOrEqual(266);
    expect(transpileFailed.length).toBeLessThanOrEqual(86);
    expect(runtimeFailed.length, `runtime failures: ${runtimeFailed.map((o) => `${o.hash}: ${o.detail}`).join(" | ")}`).toBe(0);
    expect(noComparable.length, `no comparable key: ${noComparable.map((o) => o.hash).join(", ")}`).toBeLessThanOrEqual(2);
  });
});
