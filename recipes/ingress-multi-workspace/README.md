# recipes/ingress-multi-workspace/ — 共有のリバースプロキシの単体検証 (ワイルドカードサブドメイン + Docker DNS)

並列で複数の per-task workspace を起動し、ホストブラウザから **`<task>.devsbx.localhost:8080`** で各作業コンテナに振り分けるレシピ。task 名 (= compose project name) は事前に列挙する必要がなく、起動時に決まる。Caddy `header_regexp` マッチャ + Docker DNS の組み合わせで、動的ルーティング機構なしの完全静的な Caddyfile で並列の作業コンテナの振り分けを実証する。

[`integrated/multi-workspace/`](../../integrated/multi-workspace/) の共有のリバースプロキシ部分を **単体検証用に切り出したレシピ** で、独立利用は想定していない (統合構成は `integrated/multi-workspace/` を参照)。設計上の動機は docs 側で扱う:

- [docs/09-ingress.md](../../docs/09-ingress.md) — インバウンド軸の章

## 構成

```
recipes/ingress-multi-workspace/
├── README.md                           # 本ファイル
├── ingress/
│   ├── compose.yaml                    # ingress 単独 (compose project = shared-ingress-test)
│   ├── Dockerfile                      # caddy:2-alpine
│   └── Caddyfile                       # task ワイルドカード + 404 フォールバック
├── workspace/
│   ├── compose.yaml                    # workspace (compose project = task 名)
│   └── compose.smoke.yaml              # smoke 用 override (python3 http.server)
└── test/
    └── smoke.sh                        # 並列起動 + ルーティング検証 (8/8)
```

```
                               ┌──────────────────────────┐
                               │ ホストブラウザ              │
                               │  http://task-a.        │
                               │    devsbx.localhost:8080/ │
                               │  http://task-b.        │
                               │    devsbx.localhost:8080/ │
                               └──────────┬────────────────┘
                                          │ 127.0.0.1:8080
                                          ▼
                              ┌─────────────────────────┐
                              │ ingress (Caddy)          │
                              │ networks:                │
                              │  - shared (internal)     │
                              │  - external (公開用)     │
                              │                          │
                              │ Caddyfile:               │
                              │  header_regexp Host      │
                              │  (?P<name>[...])         │
                              │  .devsbx.localhost       │
                              │  → {re.host.name}        │
                              │    -workspace:3000       │
                              └──────────┬───────────────┘
                                         │ shared ネットワーク (Docker DNS)
                  ┌──────────────────────┼──────────────────────┐
                  │                      │                      │
        ┌─────────┴────────┐   ┌─────────┴────────┐   ┌─────────┴────────┐
        │ task-a-       │   │ task-b-       │   │ ...              │
        │  workspace       │   │  workspace       │   │                  │
        │ エイリアス一致で   │   │                  │   │                  │
        │ DNS 解決         │   │                  │   │                  │
        │  (network: shared)│   │                  │   │                  │
        │  + task-a_    │   │  + task-b_    │   │                  │
        │    internal      │   │    internal      │   │                  │
        └──────────────────┘   └──────────────────┘   └──────────────────┘
```

## 使い方

### smoke test (ホストから実行)

```sh
./test/smoke.sh
```

`test/smoke.sh` が 8 ケース (`task-a` / `task-b` へのルーティング / ブラウザスタイル `Host: <name>.devsbx.localhost:8080` のマッチャ一致 / 名前付きポート `app.<task>` → :3000 と `api.<task>` → :4000 の振り分け / 未知 Host の 404 フォールスルー / 作業コンテナ停止時の 502 / 作業コンテナ再起動によるルーティング自動復帰) を通す。後ろ 2 ケースは **動的ルーティング機構なしで作業コンテナの起動 / 停止に追従できる** ことを実証する核心テスト。

### 手動起動

```sh
# 1. ingress を 1 度起動 (shared ネットワークも同時作成)
docker compose -f ingress/compose.yaml -p shared-ingress-test up -d --build

# 2. 並列で workspace を起動 (compose project name = task 名)
docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml \
  -p task-a up -d
docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml \
  -p task-b up -d

# 3. ホストブラウザ / curl で確認
curl -H 'Host: task-a.devsbx.localhost' http://127.0.0.1:8080/index.html
# → "workspace: task-a"

curl -H 'Host: task-b.devsbx.localhost' http://127.0.0.1:8080/index.html
# → "workspace: task-b"

# 4. クリーンアップ
docker compose -f workspace/compose.yaml -p task-a down
docker compose -f workspace/compose.yaml -p task-b down
docker compose -f ingress/compose.yaml -p shared-ingress-test down
```

ブラウザからも `*.devsbx.localhost` が RFC 6761 §6.3 でループバック解決されるためホストの DNS 設定不要。

## 実装の罠と工夫

