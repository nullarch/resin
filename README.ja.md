<p align="center">
  <img src="docs/logo.svg" width="96" alt="Resin logo — an amber droplet with a candlestick chart preserved inside">
</p>

<h1 align="center">Resin</h1>

<p align="center"><strong>TradingView の外で Pine Script を動かす。</strong></p>

<p align="center">
  <a href="https://github.com/nullarch/resin/actions/workflows/ci.yml"><img src="https://github.com/nullarch/resin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Pine_Script-v5%20%2F%20v6-1a7f37" alt="Pine Script v5 / v6">
  <img src="https://img.shields.io/badge/dependencies-none-success" alt="Zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <a href="#quick-start">クイックスタート</a> ·
  <a href="API.md">ライブラリ API</a> ·
  <a href="https://www.wavealgo.com/leaderboard">本番稼働例：wavealgo リーダーボード ↗</a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <strong>日本語</strong> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="docs/hero.svg" width="640" alt="Terminal session: a Pine Script indicator is compiled to JavaScript with resin build and executed with resin run">
</p>

Resin は Pine Script v5/v6 を素の JavaScript モジュールにコンパイルして実行します。
同じインジケーター、同じ時系列セマンティクス、それがあなた自身のマシンで動きます。
TradingView はスクリプトをプラットフォームの外に出させてくれません。これはそれを外に出す方法です。

