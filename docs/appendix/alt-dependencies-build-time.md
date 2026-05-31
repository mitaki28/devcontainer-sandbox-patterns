# 付録: 実行時疎通先の最小化 — ビルド時に依存関係を焼き込む

`alternatives/dependencies-build-time/` を扱う付録。主推奨である [10-single-workspace.md](../10-single-workspace.md) で採用した「実行時に `pnpm install` を許す + mitm の読み取りのみ許可で publish を塞ぐ」とは別アプローチとして、**実行時の外向き通信を経路ごと断つ** 方向の代替を残す。

## このパターンの位置付け

主推奨の統合構成 (`integrated/single-workspace/`) は、レジストリへの GET (= 依存解決) を **実行時に許して** mitm-proxy の読み取りのみ許可で publish 系をポリシーで塞ぐバランスを取った。一方、本付録の `alternatives/dependencies-build-time/` は **依存解決をイメージビルド時に閉じ込め、実行時のレジストリへの外向き通信を経路ごと断つ** アプローチを採る。

両者は競合する設計ではなく、**脅威モデルの好みで使い分ける** 代替の関係にある。実行時の外向き通信を許さない構成にしたい場合に本付録が選択肢となる。

## 何を実現するか

- 作業コンテナの `node_modules` を **イメージビルド時に焼き込む** (`Dockerfile` の `pnpm install --frozen-lockfile`)
- 作業コンテナは `internal: true` のネットワークにしか居ないため、**実行時にレジストリへ TCP を出す経路が存在しない**
- 依存追加・更新は **`profiles: [tools]` で隔離した dep-update サイドカー** で人間が都度実行 (`docker compose --profile tools run --rm dep-update pnpm add ...`)
- dep-update の発火はホスト側の人間操作に閉じる (作業コンテナ内からはサイドカーを起動する経路が無い)

## 主推奨に対するトレードオフ

| 観点 | 主推奨 (`integrated/single-workspace/` + mitm の読み取りのみ許可) | 本付録 (`dependencies-build-time`) |
|---|---|---|
| 実行時のレジストリ GET | 通す (mitm 経由) | **塞ぐ** (経路無し) |
| 実行時のレジストリ POST / PUT (publish) | 403 で塞ぐ | (経路自体無いため当然塞がれる) |
| 依存追加の DX | `pnpm add` を実行時に叩ける | dep-update をホストで起動 → 再ビルド |
| AI エージェントが依存をいじる権限 | あり (`pnpm add`) | **無し** (外向き通信なしで `pnpm add` 不可、サイドカーもホスト操作のみ) |
| 攻撃面 | mitm-proxy 実装 / ポリシー設定ミス | イメージビルド時の postinstall スクリプト |

主推奨の方が DX が良い (依存追加がエージェントから自然に動く) 一方、本付録の方が **AI エージェントから依存変更権限を完全に取り上げられる**。後者は「依存変更を人間レビュー必須にしたい」脅威モデル向け。

## 採用シナリオ

- **AI エージェントに依存変更を任せたくない** — 依存追加・更新を人間の操作に閉じ込めたい
- **実行時の外向き通信を経路ごと断ちたい** — 「mitm 経由なら GET は通る」状態自体を許さない設計にしたい
- **依存追加が低頻度** — イメージビルドを都度走らせるコストが許容できる範囲

逆に、依存追加が頻繁・実験的で AI エージェントが `pnpm add` を自由に叩く方が DX 上自然な場合は、主推奨 (mitm の読み取りのみ許可) を選ぶ。

## 詳細はレシピ README へ

実装の詳細 (lockfile 生成手順、smoke テストで検証している 3 項目、名前付きボリュームとバインドマウントの共存、`--lockfile-only` を使う理由、corepack の固定) と限界 (ビルド時インストールの postinstall は走る / dep-update の外向き通信はレジストリ全域) はレシピ README にまとめてある:

- [`alternatives/dependencies-build-time/README.md`](../../alternatives/dependencies-build-time/) — ビルド時インストール + dep-update サイドカーの詳細
