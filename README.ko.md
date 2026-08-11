<p align="center">
  <img src="docs/logo.svg" width="96" alt="Resin logo — an amber droplet with a candlestick chart preserved inside">
</p>

<h1 align="center">Resin</h1>

<p align="center"><strong>TradingView 밖에서 Pine Script를 실행하세요.</strong></p>

<p align="center">
  <a href="https://github.com/nullarch/resin/actions/workflows/ci.yml"><img src="https://github.com/nullarch/resin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Pine_Script-v5%20%2F%20v6-1a7f37" alt="Pine Script v5 / v6">
  <img src="https://img.shields.io/badge/dependencies-none-success" alt="Zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <a href="#quick-start">빠른 시작</a> ·
  <a href="API.md">라이브러리 API</a> ·
  <a href="https://www.wavealgo.com/leaderboard">실제 운영 사례: wavealgo 리더보드 ↗</a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <strong>한국어</strong>
</p>

<p align="center">
  <img src="docs/hero.svg" width="640" alt="Terminal session: a Pine Script indicator is compiled to JavaScript with resin build and executed with resin run">
</p>

Resin은 Pine Script v5/v6를 평범한 JavaScript 모듈로 컴파일해서 실행합니다. 같은 지표,
같은 시계열 시맨틱스를 당신의 기계에서 돌립니다. TradingView는 스크립트가 플랫폼 밖으로
나가는 것을 허용하지 않습니다. 이건 그걸 꺼내오는 방법입니다.

