# @geemil/potree-v2-three

PotreeConverter **2.0** の `metadata.json`, `hierarchy.bin`, `octree.bin` を Three.js で表示するライブラリです。Potree v1 と Potree-Next v3 は対象外です。

## 使い方

```ts
import { loadPotreeV2 } from '@geemil/potree-v2-three';

const cloud = await loadPotreeV2('/pointcloud/metadata.json', {
  pointBudget: 2_000_000,
  onError: (error, node) => console.error(node, error),
});
scene.add(cloud.group);

function render() {
  requestAnimationFrame(render);
  cloud.update(camera, renderer.domElement.clientHeight);
  renderer.render(scene, camera);
}
render();

// When the cloud is no longer needed:
scene.remove(cloud.group);
cloud.dispose();
```

`cloud.group` は座標を点群の bounding box の最小値で平行移動したローカル座標で表示します。元の座標は `cloud.worldOffset` にあります。大きな地理座標をそのまま `group.position` に設定すると GPU の精度が落ちるため、アプリ側で扱いを決めてください。

`cloud.update()` はカメラと表示領域の高さから必要な階層を選び、近接するノードをまとめて HTTP Range で非同期に読み込みます。戻り値は、ノードの追加・表示切り替え・破棄でシーンが変わったときに `true` になります。カメラ・点群の行列、表示領域の高さ、`pointBudget`、`cachePointBudget`、`minNodePixelSize`、`showBoundingBoxes` が前回と同じで、選ばれたノードがすべてシーンに追加され、読み込み中の処理がない間は、階層の走査を省略して `false` を返します。静止中は、戻り値とカメラ操作を見て描画を省略できます。

```ts
let needsRender = true;
function render() {
  requestAnimationFrame(render);
  if (controls.update()) needsRender = true;
  if (cloud.update(camera, renderer.domElement.clientHeight)) needsRender = true;
  if (needsRender) {
    needsRender = false;
    renderer.render(scene, camera);
  }
}
```

同時に行う HTTP リクエスト（階層チャンクと octree の取得）は `maxConcurrentLoads`（初期値 6）、デコード用の Worker 数は `decoderWorkers`（初期値は論理コア数 - 1、1〜4）で指定します。Worker は全点群で 1 つのプールを共有し、生きている点群が指定した最大の数まで増えます。最後の点群を `dispose()` すると終了します。取得を終えたバッチはすぐにリクエストの枠を空けるので、Worker がデコードしている間も次のノードを取得できます。デコード待ちのバッチは共有プール全体で Worker 数の 2 倍までに抑えます。サーバーは 3 ファイルにアクセス可能で、Range リクエストと CORS（別オリジンの場合）に対応させてください。`hierarchy.bin` と `octree.bin` の取得は HTTP 206 だけを受け付けます。Range を無視して 200 でファイル全体を返すサーバーはエラーになり、その時点で受信を打ち切ります。レスポンスの長さは `Content-Length` に頼らず、ボディを読みながら要求したバイト数と一致するかを確かめるので、chunked 転送や圧縮されたレスポンスでも要求サイズを超えて読み込みません。別オリジンで `Content-Range` を検証させたい場合は、`Access-Control-Expose-Headers: Content-Range` で公開してください（公開されていなければ検証を省略します）。

ノードは画面上の投影半径が大きい順に選び、`pointBudget` に収まらないノードに当たった時点で選択を終えます（公式 Potree と同じです）。視錐台の外にある子ノードは候補に加えません。取得中のバッチに含まれるノードがどれも 300 ms 以上選ばれなかった場合は、視点が移ったものとしてそのリクエストを中断します（`loadDiagnostics.abortedRequests`）。中断したノードは、再び選ばれたときに取得し直します。

子ノードは画面上の投影半径が `minNodePixelSize` 以上の場合に探索します。既定値は公式 Potree Viewer と同じ 30 px です。値を変えると次の `update()` から反映されます。

復号後に描画へ追加するノード数は `maxNodesToGPUPerFrame` で制御できます（初期値 8）。`cloud.maxNodesToGPUPerFrame` を変更すると次の `update()` から反映されます。

