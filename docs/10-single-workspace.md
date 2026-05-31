# 統合構成: 作業コンテナ単独起動向けの構成

本章は `integrated/single-workspace/` を扱う。これまでのレシピを 1 つの compose に統合した構成。

## 1. 章のスコープ

Claude Code が動く devcontainer 1 つに、MCP × 4 (GitHub / Atlassian / Context7 / GCP) + git-gateway + mitm-proxy + リバースプロキシの全プロキシが揃った構成。単独起動前提で 1 つの compose で完結する。並列稼働が必要なら次章 [11-multi-workspace.md](./11-multi-workspace.md) を選ぶ。

## 2. 統合構造の全体像

![単独起動の作業コンテナの構成図](./single-workspace.excalidraw.png)

6 つの外向き通信経路 (MCP × 4 + mitm-proxy + git-gateway) + 1 つの内向き通信経路 (リバースプロキシ) という構造。作業コンテナは internal ネットワーク 1 つにしか所属せず、外部に出る経路はプロキシ群経由しか存在しない。

## 3. 3 種類のプロキシの役割分担

統合構成では 3 種類のプロキシがそれぞれ独立に許可判定を担う:

- **mcp-proxy (× 4)** — MCP ツール名単位の ACL + 認証肩代わり。GitHub / Atlassian / Context7 / GCP の各 MCP に 1 つずつ
- **mitm-proxy** — ホスト × HTTP メソッド × パス単位の ACL。参照系のみ許可を主とする (`registry.npmjs.org` GET 等)
- **git-gateway** — ref / commit 単位の ACL。github.com 向けの fetch + push

加えてリバースプロキシ (Caddy) が内向き通信の経路として開発サーバをホストに見せる。書き込みは mcp-proxy / git-gateway が担い、mitm-proxy は読み取り主体とする形で、[02-design.md](./02-design.md) §3.2 の運用方針がそのまま実装に落ちている。

## 4. 同一ホスト (github.com) に対する複数経路の網羅

`github.com` は MCP と git transport の両方が扱うため、同一ホストでも操作の種類ごとに別のプロキシが別の粒度で許可判定する。3 種類のプロキシを並べる意味がここに表れる:

- **MCP 操作** — mcp-github-proxy がツール名単位で ACL (`--deny-tool 'delete_*' 'merge_*'` 等)
- **git push / fetch** — git-gateway がリポジトリ / ref 単位で ACL
- **HTTP 直叩き** — mitm-proxy が原則拒否 (`github.com` を `readonly_hosts` に入れない)


## 5. 実行時の外向き通信と `pnpm install` の扱い

ホスト単位の通信制御だと、`pnpm install` のために `registry.npmjs.org` を許可した瞬間 `pnpm publish` も通ってしまう。本構成では mitm-proxy が HTTP メソッドまで見るため、GET (metadata + tarball) だけ通して POST / PUT (publish) は 403 で拒否できる。DX を損なわずに書き込み系を塞げるのが、ホスト × HTTP メソッド × パス粒度の利点が活きるポイントになる。

実行時にレジストリへの通信自体を作りたくない場合は付録のビルド時インストールパターン ([alt-dependencies-build-time](./appendix/alt-dependencies-build-time.md)) が使える。

## 6. 詳細はレシピ README へ

利用手順はレシピ README を参照:

- [`integrated/single-workspace/README.md`](../integrated/single-workspace/)

## 7. 次の章への接続

並列起動が必要になったら次章へ。

- [11-multi-workspace.md](./11-multi-workspace.md) — 作業コンテナ並列起動向けの構成
