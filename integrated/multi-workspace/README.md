# integrated/multi-workspace/ — 並列起動対応の統合構成 (shared-infra + per-task workspace)

[`integrated/single-workspace/`](../single-workspace/) を **「同一プロジェクトを複数の作業コンテナで並列展開し、それぞれで別タスクを進める AI 作業環境」前提** に書き直した並列起動対応版。サンドボックス全体を 2 層に分割し、共有のインフラ (プロキシ群 + リバースプロキシ) を 1 度だけ常駐起動 + タスクごとの作業コンテナを別 compose プロジェクトとして並列に起動する。

両者は意図的に並存させてあり、ユースケースに応じて選ぶ対等な選択肢: 並列稼働を想定しないときは single-workspace、同一プロジェクトの作業コンテナを同時に複数走らせて並列タスクを進めたいときは本レシピ (multi-workspace)。同じホストポート (`127.0.0.1:8080` / `127.0.0.1:3030`) と OAuth トークンストアを共有するため **同時起動は不可** (排他運用)。

並列起動が必要になる根拠 (ホストポート衝突 / OAuth リフレッシュの競合 / プロキシのリソース重複)、設計の核心 (Docker DNS へのルーティング移譲)、共有構成で許容する漏れ、評価軸との対応は docs 側で扱う:

- [docs/11-multi-workspace.md](../../docs/11-multi-workspace.md) — 並列起動の作業コンテナの章

## アーキテクチャ概略

```
                              ┌─────────────────────────────────────┐
                              │ external network                    │
                              │  api.githubcopilot.com / mcp.atlassian.com / mcp.context7.com  │
                              │  github.com / api.anthropic.com / registry.npmjs.org / ...     │
                              │  googleapis.com (任意)                                          │
                              └─▲────▲────▲────▲────▲────▲──────────┘
                                │    │    │    │    │    │
   ┌────────────────────────────┴────┴────┴────┴────┴────┴───────────┐
   │ shared-infra (1 度だけ起動、別 compose プロジェクト = devsbx-infra)     │
   │                                                                    │
   │  mcp-* proxies (per backend: github / atlassian / context7 /       │
   │  gcloud (任意)) / mitmproxy / git-gateway / shared ingress (Caddy) │
   │                                                                    │
   │  networks:                                                         │
   │    devsbx-shared (internal: true)                                  │
   │    devsbx-external (外向き + ingress publish の動作要件)            │
   └────────────────────────────▲────────────────────────────────────────┘
                                │  devsbx-shared
              ┌─────────────────┴───────────────┬──────────────────────┐
              │                                 │                      │
   ┌──────────┴──────────────┐  ┌───────────────┴────────────┐  ┌──────┴───────┐
   │ per-task workspace A    │  │ per-task workspace B       │  │ ...          │
   │ (compose -p task-auth)  │  │ (compose -p task-search)   │  │              │
   │                          │  │                            │  │              │
   │  workspace               │  │  workspace                 │  │              │
   │  networks:               │  │  networks:                 │  │              │
   │    task-auth_internal    │  │    task-search_internal    │  │              │
   │      (internal: true)    │  │      (internal: true)      │  │              │
   │    + devsbx-shared (ext) │  │    + devsbx-shared (ext)   │  │              │
   └──────────────────────────┘  └────────────────────────────┘  └──────────────┘
                ▲                                ▲
                │                                │
        host browser                     host browser
   http://task-auth.devsbx.localhost:8080/   http://task-search.devsbx.localhost:8080/
   (共有のリバースプロキシが header_regexp でワイルドカード振り分け)
```

## 構成

```
integrated/multi-workspace/
├── README.md
├── compose.yaml                # per-task workspace の定義 (workspace のみ)
├── Dockerfile                  # workspace イメージ (single-workspace/Dockerfile を流用)
├── package.json                # サンプル依存
├── pnpm-lock.yaml
├── .gitignore
├── .mcp.json                   # 各 mcp-* の参照先 (atlassian.mcp.devsbx.internal:8000/mcp 等)
├── .claude/
│   └── settings.json
├── .devcontainer/
│   └── devcontainer.json
└── shared-infra/                 # 共有系サービス (別 compose プロジェクト = devsbx-infra)
    ├── compose.yaml            # mcp-* / mitmproxy / git-gateway / 共有のリバースプロキシ + networks
    ├── policy.json             # mitm-proxy の policy (shared-infra 直下が筋)
    └── ingress/
        ├── Dockerfile          # caddy:2-alpine
        └── Caddyfile           # ワイルドカードサブドメインによるルーティング
```