ノードや階層チャンクの読み込みに失敗すると `onError` が呼ばれ、`retryDelayMs`（初期値 1000）後の `update()` で再試行されます。待ち時間は失敗のたびに倍になり、最大 30 秒です。読み込みに成功すると元に戻ります。

HTTP 429（Too Many Requests）と 503（Service Unavailable）は、ノードの失敗ではなくサーバーからの「控えてほしい」という合図として扱います。同じオリジンへのリクエストは、複数の点群をまたいで1つの窓口で管理します。429 か 503 を受けると、そのオリジンへの新しいリクエストをすべて止めます（実行中のリクエストは完了を待ちます）。再開までの時間は `Retry-After` があればその値（最大 5 分）、なければ `retryDelayMs` から倍々に延ばします（最大 30 秒）。同時に同時実行数の上限を半分に下げ、成功が続くと 1 ずつ戻します。止めている間に取得できなかったノードは、再開後の `update()` がその時点の視点で選び直して取得します。この場合 `onError` は呼ばれず、ノードごとの再試行の待ち時間も増えません。回数は `loadDiagnostics.throttledResponses` で確認できます。`loadPotreeV2()` 中の `metadata.json`、最初の階層チャンク、ルートノードの取得も、429・503 なら待ってから再試行します（最大 6 回）。別オリジンで `Retry-After` を使わせるには、サーバーで `Access-Control-Expose-Headers: Retry-After` を設定してください。また、CDN が 429 のレスポンスに CORS ヘッダーを付けないと、ブラウザはステータスを見せずにネットワークエラーとして扱うため、通常の失敗として `onError` と再試行の対象になります。

HTTP のエラーは `HttpError`（`status` と `retryAfterMs` を持ちます）として `onError` に渡されるので、404 などの内容に応じて処理を分けられます。

キャッシュは二段階です。復号済みジオメトリは、表示中の `pointBudget` の2倍の点数まで保持し、超過時に非表示ノードを古い順に破棄します。この上限は `pointBudget` の変更に追従し、`cachePointBudget` で固定値に上書きできます。BROTLI の URL データは、復号前のノードも LRU で最大 128 MiB 保持します。上限は `encodedCacheByteBudget`（バイト数）で変更でき、`0` で無効になります。UNCOMPRESSED データとローカルファイルは初期状態では復号前のキャッシュを使いません。復号前のキャッシュに残っているノードは再取得せず、Worker で再デコードします。

`cloud.fetchStats` で成功した octree Range 取得回数 (`rangeRequests`) と取得ノード数 (`fetchedNodes`) を参照できます。復号前キャッシュからの再デコードは含みません。`cloud.clearFetchStats()` で両方を 0 に戻せます。クリア時点で進行中だった取得は、新しいカウントに含めません。

BROTLI は google/brotli 1.2.0 の decode-only WASM で復号します。Worker と WASM は点群の読み込み中（最初の hierarchy を取得している間）に全 Worker で準備され、JS ファイルに埋め込まれているため別の `.wasm` 配布は不要です。

`cloud.loadDiagnostics` は現在の視点で必要なノードの復号完了と表示完了、バッチ数、取得・復号の時間を返します。`cloud.resetLoadDiagnostics()` で計測を開始し直せます。`brotliMs` は純粋な Brotli 展開時間、`attributesMs` は展開後の属性デコード時間、`codecSetupMs` は各 Worker での初回準備時間の合計です。これらの時間は並列 Worker の処理時間の合計なので、表示完了までの経過時間とは一致しません。表示完了は選択された全ノードをシーンへ追加した時刻で、500 ms 安定すると状態が `complete` になります。

`showBoundingBoxes: true` を指定すると表示中のノードの bbox を描画します。`cloud.showBoundingBoxes` の変更も次の `update()` から反映されます（初期値は `false`）。

