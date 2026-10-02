# potree-v2-three 監査レポート

## 1. 調査概要

対象コミットは `84b71afbb04f4c8226ab742d551722deb3033937`。調査日は **2026年10月2日、基準テスト完了 14:03 JST（05:03 UTC）、最終整合確認 14:42 JST（05:42 UTC）**。開始時の作業ツリーは clean で、`AGENTS.md` は見つからなかった。製品コード、既存テスト、lockfile は変更していない。追加したのは本レポート、監査用スクリプト・ブラウザ harness・観測テスト、ログである。

途中から `apps/web` に別作業の変更（node → space 等）が現れ、終了時の HEAD は `7acd189b9f6e36be1846929f2f879de35836f453` になった。これらには触れていない。開始・終了コミット間の `packages/potree-v2-three` / `apps/playground` の tracked diff は空である。ライブラリの `src/`、README、既存 package tests、既存ブラウザ harness/spec は対象コミットと同一である。web のチェック・ビルド結果は実行時点のスナップショットの結果であり、別作業の最終成果全体を再検証した結果ではない。

以下の `src/`、`tests/`、README の参照基点は、特記しない限り `packages/potree-v2-three/`。ブラウザの `harness.ts` / `rendering.spec.ts` は `apps/playground/e2e/`。lockfile の SHA-256 は `30c745d3417dc7f46d790bb74b57b8b1b8877a397196983ee0376a715ca5b17c` で、調査前後で不変。

| 項目               | 実測・確認結果                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS                 | Linux x86_64、WSL2、kernel `6.18.40.1-microsoft-standard-WSL2`                                                                                                                        |
| Node / pnpm        | `v24.21.0` / `12.6.0`                                                                                                                                                                 |
| workspace Three.js | `0.180.0`、型 `@types/three` は r180 系                                                                                                                                               |
| TypeScript / Vite  | TypeScript 6.0 系、workspace Vite `8.3.1`、梱包版検証 Vite `8.3.0`                                                                                                                    |
| ブラウザ           | Playwright Chromium `153.0.8010.12`、headless                                                                                                                                         |
| WebGL / GPU        | WebGL2、ANGLE Vulkan、SwiftShader Device (Subzero)                                                                                                                                    |
| GPU 上限           | `MAX_VERTEX_UNIFORM_VECTORS=4096`、`MAX_TEXTURE_SIZE=8192`                                                                                                                            |
| 対象               | package の全実装モジュール、全テストファイル・fixture、README / package.json / tsconfig / dist / exports、playground の e2e と利用箇所、web の viewer、Potree の関連 loader / shaders |
| 調査の限界         | WASM バイナリそのものの逆解析・Brotli ビルド再現、全ブラウザ・実 GPU、全機能組み合わせは未実施                                                                                        |

README 冒頭と peerDependencies は **PotreeConverter の metadata version `2.0`、DEFAULT / BROTLI、Three.js r180〜r189** を対象としている。Potree v1、Potree-Next v3 の未対応は不具合に数えていない。Converter の製品版番号と metadata の `version: "2.0"` は別物である。

発見事項は **21件**。分類は、確認済みバグ11件、性能・リソース上の問題4件、仕様・ドキュメントの不整合4件、検証漏れ2件。重要度は **高7件、中10件、低4件**。高はデータの大幅な誤復号、中断・描画状態の破綻、無制限な探索や上限を超えるメモリ使用を優先した。重要度と確信度は独立している。未再現のリスクは第6節で明記し、この件数に混ぜていない。

既存単体 **116/116**、既存実ブラウザ **19/19** が成功した。それでも、64 bit 属性の精度損失、Worker 復号中の中断待ち、EDL 例外時の `autoClear` 復元漏れ、scissor を無視するピックを再現した。追加観測テストは Node **19/19**、ブラウザ **2/2**、既存を含む最終ブラウザ実行は **21/21**。追加観測テストの成功は「不具合を再現できた」という意味であり、「修正された」という意味ではない。

## 2. 実装と仕様の整理

### 2.1 読み込みから破棄まで

1. `loadPotreeV2()` は URL を解決し、オリジン別 `RequestGate` を通して metadata を取得・検証する。
2. 点群を構築し、全点群共通の `DecoderPool` を acquire / warm する。最初の hierarchy を取得し、root の octree データを取得・復号・ジオメトリ化する。この初期処理はセット参加前に行う。
3. `PotreeV2PointCloudSet.update()` は全点群共通の heap で LOD を選択する。近いバイト範囲を `makeNodeBatches()` でまとめる。HTTP 枠はセット別、429 / 503 の gate と Worker backlog はセットをまたいで共有する。
4. バイト取得終了で HTTP 枠を返却し、ArrayBuffer を Worker に transfer する。encoded cache 用のノード payload は transfer 前に別途コピーする。Brotli は列配置、DEFAULT は点ごとの interleaved 配置を復号する。
5. 復号結果を `decodedQueue` に入れ、フレーム当たりのノード数に従ってシーンへ追加する。点座標はノード bbox 最小値に対する Float32 相対座標で、ノードの平行移動を double の行列に残す。
6. 非表示になったジオメトリは点数ベース LRU で削除する。encoded cache はセット共有のバイトベース LRU。root と選択中のノードには削除例外がある（A06）。
7. `dispose()` はセットから外し、取得を abort、waiter を reject、ジオメトリ・material・texture を dispose、共有 Worker / picker / bbox resources を release する。最後の所有者が共有リソースを破棄する。

### 2.2 共有リソースと公開契約

| リソース・API                                                                    | 所有・更新契約                                                             | 調査結果                                                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `group`, `boundingBox`, `worldOffset`                                            | group は点群ローカル座標、bbox / offset はコピーを返す                     | 単体テストと実装で確認                                                                              |
| `metadata`                                                                       | readonly 型で外部に公開                                                    | 実行時 freeze は行わない。JS からの書き換えは同一参照へ作用するため、変更不可の契約を守る必要がある |
| `loadPotreeV2FromFiles`, `selectPotreeV2Files`                                   | 同一フォルダの3ファイルを選択し slice で読む                               | 不足・複数完成フォルダは reject、同名重複は A07                                                     |
| `pointBudget`, `cachePointBudget`, `maxConcurrentLoads`, `maxNodesToGPUPerFrame` | セットで共有、変更は次回 update                                            | A05 / A06 / A09 / A14 に例外・問題                                                                  |
| `cacheEncodedNodes`, `encodedCacheByteBudget`                                    | 点群別の利用可否、セット別バイト上限                                       | disable / LRU / 点群識別 / 失敗データ非保存を確認                                                   |
| `DecoderPool`                                                                    | 全点群共通、最大要求数まで増加、最後の release で終了                      | 基本共有と異常後の交換は検証済み。中断 A04、最大数の寿命 A12                                        |
| `RequestGate`                                                                    | オリジン別、429 / 503 の待機と並列数回復                                   | 通常の pause / retry / recovery は既存テストで検証。redirect の実オリジンは追跡していない           |
| `loading`, `whenLoaded({signal})`                                                | update 時に settle、次回 update で waiter 解決。dispose / signal で reject | 単体の正常・中断経路を確認。失敗が続けば loaded にならないのは記載どおり                            |
| `material`                                                                       | ShaderMaterial 継承、色・サイズ・形・分類はアプリが再描画を要求            | 色変更で update が false のままなのは記載された契約。material の可視性と pick は A16                |
| clipping                                                                         | ワールド座標、keep の和集合、hide / plane との積、変更を次回 update で検出 | 主要組み合わせ成功。階層 prune の複合条件 A10                                                       |
| `pick`, set の `pick`                                                            | CSS px、現在の viewport と camera layers、非同期整数 target readback       | equal depth / log depth / DPR / viewport 成功。scissor A15、view offset の説明 A18                  |
| `PotreeV2EDL`                                                                    | シーン・点群・合成の3描画、target / viewport を復元                        | 正常時の合成と深度成功。例外時 A08                                                                  |
| stats / diagnostics                                                              | コピーで返す、世代別リセット、互換性保証外                                 | 単体テストで確認。診断の complete は500 ms安定後で `loading=false` と時刻が異なる                   |