- 実在するスクリプトの **95.1%** がコンパイルできる（10,618 本中、[測定方法は下記](#coverage)）
- **9,839 件のテスト**、加えて独立実装と 1e-9 の精度で突き合わせる差分オラクル
- **ランタイム依存ゼロ** — CLI は clone した状態からそのまま動く。インストール手順もビルド手順も不要
- **本番で稼働中** — [wavealgo リーダーボード](https://www.wavealgo.com/leaderboard)
  に並ぶスコアはすべてこのエンジンが計算しています

<a id="quick-start"></a>

## クイックスタート

Node 22.18 以上が必要です（TypeScript のソースを直接実行するため）。インストールするものはありません:

```bash
git clone https://github.com/nullarch/resin.git
cd resin

# インジケーターを実行し、最終バーの plot 値を表示する
node bin/resin.mjs run examples/rsi-cross.pine --bars 300
```

```text
RSI                      57.66239695569333
Smoothed                 54.056462491106444
```

```bash
# 読める形の JavaScript モジュールにコンパイルする
node bin/resin.mjs build examples/rsi-cross.pine -o rsi-cross.js

# 自分のスクリプトが入ったフォルダを指定し、どれだけコンパイルできるか調べる
node bin/resin.mjs check ./my-scripts

# 任意: node bin/resin.mjs と打つ代わりに `resin` を PATH に通す
npm install -g .
```

`run` は既定では決定論的なバーを合成します。`--data bars.json` を渡せば自分の OHLCV データを
使えます。npm には未公開です — 今のところは clone してください。

## なぜ作ったか

Pine はトレードのアイデアを表現するには良い言語ですが、アイデアを置いておく場所としては良くありません。
Pine スクリプトを CI で走らせることはできず、午後いっぱいで千本バックテストすることもできず、
ボットに組み込むこともできず、週末をかけてチューニングしたインジケーターを自分のアプリケーションに
持ち込むこともできません。そのどれもが、スクリプトが別の場所で動くことを必要とします。

Resin はコンパイラとランタイムであって、チャート製品ではありません。値を渡すところまでが Resin の仕事で、
その値をどう使うかはあなたのものです。

## 本番環境: wavealgo リーダーボード

「TradingView の外で Pine を動かす」ことを最も分かりやすく示すのは、それを大規模にやっているサイトです。
[wavealgo.com/leaderboard](https://www.wavealgo.com/leaderboard) — 同じチームが作っています — は、
1 枚のチャートでは到底できないやり方で Pine ストラテジーを採点します。各スクリプトはこのエンジンで
コンパイルされ、**6 市場 × 3 時間軸、1 スクリプトあたり 18 セル**でバックテストされます。
約定は TradingView の「次バーの始値」ルールに従い、片道ごとの手数料も加味した上で、判定と
アルファスコアが与えられます。あのページの数字はすべてこのコンパイラから出たものです。
[方法論](https://www.wavealgo.com/methodology)は公開されています。

何かを clone する前に Resin の出力がどんなものか見たいなら、そこから始めてください。

<a id="coverage"></a>

## カバレッジと、その数字の出どころ

GitHub から収集した公開 Pine v5/v6 スクリプト **12,424** 本のスナップショットに対して:

| | スクリプト数 | |
|---|---:|---|
| スナップショット | 12,424 | v5/v6、重複除去済み |
| — TradingView 自身も弾くもの | −1,085 | TradingView 純正のコンパイラで検証済み |
| — 解決できない非公開ライブラリを import しているもの | −719 | 対象外 |
| **母数** | **10,618** | |
| **コンパイル成功** | **10,100** | **95.1%** |

この 1,085 本の除外は私たちの判断ではありません。コンパイルに失敗したスクリプトはすべて
TradingView 純正のコンパイラに投げて結果を記録しており、これらは TradingView もまた受け付けない
ものです。本プロジェクトの以前のバージョンは検証ではなく推測でこの線引きをしており、
まったく正当なスクリプトを約 1,200 本も捨てかけました。

**コーパスはこのリポジトリには含まれていません。** ライセンスがまちまちで、多くの場合は明示すら
されていない、数千本のサードパーティ製スクリプトであり、それを再配布するのは私たちの権利では
ありません。したがってこの具体的な数字をここで再現することはできません。再現できるのは方法だけです。
すでにお手元にあるスクリプトに対して `resin check` を走らせてください。

リポジトリにある `corpus/` ディレクトリは、その調査とは別物です。参照実装自身のテストスイートから
取った Pine のフィクスチャで、後述の差分リプレイがこれを参照実装のゴールデン出力と突き合わせます。
ソースコメントが挙げている `corpus/wild/...` のほうは確かにその調査を指しており、
それらのパスはここでは解決しません。

## どう検証しているか

独立した検査が三つあります。単に自分自身と整合しているだけのコンパイラには、大した価値がないからです:

1. **参照実装との差分比較。** 同じ言語の独立した Python 実装が、同じスクリプトを同じバー列で実行し、
   出力をバーごとに突き合わせます — `oracle/` にある 263 本のスクリプトが 1e-9 で一致します。
   数か所だけ意図的に食い違っていますが、それは参照実装のほうが誤っている箇所であり、
   そのそれぞれについて黙って見逃すのではなく、呼び出し箇所で理由を論じています。
2. **TradingView 純正のコンパイラ**。そもそも何が正当な Pine なのかを決める裁定者としてです。
   これがあるからこそ「このスクリプトで失敗した」が、誰の推測も挟まずに「こちらの欠落」か
   「そもそも正当な Pine ではない」かに切り分けられます。
3. **テストスイート**。セマンティクスが実際に宿っている場所です。

## 実装済みの範囲

Pine のセマンティクスは独特で、作業量の大半は構文ではなくそちらにあります。あらゆる値が時系列であり、
`var` と `varip` はそれぞれ固有の初期化規則を持ち、`na` はすべての文脈で `NaN` と同じではなく、
テクニカル分析関数は呼び出し箇所ごとの隠れた状態を持っていてコンパイル時に確保する必要があり、
条件分岐の中の `ta.*` 呼び出しは、その分岐が実行されなかったバーでも状態を進めなければなりません。
実装され、テストされているのはこの部分です。

68 個の `ta.*` 関数、ストラテジーエンジン（エントリー、エグジット、ピラミッディング、`strategy.*` の状態）、
ユーザー定義型とメソッド、配列、マップ、行列、上位時間軸の集約を伴う `request.security`、
描画オブジェクト、そして `input.*` 一式。

## ライブラリとして使う

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

実行の途中経過を観測する必要がなければ、`run()` が同じことを 1 回の呼び出しで行います。
サポート対象の API 面は `src/index.ts` が export しているものが厳密にすべてです。
それ以外の `src/` 配下は内部実装であり、変更されます。[API.md](API.md) を参照してください。

## やらないこと

- **チャートはありません。** Resin は plot の系列を計算します。それを描くのはあなたの仕事です。
- **可視化専用の呼び出しは no-op にコンパイルされます。** `plotshape`、`plotchar`、`bgcolor`、
  `barcolor`、`hline`、`alertcondition`、`alert` などが装飾する対象のチャートはここには存在しないため、
  コンパイル時に落とされます。ただし引数の中に入れ子になった `plot()` 呼び出しは記録されます。
  シェイプの条件をデータとして得たい場合は、それを `plot()` してください。
- **注文約定は TradingView が文書化しているルール（成行は次バーの始値）に従いますが、TradingView 自身と
  突き合わせて確認したわけではありません。** ルールは仕様書から実装したものであって、並走比較から
  得たものではありません。インジケーターの値ではなくバックテストの数字に依存するのであれば、
  それは暫定値として扱ってください。
- **バー内の約定はバーデータからは原理的に確認できません。** 逆指値・指値・トレーリングでの決済は
  バーの内側のどこかで約定しますが、OHLC はその位置を記録しません。どのエンジンも — これも含めて —
  値動きの経路を推測しています。TradingView にも同じ制約があり、そのように明記しています。
- **`request.security` はあなたが渡したバーから集約されます**、取得するのではありません。
  日足を渡してスクリプトが週足を要求した場合、Resin はカレンダー集約で週足系列を組み立てます。
- **`v4` 以前には対応しません。** v5 が下限です。
- **一部のセマンティクスは推論であり、確認されたものではありません。** TradingView はすべてを
  文書化しているわけではありません — 週の境界で `dayofweek` が何を返すか、特定の組み込み関数を
  `na` がどう伝播するか、といったことです。挙動を推論するしかなかった箇所では、その推論と根拠が
  呼び出し箇所のコメントに置かれ、実測ではなく仮説として明示されています。
- **既知の欠落は、それが実際に問題になる場所に記録されています。** ロングテールにあるのは、
  多段の関数引数を経由したユーザー定義型フィールドのヒストリー参照や、ループ変数から組み立てた式を
  `request.security` に渡すケースなどです。それぞれ拒否される箇所にコメントがあり、回避策がある
  場合には併記されています。

## どうやって作られたか

Resin は自律エージェントのループによって、800 回あまりのイテレーションを重ねて開発されました。
各イテレーションは、固定された状態ファイル群に対する 1 コミットです。これを知っておく価値があるのは、
それがこのプロジェクトの形を説明するからです。上に挙げた検証の仕掛けは飾りではなく、
そのループを回しっぱなしにしても安全にした当のものです。差分オラクル、正当性を判定する外部の裁定者、
そして「再測定されるまでどんな主張も成立しない」という不動のルール — 機械がこれを書きながら
静かに壊してしまわずに済んだ理由は、そこにあります。

その帰結が一つ、すぐ目に見える形で現れます。何かを実行する前に知っておいてください:

- **コンパイラのエラーメッセージはまだ韓国語です** — 378 件あります。スクリプトのコンパイルに失敗すると、
  その理由があなたの読めない言語で返ってくるかもしれません。このリストの中でこれが最優先で修正されます。
  ツールを*読む*ことではなく*使う*ことに影響する唯一の項目だからです。
- **`src/` のコメントのおよそ三分の一が韓国語です**、およそ 14,000 行。読み飛ばすという選択肢は
  現実的ではありません — 奇妙に見える分岐の背後にある論拠の多くがそこに書かれているからです —
  そのため、削除するのではなく翻訳を進めています。
- コード、識別子、README、API ドキュメントはすべて英語です。

翻訳は上流の開発リポジトリで行われ、再スナップショットによってここに反映されるため、
少しずつではなくまとまった単位で届きます。

## PineTS についての告知

[PineTS](https://github.com/alaa-eddine/PineTS) は既存の AGPL-3.0 の Pine→JavaScript プロジェクトです。
Resin はそれとコードを共有していません。文書化されていない TradingView のセマンティクス —
`dayofweek` の値、どの plot スタイルが存在するか、といった類のもの — についてのブラックボックスな
挙動の参照先として参照しており、それを行った箇所はすべてソースコードのコメントで出典を明記しています。
来歴が主張ではなく監査可能であるようにするためです。サードパーティ製品についての事実に著作権は
及びません。その実装がこちらに読み込まれたことはありません。

## ライセンス

Apache-2.0。[LICENSE](LICENSE) を参照してください。

Pine Script および TradingView は TradingView, Inc. の商標です。本プロジェクトは TradingView と
提携関係にはなく、その承認を受けたものでもありません。