- 실제 스크립트 10,618개 중 **95.1%** 컴파일 ([측정 방법은 아래](#coverage))
- **테스트 9,870개**, 그리고 독립 구현과 1e-9까지 대조하는 차분 오라클
- **런타임 의존성 0** — CLI는 clone한 그대로 실행됩니다. 설치 단계도, 빌드 단계도 없습니다
- **프로덕션에서 가동 중** — [wavealgo 리더보드](https://www.wavealgo.com/leaderboard)의
  모든 점수가 이 엔진으로 계산됩니다

<a id="quick-start"></a>

## 빠른 시작

Node 22.18 이상이 필요합니다 (TypeScript 소스를 직접 실행합니다). 설치할 것은 없습니다:

```bash
git clone https://github.com/nullarch/resin.git
cd resin

# 지표를 실행하고 마지막 바의 plot 값을 출력
node bin/resin.mjs run examples/rsi-cross.pine --bars 300
```

```text
RSI                      57.66239695569333
Smoothed                 54.056462491106444
```

```bash
# 읽을 수 있는 JavaScript 모듈로 컴파일
node bin/resin.mjs build examples/rsi-cross.pine -o rsi-cross.js

# 자기 스크립트 폴더를 지정해서 그중 얼마나 컴파일되는지 확인
node bin/resin.mjs check ./my-scripts

# 선택: node bin/resin.mjs 대신 `resin` 명령을 PATH에 등록
npm install -g .
```

`run`은 기본적으로 결정론적인 바를 합성합니다. `--data bars.json`을 넘기면 자신의 OHLCV
데이터를 쓸 수 있습니다. 아직 npm에 올라가지 않았습니다 — 지금은 clone해서 쓰세요.

## 왜 만들었나

Pine은 매매 아이디어를 표현하기에는 좋은 언어지만, 아이디어를 보관하기에는 나쁜 장소입니다.
Pine 스크립트는 CI에서 돌릴 수 없고, 하루 오후에 천 개를 백테스트할 수 없고, 봇에 임베드할 수
없고, 주말 내내 튜닝한 지표를 자기 애플리케이션에 넣을 수도 없습니다. 그 모든 일이 스크립트가
다른 곳에서 실행되기를 요구합니다.

Resin은 컴파일러이자 런타임이지 차팅 제품이 아닙니다. 값을 줄 뿐이고, 그 값으로 무엇을 할지는
당신의 몫입니다.

## 프로덕션: wavealgo 리더보드

"Pine을 TradingView 밖에서 돌린다"를 가장 분명하게 보여주는 것은, 그걸 대규모로 하고 있는
사이트입니다. [wavealgo.com/leaderboard](https://www.wavealgo.com/leaderboard) — 같은 팀이
만들었습니다 — 는 차트 한 장으로는 결코 할 수 없는 방식으로 Pine 전략을 채점합니다. 각
스크립트는 이 엔진으로 컴파일되어 **6개 시장 × 3개 타임프레임, 스크립트당 18개 셀**에서
백테스트되며, TradingView의 다음 바 시가 체결 규칙과 편도 수수료를 적용한 뒤 판정과 알파
점수를 받습니다. 그 페이지의 모든 숫자가 이 컴파일러에서 나왔고,
[방법론](https://www.wavealgo.com/methodology)은 공개되어 있습니다.

아무것도 clone하기 전에 Resin의 출력이 어떤 모양인지 보고 싶다면 거기서 시작하세요.

<a id="coverage"></a>

## 커버리지, 그리고 그 숫자의 출처

GitHub에서 수집한 공개 Pine v5/v6 스크립트 **12,424개** 스냅샷에 대해:

| | 스크립트 | |
|---|---:|---|
| 스냅샷 | 12,424 | v5/v6, 중복 제거 |
| — TradingView도 거부하는 것 | −1,085 | TradingView 자체 컴파일러로 검증 |
| — 해석할 수 없는 비공개 라이브러리를 import | −719 | 범위 밖 |
| **분모** | **10,618** | |
| **컴파일 성공** | **10,100** | **95.1%** |

이 1,085개 제외는 우리의 판단이 아닙니다. 실패한 스크립트는 전부 TradingView 자체 컴파일러에
제출해 결과를 기록했고, 이것들은 TradingView 역시 거부하는 것들입니다. 이 프로젝트의 이전
버전은 검증 대신 추론으로 그 선을 그었고, 멀쩡한 스크립트 약 1,200개를 버릴 뻔했습니다.

**코퍼스는 이 저장소에 없습니다.** 라이선스가 뒤섞여 있고 대개는 아예 없는 서드파티 스크립트
수천 개이며, 그것을 재배포하는 것은 우리 권한이 아닙니다. 그래서 이 특정 숫자를 여기서 재현할
수는 없습니다 — 재현할 수 있는 것은 방법뿐입니다. 이미 가지고 있는 스크립트에 `resin check`를
돌려보세요.

저장소에 있는 `corpus/` 디렉토리는 그 조사와는 다른 것입니다. 참조 구현 자체의 테스트 스위트에서
가져온 Pine 픽스처이고, 아래의 차분 리플레이가 이것을 참조 구현의 골든 출력과 대조합니다. 소스
주석이 인용하는 `corpus/wild/...` 쪽이 그 조사를 가리키며, 그 경로들은 여기서 해석되지 않습니다.

## 어떻게 검증하는가

독립적인 검사 세 가지. 자기 자신과만 일관된 컴파일러는 별 가치가 없기 때문입니다:

1. **참조 구현과의 차분 대조.** 같은 언어의 독립적인 Python 구현이 같은 스크립트를 같은 바
   위에서 돌리고, 출력을 바 단위로 대조합니다 — `oracle/`의 263개 스크립트가 1e-9까지
   일치합니다. 몇 군데는 의도적으로 불일치하는데, 그 지점들은 참조 구현 쪽이 틀렸기
   때문입니다. 각각을 조용히 넘기는 대신 호출 지점에서 근거를 적어두었습니다.
2. **TradingView 자체 컴파일러**를 무엇이 유효한 Pine인지 가리는 심판으로 씁니다. 이것이
   "우리가 이 스크립트에서 실패했다"를 누구의 추측도 없이 "우리 쪽 공백"이냐 "애초에 유효한
   Pine이 아니다"냐로 갈라줍니다.
3. **테스트 스위트**, 시맨틱스가 실제로 살고 있는 곳입니다.

## 구현된 범위

Pine의 시맨틱스는 독특하고, 작업량의 대부분은 문법이 아니라 거기에 있습니다. 모든 값이
시계열이고, `var`와 `varip`는 각자의 초기화 규칙을 가지며, `na`는 모든 문맥에서 `NaN`인 것이
아니고, 기술적 분석 함수는 컴파일 타임에 할당해야 하는 호출별 숨은 상태를 지니며, 조건부로
실행되는 `ta.*` 호출은 그 분기가 실행되지 않은 바에서도 상태를 전진시켜야 합니다. 구현되고
테스트된 부분이 바로 이것들입니다.

`ta.*` 함수 68개, 전략 엔진(진입, 청산, 피라미딩, `strategy.*` 상태), 사용자 정의 타입과
메서드, 배열, 맵, 행렬, 상위 타임프레임 집계를 포함한 `request.security`, 드로잉 객체,
그리고 `input.*` 계열.

## 라이브러리로 사용하기

```js
import { transpile, compile, Context } from '@nullarch/resin';

const result = transpile(source, { chartTf: 'D' });
if (!result.ok) throw new Error(result.errors.join('\n'));

const ctx = new Context(
  data, result.varSlots.length, result.taSlotCount, result.fnVarSlotCount,
  result.historySlotCount, result.taScratchSize, {},
  result.plotTitles.length, result.securityTfs, result.refHistorySlotCount,
  result.condCallHistorySlotCount, result.condCallRefHistorySlotCount,
);
const bar = compile(result.code)(ctx);
for (let i = 0; i < ctx.barCount; i++) { ctx.advance(); bar(); }

console.log(ctx.plots[0].toArray());
```

실행 도중의 상태를 관찰할 필요가 없다면 `run()`이 같은 일을 한 번의 호출로 처리합니다.
지원되는 표면은 정확히 `src/index.ts`가 export하는 것뿐이며, 그 밖의 `src/` 아래는 전부
내부 구현이고 바뀝니다. [API.md](API.md)를 참고하세요.

## 하지 않는 것

- **차트 없음.** Resin은 plot 시리즈를 계산합니다. 그리는 것은 당신의 몫입니다.
- **시각화 전용 호출은 no-op으로 컴파일됩니다.** `plotshape`, `plotchar`, `bgcolor`,
  `barcolor`, `hline`, `alertcondition`, `alert` 같은 것들은 여기 존재하지 않는 차트를
  꾸미는 호출이라 컴파일 시점에 제거됩니다 — 다만 인자 안에 중첩된 `plot()` 호출은 여전히
  기록됩니다. 어떤 모양의 조건을 데이터로 받고 싶다면 그것을 `plot()` 하세요.
- **주문 체결은 TradingView가 문서화한 규칙(시장가 주문은 다음 바 시가)을 따르지만, TradingView
  자체와 대조해 확인한 것은 아닙니다.** 규칙은 명세를 보고 구현한 것이지 나란히 돌려서 얻은
  것이 아닙니다. 지표 값이 아니라 백테스트 숫자에 의존한다면 잠정치로 취급하세요.
- **바 내부 체결은 바 데이터만으로는 애초에 확인이 불가능합니다.** 스탑, 리밋, 트레일링 청산은
  바 안쪽 어딘가에서 체결되는데 OHLC는 그 위치를 기록하지 않습니다. 어떤 엔진이든 — 이것을
  포함해서 — 가격 경로를 추측하고 있습니다. TradingView도 같은 한계를 가지고 있고 그렇게
  밝히고 있습니다.
- **`request.security`는 당신이 제공한 바에서 집계됩니다**, 가져오는 것이 아닙니다. 일봉을
  넣었는데 스크립트가 주봉을 요구하면 Resin이 캘린더 집계로 주봉 시리즈를 만듭니다.
- **`v4` 이하는 지원하지 않습니다.** v5가 하한입니다.
- **일부 시맨틱스는 추론이지 확인된 것이 아닙니다.** TradingView가 모든 것을 문서화하지는
  않습니다 — 주 경계에서 `dayofweek`가 무엇을 반환하는지, 특정 빌트인을 통해 `na`가 어떻게
  전파되는지 같은 것들입니다. 동작을 추론할 수밖에 없었던 곳은 그 추론과 근거가 호출 지점
  주석에 있고, 실측이 아니라 가설이라고 표시되어 있습니다.
- **알려진 공백은 그것이 실제로 걸리는 자리에 기록되어 있습니다.** 롱테일에는 다단계 함수
  파라미터를 통한 사용자 정의 타입 필드의 히스토리 접근, 또는 루프 변수로 만든 표현식을
  `request.security`에 넘기는 경우 같은 것들이 있습니다. 각각 거부되는 지점에 주석이 있고,
  우회 방법이 있으면 함께 적어두었습니다.

## 어떻게 만들어졌나

Resin은 자율 에이전트 루프로 800여 회의 반복을 거쳐 개발되었습니다. 각 반복은 고정된 상태
파일 묶음에 대한 단일 커밋입니다. 이걸 알아둘 가치가 있는 이유는 이 프로젝트의 모양을
설명해주기 때문입니다. 위의 검증 장치는 장식이 아니라, 그 루프를 켜둔 채로 두어도 안전하게
만들어준 바로 그것입니다. 차분 오라클, 유효성을 가리는 외부 심판, 그리고 어떤 주장도
재측정되기 전까지는 인정하지 않는다는 상시 규칙 — 기계가 이걸 쓰면서도 조용히 망가뜨리지
않을 수 있었던 이유가 거기 있습니다.

그 결과 하나가 즉시 눈에 보이고, 무엇을 실행하기 전에 알아두는 게 좋습니다:

- **컴파일러 에러 메시지가 아직 한국어입니다** — 378개. 한국어 사용자에게는 지금 그대로
  읽히지만, 이 프로젝트의 코드·문서가 영어인 이상 영어권 사용자에게는 읽을 수 없는 언어로
  실패 이유가 돌아간다는 뜻입니다. 그래서 이 목록에서 가장 먼저 고쳐지고 있습니다. 도구를
  *읽는* 것이 아니라 *쓰는* 것에 영향을 주는 유일한 항목이기 때문입니다. 곧 영어로 바뀝니다.
- **`src/` 주석의 약 3분의 1이 한국어입니다**, 대략 14,000줄. 그냥 지우는 건 선택지가 아닙니다
  — 이상해 보이는 분기 뒤의 근거 상당수가 거기 살고 있어서 — 그래서 제거가 아니라 번역하고
  있습니다.
- 코드, 식별자, README와 API 문서는 전부 영어입니다.

번역은 상위 개발 저장소에서 이루어지고 재스냅샷으로 여기 반영되므로, 조금씩이 아니라 묶음
단위로 도착합니다.

## PineTS에 관한 고지

[PineTS](https://github.com/alaa-eddine/PineTS)는 기존에 존재하는 AGPL-3.0 라이선스의
Pine→JavaScript 프로젝트입니다. Resin은 그것과 코드를 공유하지 않습니다. 달리 문서화되어 있지
않은 TradingView 시맨틱스 — `dayofweek`의 값, 어떤 plot 스타일이 존재하는지 같은 것들 — 에
대한 블랙박스 행동 레퍼런스로 참조했으며, 그렇게 한 모든 지점은 소스 주석에 출처를 인용해
두어 출처가 주장이 아니라 감사 가능하도록 했습니다. 서드파티 제품에 관한 사실은 저작권의
대상이 아니며, 그 구현이 이쪽으로 읽혀 들어온 적은 없습니다.

## 라이선스

Apache-2.0. [LICENSE](LICENSE)를 참고하세요.

Pine Script와 TradingView는 TradingView, Inc.의 상표입니다. 이 프로젝트는 TradingView와
제휴 관계가 없으며 승인을 받지도 않았습니다.