セットから外した点群の表示をそのまま残すのは公開 API の意図であり、不具合扱いしていない。ただし進行中の取得枠が新しいセットに移管されない問題は A14 として扱った。

### 2.3 仕様の根拠と比較

- `ref/potree` は別 git リポジトリ、commit **`5636cd471d9eb464969e758be45c44d7613d3859`**（2026-01-08）、package version **1.8.0**。Viewer 全体が1.8系でも、比較したのは `src/modules/loader/2.0/` にある **v2 loader** と関連 shader / visibility texture である。v1 loader の仕様を当該 package に押し付けていない。
- Converter の一次実装は一時環境に取得した commit **`c2cb61843bf2b901e8e257874b1a6dcf67792fb2`**（2026-09-23、tag 2.1.5）。metadata は `2.0` を出力する。`Writer.cpp:100–144` の位置 Morton は上位48 bit → 下位48 bit、RGB は8 byte、generic は属性列。`HierarchyBuilder.h:257–280` は chunk root の proxy を NORMAL に変えて出力し、22 byte の uint64 offset / size を書く。
- package の signed int32 位置復号、Morton high / low と列配置は、Converter と独立に組み立てた合成値、DEFAULT / BROTLI 実 fixture の一致で裏付けた。
- 参照 Potree は hierarchy offset / size を `getBigInt64` で読むが、Converter は uint64 で書く。ここは package の `getBigUint64` が書き手に合う。参照の getter をそのまま仕様とはしない。
- 参照 Potree の generic `int64` / `uint64` getter はコメントアウトされている（`DecoderWorker.js:112–123`）。参照だけでは当該 package の64 bit対応の正しさを保証できない。
- 参照の RGB は値ごとに8 / 16 bitを推測する。package は metadata max があればデータ全体のbit幅を選ぶ。暗い16 bit色を明るくしないための記載された差であり、不具合扱いしていない。
- 参照の density 補正は texture へ uint8 / 0.1 level 単位で量子化する。package は Float32 bits を保存するため、README の「同じ大きさ」は厳密には一致しない（A17）。
- 実 fixture の LICENSE は Converter の具体的な版、commit、完全な変換コマンド、入力のハッシュを記録していない。今回取得した Converter と同じ版で作ったと断定できない。今回は Converter 本体をビルドして fixture を再生成する検証は行っていない。

## 3. 実行した検証

### 3.1 コマンドと結果

各コマンドはリポジトリ root から実行。scripts を読んでから実行した。ログは [audit-artifacts/potree-v2-three/](audit-artifacts/potree-v2-three/) に保存した。

