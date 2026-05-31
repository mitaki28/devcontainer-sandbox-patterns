# 付録: 実行時疎通先の最小化 — ビルド時に依存関係を焼き込む

`alternatives/dependencies-build-time/` を扱う付録。[10-single-workspace.md](../10-single-workspace.md) §5 とは別のアプローチで、実行時にレジストリへの通信を一切作らない代替構成。

## このパターンの位置付け

統合構成はレジストリへの GET を実行時に許し、publish 系だけ mitm-proxy で塞ぐ構成だった。本付録は依存解決をイメージビルド時に閉じ込め、実行時のレジストリ通信自体を無くす代替。用途に応じて使い分ける。

## 何を実現するか

- `node_modules` をイメージビルド時に焼き込む (`pnpm install --frozen-lockfile`)
- 実行時はレジストリへの通信経路が無い (`internal: true` のみ)
- 依存追加・更新は dep-update サイドカーで人間が都度実行 (`docker compose --profile tools run --rm dep-update pnpm add ...`)
- サイドカーの起動はホスト側の人間操作に閉じる (作業コンテナからは起動できない)

## `integrated/single-workspace/` に対するトレードオフ

| 観点 | `integrated/single-workspace/` + mitm-proxy の読み取りのみ許可 | 本付録 (`dependencies-build-time`) |
|---|---|---|
| 実行時のレジストリ GET | **通す** (mitm-proxy 経由) | **経路無し** |
| 実行時のレジストリ POST / PUT (publish) | 403 で塞ぐ | (経路無しの帰結として塞がれる) |
| 依存追加の DX | `pnpm add` を実行時に叩ける | dep-update をホストで起動 → 再ビルド |
| AI エージェントが依存を変更する権限 | **あり** (`pnpm add`) | **無し** (外向き通信なしで `pnpm add` 不可、サイドカーもホスト操作のみ) |
| 攻撃面 | mitm-proxy 実装 / ポリシー設定ミス | イメージビルド時の postinstall スクリプト |

統合構成の方が DX は良い (依存追加がエージェントからそのまま動く) が、本付録は依存変更を人間の操作に限定できる。

## 採用シナリオ

- **依存変更を人間の操作に限定したい** — AI エージェントに `pnpm add` させたくない場合
- **実行時のレジストリ通信自体を無くしたい** — GET も含めて経路を断ちたい場合
- **依存追加が低頻度** — ビルドを都度走らせるコストが許容できる場合

依存追加が頻繁で AI エージェントに任せたい場合は統合構成 (mitm-proxy の読み取りのみ許可) を選ぶ。

## 詳細はレシピ README へ

実装詳細はレシピ README を参照:

- [`alternatives/dependencies-build-time/README.md`](../../alternatives/dependencies-build-time/)
