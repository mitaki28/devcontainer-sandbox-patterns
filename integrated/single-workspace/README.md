# integrated/single-workspace/ — Claude Code 同梱の統合 devcontainer (mcp-proxy + mitm-proxy + git-gateway)

全プロキシを 1 つの compose に統合した構成。設計は docs 側で扱う:

- [docs/10-single-workspace.md](../../docs/10-single-workspace.md)

## 経路

| 経路 | プロキシ | 何が出ていけるか | 隔離される秘匿情報 |
|---|---|---|---|
| MCP (GitHub) | `mcp-github-proxy` | GitHub MCP API のみ | GitHub PAT (MCP 用) |
| MCP (Atlassian) | `mcp-atlassian-proxy` | Atlassian Rovo MCP API のみ | OAuth トークン / DCR client_id |
| MCP (Context7) | `mcp-context7-proxy` | Context7 MCP API のみ | API キー (任意) |
| MCP (GCP) | `mcp-gcloud-proxy` | GCP API のみ (gcloud-mcp 経由) | 1h 寿命の SA アクセストークン |
| mitm-proxy | `mitmproxy` | trusted + 読み取り専用許可 | (デフォルトでは何も注入しない) |
| git-gateway | `git-gateway` | github.com 向け git transport | git transport 用 GitHub PAT |

## 事前準備 (ホスト側)

### 1. 環境変数ファイル

```sh
mkdir -p ~/.config/devsbx

# GitHub MCP 用 PAT
cp ../../lib/mcp-proxy/examples/api-key/.env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env

# git transport 用 PAT + ACL
cp ../../recipes/git-gateway/.env.example ~/.config/devsbx/git-gateway.env
chmod 600 ~/.config/devsbx/git-gateway.env

# mitm-proxy (デフォルトでは何も注入しない)
cp ../../lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env

# 各 env ファイルを編集して値を入れる
```

GitHub PAT は fine-grained PAT でスコープを最小に絞ること。

#### Context7 API キー (任意)

無認証でも動く。レート制限を緩めたい場合のみ:

```sh
echo 'CONTEXT7_API_KEY=ctx7sk-...' > ~/.config/devsbx/mcp-context7.env
chmod 600 ~/.config/devsbx/mcp-context7.env
```

#### Cloud MCP (任意)

GCP を使う場合は追加準備が要る。詳細は [`../../recipes/cloud-mcp-with-short-lived-credential/`](../../recipes/cloud-mcp-with-short-lived-credential/) を参照。

```sh
cp ../../recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める
mkdir -p ~/.cache/devsbx/gcp-mcp
chmod 700 ~/.cache/devsbx/gcp-mcp
../../recipes/cloud-mcp-with-short-lived-credential/refresh-token.sh
```

使わない場合はトークンディレクトリを作らなければ `mcp-gcloud-proxy` だけ起動失敗する (他のサービスに影響なし)。

### 2. Atlassian OAuth トークン用ディレクトリ

```sh
mkdir -p ~/.cache/devsbx/mcp-atlassian
```

### 3. Claude Code config 用ディレクトリ

```sh
mkdir -p ~/.config/devsbx/claude
```

### 4. 初回 OAuth 認可 (Atlassian)

```sh
docker compose up mcp-atlassian-proxy --build
# 標準エラーに出る認可 URL をホストブラウザで開く → 承認 → コールバック → トークン永続化
# 以降は再認可不要
```

## 起動

```sh
docker compose up -d
docker compose exec workspace pnpm install   # 初回のみ (devcontainer 経由なら postCreateCommand で自動)
```

または VS Code / Cursor で `integrated/single-workspace/` を開いて「Reopen in Container」。

## devcontainer 内で確認すること

```sh
# 認証情報が持ち込まれていないこと
env | grep -i pat        # 何も出ないこと
env | grep -i github     # 何も出ないこと
env | grep -i atlassian  # 何も出ないこと
env | grep PROXY         # HTTPS_PROXY=http://mitmproxy:8080 のみ

# git transport が git-gateway 経由で動くこと
git ls-remote https://github.com/anthropics/claude-code.git HEAD

# 読み取り専用な GET は通る、POST は 403
curl -sS -o /dev/null -w "%{http_code}\n" https://api.github.com/zen     # 200
curl -sS -X POST -o /dev/null -w "%{http_code}\n" https://api.github.com/  # 403

# 許可リスト外のホストは 403
curl -sS -o /dev/null -w "%{http_code}\n" https://example.com  # 403

# Claude Code
claude --version
claude login   # 初回のみ
claude         # /mcp で github / atlassian / context7 が認識されること
```

`.claude/settings.json` で組み込み `WebFetch` を deny し、ドキュメント参照は Context7 MCP に集約している。

## ホストブラウザから開発サーバを見る

```sh
# devcontainer 内で 0.0.0.0 で listen させる:
python3 -m http.server 3000
```

```
http://app.localhost:8080/   → workspace:3000
http://api.localhost:8080/   → workspace:4000
```

マッピング追加は `./ingress/Caddyfile` を編集して `docker compose build ingress && docker compose up -d ingress`。

## 依存関係の追加・更新

`pnpm install` / `pnpm add` が動く (GET は mitmproxy の読み取り専用許可で通る)。`pnpm publish` 等は 403。

## 隔離されているもの

| 情報 | host | プロキシ | workspace |
|---|---|---|---|
| GitHub PAT (MCP 用) | `~/.config/.../mcp-github.env` | `mcp-github-proxy` のみ | **無し** |
| GitHub PAT (git transport) | `~/.config/.../git-gateway.env` | `git-gateway` のみ | **無し** |
| Atlassian トークン + client_id | `~/.cache/.../mcp-atlassian/` | `mcp-atlassian-proxy` のみ | **無し** |
| Context7 API キー (任意) | `~/.config/.../mcp-context7.env` | `mcp-context7-proxy` のみ | **無し** |
| GCP 個人 ADC | `~/.config/gcloud/` (host) | **無し** | **無し** |
| GCP SA アクセストークン (1h 寿命) | `~/.cache/.../gcp-mcp/token` | `mcp-gcloud-proxy` のみ | **無し** |
| mitmproxy の CA 秘密鍵 | 名前付きボリューム `mitm-ca` | `mitmproxy` のみ | **無し** |
| Claude Code 認証情報 | `~/.config/devsbx/claude/` | - | バインドマウント |

> `CLAUDE_CONFIG_DIR=/home/node/.claude` を設定して config をバインドマウント内に集約している。未設定だと `~/.claude.json` が毎回失われる。
