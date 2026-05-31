# integrated/single-workspace/ — Claude Code 同梱の完成形 devcontainer (mcp-proxy + mitm-proxy 2 つの基本コンポーネント + git-gateway)

[`lib/mcp-proxy/examples/`](../../lib/mcp-proxy/examples/) (MCP 認証情報の隔離) と [`lib/mitm-proxy/`](../../lib/mitm-proxy/) (参照系の読み取り専用許可を主とする)、Context7 等の特化 MCP による Web 情報取得制御を 1 つの compose に統合し、**Claude Code が動く devcontainer から作業コンテナの外向き通信を経路レベルで最小化する** 完成形を組む。

統合構造の全体像 / 3 種類のプロキシの役割分担 / 同一ホスト (github.com) を扱う 3 つの境界の多層防御 / 評価軸との対応は docs 側で扱う:

- [docs/10-single-workspace.md](../../docs/10-single-workspace.md) — 統合構成 (単独起動の作業コンテナ) の章

本 README はレシピ固有の構築手順 (環境変数の配置 / 初回 OAuth 認可 / devcontainer 動作確認 / リバースプロキシ設定) と隔離されているもの一覧、残存リスクに集中する。

## 経路

| 経路 | プロキシ | 何が出ていけるか | 隔離される秘匿情報 |
|---|---|---|---|
| MCP (GitHub) | `mcp-github-proxy` | GitHub MCP API のみ | GitHub PAT (MCP 用) |
| MCP (Atlassian) | `mcp-atlassian-proxy` | Atlassian Rovo MCP API のみ | OAuth トークン / DCR client_id |
| MCP (Context7) | `mcp-context7-proxy` | Context7 MCP API のみ (パッケージドキュメント検索 + 取得) | API キー (任意。無認証でも動く) |
| MCP (GCP) | `mcp-gcloud-proxy` | GCP API のみ (gcloud-mcp 経由、クラウドのトークン未設定なら起動失敗) | 1h 寿命の SA アクセストークンファイル (個人 ADC はホストに閉じる) |
| mitm-proxy | `mitmproxy` | trusted (Claude Code 自身の外向き通信) + 読み取り専用許可 (`api.github.com` / `*.githubusercontent.com` / `registry.npmjs.org` 等) | (デフォルトでは何も注入しない、読み取り専用許可を主とする最小構成) |
| git-gateway | `git-gateway` | github.com 向け git transport の単一窓口。登録リポジトリは fetch reverse-proxy + push 内部 git-http-backend → pre-receive で ref ACL + 上流転送 | git transport 用 GitHub PAT (`ALLOWED_REPOS` / `ALLOWED_REF_PATTERNS` も) |

ホストブラウザから作業コンテナの開発サーバを覗くインバウンド経路は別途リバースプロキシ (Caddy) が担う。

## 構造図

```
                                ┌─────────────────────────────┐
                                │ external network             │
                                │  api.githubcopilot.com       │
                                │  mcp.atlassian.com           │
                                │  mcp.context7.com            │
                                │  googleapis.com (任意)        │
                                │  github.com                  │
                                │  api.anthropic.com 等         │
                                │  registry.npmjs.org / etc.   │
                                └──▲─────────────▲──────▲──────┘
                                   │             │      │
                ┌──────────────────┘             │      │
                │                      ┌─────────┘      │
                │                      │         ┌──────┘
                │                      │         │
        ┌───────┴────────────┐ ┌───────┴─────┐ ┌─┴──────────┐
        │ mcp-* proxy        │ │ mitmproxy   │ │ git-gateway│
        │  (1 container per  │ │ (読み取り    │ │ (github.com│
        │   backend:         │ │  専用許可 +  │ │  git のみ、 │
        │   github /         │ │  ACL)       │ │  ref/repo  │
        │   atlassian /      │ │             │ │  ACL)      │
        │   context7 /       │ │             │ │            │
        │   gcloud (任意))    │ │             │ │            │
        └────────▲───────────┘ └──────▲──────┘ └─────▲──────┘
                 │                    │              │
                 │ Bearer ${PROXY_    │ HTTPS_PROXY  │ http://git-gateway:8080/
                 │  TOKEN}            │              │ (workspace gitconfig insteadOf)
                 └────────────────────┴──────────────┘
                                      │
        internal: true ───────────────┼─────────────── (他に外向き通信無し)
                              ┌───────┴─────────┐  ◀──── ingress (Caddy)
                              │ workspace        │      :8080 publish
                              │  - Claude Code   │      `Host` ヘッダで
                              │  - devcontainer  │      app.localhost / api.localhost
                              │  - 認証情報なし   │      → workspace:3000 / :4000
                              └─────────────────┘
                                                       ▲
                                                       │ host browser
                                                http://app.localhost:8080/
```