## 実装の核心

### ルーティング管理を Docker DNS に移譲

共有のリバースプロキシ (Caddy) の Caddyfile を完全に静的に保ち、作業コンテナの起動 / 停止追従は Docker DNS に任せる。作業コンテナ起動 → Docker DNS に `<task>-workspace` が追加 → Caddy は次のリクエストから到達可能、作業コンテナ停止 → DNS から削除 → 502。**Caddyfile 編集やリロード一切不要**。

```caddy
# shared-infra/ingress/Caddyfile (抜粋)
:80 {
    # task ワイルドカード: <task>.devsbx.localhost → <task>-workspace:3000
    @task header_regexp host Host ^(?P<name>[a-z0-9-]+)\.devsbx\.localhost(?::\d+)?$
    handle @task {
        reverse_proxy {re.host.name}-workspace:3000
    }

    # 名前付きポート (利用者が静的に追加): app. / api.
    @app header_regexp app Host ^app\.(?P<name>[a-z0-9-]+)\.devsbx\.localhost(?::\d+)?$
    handle @app {
        reverse_proxy {re.app.name}-workspace:3000
    }
    @api header_regexp api Host ^api\.(?P<name>[a-z0-9-]+)\.devsbx\.localhost(?::\d+)?$
    handle @api {
        reverse_proxy {re.api.name}-workspace:4000
    }

    handle {
        respond "no route" 404
    }
}
```

task ワイルドカードルーティング自体の実装の罠 (Caddy v2 の `host_regexp` 不在 / `header_regexp` のポート取り扱い / `${COMPOSE_PROJECT_NAME}` によるネットワークエイリアス / 動的ルーティング機構 (admin API / file provider) を採用しない根拠) は [`recipes/ingress-multi-workspace/`](../../recipes/ingress-multi-workspace/) に集約してある。

### 共有のネットワークへの統合

shared-infra 側の共有系 (mcp-* / mitmproxy / git-gateway / リバースプロキシ) は **1 つの `devsbx-shared` ネットワークに統合** している。shared-infra 側で `name: devsbx-shared` 固定で明示作成し、per-task compose は `external: true` で参照する形:

```yaml
# shared-infra/compose.yaml
networks:
  shared:
    internal: true
    name: devsbx-shared
  external:
    name: devsbx-external   # mcp-* / mitmproxy / リバースプロキシの外向き通信 + ポート公開に必要な外部疎通
```

```yaml
# integrated/multi-workspace/compose.yaml (per-task workspace)
networks:
  internal:
    internal: true          # ← <task>_internal: スタックごとの外向き通信を Docker ネットワーク設定で遮断
  shared:
    external: true
    name: devsbx-shared     # ← shared-infra で作成済みのネットワークを参照
```

共有を 1 つのネットワークに統合した理由は次の通り。**作業コンテナ間の到達可能性** という副作用 (作業コンテナ A から作業コンテナ B の `:3000` に到達可能) は受け入れる:

- mitm → mcp のチェーンを取れる余地を残す
- 共有サービス間の協調 (RPC 等) を妨げない

副作用を許容する根拠と他のトレードオフは [docs/11-multi-workspace.md](../../docs/11-multi-workspace.md) §5 (許容する漏れ) を参照。

### task 規約 / workspace イメージ

- **task 名 = compose プロジェクト名 = サブドメインの接頭辞**: `docker compose -p <task> up -d` の `<task>` がそのまま `<task>.devsbx.localhost:8080` になる
- **サブドメインの接尾辞**: `.devsbx.localhost` (RFC 6761 §6.3 でブラウザがループバック固定するためホスト DNS 設定不要)
- **命名制約**: 小文字英数字 + ハイフン (`_` 不可、サブドメイン RFC 1123 制約)
- **`<task>_internal` は compose デフォルトの命名**: 利用者は `docker compose -p <task> up -d` だけで自分の internal ネットワークが生まれる
- **workspace イメージ**: `integrated/single-workspace/Dockerfile` と同内容 (配置だけが違って中身は同じ)
- **各 mcp-* プロキシは task を区別しない**: 全作業コンテナが同じトークン / PAT を共有 (1 個人開発者前提で合理的)。トークンストアの競合は 1 つの mcp-proxy が 1 つのストアを独占管理することで自動的に解消

