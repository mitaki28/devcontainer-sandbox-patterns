# recipes/ingress-single-workspace/ — devcontainer 内の開発サーバのホスト公開

`internal: true` で外向き通信を塞いだ devcontainer において、**作業コンテナ内で動く開発サーバ (`pnpm dev` の `:3000` 等) をホスト側のブラウザから見る** ためのプロジェクトごとのリバースプロキシ構成。ホストポートを 1 個だけ公開した Caddy が `Host:` ヘッダで作業コンテナの任意のポートに振り分ける。

インバウンド軸の設計意図 / `*.localhost` を採用した理由 / アウトバウンド軸との対比は docs 側で扱う:

- [docs/09-ingress.md](../../docs/09-ingress.md) — インバウンド軸の章

## 構成

```
                     (ホストブラウザ)
                            │  http://app.localhost:8080/
                            │  http://api.localhost:8080/
                            ▼
                     127.0.0.1:8080
                            │  (Docker port publish: DNAT)
        ┌───────────────────┴─────────────────────┐
        │ ingress (Caddy)                          │
        │ networks: [internal, external]           │
        │ Host: app.localhost → workspace:3000     │
        │ Host: api.localhost → workspace:4000     │
        │ Host: その他       → 404                  │
        └───────────────────┬─────────────────────┘
                            │ internal-net
                            │ (internal: true、ゲートウェイ無し)
                ┌───────────┴─────────────┐
                │ workspace (devcontainer) │
                │ networks: [internal]     │
                │ pnpm dev → :3000         │
                │ pnpm api → :4000         │
                └─────────────────────────┘
```

リバースプロキシを `internal` だけでなく外部疎通を持つ bridge ネットワーク `external` にも所属させているのは、`internal: true` 単独所属ではポート公開 (`ports:`) が効かないため。

```
recipes/ingress-single-workspace/
├── compose.yaml            # ingress + workspace + 2 networks
├── compose.smoke.yaml      # smoke override (workspace サービスを python http.server に差し替え)
├── ingress/
│   ├── Dockerfile          # caddy:2-alpine + Caddyfile
│   └── Caddyfile           # `Host` ヘッダによるルーティング定義
├── .env.example            # HOST_PORT=8080
├── .gitignore              # .env 除外
├── .devcontainer/
│   └── devcontainer.json   # workspace を devcontainer として起動
└── test/
    └── smoke.sh            # ホストから実行する smoke test
```

## 使い方

### 初期設定

```sh
cp .env.example .env
# 並列起動するなら HOST_PORT をプロジェクトごとに変える
```

### smoke test (ホストから実行)

```sh
./test/smoke.sh
```

`test/smoke.sh` が 4 ケース (`app.localhost` のルーティング / `api.localhost` のルーティング / ブラウザスタイル `Host: <name>:<port>` のマッチャ一致 / 未知 Host が 404 フォールスルー) を通す。

### devcontainer として起動

VS Code / Cursor で `recipes/ingress-single-workspace/` を開き「Reopen in Container」。`compose.yaml` の `workspace` サービスが起動し、`ingress` も `depends_on` で連動起動する。

作業コンテナ内で開発サーバを起動する際は、リバースプロキシのコンテナから別 netns 経由でアクセスされるため `0.0.0.0` で listen させる:

```sh
# 作業コンテナ内で
python3 -m http.server 3000              # デフォルトで 0.0.0.0 bind なので OK
# next dev / vite 等は --host 0.0.0.0 オプション指定
```

ホスト側ブラウザから `http://app.localhost:8080/` でアクセスする。

### `Host` のマッピングを追加する

`ingress/Caddyfile` に handle ブロックを増やすだけ:

```caddy
@docs host docs.localhost
handle @docs {
    reverse_proxy workspace:5000
}
```

リバースプロキシを再起動:

```sh
docker compose restart ingress
```

### 並列で複数 devcontainer を起動する

各プロジェクトの `.env` で `HOST_PORT` を別々の値に設定する:

```sh
# プロジェクト A
HOST_PORT=8080

# プロジェクト B
HOST_PORT=8081
```

ホスト側からは `http://app.localhost:8080/` (A), `http://app.localhost:8081/` (B) で別々に到達する。複数のプロジェクトをまたいでホストポートを 1 個に集約したい場合は `recipes/ingress-multi-workspace/` (統合構成は `integrated/multi-workspace/`) を参照。

## 利用上の制約

### `*.localhost` の解決

ホスト側で `app.localhost` 等が `127.0.0.1` に解決される必要がある。

- **ブラウザ (Chrome / Firefox / Safari の現行版)**: RFC 6761 §6.3 に基づき `*.localhost` をループバックに固定する実装になっており、`/etc/hosts` 設定不要。セキュアコンテキスト扱い (Service Worker / SameSite=None 等が動く)
- **macOS のリゾルバ (curl, dig 等の CLI)**: `dscacheutil -q host -a name app.localhost` は no result を返す。CLI から叩くなら `--resolve` で明示するか `/etc/hosts` に追記が必要
- **Linux glibc**: 実装によるが、`/etc/nsswitch.conf` で myhostname / files が `*.localhost` をループバックに向ける設定が一般的

「ブラウザで開発サーバを見る」という主用途では問題にならない。CLI (curl で API を叩く等) で使いたい場合は `/etc/hosts` に追記するか、`curl --resolve app.localhost:8080:127.0.0.1` を使う。

第三者所有ドメイン (`localtest.me`, `lvh.me`, `nip.io` 等) は所有者の運用継続に依存するため本レシピでは採用しない。

## 信頼の前提

- Docker (dockerd / network namespace) の隔離を信頼する (`alternatives/simple-http-proxy/` と同じ)
- 「カーネルの脆弱性 / docker socket 不正アクセスで netns を抜けられる」脅威モデルは本レシピのスコープ外

## 漏れる余地 / 限界

1. **HTTP only**: TLS なし。Service Worker や `SameSite=None` のクッキーの挙動を再現したい場合は HTTPS 化が必要 (本レシピでは未対応)
2. **WebSocket / SSE**: Caddy の `reverse_proxy` は WebSocket / SSE を透過的に転送する想定だが、smoke でカバーしていない。実利用時は要確認
3. **リバースプロキシの侵害**: リバースプロキシは両ネットワークに足を持つので、ここを取られると外向き通信が可能。緩和: イメージ最小 (caddy:2-alpine)、リバースプロキシに秘匿情報 / トークンを載せない
4. **`Host` ヘッダの詐称**: 攻撃者が任意のクライアントで `Host: app.localhost` を送ると作業コンテナの `:3000` に到達できる。ただしホストポートは `127.0.0.1:8080` にバインドしているので外部 IP からの到達は無い (ローカルプロセス間に閉じる)
5. **並列起動時の調整**: 各プロジェクトごとに `HOST_PORT` を手動で割り振る必要がある。1 つのホストポートに集約したいなら `recipes/ingress-multi-workspace/` を使う
6. **Docker / カーネルそのものの侵害**: スコープ外。VM 隔離など別アプローチが必要

## 関連

- [`../../alternatives/simple-http-proxy/`](../../alternatives/simple-http-proxy/) — アウトバウンド軸の対概念。`internal: true` で外を塞ぐ思想を共有
- [`../ingress-multi-workspace/`](../ingress-multi-workspace/) — 並列起動の作業コンテナを 1 ホストポート + サブドメインで振り分ける版
- [`../../integrated/single-workspace/`](../../integrated/single-workspace/) — 本レシピを組み込んだ統合構成