## 構成

```
integrated/single-workspace/
├── README.md
├── compose.yaml                 # 全サービスの統合定義
├── Dockerfile                   # devcontainers/javascript-node + claude-code + pnpm 同梱 + bootstrap-ca.sh ENTRYPOINT
├── package.json                 # サンプル依存 (typescript ^6.0.3)
├── pnpm-lock.yaml               # devcontainer postCreateCommand の `pnpm install` で読まれる
├── policy.json                  # mitm-proxy の trusted_hosts / readonly_hosts / header_inject
├── .gitignore                   # .env / node_modules の保険
├── .mcp.json                    # github / atlassian / context7 MCP の参照先
├── .claude/
│   └── settings.json            # 組み込み WebFetch を deny + context7 ツールだけ allow
├── ingress/                     # ホストブラウザ → 作業コンテナのインバウンド経路 (Caddy)
│   ├── Dockerfile               # caddy:2-alpine + COPY Caddyfile
│   └── Caddyfile                # `Host` ヘッダによるルーティング (app.localhost → workspace:3000 等)
└── .devcontainer/
    └── devcontainer.json        # workspace を devcontainer として起動 + postCreateCommand: pnpm install
```

`compose.yaml` の各 build context は他コンポーネントを直接参照する:

- `mcp-github-proxy` / `mcp-atlassian-proxy` / `mcp-context7-proxy`: `../../lib/mcp-proxy` の `Dockerfile.binary`
- `mitmproxy`: `mitmproxy/mitmproxy` 公式イメージを直使用 (digest ピン、ビルドなし)。アドオンは `../../lib/mitm-proxy/addons` をバインドマウント、policy はレシピ固有の `./policy.json` をバインドマウント
- `git-gateway`: `../../recipes/git-gateway/gateway/` (Caddy + fcgiwrap + git-http-backend + 独自フック)。作業コンテナの gitconfig insteadOf で github.com → `git-gateway:8080` に書き換わる
- `ingress`: 本レシピ直下の `./ingress/` (`caddy:2-alpine` の digest ピン + Caddyfile)
- `workspace`: build context = リポジトリルート (`../..`) で `lib/mitm-proxy/bootstrap-ca.sh` を Dockerfile から COPY、`integrated/single-workspace/workspace-gitconfig` も COPY (レシピ固有のサンプル `package.json` 等は build context 経由ではなく実行時のバインドマウントで見える)

`mcp-github-proxy` には `lib/mcp-proxy/examples/api-key/` と同じ「破壊的系を deny する」フィルタ (`--deny-tool 'delete_*' 'merge_*' 'push_*'`) を当てている。これと git-gateway 側の `ALLOWED_REPOS` + `ALLOWED_REF_PATTERNS` ACL、加えて mitm の policy.json から github.com を外して直叩きを拒否する 3 つの境界が独立に効く多層防御が構成の核心 (詳細は [docs/10-single-workspace.md](../../docs/10-single-workspace.md) §4)。

## 事前準備 (ホスト側)

### 1. 環境変数ファイル

`recipes/git-gateway/` および `lib/mcp-proxy/examples/api-key/` と同じ規約で、**ホームの `.config` 配下** に env ファイルを配置する:

```sh
mkdir -p ~/.config/devsbx

# GitHub MCP 用 PAT (api.githubcopilot.com への Bearer 認証)
cp ../../lib/mcp-proxy/examples/api-key/.env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env

# git transport 用 PAT + ACL (git-gateway が github.com に Basic 注入 + ref/branch ACL)
cp ../../recipes/git-gateway/.env.example ~/.config/devsbx/git-gateway.env
chmod 600 ~/.config/devsbx/git-gateway.env

# mitm-proxy.env はデフォルトでは何も注入しない (読み取り専用許可として機能する)。
# レシピで header_inject ルールが必要な場合のみ秘匿情報をここに書く。
cp ../../lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env

# mcp-proxy.env: 全 mcp-* プロキシと作業コンテナで共有する Bearer トークン。
# `.mcp.json` の headers で `${PROXY_TOKEN}` として参照される。
printf 'PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/devsbx/mcp-proxy.env
chmod 600 ~/.config/devsbx/mcp-proxy.env

# 各 PAT / ACL のファイルを編集して値を入れる
```

GitHub PAT は **このリポジトリ専用** の fine-grained PAT を強く推奨。`mcp-github.env` と `git-gateway.env` は別 PAT でも同じ PAT でもよいが、スコープは最小権限に絞ること。

`git-gateway.env` の指定:
- `GITHUB_PAT`: github.com の git smart-HTTP に Basic 注入される PAT
- `ALLOWED_REPOS`: `owner/repo,owner/repo2` の CSV。ここに含まれないリポジトリは匿名 fetch のみ通り、push は 403 (git-gateway 側で拒否)
- `ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS`: glob CSV で push 時の ref 単位 ACL (例: `DENIED_REF_PATTERNS=refs/heads/main` で main 直 push を pre-receive で reject)

#### Context7 API キー (任意)