## 利用フロー

### 1. 事前準備 (ホスト側、初回のみ)

```sh
# env ファイル (single-workspace と同じ場所、共有運用前提)
mkdir -p ~/.config/devsbx \
         ~/.config/devsbx/claude \
         ~/.cache/devsbx/mcp-atlassian

# GitHub MCP 用 PAT
cp ../../lib/mcp-proxy/examples/api-key/.env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env

# git transport 用 PAT + ALLOWED_REPOS (git-gateway サービスが読む)
cat > ~/.config/devsbx/git-gateway.env <<'EOF'
GITHUB_PAT=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALLOWED_REPOS=myorg/myrepo
ALLOWED_REF_PATTERNS=refs/heads/feature/*,refs/heads/claude/*
DENIED_REF_PATTERNS=refs/heads/main,refs/heads/master,refs/tags/*
EOF
chmod 600 ~/.config/devsbx/git-gateway.env

# mitm-proxy.env はデフォルトでは何も注入しない (読み取り専用許可として機能する)。
# レシピごとに header_inject ルールで `${VAR}` を参照する場合のみ秘匿情報をここに書く。
cp ../../lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env

# Context7 API キー (任意、無認証でも動く)
echo 'CONTEXT7_API_KEY=ctx7sk-...' > ~/.config/devsbx/mcp-context7.env
chmod 600 ~/.config/devsbx/mcp-context7.env

# Cloud MCP (任意): GCP を使う場合のみ
# sandbox SA 作成 + impersonation 許可 + 個人 ADC 確立の詳細は
# ../../recipes/cloud-mcp-with-short-lived-credential/README.md
cp ../../recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める
mkdir -p ~/.cache/devsbx/gcp-mcp
chmod 700 ~/.cache/devsbx/gcp-mcp
../../recipes/cloud-mcp-with-short-lived-credential/refresh-token.sh   # 1h 寿命の SA アクセストークンを発行 (以降 50min ごとに回す)

# mcp-proxy.env: 全 mcp-* プロキシと全作業コンテナで共有する Bearer トークン (1 値)。
# `.mcp.json` の headers で `${PROXY_TOKEN}` として参照される。
printf 'PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/devsbx/mcp-proxy.env
chmod 600 ~/.config/devsbx/mcp-proxy.env

# Atlassian OAuth トークンストアのディレクトリも 0700 で固める
# (リフレッシュトークンが平文 JSON で書かれるため、同ホスト上の他プロセスからの読み取りを抑止)
chmod 700 ~/.cache/devsbx/mcp-atlassian
```

#### GitHub PAT スコープの最小化 (重要)

作業コンテナ内で RCE が起きた場合、攻撃者は本レシピで配布したトークンと等価な権限を獲得する (shared-infra の各プロキシ経由で正規ルートで API を叩ける)。**つまり PAT に与えたスコープが事故時の被害上限になる**。Anthropic 側のサブスクリプションは定額で塞がるが、GitHub / Atlassian はスコープの広さでそのまま被害幅が決まる。fine-grained PAT で必要最小に絞ることを強く推奨:

**GitHub MCP 用 PAT (`mcp-github.env`)** — `api.githubcopilot.com` への Bearer。本レシピは `--allow-tool 'get_* list_* search_* *_read'` で MCP 側を読み取り専用に絞っているので、PAT 側も読み取り専用スコープのみで足りる:

- Repository access: 対象リポジトリのみ (Specific repositories) を選択
- Repository permissions:
  - Metadata: **Read** (必須)
  - Contents: **Read**
  - Issues: **Read** (issue 系のツールを使う場合)
  - Pull requests: **Read** (PR 系のツールを使う場合)
- それ以外は **No access**

**git transport 用 PAT (`git-gateway.env` の `GITHUB_PAT`)** — 作業コンテナの gitconfig で github.com → git-gateway に書き換えられ、git-gateway が `ALLOWED_REPOS` に列挙したリポジトリの fetch / push に Basic 注入する:

- Repository access: `ALLOWED_REPOS` で許可したリポジトリのみ
- Repository permissions:
  - Metadata: **Read** (必須)
  - Contents: **Read and write** (push に必要)