複数の点群を表示するときは `PotreeV2PointCloudSet` で点数予算・復号済みキャッシュ・同時リクエスト数・1 フレームの追加ノード数を共有できます。全点群をまとめて投影サイズの大きいノードから選び、取得と描画への追加もその順に行うので、これらの上限は点群の数に関係なく一定です。キャッシュも全点群で最近表示していないノードから解放します（本家 Potree の `Potree.pointBudget` と同じ考え方です）。オプションは `pointBudget`、`cachePointBudget`、`maxConcurrentLoads`、`maxNodesToGPUPerFrame` で、初期値は点群単体と同じです。セットに入れた点群の同名の設定は使われず、`cloud.update()` を呼ぶとエラーになります。`minNodePixelSize` や `showBoundingBoxes` は点群ごとの設定がそのまま効きます。

```ts
const clouds = new PotreeV2PointCloudSet({ pointBudget: 3_000_000 });
for (const cloud of [a, b]) {
  clouds.add(cloud);
  scene.add(cloud.group);
}
// 描画ループで毎フレーム
if (clouds.update(camera, canvas.clientHeight)) renderer.render(scene, camera);
```

`clouds.remove(cloud)` で外すと、その点群は再び自分の予算で `cloud.update()` できます。`cloud.dispose()` するとセットからも外れます。

`cloud.pick(renderer, camera, x, y)` は、キャンバス左上からの CSS ピクセル座標 `x`, `y` に描画されている点を返します（なければ `null`）。対象は直前の `update()` で表示したノードです。カーソル周辺だけをノード番号と点番号（`gl_VertexID`）の整数レンダーターゲットに描画し、GPU の完了を待たずに非同期で読み取るので、ピック用の頂点属性は持ちません。点のサイズと形は表示と同じなので、画面上で点が描かれているピクセルだけが当たります。`radius`（CSS px、初期値 0）を指定すると、その距離内で最も近い点を返します。属性値は CPU 側に保持している復号済みの配列から読みます。

```ts
canvas.addEventListener('pointermove', async event => {
  const hit = await cloud.pick(renderer, camera, event.offsetX, event.offsetY, { radius: 2 });
  if (hit) console.log(hit.node, hit.index, hit.sourcePosition, hit.attributes);
});
```

結果の `position` は `cloud.group` の変換を含むワールド座標、`sourcePosition` は metadata.json の座標系、`attributes` は復号した `position` 以外の属性（`rgb` は 0〜255）です。カメラに `setViewOffset` を設定している場合には対応していません。

認証付きの取得には `fetch` を差し替えます。この関数は metadata、hierarchy、octree のすべての取得に使われます。Range ヘッダーと `signal` を維持し、hierarchy と octree には要求した範囲を HTTP 206 で返してください。

```ts
const cloud = await loadPotreeV2('/pointcloud/metadata.json', {
  fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${getAccessToken()}`);
    return fetch(input, { ...init, headers });
  },
});
```

ローカルファイルから読み込む場合は、ファイル選択で得た `FileList` を渡します。`metadata.json`、`hierarchy.bin`、`octree.bin` をまとめて選び、バイナリファイルは `Blob.slice()` で必要な範囲だけ読みます。

```ts
import { loadPotreeV2FromFiles } from '@geemil/potree-v2-three';

