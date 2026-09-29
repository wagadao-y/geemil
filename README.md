# geemil

PotreeConverter v2 の点群を Three.js で表示するライブラリと、その動作確認用 playground の pnpm モノレポです。

```text
packages/potree-v2-three/  v2 専用ライブラリ
apps/playground/           Vite + TypeScript の確認画面
```

```sh
pnpm install
pnpm dev
```

起動後に表示される URL を開くと、同梱の `pump` 点群が自動で読み込まれます。画面全体がビューアーになり、右上の lil-gui で読み込みと表示設定を操作できます。実データは `metadata.json` の URL を入力するか、「3ファイルを選択」から同じフォルダにある `metadata.json`、`hierarchy.bin`、`octree.bin` をまとめて指定してください。ローカルファイルはサーバーへ送信されません。別オリジンの URL を使う場合は、配信元で CORS と HTTP Range を有効にしてください。

同梱の `apps/playground/public/pump/` は、[libE57 のテストデータ](http://www.libe57.org/data.html) `PumpNoInvalidPoints.e57`（© 2008 Carnahan-Proctor and Cross, Inc.）を PotreeConverter で Potree 2.0 形式に変換したものです。ライセンスは同じフォルダの `LICENSE.txt`（libE57 Test Data License）を参照してください。

`pnpm build` は両プロジェクトをビルドし、`pnpm test` はライブラリの形式解析と読込を検証します。ライブラリの API は [パッケージ README](packages/potree-v2-three/README.md) を参照してください。