- それ以外は **No access**

ref / branch 単位の制限は `git-gateway.env` の `ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS` で更に絞れる (pre-receive で照合)。

> 2 つの PAT は意図的に別経路で配布している (mcp-proxy が握る PAT と git transport が握る PAT は別人にできる)。MCP 経由の書き込みを許可したくなくても push は許可、という分離が成立する設計。

**Atlassian OAuth スコープ** — claude.ai 側で承認時に表示されるスコープを確認し、`read:*` 系のみで済む用途であれば書き込み系のスコープを承認しない。本レシピで MCP を読み取り専用用途に限定したい場合は再認可時にチェックを外す。

### 2. 既存の single-workspace を down (排他運用)

```sh
cd integrated/single-workspace && docker compose down  # ポート 8080 / 3030 の衝突回避
```

### 3. shared-infra を常駐起動 (1 度だけ)

```sh
cd integrated/multi-workspace/shared-infra
docker compose -p devsbx-infra up -d --build

# サービス + ネットワーク作成を確認
docker compose -p devsbx-infra ps
docker network ls --filter 'name=devsbx'
```

### 4. 初回 OAuth 認可 (Atlassian)

`mcp-atlassian-proxy` は shared-infra に 1 つだけ常駐し、`127.0.0.1:3030` を直接公開して OAuth コールバックを受ける。初回認可手順:

```sh
# shared-infra の mcp-atlassian-proxy の標準エラーに認可 URL が出るので、それをホストブラウザで開く
docker compose -p devsbx-infra logs --follow mcp-atlassian-proxy
# (別端末で) ブラウザで認可 URL を開く → Atlassian で承認 →
# http://localhost:3030/callback?code=... にリダイレクト →
# "Authorization complete" HTML → トークン永続化
```

完了後はトークンが永続化され、以降の shared-infra 起動では認可フローが自動でスキップされる (再認可不要)。

### 5. per-task workspace を起動 (タスクごとに別 compose プロジェクト)

```sh
cd ../    # back to integrated/multi-workspace/

# task 名 = compose プロジェクト名 = サブドメイン (小文字英数字 + ハイフンのみ)
docker compose -p task-auth up -d --build
docker compose -p task-search up -d
docker compose -p task-docs up -d
# (並列で何個でも、ホストポート衝突なし)
```

### 6. ホストブラウザで開発サーバ確認

```sh
# 作業コンテナ内で開発サーバ起動 (例: task-auth)
docker compose -p task-auth exec workspace pnpm dev --host 0.0.0.0 --port 3000

# ホストブラウザで:
# http://task-auth.devsbx.localhost:8080/         → workspace task-auth の :3000
# http://app.task-auth.devsbx.localhost:8080/     → 同上 (名前付きポート: 3000)
# http://api.task-auth.devsbx.localhost:8080/     → workspace task-auth の :4000
# http://task-search.devsbx.localhost:8080/       → workspace task-search の :3000 (並列)
```

### 7. devcontainer として起動

各タスクのディレクトリを VS Code / Cursor で開いて「Reopen in Container」。**ただし compose プロジェクト名の決定方式は IDE デフォルト挙動 (workspace folder basename) に依存する**。タスクのディレクトリ名がサブドメイン制約 (小文字英数字 + ハイフン) に従う場合は素直に動くが、`_` や大文字を含む場合はサブドメインで resolve できない。

開発者の運用としては:

- タスクのディレクトリをサブドメイン制約に従う名前 (`task-auth/` 等) で作る
- もしくは CLI 経由 (`docker compose -p <task> up -d`) でプロジェクト名を明示

`devcontainer.json` でプロジェクト名を明示的に固定する標準的な方法は無く、IDE 拡張側の挙動に依存する。

### 8. クリーンアップ

```sh
docker compose -p task-auth down
docker compose -p task-search down
docker compose -p task-docs down

# shared-infra は常駐前提なので普段は down しない (down すると全作業コンテナから切断される)
# 完全停止する場合のみ:
cd shared-infra && docker compose -p devsbx-infra down
```

## 隔離されているもの