const input = document.querySelector<HTMLInputElement>('#files-input')!;
// <input id="files-input" type="file" accept=".json,.bin" multiple>
const cloud = await loadPotreeV2FromFiles(input.files!);
scene.add(cloud.group);
```

初期状態では `position` と `rgb`（metadata にある場合）だけを復号し、GPU に送ります。強度や分類で色を付ける場合や、ほかの属性を独自のマテリアルなどで使う場合は、`attributes` オプションで復号する属性名を指定します。この指定は初期値を置き換えるので、色も必要なら `rgb` を含めてください。`position` と、`pointColorType` で指定した色の種類が使う属性は常に復号します。metadata にない名前を指定すると読み込みはエラーになります。

```ts
const cloud = await loadPotreeV2('/pointcloud/metadata.json', {
  attributes: ['rgb', 'intensity', 'classification'],
});
```

各ノードの `Points` は `position` をノードの bounding box の最小値に置き、`position` attribute はそこからの相対座標（float32）で持ちます。大きな平行移動は double 精度の行列側で打ち消されるので、ノードが細かくなるほど座標の精度が上がります。独自のシェーダーでは `modelMatrix` を通して座標を扱ってください。`rgb` は `color` attribute（`Uint8` の RGBA、正規化、alpha は常に 255）に格納し、点色として表示します。Potree の RGB 値は sRGB として扱い、シェーダー内で線形色へ変換してから Three.js の出力色変換に渡します。`rgb` と `position` 以外で指定した属性は `BufferGeometry` の同名 attribute に格納します。8・16 bit の整数属性は元の型の配列（`Uint16Array` など、正規化なし）のままにし、それ以外は `Float32Array` にします。シェーダーではどちらも `float` の attribute として読めます。64-bit の単一値属性は GPU の float 精度に合わせて metadata の min/max で 0～1 に正規化します。

`metadata.json`、`hierarchy.bin`、`octree.bin` の取得はメインスレッドで行います。認証や独自の通信処理が必要なら `fetch` オプションで差し替えられます。近接するノードは1回の Range リクエストにまとめ、取得した `ArrayBuffer` をコピーせず Worker に転送します。Worker プールが Brotli 展開と点属性の復号を行い、描画側でジオメトリを組み立てます。ローカルファイルはメインスレッドで `Blob.slice()` から読みます。Web Worker が利用できない環境ではメインスレッドで復号します。

## クリッピング

`PotreeV2Clipping` にボックスと平面を登録し、点群の `clipping` に割り当てます。1 つの `PotreeV2Clipping` を複数の点群で共有できます。座標はワールド座標で、各点群の `group` の変換は内部で合成します。

```ts
import { PotreeV2Clipping } from '@geemil/potree-v2-three';

const clipping = new PotreeV2Clipping();
cloud.clipping = clipping; // or loadPotreeV2(url, { clipping })

// A box is the unit cube from -0.5 to 0.5 transformed by `matrix`.
const room = clipping.addBox({ matrix: new Matrix4().compose(center, rotation, size), mode: 'keep-inside' });
const wall = clipping.addBox({ matrix: wallMatrix, mode: 'hide-inside' });
// Keeps the side the normal points to.
const cut = clipping.addPlane({ plane: new Plane(new Vector3(0, 0, -1), 3) });