### Caddy v2 に `host_regexp` マッチャは無い

Caddy 2.6+ の `host_regexp` マッチャを想定すると module not registered で起動失敗する (存在しない)。Caddy v2 のマッチャ一覧で、`Host` ヘッダから **正規表現 + 名前付きキャプチャ** を取れるのは `header_regexp` のみ。

```caddy
@task header_regexp host Host ^(?P<name>[a-z0-9-]+)\.devsbx\.localhost(?::\d+)?$
handle @task {
    reverse_proxy {re.host.name}-workspace:3000
}
```

`header_regexp <key> <header> <regex>` の `<key>` (例: `host`) がキャプチャ参照名で、`{re.<key>.<group>}` で展開する。

### `header_regexp` はポートを除去しない

`host` マッチャは `Host` ヘッダのポート部分を勝手に除去するが、`header_regexp` は生のヘッダを取る。ブラウザは `Host: task-a.devsbx.localhost:8080` のようにポート込みで送るため、正規表現末尾に **`(?::\d+)?` でポート部分を許容** する必要がある。これを忘れるとポート込みの Host だけマッチせず、ブラウザからのアクセスだけ 404 になる。

### 作業コンテナのネットワークエイリアス

per-task compose で:

```yaml
services:
  workspace:
    networks:
      shared:
        aliases:
          - ${COMPOSE_PROJECT_NAME}-workspace
```

`${COMPOSE_PROJECT_NAME}` は compose の組み込み変数で、`-p <task>` で指定した値が入る。これで shared ネットワーク内の Docker DNS が `<task>-workspace` を解決するため、リバースプロキシの `{re.host.name}-workspace:3000` がそのまま到達する。

### 動的ルーティング機構を持たない構造

作業コンテナの起動 / 停止 / 再起動は Docker DNS の追加 / 削除で完結し、リバースプロキシ側に動的更新機構を一切持たせない:

- 作業コンテナ起動 → Docker デーモンが DNS に追加 → リバースプロキシは次のリクエストから到達可能
- 作業コンテナ停止 → Docker デーモンが DNS から削除 → リバースプロキシは次のリクエストで 502
- 作業コンテナ再起動 → リバースプロキシの再起動・リロード不要、自動復帰

この構造を選んだのは、動的更新機構を持つ案 (Caddy admin API + init コンテナ / Caddy file provider + 共有の名前付きボリューム) がいずれも **作業コンテナ側に Caddy 設定を改変する経路を作ってしまう** ためである:

- **admin API + init コンテナ案**: 各作業コンテナの init コンテナが Caddy admin API (`localhost:2019`) に POST/DELETE でルートを登録する形。admin API を露出する時点で作業コンテナから自由にルートを改変可能になり、task 隔離が薄い
- **file provider + 共有の名前付きボリューム案**: 各作業コンテナが起動時にスニペットを共有ボリュームに書き込み、Caddy がファイル監視でリロードする形。全作業コンテナが他の作業コンテナのスニペットを改変可能で、こちらも task 隔離が薄い + クリーンアップ処理が要る

ワイルドカード方式は両方の攻撃面を構造的に排除する (作業コンテナから Caddy 設定に触る経路が無く、クリーンアップも作業コンテナの停止で自動完結する)。

## 信頼の前提

- Docker (dockerd / network namespace) の隔離を信頼する
- Docker DNS が compose のネットワークエイリアスを期待通り解決する
- Caddy が upstream の DNS 解決失敗時に 502 を返す挙動 (デフォルト)

「カーネルの脆弱性 / docker socket 不正アクセスで netns を抜けられる」脅威モデルは本レシピのスコープ外。

## 漏れる余地 / 限界

1. **作業コンテナ間の到達可能性**: shared ネットワークに全作業コンテナが参加するため、作業コンテナ A が作業コンテナ B の `:3000` に到達可能。個人開発者が並列で作業コンテナを回す前提では脅威モデル外として許容 (`integrated/multi-workspace/README.md` の同節と同じ性質)
2. **HTTP only**: HTTPS 化未対応
3. **リバースプロキシの侵害**: リバースプロキシは shared と external (ポート公開に必要な外部疎通) の両ネットワークに足を持つ。侵害時の到達範囲は reverse_proxy 先 + external ネットワーク内のサービス
4. **task 名の制約**: 小文字英数字 + ハイフンのみ (サブドメイン RFC 1123 準拠)
5. **Docker / カーネルそのものの侵害**: スコープ外。VM 隔離など別アプローチが必要

## 関連

- [`../ingress-single-workspace/`](../ingress-single-workspace/) — 単独プロジェクト向けの devcontainer ごとのリバースプロキシ (固定 URL、プロジェクトごとに HOST_PORT)
- [`../../integrated/multi-workspace/`](../../integrated/multi-workspace/) — 本レシピのルーティングを shared-infra に組み込んだ統合構成
