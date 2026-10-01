# geemil

PotreeConverter v2 の点群を Three.js で表示するライブラリと、その動作確認用 playground の pnpm モノレポです。

```text
packages/potree-v2-three/  v2 専用ライブラリ
apps/playground/           Vite + TypeScript の確認画面
apps/web/                  Spatial Hub（SvelteKit の SPA。施設の 3D 情報ハブ）
```

```sh
pnpm install
pnpm dev
```

起動後に表示される URL を開くと、同梱の `pump` 点群が自動で読み込まれます。画面全体がビューアーになり、右上の lil-gui で読み込みと表示設定を操作できます。実データは `metadata.json` の URL を入力するか、「3ファイルを選択」から同じフォルダにある `metadata.json`、`hierarchy.bin`、`octree.bin` をまとめて指定してください。ローカルファイルはサーバーへ送信されません。別オリジンの URL を使う場合は、配信元で CORS と HTTP Range を有効にしてください。

同梱の `apps/playground/public/pump/` は、[libE57 のテストデータ](http://www.libe57.org/data.html) `PumpNoInvalidPoints.e57`（© 2008 Carnahan-Proctor and Cross, Inc.）を PotreeConverter で Potree 2.0 形式に変換したものです。ライセンスは同じフォルダの `LICENSE.txt`（libE57 Test Data License）を参照してください。

Spatial Hub は `pnpm dev:web` で起動します。いまはデモデータ（`apps/web/src/lib/api/demo-data.ts`）で動き、追加した注記・保存ビューはブラウザの localStorage に保存されます。点群は playground の `pump` を共有し、屋外メッシュは建屋の形から生成した代用品です。画面の構成は [apps/web/README.md](apps/web/README.md) を参照してください。

`pnpm build` はすべてのプロジェクトをビルドし、`pnpm test` はライブラリの形式解析と読込を検証します。ライブラリの API は [パッケージ README](packages/potree-v2-three/README.md) を参照してください。

コードの検査と整形はルートで実行します。

```sh
pnpm lint          # ESLint による検査
pnpm lint:fix      # 自動修正できる Lint 違反を修正
pnpm format        # Prettier による整形
pnpm format:check  # 整形済みか検査（CI 向け）
```

ESLint は TypeScript の推奨ルールを使い、ライブラリのソースには型情報を使う検査も適用します。Prettier はシングルクォート・セミコロンあり・行幅 100 を基準にします。参照リポジトリ、vendor、ビルド成果物、点群データは検査・整形の対象外です。

変更後は `pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm test` で確認できます。