wall.enabled = isCameraOutside(wall); // e.g. every frame
room.matrix.compose(center, rotation, size);
clipping.remove(cut);
```

点は次の条件をすべて満たすときに表示されます。

- 有効なすべての平面について、法線の向く側にある
- 有効な `keep-inside` ボックスがあれば、そのどれかの内側にある（和集合）
- どの `hide-inside` ボックスの内側にもない（`keep-inside` と重なった部分も消えます）

境界上の点は内側として扱います。`enabled: false` のボックスや平面は、登録されていないものとして扱います。有効な `keep-inside` ボックスが 1 つもなければ、ボックスによる絞り込みはしません。

ボックスの `matrix`、`mode`、`enabled`、`prune`、平面の `plane`、`enabled`、`prune` は直接書き換えてかまいません。変更は次の `update()` で検出され、そのとき `update()` は `true` を返します。拡大率が 0 のボックスや長さ 0 の法線はエラーになります。

判定は 3 段階で行います。

1. `update()` はノードの bbox を各クリップと比べ、クリップで完全に消えるノードを選択から外します。子ノードも探索しないので、取得も点数予算の消費もしません。
2. 一部だけが消えるノードには、交差しているクリップだけを記録します。深いノードほど小さいので、ボックスが多くても 1 ノードあたりの判定数は少なくなります。
3. 頂点シェーダーが、そのノードで記録したクリップだけを点ごとに判定し、消える点を描画範囲の外に出します。ピックも同じ頂点処理で描画するので、見えない点には当たりません。

ノード単位で交差を判定するのは、平面とボックスの境界がノードの bbox と重なる場合です。回転したボックスでは判定が保守的になり、実際には交わらないノードもシェーダーでの判定に回ることがありますが、表示は正しいままです。

`prune: false` にしたボックスや平面は、完全に消えるノードも選択に残して読み込み、描画だけを止めます。点数予算とキャッシュを使い続ける代わりに、無効にしたときや移動したときにすぐ表示に戻ります。視点に応じて頻繁に切り替える壁などに向いています。`keep-inside` ボックスの外にあるノードを選択から外すのは、有効な `keep-inside` ボックスがすべて `prune: true` の場合だけです。

1 ノードで判定できるクリップの数はシェーダーの定数です。最初にクリップが必要になった時点でボックス 16 個・平面 8 枚としてコンパイルし、足りなくなったノードが現れたら倍に増やしてコンパイルし直します。コンパイルし直しても、読み込み済みのノードやキャッシュはそのまま使えます。上限は減らしません。ボックスは 1 個あたり頂点 uniform を 3 vec4 使うので、WebGL2 が保証する 256 vec4 の範囲では 1 ノードあたり 60 個程度が目安です。

`cloud.material` は `ShaderMaterial` を継承した `PotreeV2PointMaterial` です。`material.size`（CSS px）で点のサイズを変えられます。`material.shape` は点の形で、`'square'`（既定）と `'circle'` があり、オプションの `pointShape` でも指定できます。`'circle'` では四隅を描かないので、ピックもその部分には当たりません。形を変えるとシェーダーをコンパイルし直しますが、読み込み済みのノードはそのまま使えます。

`material.sizeType`（オプションは `pointSizeType`）で、`size` から画面上の大きさを決める方法を選べます。

| `sizeType` | `size` の意味 | 画面上の大きさ |
|---|---|---|
| `'fixed'`（既定） | CSS px | 常に `size` px |
| `'attenuated'` | ルートの spacing に掛ける倍率 | ワールド空間で一定の大きさ。近いほど大きい |
| `'adaptive'` | その位置で表示中の最も深いノードの spacing × 1.7 に掛ける倍率 | 細かいノードが表示されている所ほど小さく、粗い所ほど大きい |

`'attenuated'` と `'adaptive'` では、大きさを `material.minSize`〜`material.maxSize`（CSS px、既定は Potree と同じ 2〜50、オプションは `minPointSize`・`maxPointSize`）に収めます。`size` は 1 前後が目安です。

`'adaptive'` は Potree と同じく、表示中のノードの木を整数テクスチャに書き込み、頂点シェーダーが点の位置から子ノードをたどって最も深い表示ノードのレベルを求めます。加算型の LOD でも、親ノードの点は子ノードが表示されている領域では子ノードの点と同じ大きさになり、粗い点が細かい点を覆いません。オクツリーは点が少なくなった所で分割を止めるので、スキャンデータでは浅いレベルの葉ノードも周囲の深いノードと同じくらい密なことがよくあります。レベルだけで大きさを決めるとそうした葉ノードの点が数倍大きくなるため、Potree の lodOffset と同じく、ノードを読み込んだときに 32³ の格子で 1 セルあたりの点数を数えて実際の点間隔を推定し、レベルを補正します。補正量は PotreeConverter 2 のデータで Potree と一致するので、同じ `size` なら Potree と同じ大きさになります。テクスチャは表示ノードが変わった `update()` でだけ作り直します。ピックも同じ計算で描画するので、見た目どおりの範囲に当たります。

## 点の色

`material.colorType`（オプションは `pointColorType`）で、点の色の付け方を選べます。既定は `rgb` を復号していれば `'rgb'`、なければ `'elevation'` です。変えるとシェーダーをコンパイルし直しますが、読み込み済みのノードはそのまま使えます。

| `colorType` | 使う属性 | 色 |
|---|---|---|
| `'rgb'` | `rgb` | 点の RGB |
| `'solid'` | なし | `material.color`（既定は白） |
| `'elevation'` | なし | metadata.json の z 座標を `material.elevationRange` の範囲で `material.gradient` に当てはめた色 |
| `'intensity'` | `intensity` | `material.intensityRange` を黒〜白に対応させ、`material.intensityGamma` 乗した灰色 |
| `'classification'` | `classification` | `material.classification` に登録したクラスごとの色 |

復号する属性は読み込み時に決まり、使う属性を復号していない色の種類を指定するとエラーになります。`pointColorType` で指定した色の種類が使う属性は自動で復号しますが、読み込み後に `'intensity'` や `'classification'` へ切り替えるなら、`attributes` オプションにその属性を含めてください。

```ts
import { PotreeV2Classification, PotreeV2Gradients } from '@geemil/potree-v2-three';