Context7 は無料枠なら無認証で動くため省略可。レート制限を緩めたい場合のみ [context7.com/dashboard](https://context7.com/dashboard) で API キーを取得し、以下のファイルに置く:

```sh
# 認証なしでよい場合は以下をスキップしてよい
echo 'CONTEXT7_API_KEY=ctx7sk-...' > ~/.config/devsbx/mcp-context7.env
chmod 600 ~/.config/devsbx/mcp-context7.env
```

`compose.yaml` 側は `env_file` を `required: false` で参照しているため、ファイルが存在しなければ無認証で起動する。`git-gateway.env` も `required: false` で、PAT を入れずに起動した場合は `ALLOWED_REPOS` 内のリポジトリへの push が「`GITHUB_PAT is not set`」で pre-receive 段階で失敗するだけで、他の経路 (匿名 fetch / MCP) は通常どおり動く (MCP のみ使う用途なら git-gateway.env は不要)。

#### Cloud MCP (任意)

GCP (`gcloud` CLI) を AI エージェントから使いたい場合は、sandbox SA + impersonation 経路で短寿命のアクセストークンを発行する追加準備が要る。詳細・sandbox SA の作成手順は [`../../recipes/cloud-mcp-with-short-lived-credential/`](../../recipes/cloud-mcp-with-short-lived-credential/) を参照。

最低限の手順:

```sh
# 1. sandbox SA を作成 + impersonation を許可 + 個人 ADC をホストで確立
#    (詳細は ../../recipes/cloud-mcp-with-short-lived-credential/README.md「共通の前提」節)

# 2. 環境変数ファイル (project / impersonate 先 SA)
cp ../../recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める

# 3. SA アクセストークンの保存先ディレクトリを作成 (プロキシが ro バインドマウントで読む)
mkdir -p ~/.cache/devsbx/gcp-mcp
chmod 700 ~/.cache/devsbx/gcp-mcp

# 4. ホストで refresh-token.sh を実行して 1h 寿命の SA アクセストークンを発行
../../recipes/cloud-mcp-with-short-lived-credential/refresh-token.sh
```

クラウドを使わない場合は手順 3 のトークンディレクトリを作らないだけで OK。`mcp-gcloud-proxy` サービスはバインドマウント元が無いため起動失敗するが、`depends_on` に挙げていないので作業コンテナと他のプロキシは影響を受けない。

50 分間隔で refresh-token.sh を回す運用例 (launchd / systemd / cron) は [`../../recipes/cloud-mcp-with-short-lived-credential/`](../../recipes/cloud-mcp-with-short-lived-credential/) の「自動更新」節を参照。

### 2. Atlassian OAuth トークン用ディレクトリ

```sh
mkdir -p ~/.cache/devsbx/mcp-atlassian
```

`compose.yaml` は `create_host_path: false` で bind しているので、未作成だと起動失敗する。

### 3. Claude Code config 用ディレクトリ

```sh
mkdir -p ~/.config/devsbx/claude
```

`docker compose down -v` で消えないように名前付きボリュームではなくホストの bind に置く。初回 `claude login` 後の認証情報がここに永続化される。

### 4. 初回 OAuth 認可 (Atlassian)

`lib/mcp-proxy/examples/oauth/` と同じ手順。プロキシをフォアグラウンドで起動して認可 URL を確認:

```sh
docker compose up mcp-atlassian-proxy --build
```

標準エラーに `Open the following URL ...` が出るので、URL をホストブラウザにコピペ → Atlassian で承認 → `http://localhost:3030/callback?code=...` にリダイレクト → プロキシが `Authorization complete` HTML を返してトークンを永続化。

完了したら Ctrl+C で止め、以降はバックグラウンド起動でよい。

## 起動

```sh
docker compose up -d
docker compose exec workspace pnpm install   # 初回のみ (devcontainer 経由起動なら postCreateCommand で自動)
```

または devcontainer として: VS Code / Cursor で `integrated/single-workspace/` を開いて「Reopen in Container」。`workspace` サービスを起動し、依存するプロキシ群も連動起動。`postCreateCommand: pnpm install` で初回の依存解決まで自動で済む。

mitmproxy が healthy (= CA 生成完了) になるまで workspace は起動しない (`depends_on: condition: service_healthy`)。これは workspace の `bootstrap-ca.sh` ENTRYPOINT が `mitm.it/cert/pem` を mitmproxy 経由で取得する必要があるため。

## devcontainer 内で確認すること

```sh
# 認証情報が一切持ち込まれていないこと
env | grep -i pat        # 何も出ないこと
env | grep -i github     # 何も出ないこと
env | grep -i atlassian  # 何も出ないこと
env | grep -i token      # 何も出ないこと
env | grep PROXY         # HTTPS_PROXY=http://mitmproxy:8080 のみ

# CA がトラストストアに入っていること
ls -l /usr/local/share/ca-certificates/mitmproxy.crt

# git transport は git-gateway 経由で動作する (system-wide /etc/gitconfig の
# insteadOf で https://github.com/ → http://git-gateway:8080/ に書き換わる)
git ls-remote https://github.com/anthropics/claude-code.git HEAD

# 読み取り専用な GET は通る、POST は 403 で拒否される
curl -sS -o /dev/null -w "%{http_code}\n" https://api.github.com/zen     # 200
curl -sS -X POST -o /dev/null -w "%{http_code}\n" https://api.github.com/  # 403

# 許可リスト外のホストは 403
curl -sS -o /dev/null -w "%{http_code}\n" https://example.com  # 403

# Claude Code が起動できる
claude --version

# 初回のみ login が必要 (次回以降はホストの ~/.config/devsbx/claude/
# に永続化されるため、`docker compose down -v` でも消えない)
claude login

# Claude Code 起動後、`/mcp` で github / atlassian / context7 の 3 つが認識されることを確認
claude
```

`.mcp.json` の `${VAR}` は使っていない (プロキシ自体が認証なしで受けるため)。クライアントから見ると、`http://github.mcp.devsbx.internal:8000/mcp` / `http://atlassian.mcp.devsbx.internal:8000/mcp` / `http://context7.mcp.devsbx.internal:8000/mcp` が普通の HTTP MCP として見える。ホスト名の `<provider>.mcp.devsbx.internal` 規約は MCP 群を `*.mcp.devsbx.internal` 一括で識別できるよう本リポジトリで採用しており、作業コンテナの `NO_PROXY=.devsbx.internal` 設定により mitmproxy をバイパスする。

## ホストブラウザから開発サーバを見る

`internal: true` で外向き通信を塞いだ作業コンテナにおいて、`pnpm dev` 等で起動した開発サーバをホスト側ブラウザから覗くインバウンド経路を **リバースプロキシ (Caddy)** が担う。構成は [`recipes/ingress-single-workspace/`](../../recipes/ingress-single-workspace/) からの流用で、`Host` ヘッダによるルーティングで作業コンテナの各ポートに振り分ける。

```sh
# devcontainer (作業コンテナ) 内で:
python3 -m http.server 3000             # or pnpm dev / next dev --hostname 0.0.0.0 / vite --host 0.0.0.0 等
```

ホスト側ブラウザで:

```
http://app.localhost:8080/   → workspace:3000
http://api.localhost:8080/   → workspace:4000
```

ブラウザは `*.localhost` を RFC 6761 §6.3 に基づきループバック解決するので `/etc/hosts` 設定は不要。CLI から叩きたい場合は `curl --resolve app.localhost:8080:127.0.0.1` を使うか `/etc/hosts` 追記が必要 (詳細は [`../../recipes/ingress-single-workspace/README.md`](../../recipes/ingress-single-workspace/README.md) の「利用上の制約」節を参照)。

### `Host` のマッピングを追加する

`./ingress/Caddyfile` に handle ブロックを追加してリバースプロキシを再ビルド:

```caddy
@docs host docs.localhost
handle @docs {
    reverse_proxy workspace:5000
}
```

```sh
docker compose build ingress && docker compose up -d ingress
```

### 開発サーバの listen アドレス

作業コンテナ内の開発サーバは `localhost:3000` ではなく `0.0.0.0:3000` で listen させる必要がある (リバースプロキシのコンテナから別の netns で来るため)。`python3 -m http.server` はデフォルトで `0.0.0.0`。`next dev` / `vite` 等は `--host 0.0.0.0` (or `--hostname 0.0.0.0`) を渡す。

### 単独起動前提の制約

HOST_PORT は `127.0.0.1:8080` 固定。同一ホストで複数スタックを並列起動するとポートが衝突する。並列起動が必要なケースは `integrated/multi-workspace/` (共有のリバースプロキシ + サブドメイン振り分け) を使う。

## 組み込み `WebFetch` の取り扱い

本レシピでは `.claude/settings.json` で組み込み `WebFetch` を **deny** し、ドキュメント参照は Context7 MCP に集約する (設計の背景は [docs/07-web-fetch.md](../../docs/07-web-fetch.md) §2 を参照)。`.claude/settings.json` の `allow` には Context7 提供の 2 ツール (`mcp__context7__resolve-library-id` / `mcp__context7__query-docs`) だけを明示列挙しており、他の MCP ツールが増えても勝手に有効化されない。

本レシピ固有の補足として、mitmproxy の許可リストは `api.anthropic.com` 等の Claude Code 自身用 + ツール疎通用 (`api.github.com` / `registry.npmjs.org` / `*.githubusercontent.com` 等) に絞っているため、仮に WebFetch を有効化しても汎用的に取れる範囲は薄く、明示的な deny の判断と整合する (github.com の直叩きは git-gateway 経由が前提のため mitm の許可リストに含めない)。

## 依存関係の追加・更新

**作業コンテナで `pnpm install` / `pnpm add` が直接動く**:

```sh
# devcontainer 内で:
pnpm install                         # 初回 (devcontainer の postCreateCommand で自動)
pnpm add --save-dev rimraf           # 追加
pnpm install --frozen-lockfile=false # lockfile 更新が必要な場合
```

`registry.npmjs.org` への GET (metadata + tarball) は mitmproxy の読み取り専用許可で通る。一方 `pnpm publish` のような POST / PUT はアドオンが 403 で拒否する **明確な境界** として効く。CI/CD の trusted publishing や別途認証付きの publish 経路に集約する想定。

AI エージェントから `pnpm add` を直接叩けるが、publish 系がポリシーで塞がれているため書き込み系の事故面は小さい。実行時の外向き通信を経路レベルでゼロにしたい脅威モデル向けには [`alternatives/dependencies-build-time/`](../../alternatives/dependencies-build-time/) のビルド時インストールパターンが別途使える (本レシピとは別軸)。

## 隔離されているもの

| 情報 | host | プロキシ各種 | workspace |
|---|---|---|---|
| GitHub PAT (MCP 用) | `~/.config/.../mcp-github.env` | `mcp-github-proxy` のみ | **無し** |
| GitHub PAT (git transport 用) | `~/.config/.../git-gateway.env` | `git-gateway` のみ | **無し** |
| Atlassian access_token / refresh_token | `~/.cache/.../mcp-atlassian/` | `mcp-atlassian-proxy` のみ | **無し** |
| DCR で発行された Atlassian client_id | 同上 | 同上 | **無し** |
| Context7 API キー (任意) | `~/.config/.../mcp-context7.env` | `mcp-context7-proxy` のみ | **無し** |
| GCP 個人 ADC (リフレッシュトークン) | `~/.config/gcloud/` (host) | **無し** (ホストで refresh-token.sh が消費) | **無し** |
| GCP sandbox SA アクセストークン (1h 寿命) | `~/.cache/.../gcp-mcp/token` | `mcp-gcloud-proxy` のみ (`/tokens/token` ro) | **無し** |
| mitmproxy の CA 秘密鍵 | 名前付きボリューム `mitm-ca` (mitmproxy コンテナのみ mount) | `mitmproxy` のみ | **無し** (公開鍵側の証明書のみ配布) |
| Claude Code 認証情報 (login トークン等) | `~/.config/devsbx/claude/` (ホストの `~/.claude/` 本体には流入させない) | - | バインドマウント経由で読み書き |

> 注: 作業コンテナでは `CLAUDE_CONFIG_DIR=/home/node/.claude` を設定して config と state (`.claude.json` 含む) をバインドマウント内に集約する。これを設定しないと `~/.claude.json` が home 直下に作られて毎回失われる。参考: [anthropics/claude-code/.devcontainer/devcontainer.json](https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json)

作業コンテナの環境変数 / ファイルシステム / プロセス空間に、上記 PAT・トークンは一切現れない。作業コンテナがプロンプトインジェクション等で侵害されても、攻撃者が直接持ち出せる秘匿情報は無い。

## 残る漏れ余地

1. **プロキシ経由のアクション全般は作業コンテナから自由**: 作業コンテナに居られる攻撃者は、PAT / OAuth トークンのスコープ範囲で github / atlassian を任意操作可能 (PAT そのものを盗み出して別系統で使うことはできない)。緩和: PAT / OAuth スコープを最小権限で発行する。`mcp-github-proxy` の `--deny-tool` と git-gateway の `ALLOWED_REPOS` + `ALLOWED_REF_PATTERNS` で操作・対象を二重に絞る
2. **`WebFetch` は `.claude/settings.json` の `permissions.deny` で無効化してある**: 任意 URL を Claude Code から叩く経路は閉じている。ドキュメント参照は Context7 MCP (`resolve-library-id` / `query-docs`) に集約。mitmproxy の許可リスト内のホストへの bash + curl での GET は Claude Code が実行プロンプトを得れば走り得る (現状のトレードオフ)。Bash コマンド自体の deny を併用する必要があれば `.claude/settings.json` で個別に絞る
3. **mitmproxy 自身が信頼境界の主体になる**: mitmproxy は `internal` と `external` の両ネットワークに足を持つ + CA 秘密鍵を保持。ここを取られると作業コンテナから外への直接の外向き通信 + 任意ドメインの偽証明書発行が可能。緩和: アドオン経由で実行されるコードを最小化、イメージを最新に保つ、policy.json を最小限に保つ
4. **プロキシ側の通信ログにはリクエストのペイロードが残る**: 本番用途では各プロキシのログ設定を見直すこと。mitmproxy の audit log (`docker compose logs mitmproxy`) は PAT 値そのものは出さないが、ヘッダ注入の対象ホスト / パスは記録される
5. **ビルド時インストールの postinstall スクリプトは実行される**: イメージビルド時に攻撃面はある。新規依存の採用時は人間レビュー前提 (詳細は [`alternatives/dependencies-build-time/`](../../alternatives/dependencies-build-time/))
6. **リバースプロキシ (Caddy) も信頼境界の主体になる**: リバースプロキシは `internal` と `external` の両ネットワークに足を持つ (ホストへのポート公開に必要な外部疎通)。Caddy が侵害された場合、`external` ネットワーク経由で外部への通信経路を持ちうる。ただし PAT / OAuth トークン / CA 秘密鍵にはアクセスできず、Caddyfile に書かれた reverse_proxy 先 (作業コンテナ) と各プロキシへの TCP 到達が直接の影響範囲 (詳細は [`recipes/ingress-single-workspace/`](../../recipes/ingress-single-workspace/) の「漏れる余地 / 限界」節)

## 既知の制約

- **初回 OAuth 認可時のみ `127.0.0.1:3030` をホストから参照する** ため、これだけは mitmproxy / internal ネットワークの枠外にある。認可完了後は使わない (必要なら ports 設定を消してよい)
- **リバースプロキシの `127.0.0.1:8080` も同様にホストへのポート公開が必要**。開発サーバをホストブラウザから見るためのインバウンド経路。並列起動非対応 (並列起動が要るなら `integrated/multi-workspace/` を使う)
- **作業コンテナのイメージは `mcr.microsoft.com/devcontainers/javascript-node:22-trixie`**。他言語ベースが必要ならレシピを fork する形
- **CA 証明書を OS のトラストストアでなく自前のバンドルで読むツール** (Java の `cacerts.jks`、AWS CLI の `AWS_CA_BUNDLE` 等) は、作業コンテナの Dockerfile に追加の環境変数が必要になる場合あり。本レシピでは Node / Python / pip / cargo / git の環境変数を一通りセット済み

## 関連

- [`../../lib/mcp-proxy/`](../../lib/mcp-proxy/) — mcp-proxy 本体
- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — mitm-proxy 本体 (mitmproxy + アドオンモジュール + ポリシースキーマ)。TLS 終端と CA 配布の詳細はこちら
- [`../../lib/mcp-proxy/examples/`](../../lib/mcp-proxy/examples/) — MCP 認証情報の隔離 (api-key / oauth の認証パターン別レシピ)
- [`../../recipes/git-gateway/`](../../recipes/git-gateway/) — Git transport の単一窓口
- [`../../recipes/cloud-mcp-with-short-lived-credential/`](../../recipes/cloud-mcp-with-short-lived-credential/) — 任意の Cloud MCP 追加用
- [`../../recipes/ingress-single-workspace/`](../../recipes/ingress-single-workspace/) — インバウンド軸の元レシピ (本レシピの `ingress/` はこれを流用)
- [`../../alternatives/simple-http-proxy/`](../../alternatives/simple-http-proxy/) — Squid + internal ネットワークの SNI 許可リスト単独レシピ
- [`../../alternatives/dependencies-build-time/`](../../alternatives/dependencies-build-time/) — レジストリ隔離 (実行時の外向き通信を経路レベルでゼロにする版、本レシピと組み合わせ可)
- [`../multi-workspace/`](../multi-workspace/) — 並列起動対応版の統合構成
