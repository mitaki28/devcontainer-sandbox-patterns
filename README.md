# devcontainer-sandbox-patterns

devcontainer をサンドボックスとして扱うための隔離パターン集。AI エージェント (Claude Code / Cursor / Codex 等) を運用する開発者向けに、もう一歩踏み込んだ隔離を見通しよく実現する構成の作り方を整理したもの。

本書のレシピは、秘匿情報自体を作業コンテナの外 (プロキシ側) に置き、許可ドメイン内でも特定の操作 (例: 指定したリポジトリへの push) だけ通る粒度で絞る形を目指す。

これを作業コンテナ内で実装しようとすると、任意コード実行が前提の環境内で秘匿情報や許可判定を守る必要があり、考慮すべきことが多い。本書では、秘匿情報と許可判定を別の Docker コンテナに分離し、**操作許可をプロキシ群に集約する** 構造を取る。

> [!CAUTION]
> **無保証**: 本リポジトリは隔離パターンと設計の考え方を個人的に整理したものであり、実装や構成に脆弱性や不具合が存在しないことを保証するものではない。利用者の責任で評価・採用すること (詳細は [LICENSE](./LICENSE) の `AS IS` 条項)。

> [!IMPORTANT]
> **AI 支援**: 本リポジトリのコードおよびドキュメントは [Claude](https://claude.com/) (主に Claude Code) を用いて実装・執筆している。設計判断・監修・レビューは mitaki28 が行っているが、文章・コードは生成されたものである。

> [!NOTE]
> 本書は 2026 年 4 月時点で一般的だった devcontainer 構成を出発点としている。AI エージェント周辺のツールや隔離手法は急速に進歩しており、既に同種の機能を持つ実装も存在する ([02-design.md §7](./docs/02-design.md#7-関連する取り組みと本書の位置づけ))。

## 概要

本書のレシピは、秘匿情報を作業コンテナの外に出し、外向きの通信先を細かい粒度で絞る、という 2 つの目標を、判定をプロキシ側に集めることで実現する。
![操作許可をプロキシ群に集約する](./docs/concept.excalidraw.png)

基本コンポーネントと設計の詳細は [02-design.md](./docs/02-design.md) を参照。

## 想定する読者と前提

以下に当てはまる読者向け:

**やりたいこと**:

- AI エージェント (Claude Code / Cursor / Codex CLI 等) を、許可した範囲内で運用したい
- もう一歩踏み込んだ隔離 (秘匿情報を作業コンテナの外に置く / 許可ドメイン内でも操作粒度を絞る) を、見通しよく実現したい
- 操作許可の方針を、設計の考え方として参照したい

**適用範囲**:

- 個人開発者のローカル環境での利用を主眼とする
- チーム共有環境 / CI / 本番環境への直接適用は想定外
- macOS + Docker Desktop 環境を想定

## 構成

```
.
├── docs/             # 読み物 (思想 → 設計 → 各論)
├── lib/              # 基本コンポーネント (mcp-proxy / mitm-proxy)
├── recipes/          # ユースケース別レシピ
├── integrated/       # 統合構成 (基本コンポーネント + レシピを 1 compose にまとめた統合構成)
└── alternatives/     # 代替・参考実装 (recipes/ とは別軸の選択肢)
```

### 読み物 (docs/)

順番に読むことを想定している。

1. [01-problem.md](./docs/01-problem.md) — 踏み込んだ隔離を見通しよく実現したい
2. [02-design.md](./docs/02-design.md) — 操作許可をプロキシ群に集約する
3. [03-foundation.md](./docs/03-foundation.md) — Docker + internal ネットワーク
4. [04-mcp-proxy.md](./docs/04-mcp-proxy.md) — mcp-proxy — 細粒度・明示的な操作許可
5. [05-mitm-proxy.md](./docs/05-mitm-proxy.md) — mitm-proxy — 粗粒度・暗黙的な操作許可
6. [06-cloud-mcp.md](./docs/06-cloud-mcp.md) — クラウド認証情報の短寿命化
7. [07-web-fetch.md](./docs/07-web-fetch.md) — web fetch を特化 MCP に集約する
8. [08-git-gateway.md](./docs/08-git-gateway.md) — Git 向けのカスタムプロキシ
9. [09-ingress.md](./docs/09-ingress.md) — 開発サーバをホストブラウザに見せる
10. [10-single-workspace.md](./docs/10-single-workspace.md) — 作業コンテナ単独起動向けの構成
11. [11-multi-workspace.md](./docs/11-multi-workspace.md) — 作業コンテナ並列起動向けの構成

付録:

- [alt-dependencies-build-time.md](./docs/appendix/alt-dependencies-build-time.md) — 実行時疎通先の最小化
- [alt-simple-http-proxy.md](./docs/appendix/alt-simple-http-proxy.md) — 独自 CA 不要の mitm-proxy 代替
- [alt-git-mitm-proxy-addon.md](./docs/appendix/alt-git-mitm-proxy-addon.md) — git-gateway の軽量代替

巻末:

- [99-postscript.md](./docs/99-postscript.md) — あとがき

### コード (lib/, recipes/, integrated/, alternatives/)

すべて `docker compose run --rm --build smoke` (smoke test = 最小疎通検証) またはレシピごとのシェルスクリプトで動作確認できる。各レシピの README に手順あり。

**基本コンポーネント** (`lib/`) — レシピや統合構成から再利用される土台:

| 実装 | 役割 | 説明章 |
|---|---|---|
| `lib/mcp-proxy/` | 細粒度・明示的な操作許可 | [04](./docs/04-mcp-proxy.md) |
| `lib/mitm-proxy/` | 粗粒度・暗黙的な操作許可 | [05](./docs/05-mitm-proxy.md) |

`lib/mcp-proxy/examples/` (api-key 認証 = GitHub MCP / OAuth 2.1 = Atlassian Rovo) は `lib/mcp-proxy` の利用例として位置付け、統合構成から再利用される。詳細は [04-mcp-proxy.md](./docs/04-mcp-proxy.md) と examples 側 README を参照。

**レシピ** (`recipes/`) — ユースケースごとに独立して動作する隔離パターン:

| 実装 | 役割 | 説明章 |
|---|---|---|
| `recipes/cloud-mcp-with-short-lived-credential/` | クラウド認証情報の短寿命化 | [06](./docs/06-cloud-mcp.md) |
| `recipes/git-gateway/` | Git 向けのカスタムプロキシ | [08](./docs/08-git-gateway.md) |
| `recipes/ingress-single-workspace/` | 作業コンテナ単独起動向けのインバウンド経路 | [09](./docs/09-ingress.md) |
| `recipes/ingress-multi-workspace/` | 作業コンテナ並列起動向けのインバウンド経路 | [09](./docs/09-ingress.md) |

**統合構成** (`integrated/`) — 基本コンポーネント + 複数レシピを 1 つの compose に組み合わせた統合構成:

| 実装 | 役割 | 説明章 |
|---|---|---|
| `integrated/single-workspace/` | 作業コンテナ単独起動向けの構成 | [10](./docs/10-single-workspace.md) |
| `integrated/multi-workspace/` | 作業コンテナ並列起動向けの構成 | [11](./docs/11-multi-workspace.md) |

両者はユースケースに応じて選ぶ対等な選択肢で、同じホストポート (`127.0.0.1:8080`) を使うため同時起動は不可。

**代替・参考** (`alternatives/`) — `recipes/` とは別軸の選択肢 (軽量化 / 別アプローチ):

| 実装 | 役割 | 説明章 |
|---|---|---|
| `alternatives/dependencies-build-time/` | 実行時疎通先の最小化 | 付録 [alt-dependencies-build-time](./docs/appendix/alt-dependencies-build-time.md) |
| `alternatives/simple-http-proxy/` | 独自 CA 不要の mitm-proxy 代替 | 付録 [alt-simple-http-proxy](./docs/appendix/alt-simple-http-proxy.md) |
| `alternatives/git-mitm-proxy-addon/` | git-gateway の軽量代替 | 付録 [alt-git-mitm-proxy-addon](./docs/appendix/alt-git-mitm-proxy-addon.md) |

## 貢献について

貢献の方針は [CONTRIBUTING](./CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT License](./LICENSE) — Copyright (c) 2026 mitaki28