cloud.material.colorType = 'elevation';
cloud.material.gradient = PotreeV2Gradients.VIRIDIS; // or [[0, '#000080'], [0.5, 'white'], [1, 'red']]
cloud.material.elevationRange = [12.5, 48];

cloud.material.colorType = 'intensity';
cloud.material.intensityRange = [0, 4096];
cloud.material.intensityGamma = 0.5; // 暗い点を明るくする

cloud.material.colorType = 'solid';
cloud.material.color.set('#ffcc00');
```

- `elevationRange` の既定値は bounding box の z の範囲です。範囲外の点はグラデーションの端の色になります。z は metadata.json の座標系で、`group` の変換の影響を受けません。
- `intensityRange` の既定値は metadata にある `intensity` の min/max で、なければ 0〜65535 です。
- `gradient` の既定値は Potree と同じ `PotreeV2Gradients.SPECTRAL` です。ほかに `VIRIDIS`、`INFERNO`、`RAINBOW`、`GRAYSCALE` があります。位置 0〜1 と色の組を渡せば独自のグラデーションも作れ、色の間は CSS のグラデーションと同じく sRGB で補間します。
- RGB と強度の値は Potree と同じく sRGB の値として扱い、グラデーションとクラスの色も sRGB で指定します。

### 分類

`PotreeV2Classification` はクラス番号（0〜255）ごとの色と表示・非表示を持ちます。初期値は Potree と同じ ASPRS LAS の配色です（地面は茶、植生は緑、建物は橙、ノイズは紫、水面は青など。一覧にない番号は青緑）。点群ごとに 1 つずつ作られますが、オプションの `classification` や `material.classification` に同じものを渡せば複数の点群で共有できます。

```ts
const classification = new PotreeV2Classification({ 6: { color: '#ff4040' } });
const cloud = await loadPotreeV2(url, { classification });

classification.setVisible(7, false); // ノイズを隠す
classification.setColor(2, 'saddlebrown');
classification.reset(); // Potree の配色に戻し、すべて表示する
```

非表示にしたクラスの点は色の種類によらず描画せず、ピックでも当たりません。`classification` を復号していない点群では何もしないので、RGB などで表示しながらクラスを隠すには `attributes` に `classification` を含めてください。変更は次の描画で反映されます。クリッピングと違い、ノードの選択や読み込みは減りません。

## EDL（Eye-Dome Lighting）

`PotreeV2EDL` は Potree と同じ Eye-Dome Lighting で、点の奥行きの差に陰影を付けて形を読み取りやすくします。`renderer.render(scene, camera)` の代わりに呼びます。

```ts
import { PotreeV2EDL } from '@geemil/potree-v2-three';

const edl = new PotreeV2EDL({ strength: 0.4, radius: 1.4 }); // 既定値は Potree と同じ

function animate() {
  cloud.update(camera, viewport.clientHeight);
  edl.render(renderer, scene, camera, [cloud]);
}
```

`render()` は 3 回に分けて描画します。

1. 点群の `group` を隠してシーンを描きます。`renderer.autoClear` と背景はふだんどおり働きます。
2. 点群とその祖先だけを残してシーンを描き直し、色と深度をオフスクリーンのターゲットに描きます。シーンを通して描くので、親の変換とフォグもそのまま効きます。
3. 深度から周囲 8 点との log 深度の差を求めて陰影を付け、点群の深度も書き込んで合成します。点群と他の物体の前後関係はそのまま保たれます。

`strength` と `radius`（CSS px）はいつでも変えられます。点群の `group` の下にあるものはすべて陰影の対象になり、ノードの bbox 表示も含まれます。透視・平行投影のカメラと、`logarithmicDepthBuffer` に対応しています。`reversedDepthBuffer` には対応していません。

## 開発

リポジトリのルートで `pnpm install`, `pnpm dev` を実行するとライブラリの watch ビルドと playground が起動します。`pnpm build` で両方をビルド、`pnpm test` で形式の読み込みを検証します。
