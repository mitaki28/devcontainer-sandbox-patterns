# 統合構成: 作業コンテナ並列起動向けの構成

本章は `integrated/multi-workspace/` を扱う。前章の単独起動構成を並列起動前提に書き直したもの。

## 1. 章のスコープ

同一プロジェクトの作業コンテナを複数同時に走らせて並列タスクを進めたいときの構成。プロキシ群を shared-infra として 1 度だけ常駐起動し、タスクごとの作業コンテナを別 compose プロジェクトとして並列に起動する 2 層構造を採る。前章の単独起動構成と同じホストポートを使うため同時起動は不可。

## 2. なぜ並列起動が要るか

単独起動構成をそのまま複数並列展開すると、ホストポート衝突・OAuth リフレッシュの競合・プロキシのリソース重複が起きる。これらは全作業コンテナで共有してよいリソース (ホストポート / OAuth トークン / プロキシ群) を shared-infra に集約すれば解消する。

## 3. 2 層構造

![並列起動の作業コンテナの構成図](./multi-workspace.excalidraw.png)

2 層は次のように起動する:

- **shared-infra** — `docker compose -p devsbx-infra up -d` で 1 度だけ常駐起動。全作業コンテナで共有されるプロキシ群と共有のリバースプロキシが立ち上がる
- **per-task workspace** — `docker compose -p <task> up -d` でタスクごとに別 compose プロジェクトとして起動。`<task>` の値がそのままサブドメインの接頭辞 (`<task>.devsbx.localhost:8080`) になる

作業コンテナは `<task>_internal` (自分専用) と `devsbx-shared` (shared-infra と共有) の 2 つの internal: true ネットワークに参加する。どちらも外部への直接経路を持たないため、プロキシ群経由でしか外に出られない構造は単独構成と同じ。なお `devsbx-shared` を全作業コンテナで共有するため、作業コンテナ間は相互に到達可能になる。

## 4. ルーティング管理を Docker DNS に移譲する

複数の作業コンテナを 1 つのリバースプロキシで振り分けるには、起動 / 停止に追従する動的ルーティングが要る。本レシピでは、サブドメインを Docker DNS 上のサービス名に対応付けることで、Docker 以外の依存 (Traefik の Docker API 監視やサービスディスカバリ等) なしに動的ルーティングを実現している。

実装詳細は [`integrated/multi-workspace/README.md`](../integrated/multi-workspace/) と [`recipes/ingress-multi-workspace/`](../recipes/ingress-multi-workspace/) を参照。

## 5. 詳細はレシピ README へ

利用手順はレシピ README を参照:

- [`integrated/multi-workspace/README.md`](../integrated/multi-workspace/)

## 6. まとめ

ここまでで [01-problem.md](./01-problem.md) §3 の目標を単独 / 並列の両構成に組み立てた。本編はここで一区切り。

付録:

- [alt-dependencies-build-time.md](./appendix/alt-dependencies-build-time.md) — 実行時疎通先の最小化
- [alt-simple-http-proxy.md](./appendix/alt-simple-http-proxy.md) — 独自 CA 不要の mitm-proxy 代替
- [alt-git-mitm-proxy-addon.md](./appendix/alt-git-mitm-proxy-addon.md) — git-gateway の軽量代替

巻末:

- [99-postscript.md](./99-postscript.md) — あとがき
