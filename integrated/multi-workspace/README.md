# integrated/multi-workspace/ — 並列起動対応の統合構成 (shared-infra + per-task workspace)

`integrated/single-workspace/` の並列起動対応版。プロキシ群を shared-infra として 1 度だけ常駐起動し、タスクごとの作業コンテナを別 compose プロジェクトとして並列に起動する。single-workspace と同じホストポート (`127.0.0.1:8080` / `127.0.0.1:3030`) を使うため **同時起動は不可**。

設計は docs 側で扱う:

- [docs/11-multi-workspace.md](../../docs/11-multi-workspace.md)

## task 規約

- **task 名 = compose プロジェクト名 = サブドメイン**: `docker compose -p <task> up -d` → `<task>.devsbx.localhost:8080`
- **命名制約**: 小文字英数字 + ハイフン (`_` 不可、サブドメイン RFC 1123 制約)
- **workspace イメージ**: `integrated/single-workspace/Dockerfile` と同内容
- **各 mcp-* プロキシは task を区別しない**: 全作業コンテナが同じトークン / PAT を共有

## 利用フロー

### 1. 事前準備 (ホスト側、初回のみ)

```sh
mkdir -p ~/.config/devsbx \
         ~/.config/devsbx/claude \
         ~/.cache/devsbx/mcp-atlassian

# GitHub MCP 用 PAT
cp ../../lib/mcp-proxy/examples/api-key/.env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env

# git transport 用 PAT + ALLOWED_REPOS
cat > ~/.config/devsbx/git-gateway.env <<'EOF'
GITHUB_PAT=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALLOWED_REPOS=myorg/myrepo
ALLOWED_REF_PATTERNS=refs/heads/feature/*,refs/heads/claude/*
DENIED_REF_PATTERNS=refs/heads/main,refs/heads/master,refs/tags/*
EOF
chmod 600 ~/.config/devsbx/git-gateway.env

# mitm-proxy (デフォルトでは何も注入しない)
cp ../../lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env

# Context7 API キー (任意、無認証でも動く)
echo 'CONTEXT7_API_KEY=ctx7sk-...' > ~/.config/devsbx/mcp-context7.env
chmod 600 ~/.config/devsbx/mcp-context7.env

# Cloud MCP (任意): 詳細は ../../recipes/cloud-mcp-with-short-lived-credential/README.md
cp ../../recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める
mkdir -p ~/.cache/devsbx/gcp-mcp
chmod 700 ~/.cache/devsbx/gcp-mcp
../../recipes/cloud-mcp-with-short-lived-credential/refresh-token.sh

chmod 700 ~/.cache/devsbx/mcp-atlassian
```

#### GitHub PAT スコープの最小化

PAT のスコープがそのまま事故時の影響範囲になる。fine-grained PAT で最小に絞ること。

**GitHub MCP 用 PAT (`mcp-github.env`)** — 本レシピは `--allow-tool` で読み取り専用に絞っているので、PAT も読み取り専用で足りる:

- Repository access: 対象リポジトリのみ
- Metadata: **Read**、Contents: **Read**、Issues / Pull requests: **Read** (必要な場合)

**git transport 用 PAT (`git-gateway.env`)** — push に使うため write が要る:

- Repository access: `ALLOWED_REPOS` で許可したリポジトリのみ
- Metadata: **Read**、Contents: **Read and write**

ref / branch 単位の制限は `ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS` で絞れる。

**Atlassian OAuth スコープ** — `read:*` 系のみで済む用途であれば書き込み系スコープを承認しない。

### 2. 既存の single-workspace を down

```sh
cd integrated/single-workspace && docker compose down
```

### 3. shared-infra を常駐起動 (1 度だけ)

```sh
cd integrated/multi-workspace/shared-infra
docker compose -p devsbx-infra up -d --build
```

### 4. 初回 OAuth 認可 (Atlassian)

```sh
docker compose -p devsbx-infra logs --follow mcp-atlassian-proxy
# 標準エラーに出る認可 URL をホストブラウザで開く → 承認 → コールバック → トークン永続化
# 以降は再認可不要
```

### 5. per-task workspace を起動

```sh
cd ../    # back to integrated/multi-workspace/
docker compose -p task-auth up -d --build
docker compose -p task-search up -d
docker compose -p task-docs up -d
```

### 6. ホストブラウザで開発サーバ確認

```sh
docker compose -p task-auth exec workspace pnpm dev --host 0.0.0.0 --port 3000

# http://task-auth.devsbx.localhost:8080/     → task-auth の :3000
# http://api.task-auth.devsbx.localhost:8080/ → task-auth の :4000
```

### 7. devcontainer として起動

VS Code / Cursor で各タスクのディレクトリを開いて「Reopen in Container」。compose プロジェクト名は IDE の workspace folder basename から決まるため、ディレクトリ名はサブドメイン制約 (小文字英数字 + ハイフン) に従う必要がある。

### 8. クリーンアップ

```sh
docker compose -p task-auth down
docker compose -p task-search down
docker compose -p task-docs down

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
| GCP 個人 ADC (任意) | `~/.config/gcloud/` (host) | **無し** | **無し** |
| GCP SA アクセストークン (1h 寿命、任意) | `~/.cache/.../gcp-mcp/token` | `mcp-gcloud-proxy` のみ | **無し** |
| mitmproxy の CA 秘密鍵 | 名前付きボリューム `mitm-ca` | `mitmproxy` のみ | **無し** |
| Claude Code 認証情報 | `~/.config/.../claude/` | - | 全 task で共有 |