| コマンド                                                                                                                  | 結果                                                                 | ログ                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm test`                                                                                                               | build 成功、既存116件成功、skipなし                                  | `baseline-unit.log`                                  |
| `pnpm test:browser`（追加前）                                                                                             | 実WebGL、既存19件成功                                                | `baseline-browser.log`                               |
| `pnpm --filter @geemil/potree-v2-three build`                                                                             | 成功、JS / declaration / source map / vendor JS 出力                 | `build-library.log`                                  |
| `pnpm --filter playground build`                                                                                          | 成功（追加 e2e の型チェックも成功）。500 kB超 bundle の警告          | `build-playground.log`, `final-build-playground.log` |
| `pnpm --filter web check`                                                                                                 | Svelte check 0 errors / 0 warnings                                   | `check-web.log`                                      |
| `pnpm --filter web build`                                                                                                 | 成功。Vite設定の拡張子・bundle size 等の警告                         | `build-web.log`                                      |
| `pnpm lint`（追加前 / 最終）                                                                                              | 成功                                                                 | `baseline-lint.log`, `final-root-lint.log`           |
| `node --test docs/audit-artifacts/potree-v2-three/repro.mjs`                                                              | 19件成功。観測用の不具合assertと正常経路の追加検証                   | `repro-unit.log`                                     |
| `pnpm --filter playground exec playwright test e2e/audit.spec.ts`                                                         | 2件成功、通常深度 / log depth、shader error / GL errorなし           | `repro-browser.log`                                  |
| `pnpm test:browser`（追加後）                                                                                             | 21件成功                                                             | `final-browser.log`                                  |
| `pnpm --filter @geemil/potree-v2-three pack --pack-destination /tmp/potree-audit-reference`                               | prepack build 成功。公開対象の tarball を生成                        | `pack.log`                                           |
| `node docs/audit-artifacts/potree-v2-three/packed-check.mjs /tmp/potree-audit-reference/geemil-potree-v2-three-0.1.0.tgz` | 独立7環境、各116単体テストと2 encodingのproduction browser probe成功 | `packed-compatibility.log`                           |
| `node docs/audit-artifacts/potree-v2-three/mutation-check.mjs`                                                            | 一時 dist コピーの texture 拡張を壊しても既存 point-size 6件が成功   | `mutation-texture.log`                               |
| r189 を独立環境へ install / `npm view three@0.189.0 version`                                                              | install は ERESOLVE。追加確認で version は E404、最新公開版は0.186.1 | `install-r189.log`, `three-published-versions.json`  |

再現スクリプト開発中には、テクスチャのノード名の辞書順を誤ったassert、監査スクリプト自身のlint、production probe のJSON asset配置の誤りを修正した。これらは製品の不具合として数えていない。製品への修正や依存解決の `--force` は行っていない。梱包版7環境の実行では検証プロセスに `MaxListenersExceededWarning` が1回出たが、各環境は正常終了した。検証ツール / bundler 起因を切り分けていないため、製品のリークとは判定していない。

### 3.2 梱包版の互換性

| Three.js   | 既存単体 | Vite production build / Worker / BROTLI | 実WebGLの画素・pick・EDL |
| ---------- | -------- | --------------------------------------- | ------------------------ |
| 0.180.0    | 116/116  | 成功                                    | 成功                     |
| 0.181.0    | 116/116  | 成功                                    | 成功                     |
| 0.182.0    | 116/116  | 成功                                    | 成功                     |
| 0.183.0    | 116/116  | 成功                                    | 成功                     |
| 0.184.0    | 116/116  | 成功                                    | 成功                     |
| 0.185.0    | 116/116  | 成功                                    | 成功                     |
| 0.186.1    | 116/116  | 成功                                    | 成功                     |
| r187〜r189 | 未実施   | npm公開版を取得できず                   | 未実施                   |

各環境は `mkdtemp()` 配下に npm install した。workspace の lockfile を変更せず、tarball の `dist` を利用して既存テストを実行した。実 fixture は読み取り用に参照した。ブラウザ側の合成点 `(4,4,4)` と赤RGB / 分類6は独立にバイトを作成し、Brotli圧縮は Node `brotliCompressSync()` を利用した。Vite の **production 出力を preview** して、DEFAULT / BROTLI の赤画素 `[255,0,0,255]`、`sourcePosition=[4,4,4]`、hidden classification の null、EDL strength=0 の画素を確認した。Worker URL とBrotli moduleが workspace alias に依存せず配布物から解決されることを確認した。

これは各版の全ブラウザsuite、全shader、全パッチ版、consumer TypeScript / `@types/three` の全版組み合わせを検証したという意味ではない。exports の ESM入口と declaration は確認したが、CommonJS入口は提供されていない。unbundled browser / CDN import map / CSP制限下のWorkerは未実施。

### 3.3 独立性とテストの検出力

合成テストでは hierarchy レコードを DataView で直接構築し、64 bit の期待値は **BigInt差分から**計算した。ブラウザの期待座標・色も既知の1点を基準にした。実装のデコーダーで期待値を作る方法を正しさの根拠にしていない。Worker応答・HTTP完了は明示的に保留 / 解放し、dispose / set移動の観測時点を制御した。

既存 converter-output の「full pump と一致」は、比較先 pump も同じ package デコーダーで読む。この比較はデータ間整合性を検査するが、共有する復号誤りを独立に検出できない。DEFAULT / BROTLI 一致も同じoffset処理の誤りには弱い。合成 signed position / generic attribute 等の既存テストはこの弱点の一部を補う。

既存ブラウザの DEFAULT / BROTLI は **digest 完全一致**であり、画像比較の広い許容差による見逃しはない。ただしpump 2000点という同一データに依存し、色の平均や「1000画素以上」だけで色域・gamma全域を保証しない。既存 EDL の6 viewportケースはすべて **strength=0**（`harness.ts:461`）なので、深度と合成は検査するが、陰影の式・radius・strength の校正を検査しない。

## 4. 発見事項一覧

「確認済み」は下記の限定した条件での再現を指す。分類の「性能・リソース」も具体的な動作は観測済みで、OOMなど未実行の影響は詳細で区別した。

| ID  | 分類                       | 重要度 | 確信度 | 概要                                                              | 再現                |
| --- | -------------------------- | ------ | ------ | ----------------------------------------------------------------- | ------------------- |
| A01 | 確認済みバグ               | 中     | 高     | metadata点数・属性重複・計算後bboxの検証不足                      | Node                |
| A02 | 確認済みバグ               | 高     | 高     | uint64をNumberにした後で正規化し、狭い値域を潰す                  | DEFAULT / BROTLI    |
| A03 | 性能・リソース上の問題     | 高     | 高     | 循環proxy範囲でpointBudget=0でも階層が伸び続ける                  | 応答制御、12 update |
| A04 | 確認済みバグ               | 高     | 高     | rootをWorkerで復号中にabortしてもloadが待ち続ける                 | Worker応答制御      |
| A05 | 性能・リソース上の問題     | 高     | 高     | decodedQueueの32ノードguardを超えて64ノードが滞留                 | 73ノード合成データ  |
| A06 | 仕様・ドキュメントの不整合 | 中     | 高     | cachePointBudget=0でも非表示root全点群を保持                      | 2点群               |
| A07 | 確認済みバグ               | 中     | 高     | 同一フォルダ・同名ファイルを黙って上書き選択                      | File合成            |
| A08 | 確認済みバグ               | 高     | 高     | EDL第2描画の例外でautoClear復元を通らない                         | mockと実WebGL       |
| A09 | 確認済みバグ               | 中     | 高     | NaN設定がrejectされずGPU追加とloadingが停止する                   | Node                |
| A10 | 性能・リソース上の問題     | 中     | 高     | 非pruneクリップが祖先を隠すと子のprune判定を失う                  | clipNode合成        |
| A11 | 確認済みバグ               | 低     | 高     | Content-Rangeのtotalと終端の矛盾を受け入れる                      | Response合成        |
| A12 | 仕様・ドキュメントの不整合 | 低     | 高     | 最大Worker数は生存点群の最大でなくプールの過去最大                | acquire / release   |
| A13 | 確認済みバグ               | 中     | 高     | generic `color` がrgb由来のgeometry属性を上書き                   | 合成バイナリ        |
| A14 | 確認済みバグ               | 中     | 高     | 取得中のセット移動で移動先の並列数上限を超える                    | HTTP完了制御        |
| A15 | 確認済みバグ               | 高     | 高     | scissorで描かれない点がpickで当たる                               | 実WebGL両深度       |
| A16 | 確認済みバグ               | 中     | 高     | material.visible=falseでもpickで当たる                            | 実WebGL両深度       |
| A17 | 仕様・ドキュメントの不整合 | 低     | 高     | Potreeとadaptive補正が厳密一致する説明が不正確                    | 独立量子化計算      |
| A18 | 仕様・ドキュメントの不整合 | 低     | 高     | view offset未対応の説明と実装・実ブラウザテストが矛盾             | 既存ブラウザ        |
| R01 | 性能・リソース上の問題     | 高     | 高     | Rangeが安全整数でも現実的メモリ上限がなく確保失敗時にbody未cancel | RangeError観測      |
| G01 | 検証漏れ                   | 中     | 高     | texture row拡張のテストは585ノードで境界未到達                    | mutation            |
| G02 | 検証漏れ                   | 中     | 高     | r187〜r189と実GPU / 他ブラウザを支える検証がない                  | registry / test構成 |

## 5. 各発見事項の詳細

以下の Node 再現は、先に build した後、root から
`node --test --test-name-pattern='A01:' docs/audit-artifacts/potree-v2-three/repro.mjs`
のIDを置き換えて単独実行できる。ブラウザ再現は
`pnpm --filter playground exec playwright test e2e/audit.spec.ts`
で行う。製品の将来修正後には、観測assertを期待動作のassertに反転する必要がある。

### A01 — metadata整合性の検証が足りない

**影響・条件:** 必須の `points` が欠落・負数・小数・非有限・安全整数外でも通る。属性名の重複も通り、同名の後続値で復号結果を上書きする。各bbox端点が有限でも差がInfinityになる極端値を通す。

**根拠:** `src/format.ts:190–258` は `points` を検査せず、名前の一意性を検査せず、端点間の差を検査しない。`src/decode.ts:312,364,412,422` は属性名を結果のキーにする。

**最小再現 / 期待と実際:** A01では `points=-1` 等が全て受理される。`position` を二度宣言して第2フィールドx=7とすると、結果は第1フィールドの0を失って7。`min.x=-1e308`, `max.x=1e308` を受理し、root最大xはInfinityになる。期待は取得・復号前の明示的なmetadataエラー。

**修正案:** `points` に非負安全整数、属性名に非空文字列・一意性、`numElements / size / elementSize` と全stride・点数積に安全整数と上限、min/max/scale/offsetの属性別配列長・有限性・順序を検査する。bbox幅・座標変換の中間値も有限と検査する。NaN / Infinity を標準JSONが直接表現しない点は区別する（欠落・負数・重複・`1e308` は通常JSONでも成立する）。

**回帰テスト:** 各項目の欠落・異型・null・重複・巨大値、後続の重複position/rgbだけ型が異なる場合、正常空点群。総点数がmetadata / hierarchyと矛盾した場合の検出時点も決める。

### A02 — 64 bit整数の差分精度を正規化前に失う

**影響・条件:** uint64 / int64の絶対値が大きく、値域が狭い場合、Float32正規化で保持できる差分を、先行するNumber変換で失う。generic属性とpickの復元値に影響する。

**根拠:** `src/decode.ts:27–30` の `Number(view.getBig[U]Int64())`、`76–94,108–140` の後段正規化。README `:126,159` の誤差「幅の1e-7程度」はこの経路を含めると成立しない。

**再現:** A02。`min=2^60`, `max=2^60+256`, 実値`2^60+128`。独立BigInt差分からの期待正規化値は **0.5**、DEFAULT / BROTLIとも実際は **0**。min/max自体はNumberで正確に表現できる。正規化後に保持可能な中央値を失うことを検証している。

**原因・修正案:** int64 / uint64はBigIntのまま原点を引いてからNumberにし、必要に応じBigIntのspanで割る。metadataの64 bit min/maxもJSON Numberの制約があるので、安全に対応できる範囲と文字列表現・別origin表現を決める。pickの`number[]`は巨大整数の単位精度を返せないため、完全復元を求める用途にはBigInt / raw値を返す別契約が必要。double属性とは別に扱う。

**回帰テスト:** 符号付き負値、2^53 / 2^60境界、狭いspan、DEFAULT / BROTLI、正規化配列とpickの許容誤差。int64の同じ原因は静的に確認したが、今回の狭い値域の動的再現はuint64である。

### A03 — proxyの循環参照で点数予算なしの探索が続く

**影響・条件:** metadata depth=2、root NORMAL + 子proxyが同じhierarchy byte rangeを参照する壊れたデータ。`minNodePixelSize=0`, `pointBudget=0` で同じ2レコードを毎回子chunkとして受け入れ、新しいノードを生成し続ける。

**根拠:** `src/format.ts:99–158` はレコード数・typeの範囲を検査するがchunk参照履歴・depth・型ごとのchild maskの意味を検査しない。`src/point-cloud.ts:1337–1357` は空ノード・proxyの探索を点数予算で止めない。Converter `HierarchyBuilder.h:257–280` ではchunk rootはproxyのまま出力しない。

**再現 / 期待と実際:** A03。44 byteの `NORMAL(mask=1,points=0,size=0)` + `PROXY(points=0,offset=0,size=44)`。期待はcycle / depth不整合のreject。実際は初期取得+12 updateで同じ `bytes=0-43` を13回取得し、最深levelが12以上、`loading=true`が続く。無限時間の実行はしていないが、繰り返しの停止条件がない経路を観測した。

**修正案・回帰:** 祖先に同じchunk範囲がある参照を拒否、chunk rootの種別・proxyサイズ / alignment・leafのmask・最大depth / node数を検査する。同一範囲を再利用する仕様を許す場合でも循環は区別する。自己参照 / 相互参照 / depth超過 / 正常複数chunkのテストを追加する。

### A04 — 初期loadのabortが実行中Workerの終了待ちになる

**影響・条件:** rootの取得は済み、Workerで復号中に `options.signal.abort(reason)`。promiseが拒否されず、部分生成した点群も復号応答までdisposeされない。Workerが応答しない場合、取消したloadが残る。

**根拠:** `src/point-cloud.ts:726–750` のabort handlerはcloud controllerをabortするのみ。`src/decoder-pool.ts:136,172–180,231` は待機中jobだけを取消し、実行jobのabort listenerを外す。

**再現 / 期待と実際:** A04でWorker root応答を明示的に保留。abort後の2 event-loop turnでも未settle・未terminate。応答を返すと初めて指定reasonでrejectしWorker終了。期待は共有Workerで計算を続ける場合でも、呼出側loadの取消・点群の後始末を独立に完了できること。

**修正案:** loadをabortとraceし、abort時に即dispose / releaseする。実行jobの計算継続と呼出側Promiseのsettleを分離し、遅い成功・失敗は所有者世代を確認して捨てる。共有pool全体を他点群のために破棄する修正は避ける。

**回帰テスト:** root復号中の取消、共有peerが生存する場合、遅い成功 / 失敗、reasonの同一性、二重dispose、最後の所有者のみの場合、Listener / Promise / queueの解放。

### A05 — decodedQueue上限は取得済み・進行中ノードを予約しない

**影響・条件:** 多数の小さいノードが1 updateで取得開始し、次フレームまでに復号完了する。32ノードを超えて配列を保持し、復号済みジオメトリのキャッシュ点数にはまだ算入されない。pointBudgetで選択点数を制限しても、遅れて届く復号結果の滞留量を制限できない。

**根拠:** `src/point-cloud.ts:369,1175–1190` は開始時のqueue長だけで判定。`909–929` で各応答のノードを制限なくpushする。`batches.ts:25–31` は1 batchの条件であり、全batchのqueue上限ではない。

**再現 / 期待と実際:** A05はbbox内の点を持つ root + 8 children + 64 grandchildren（73点）。`maxNodesToGPUPerFrame=1`。1回update後、取得と復号が終わるまで次のupdateを呼ばないとqueueは **64**。期待は32以内、又は文書化した予約済みbatch分の明確な超過限度。

**修正案・回帰:** 取得中・decode中・queue中のノード数 / 点数 / bytesを予約して総量を制限し、batchを残り容量で分割する。起動中root、cache hitも考慮する。32境界、複数点群、全部のHTTP同時完了、slow GPU追加、巨大単独nodeを検査する。今回OOMは起こしていない。

### A06 — decoded cacheの「上限」とroot固定保持が一致しない

**根拠・条件:** `src/point-cloud.ts:1636–1638` はrootを常にeviction対象から除外し、選択中ノードも除外する。README `:87` は全点群の点数上限として説明する。既存 `tests/format.test.mjs:1713–1716` には表示ノードを超過して保持するassertがあり、少なくとも一部は意図した方針である。

**再現 / 期待と実際:** A06。2点群各root1点、`pointBudget=0`, `cachePointBudget=0`。選択・表示は0点でもroot geometry計2点は残る。予算上限の説明だけでは利用者は0点保持を期待する。点群が多い場合、非表示root合計に下限がある。

**修正案・回帰:** rootを再取得可能にして非選択rootをevictするか、表示中 / rootは予算外という契約と実効最小メモリを明記する。「LRU目標値」と「hard limit」を区別する。0・root合計未満・hidden多数・予算縮小を検査する。

### A07 — 重複ローカルファイルが選択順で黙って置換される

**根拠:** `src/local-files.ts:9–23` の `entries.set(name,file)`。同じdirectory内の重複検査がない。

**再現 / 期待と実際:** A07は異なる内容の`metadata.json`を2個、他2ファイルを1個ずつ渡す。期待は曖昧なデータ選択のreject、実際は最後のmetadataを採用。`Iterable<File>`や複数場所のflatファイル選択では、選択元フォルダが識別できず異なるデータを混ぜる可能性がある。

**修正案・回帰:** directory + basenameの重複をrejectする。複数データを意図的に選ぶAPIとは分ける。同名・同サイズ・異内容、逆順、webkitRelativePathあり / なし、未完成フォルダを併記した場合を検査する。

### A08 — EDLの例外でrenderer.autoClearが復元されない

**影響:** point passの `onBeforeRender` 等が例外を投げると、以後の通常描画がclearされず残像・古いdepthが残る。

**根拠:** `src/edl.ts:162–189`。第2描画で `autoClear=false` にするが、そのfinallyはautoClearを戻さず、第3合成描画のfinallyまで到達した場合にしか戻らない。

**再現 / 期待と実際:** Node A08とbrowser auditで第2 `renderer.render()` に例外を注入。期待は元のtrueへの復元。実際はfalse。scene.background、group.visible、targetは復元された。通常深度 / log depth双方の実rendererで確認。

**修正案・回帰:** renderer / scene の全一時変更を囲む外側finallyで復元する。第1・第2・第3描画、clear / uniform更新 / target resizeでの例外、autoClear初期false、既存target / scissor / DPR / backgroundも検査する。

### A09 — 数値オプションの非有限値を受け入れloadingが止まる

**根拠:** `src/point-cloud-set.ts:58–62` は `Math.max(1,Math.floor(value))` でNaNを除去できない。public setter相当の直接代入にも検証がない。`src/point-cloud.ts:1065` のinstallループはNaNなら0回である。

**再現 / 期待と実際:** A09。`maxNodesToGPUPerFrame=NaN`、root+child。childは復号済みqueueに残り、updateを続けても追加されず`loading=true`。期待は設定時のreject、又は明示的な既定値へのフォールバック。

**修正案・回帰:** point / cache予算は有限非負、並列数・GPU追加数は有限整数、Worker数は有限かつ実用上限を検査する。0を停止値とするかは項目ごとに仕様化する。NaN / ±Infinity / 負数 / 0 / 小数 / 極端値、constructorと実行中の変更を同じ規則で検査する。

### A10 — hidden祖先で他クリップの子prune条件を失う

**根拠:** `src/clipping.ts:279,315`。非prune clipで全体hiddenになった親は共通`HIDDEN_CLIP`を返し、他のcrossing prune clipを捨てる。子は早期returnして判定しない。

**再現 / 期待と実際:** A10はx>=20をkeepする非prune平面でroot `[0,8]^3`を隠し、prune=trueのhide boxで子`[0,4]^3`を完全に隠す。元snapshotから子を判定するとnull（prune）だが、親結果を継承するとhiddenオブジェクト（探索・取得継続）。表示の漏れはないが、READMEのpruneによる取得・予算削減が失われる。

**修正案・回帰:** hiddenになっても残るpruning clipを伝播し、描画上のhiddenと探索不要を別状態として扱う。非prune plane / box × prune plane / keep union / hide box、親crossing・子insideで取得回数を検査する。

### A11 — 不正なContent-Rangeのcomplete lengthを検査しない

**根拠:** `src/http.ts:74–78` はstart / endだけを比較し、slash後のtotalをcapture / 比較しない。

**再現 / 期待と実際:** A11。要求`bytes=10-11`、body2 byte、header`Content-Range: bytes 10-11/1`。期待は矛盾したheaderのreject、実際は成功。RFC 9110 §14.4の有効な範囲条件ではcomplete lengthはlast byte位置より大きい必要がある。[RFC 9110 §14.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-content-range)

**修正案・回帰:** totalが数値なら `total > end` をBigInt比較し、`*`は別扱い。欠落 / CORS非公開の場合に検証を省略する現行契約は維持してよい。大きいtotal、end=total、終端超過、空白・複数header・非整数を検査する。

### A12 — Worker数はpool寿命中の過去最大

**根拠:** `src/decoder-pool.ts:43–46,73–77` は最大値の更新と参照数の減算だけ。README `:63` と `PotreeV2Options.decoderWorkers` は生きている点群の指定最大と説明する一方、poolコメント`:40`はpool寿命中の最大と説明している。

**再現 / 期待と実際:** A12で4と1をacquireし、4の所有者をreleaseしても残るpoolはmaxWorkers=4。これは新しいpoolで最後までリセットされない。期待はREADMEどおりなら1、実装方針どおりなら説明の変更。

**修正案・回帰:** 所有者ごとの要求数をleaseで管理しidle Workerを減らすか、pool過去最大という仕様を明記する。進行中jobを殺さず縮小、最後のrelease、失敗pool交換も検査する。

### A13 — rgbとgeneric colorのgeometry名が衝突する

**根拠:** `src/decode.ts:412` はrgbを`attributes.color`に保存、`:422`は他属性を元の名前で同じオブジェクトに保存する。`src/node-geometry.ts:14–18` はその名前をそのままgeometryへ渡す。

**再現 / 期待と実際:** A13。一意のmetadata名 `position`, `rgb`, `color(uint8 scalar)` を宣言し全て復号。期待は両属性を保持又は明示的な予約名エラー、実際は赤RGBAが`[42]`の非normalized scalarに置き換わる。属性の順序が逆ならgeneric側が消える。独自形式 / LAS Extra Bytesの命名で起こり得る。

**修正案・回帰:** GPU予約名・変換後名の衝突を検査しreject、又はgenericを別prefixで格納してmetadata名とのmappingを公開する。`color`, `__proto__`, `constructor`などJS辞書名も検査し、結果辞書はnull prototype / Mapを検討する。前後両順序、未選択の衝突属性、pick属性名を検査する。

### A14 — セット移動中の取得枠が旧セットに残る

**根拠:** `src/point-cloud-set.ts:117–128` はremove時にmembership / encoded cacheだけを変更する。`src/point-cloud.ts:1237–1258` は開始時に旧setの`slots`をclosureへ保持し、完了時も旧slotへ返す。

**再現 / 期待と実際:** A14。各childを70 kB離して別batchにし、set A（並列1）で1 childの取得を保留。remove→set B（並列1）へaddしupdateすると、もう1 childを開始。Bのslotは1だがBにいるcloudの実取得は **2**。Bのcache上限を0にしてから両応答を解放した場合のcache書込み抑止は正常だった。

**修正案・回帰:** 取得枠を所有者のrequest leaseとして移管する、又は移動時に旧リクエストをabortし、その完了まで再取得を抑止する。removeだけの場合に更新を続けないという契約も明確にする。複数点群 / 旧新予算差 / 復号段階 / cache disable / 遅い成功失敗 / disposeを検査する。

### A15 — scissorとピックが一致しない

**根拠:** `src/picking.ts:288–337` はviewportだけで対象領域を求め、scissorを参照しない。`:405–406` で内部targetへ切り替え、そのtargetは既定の`scissorTest=false`である（`:224–230`）。Three.jsのtarget切替はtargetのscissorを使用する。現在のscissorは描画対象領域を制限する契約である。[Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)

**再現 / 期待と実際:** browser audit、canvas100×100、中央の赤1点、scissor `(0,0,10,10)`。中央の描画画素は黒であるのに`pick(50,50)`はnode rを返す。通常 / log depth双方で再現。期待はnull。戻り後にrendererのscissor有効状態は復元されているので、問題は復元ではなく対象領域の不一致。

**修正案・回帰:** output targetの実scissorとviewport / drawing bufferの交差を求め、radius領域もこの範囲に限定する。canvasと既存target、device / CSS px、DPR1.5 / 2、scissor画面端・空領域を検査する。

### A16 — 非表示materialをピックが無視しない

**根拠:** `src/point-cloud.ts:1708–1729` と `src/picking.ts:374–386` はPoints.visibleとlayersを検査するが、`display.visible`を検査しない。pick専用ShaderMaterialはvisible=trueのままである。

**再現 / 期待と実際:** browser auditで `cloud.material.visible=false`。中央画素は黒だがpickはrを返す。期待はnull。`material.colorWrite=false`でも同じ不一致を観測したが、色を書かずdepthだけ書く点をピック対象にするかは別途仕様を決める必要がある。

**修正案・回帰:** display materialのvisibleを対象選定に反映する。ShaderMaterial継承で変更可能なdepthFunc / depthTest / depthWrite / transparent / opacity / colorWriteなど、対応する変更と非対応の変更を明示し、必要ならpick shaderへ同期する。visible変更・同深度点群のrenderOrderとdepth設定・通常 / log depthを検査する。

### A17 — adaptiveサイズのPotreeとの一致保証が強すぎる

**根拠:** README `:221` の一致説明。`src/point-size.ts:40–50,154–167` は密度補正をfloatで保持。参照 `PointCloudOctree.js:368–377` は`(lodOffset+10)*10`をUint8へ格納し、`pointcloud.vs:245`は0.1単位に戻す。

**再現 / 期待と実際:** A17。cube32、root spacing32/128、occupancy=3。packageの補正は約 **-0.707519**、参照のbyte92からの補正は **-0.8**。min/max clamp前のサイズ比は約0.938、約6%の差。これは計算比較であり、Potree Viewer自体を起動した画素比較は未実施。GPUの点サイズ丸め・clampで差が消える場合もある。

**修正案・回帰:** 改良した精度を維持するなら「Potreeと同じ密度推定式だが量子化精度が異なる」と説明する。厳密互換を保証するなら参照版を固定し量子化も揃える。occupancy3・5等、reference texture byteとshader復元、clamp前後の画素径を比較する。

### A18 — setViewOffset未対応の記述が古い

**根拠:** README `:126` はcamera.setViewOffset未対応とする。`src/picking.ts:352–366` は元projectionをcropして保持する。既存 `rendering.spec.ts:271–300` / `harness.ts:441` にviewOffsetを設定する実WebGL検証がある。

**再現 / 期待と実際:** 既存browserの`perspective viewport with camera view offset`は描画・pick・EDLとviewport復元のassertに成功。少なくともこの条件では対応しており、READMEの一律未対応と一致しない。

**修正案・回帰:** 対応条件をREADMEへ反映する。perspective / orthographic、DPR、既存render target、scissorとの組み合わせまで対応するなら明示的に検査する。

### R01 — 現実的な確保量上限と確保失敗時のbody解放がない

**根拠:** `src/http.ts:54` の上限はNumber.MAX_SAFE_INTEGERのみ、`:112`で要求全量を先にUint8Arrayへ確保する。失敗時のcancel / finallyがない。DEFAULTのnode points×stride整合性は取得後の `decode.ts:303–309` まで検査されない。Brotli vendor wrapperは出力最大0x7fffffffを検査するが、それだけでも実用メモリ上限には大きい。

**再現 / 期待と実際:** R01。12 byteだけのResponseに対して安全整数上限のRangeを要求。先行validationは通り、配列確保のRangeErrorで失敗し、bodyのcancelは呼ばれない。巨大配列を実際に確保したりOOMを起こす実験はしていない。観測したのは受理→不可能な確保の試行→body未解放の経路である。

**修正案・回帰:** hierarchy chunk / octree range / 展開後bytes / decoded attribute bytesに利用者設定可能な実用上限を設け、DEFAULTはpoints×strideとbyteSizeを取得前に突き合わせる。受信・確保・読み取り全経路をfinallyでcancel / reader解放し、例外時に枠も返す。巨大single nodeはbatchの2 MiB上限から例外になるため別の上限が必要。安全整数境界、確保失敗注入、Brotli小入力大出力、metadata JSONサイズ・総queue bytesを検査する。

### G01 — texture行拡張テストの名前と入力が一致しない

**根拠:** `tests/point-size.test.mjs:107–126` の`visible node texture grows past one row`は root + 8 + 64 + 512 = **585 nodes**。`src/point-size.ts:25` の幅は **2048**。assertも「capacity >= node数」なので高さ1のままで成功する。

**再現 / 期待と実際:** 一時distで行拡張のifを `if(false)` にしたmutationでも既存6テスト全成功。期待は拡張破壊を検出する失敗。今回のG01追加テストは2049件でheight=2、末尾index=2048を確認し、実装のこの拡張経路は正常だった。

**修正案・回帰:** 正しいoctreeを2048・2049・4096・4097件で作り、height増加、row境界のchild index、texture置換 / dispose、shaderのtexelFetchを検査する。今回の2049件テストはtable拡張の検査で、階層walkと実GPUのrow跨ぎまでは検査していない。

### G02 — 対応版・ブラウザ・GPUの保証範囲に未検証部分がある

**根拠:** README `:3` / peerDependenciesはr180〜r189、workspace依存と既存テストはr180のみ。`apps/playground/playwright.config.ts:28–31` はchromiumのみ、SwiftShader固定。今回のregistry照会ではr187〜r189の公開版を取得できなかった。

**再現:** r189 installのERESOLVE後、`npm view three@0.189.0 version`もE404。依存の不整合を強制解決して互換性成功とは扱わなかった。公開済み7版は独立梱包検証で成功した。

**修正案・必要なテスト:** 現在検証した版と将来許容するpeer範囲を分けて記載し、公開後の版追加をCI matrixで検査する。Firefox / WebKit、Windows実ANGLE / D3D、macOS / Safari、mobile、最小uniform上限256、最大point size、context lossを検査する。SwiftShaderのuniform4096で成功するshaderは最低仕様GPUで成功するとは限らない。

## 6. 検証漏れの一覧

### 6.1 保証・公開APIと検証の対応

| 仕様・機能                                                         | 既存検証                                                                               | 今回の追加・確認                                                                  | 残る不足・優先度                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| metadata version / encoding / scale / bbox / spacing / attribute型 | formatのreject・signed int32・rgb型                                                    | A01、極端な計算幅、重複、予約color                                                | **高:** 全必須値・配列長・attribute min/max / scale / offset、総点数、算術上限                                                           |
| hierarchy 22 byte / BFS / proxy / 子bbox                           | invalid chunkの原子性、正常proxy                                                       | A03、Converterとの種別・uint64比較                                                | **高:** leaf mask、chunk root proxy、相互循環、alignment、重複 / overlap / ファイル終端、最大depth                                       |
| DEFAULT / BROTLI 配置・符号・Morton・RGB                           | 独立morton生成、全32 bit signed境界、pump両encoding                                    | packed独立1点、A02 / A13                                                          | **高:** 広い点数・巨大Brotli出力・余分なcompressed bytes、64 bit全符号 / 数域                                                            |
| generic属性 / pick属性                                             | int8/uint16/uint32/int64/doubleなど、64 bitの小値域                                    | uint64の2^60正規化失敗                                                            | 未指定min/max・逆転・不正長・NaN値、vec2/vec3/多成分のGPU利用、属性scale/offsetを生値として扱う契約                                      |
| Brotli内部バッファ寿命                                             | 連続復号後の配列不変、実Node Worker、gapped batch                                      | 配布物のWASM / Workerロード                                                       | 大量反復・memory growth / allocation failure、bundleのビルド再現性                                                                       |
| HTTP Range / 206 / 200 / actual length                             | Response / stream mocks、認証実HTTP正常系                                              | A11 / R01、**実HTTP** chunked過長 / 過短、Content-Length途中切断をV02でreject確認 | CORS expose / 非公開 / CDN、gzip encoding、timeout、real redirect / auth / signed URL                                                    |
| 404 / 429 / 503 / retry / onError throw                            | gate pause・並列枠・復帰、onError throwを独立例外として観測                            | bookkeeping精読、通常失敗区別                                                     | 長期反復・複数origins、Retry-After上限300秒、date clock skew。onError throwはアプリ例外として表面化する設計で、無視される保証ではない    |
| Range batch / gap / partial failure                                | gaps、優先順位、cacheとmissing混在、部分失敗                                           | A05 / A14                                                                         | overlap nodes、進行中batchのbudget縮小、stage別総byte上限                                                                                |
| local Files / Blob.slice                                           | folder選択・不足・複数完成dataset・slice実績                                           | A07                                                                               | 同名異データ、境界外・途中blob読取のsignal、巨大File、browser FileListの実操作                                                           |
| Worker ownership / failure / transfer                              | Node shim実transfer・detach、onerror交換、messageerror、queue abort                    | V01で共有peer継続・dispose後遅い応答を抑止、A04                                   | **高:** 起動例外、real Worker crash / OOM、自発close、malformed正当id応答、timeout/watchdog、乱順と同時pick                              |
| loading / whenLoaded / dispose                                     | view変更・次update待ち・reason・dispose拒否                                            | A03 / A04 / A09の永続loading、V01、反復disposeのガード精読                        | hidden中に残る取得の扱い、remove後のwaiter、set自身のdispose APIがない場合のwaiter寿命                                                   |
| LOD / shared point budget / zoom / parent / layers                 | root予算、カメラzoom、parent移動、visibility祖先、group layers、静止スキップ           | A06 / A14、実WebGL親の反転・非一様scale下で中心点を確認                           | **中:** large geographyの実GPU精度、shear、orthographic zoom閾値、camera layersと予算の関係、root優先Infinityの多点群飢餓                |
| decoded / encoded LRU / disable / set move                         | node eviction順、owner識別、failure不保存、budget変更、settled移動                     | A05 / A06、進行中移動+cache上限0のA14                                             | queued decoded点数の計上、移動後HTTP枠、cache disable→再enable中の遅い結果                                                               |
| shader共有・色・sRGB                                               | 5色型、変更・分類hidden、gradient / gamma、2cloud clip shader共有                      | packed各版、material.visibleのA16                                                 | tone mapping / exposure / outputColorSpace全組合せ、fog / scene.overrideMaterial、classification共有と交換後のdispose、色の全域校正      |
| fixed / attenuated / adaptive / circle                             | CPU texture walk、density式、uniform DPR                                               | 実GPU adaptive+circle+clipping+classification、G01 / A17                          | **高:** adaptive row跨ぎ実GPU、depth24境界・最終density、attenuated実画素径、非一様scaleでclampなしのサイズ、circle角のpick              |
| clipping / keep union / hide / plane / prune                       | CPU box relation / uniform写像 / union / 境界、17box容量増加                           | A10、実GPU keep box+plane+hidden class+adaptive                                   | 回転境界のfloat32丸め、CPU pruner対独立point oracle、GPU uniform capacity超過、singular group transform                                  |
| pick / equal depth / layers / DPR / viewport                       | 実WebGL多点群、同深度draw order、sibling object ID、log depth、target / fractional DPR | A15 / A16、既知sourcePosition                                                     | **高:** scissor、material render flags、pick readback中のevict / set移動 / renderer破棄 / context loss、PBO作成後の例外cleanup           |
| EDL normal objects / state                                         | mock順序・正常復元、実GPU viewportのstrength0                                          | 実GPU前景青plane / 背景planeで深度前後、両depth、A08                              | **高:** strength>0陰影画像oracle、fog、autoClear falseと既存depth、transparent objects、resize / 多renderer / dispose後reuse、全例外位置 |
| packaging / exports / Worker URL / vendor                          | workerのbare import禁止を静的検査、workspace build                                     | tarball install、7版・Vite production / preview                                   | G02、全consumer型環境、CDN unbundled / CSP、他bundler、最小GPU                                                                           |

バグが見つからなかった行も、その検証条件に限った結果である。例えばBrotli配列の再利用破損、dispose後の点群シーン追加、通常の共有shader clip値混入は観測しなかったが、長期・全異常経路まで否定したものではない。

### 6.2 必須の機能組み合わせ

| 組み合わせ                                     | 実施内容・選定理由                                                                                                            | 未実施                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 複数点群 × 共有Worker × dispose                | V01で1点群のchild復号を保留、dispose、遅い成功を返し、peerが正常表示・最後にterminateすることを確認。所有権の破壊リスクを優先 | real Worker異常終了と遅い失敗を同時に発生、pool交換中の多所有者                                                         |
| 視点変更 × abort × 遅延応答 × retry            | 既存 stale fetch abort / 再取得、既存retry、今回root遅延decode × abort                                                        | **一連の4条件全てを同時にしたブラウザ検証は未実施**。再試行旧世代の遅い成功 / 失敗を明示制御するテストが必要            |
| cache上限変更 × 読み込み中 × set移動           | A14で取得を保留して移動、移動先byte上限0、両応答後のcache非書込を確認し、並列枠の破綻を再現                                   | decoded queue stageでの移動、途中で再enable、複数ownersのLRU順位                                                        |
| clipping × classification × adaptive × picking | 既知1点・keep box+plane・circle・親のnegative / nonuniform scale、通常 / log depth。分類hidden時は画素0 / pick null           | 大規模階層、texture複数row、多keep union境界、容量増加を同時に実施                                                      |
| EDL × log depth × viewport / DPR × 親transform | 既存viewport / DPRと今回log / 親変換 / 通常objectの前後を別検証。最優先のstate復元とdepthを検査                               | **全条件同時かつstrength>0は未実施**。非zero shading、fractional DPR、partial target、scissorとの完全な画像oracleが必要 |

### 6.3 根拠はあるが実環境で未再現のリスク

- `DecoderPool.onmessage`（`:196–205`）は違うidを無視し、正しいidでも属性shapeまで検査しない。無応答・壊れた応答でjobが残る可能性がある。通常の自前Workerがこの応答を生成するケースやreal異常終了を今回は再現していないため、確定バグには数えていない。protocol shape検証とwatchdog、エラーの `onError` 経路が優先検証対象。
- clip capacityは倍増するがrenderer GPU上限を参照しない（`clipping.ts:466–480`）。例えばbox数65で128capacityへ増えるため最低uniform上限のGPUではコンパイル失敗の可能性がある。今回の4096環境から全GPUの破綻を断定しない。
- `point-size.ts:24,89–103` はwalk最大24。末尾のdensity補正を適用せずreturnする上限経路がある。通常Converter outputの深さより深い自作データ、非常に小さいspacingでの対応範囲を決める必要がある。
- HTTPファイルURLは `new URL(file, metadataUrl)`（`point-cloud.ts:822`）でクエリを継承しない。署名付きmetadataだけを渡して他2ファイルも認証される保証はない。redirect後のResponse.urlを基準にもしていない。通常URL解決として正当な部分と、利用環境で不足する契約を区別し、signed URL resolver / transport差替の実例を検証する。
- `RequestGate.gates` はoriginごとに永続Mapへ残る。多数originを長時間開閉するアプリでの保持量は未測定。local fetchも共通の架空originを使うため、別localデータ間のgate共有の必要性は仕様として確認すべき。
- `picking.ts:412–443` はPBO / fence生成後に同期例外が起きたとき、後段のcleanup finallyに到達しない可能性がある。通常WebGLのエラーはJS throwではないことも多く、実際のGL objectリークは今回は未再現。
- web viewerはadaptive circle + EDL strength0.6を使う（対象commit `viewer.ts:107,208–221`）。既存ブラウザはこの非zero EDL陰影を校正しない。playgroundはrequestIdで遅いloadをdisposeし、webはdisposedフラグを確認するが、初期取得そのものをsignalで止める使い方はしていない。アプリの再load・エラーUI・長時間利用は実操作で未検証。

## 7. 対応の優先順位

1. **描画・取消の利用者影響を先に修正:** A08の例外復元、A15のscissor、A04のroot復号中abort、A02の整数差分精度。最小再現を期待assertへ変えた回帰テストと実WebGLで確認する。
2. **入力と資源上限を堅くする:** A03のcycle、R01のbyte確保、A05のqueue予約、A01 / A09の数値検証。巨大allocを実行しなくても、確保呼出の注入と予約カウンタで検査できる。
3. **複合状態を修正:** A14のslot移管、A10のhidden / prune伝播、A07の同名Files、A13の属性衝突、A16のmaterial可視性。
4. **テストの検出力を増やす:** G01の2048境界、strength>0 EDL、stage別abortと遅い応答、最小GPU・多ブラウザ。対応版追加は梱包版のproduction Workerまで実行する。
5. **実装方針を明文化:** A06のcache hard limitと保護ノード、A12のWorker数寿命、A17のdensity量子化差、A18のview offset、64 bitの返却精度、各数値項目の0 / 不正値、signed URL / redirect、ShaderMaterial変更の対応範囲。

## 8. 再現用成果物・参照資料

### 8.1 追加ファイルと実行方法

- [repro.mjs](audit-artifacts/potree-v2-three/repro.mjs): 不具合の観測と正常経路。`pnpm --filter @geemil/potree-v2-three build` 後に `node --test docs/audit-artifacts/potree-v2-three/repro.mjs`。fake Workerはタイミング制御用であり、実Worker転送の代用として正しさを主張していない。
- [audit-harness.ts](../apps/playground/e2e/audit-harness.ts)、[audit.spec.ts](../apps/playground/e2e/audit.spec.ts): 独立1点の実WebGL観測。`pnpm test:browser` または `pnpm --filter playground exec playwright test e2e/audit.spec.ts`。
- [packed-check.mjs](audit-artifacts/potree-v2-three/packed-check.mjs): 公開tarballを一時環境へinstallし、既存116単体テストとVite productionのbrowser probeを実行。ネットワークとinstalled Playwright Chromiumが必要。

  ```bash
  mkdir -p /tmp/potree-audit-reference
  pnpm --filter @geemil/potree-v2-three pack --pack-destination /tmp/potree-audit-reference
  node docs/audit-artifacts/potree-v2-three/packed-check.mjs \
    /tmp/potree-audit-reference/geemil-potree-v2-three-0.1.0.tgz
  # 版を限定する場合は末尾に 0.180.0 0.186.1 などを指定
  ```

- [mutation-check.mjs](audit-artifacts/potree-v2-three/mutation-check.mjs): 一時コピーだけでtexture拡張を無効化する。`node docs/audit-artifacts/potree-v2-three/mutation-check.mjs`。一時ディレクトリはログへ表示し、調査後も確認用に保持する。
- 同ディレクトリの `.log` / `three-published-versions.json`: 基準結果、再現結果、build / lint、pack / compat、mutation、r189 install失敗。互換性の各環境の全文unit.logは実行時一時ディレクトリに保持、r180 / r186分はレポート付属にも保存した。

追加データはスクリプト内で生成する。製品コード変更なし、既存テスト書換なし。監査用観測assertは将来の修正を保証する回帰assertではないので、通常回帰suiteへ採用する際は期待側に反転する。

### 8.2 一次資料

| 資料                                                                                                                                                                                                                                                                                               | 固定版・参照箇所                                          | 用途                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Potree v2 OctreeLoader](https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/modules/loader/2.0/OctreeLoader.js)                                                                                                                                                    | 上記commit、parseHierarchy `:147–233`                     | hierarchy / proxy / 空nodeの比較。参考実装であり無条件の正解ではない           |
| [Potree DEFAULT decoder](https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/modules/loader/2.0/DecoderWorker.js) / [BROTLI decoder](https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/modules/loader/2.0/DecoderWorker_brotli.js) | DEFAULT `:69–70,112–136`、BROTLI `:108–150,307–346`       | 座標・generic・int64未対応の比較                                               |
| [Potree visibility texture](https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/PointCloudOctree.js#L368) / [pointcloud vertex shader](https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/materials/shaders/pointcloud.vs#L245)     | density byte / getLOD                                     | A17、量子化差                                                                  |
| [PotreeConverter Writer.cpp](https://github.com/potree/PotreeConverter/blob/c2cb61843bf2b901e8e257874b1a6dcf67792fb2/Converter/src/Writer.cpp)                                                                                                                                                     | `:40–64,100–144,269–271`                                  | Morton配置・色・列配置                                                         |
| [PotreeConverter HierarchyBuilder.h](https://github.com/potree/PotreeConverter/blob/c2cb61843bf2b901e8e257874b1a6dcf67792fb2/Converter/include/HierarchyBuilder.h)                                                                                                                                 | `:42–44,257–280`                                          | 正式なnode種別、chunk root、uint64レコード                                     |
| [PotreeConverter indexer.cpp](https://github.com/potree/PotreeConverter/blob/c2cb61843bf2b901e8e257874b1a6dcf67792fb2/Converter/src/indexer.cpp)                                                                                                                                                   | `:376–552,1440`                                           | metadata2.0、min/max / scale / offset、spacing                                 |
| [Three.js r180 renderer](https://github.com/mrdoob/three.js/blob/r180/src/renderers/WebGLRenderer.js)                                                                                                                                                                                              | `:2750–2805`（インストール版）、target viewport / scissor | A15とtarget state。最新docsだけでr180挙動を決めていない                        |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-content-range)                                                                                                                                                                                                                         | §14.4、2022-06                                            | Content-Range整合性                                                            |
| [three npm registry](https://registry.npmjs.org/three)                                                                                                                                                                                                                                             | 2026-10-02取得、版一覧は付属JSON                          | r187〜r189の取得不能と公開済み版の選定                                         |
| [google/brotli v1.2.0](https://github.com/google/brotli/tree/v1.2.0)                                                                                                                                                                                                                               | package README / THIRD_PARTY_LICENSESの宣言               | vendored decoderの出自宣言。埋め込みWASMがこのソースから再現されることは未検証 |
| [libE57 sample data](http://www.libe57.org/data.html)                                                                                                                                                                                                                                              | pump fixtureのLICENSE参照                                 | データ出典。独立原本E57の再変換は未実施                                        |

このレポートは修正案を提示する監査成果物であり、上記不具合の製品修正は行っていない。