| 情報 | host | shared-infra | per-task workspace |
|---|---|---|---|
| GitHub PAT (MCP 用) | `~/.config/.../mcp-github.env` | `mcp-github-proxy` のみ | **無し** |
| GitHub PAT (git transport) | `~/.config/.../git-gateway.env` | `git-gateway` のみ | **無し** |
| Atlassian access/refresh トークン | `~/.cache/.../mcp-atlassian/` | `mcp-atlassian-proxy` のみ | **無し** |
| Context7 API キー (任意) | `~/.config/.../mcp-context7.env` | `mcp-context7-proxy` のみ | **無し** |
| GCP 個人 ADC (リフレッシュトークン、任意) | `~/.config/gcloud/` (host) | **無し** (ホストで refresh-token.sh が消費) | **無し** |
| GCP sandbox SA アクセストークン (1h 寿命、任意) | `~/.cache/.../gcp-mcp/token` | `mcp-gcloud-proxy` のみ (`/tokens/token` ro) | **無し** |
| mitmproxy の CA 秘密鍵 | 名前付きボリューム `mitm-ca` | `mitmproxy` のみ | **無し** |
| Claude Code 認証情報 | `~/.config/.../claude/` (全 task で共有) | - | バインドマウントで全 task で共有 |

## 漏れる余地

1. **作業コンテナ間の到達可能性**: `devsbx-shared` 1 ネットワーク統合の副作用で、作業コンテナ A が作業コンテナ B の `:3000` に到達可能。個人開発前提で脅威モデル外として許容
2. **shared-infra 全体の侵害**: 共有サービスが侵害されると全作業コンテナに影響波及。被害範囲が単独の single-workspace より広い
3. **single-workspace と同様の漏れ余地**: プロキシ経由のアクション全般、mitmproxy 自身が信頼境界の主体になる、リバースプロキシ (Caddy) が信頼境界の主体になる、ビルド時インストールの postinstall スクリプト — 詳細は [`../single-workspace/`](../single-workspace/) の同節
4. **同じ Docker デーモンを共有する他 compose プロジェクトからの到達**: `devsbx-shared` / `devsbx-external` は別 compose プロジェクトから参照させるため `name:` 固定で公開している。その代償として、同じ Docker デーモンを使う任意の他 compose プロジェクトが `external: true, name: devsbx-shared` で join 可能 = mcp-proxy 等を Bearer 無しで叩ける位置に立てる。**Docker デーモンを共有する他プロジェクトは信頼前提** で運用 (= Docker デーモン上に起動するもの全てが利用者本人の責務)。共用の開発マシンや CI ランナーで本レシピを使う場合は、共有の秘匿情報による認証や別のデーモン (rootless docker / Podman 等) への分離を別途検討
5. **作業コンテナ内の RCE → 配布されたトークンと等価な権限**: GitHub PAT スコープの最小化が事故時の被害上限を決める (上記「GitHub PAT スコープの最小化」節)

## 既知の制約

- **shared-infra の先行起動が必須**: per-task compose は `external: true` で `devsbx-shared` を参照するため、shared-infra 不在では起動失敗 (fail-fast で良い挙動)
- **single-workspace との同時起動不可**: ホストポート 8080 / 3030 衝突 + OAuth トークンストア共有によるリフレッシュ競合
- **task 名の制約**: 小文字英数字 + ハイフンのみ (サブドメイン RFC 1123)
- **HTTPS 化未対応**: ホストブラウザから `http://` のみ。Service Worker / SameSite=None Cookie 等の挙動を再現したい場合は本レシピでは対応していない

## 関連

- [`../single-workspace/`](../single-workspace/) — 単独起動の完成形 (本レシピとの並存対象)
- [`../../recipes/ingress-single-workspace/`](../../recipes/ingress-single-workspace/) — インバウンド軸の元レシピ
- [`../../recipes/ingress-multi-workspace/`](../../recipes/ingress-multi-workspace/) — task ワイルドカードルーティングの単体検証レシピ (本レシピの共有のリバースプロキシ部分の詳細)
- [`../../recipes/git-gateway/`](../../recipes/git-gateway/) — github.com 向け git transport の単一窓口
- [`../../recipes/cloud-mcp-with-short-lived-credential/`](../../recipes/cloud-mcp-with-short-lived-credential/) — 任意の Cloud MCP 追加用
- [`../../lib/mcp-proxy/`](../../lib/mcp-proxy/) — mcp-proxy 本体
- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — mitm-proxy 本体 (TLS 終端 / CA 配布の詳細)
