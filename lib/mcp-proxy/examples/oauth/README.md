# lib/mcp-proxy/examples/oauth/ — OAuth 2.1 + DCR 認証 MCP の利用例 (Atlassian Rovo MCP)

OAuth 2.1 + DCR 認証の MCP バックエンドをプロキシ経由で使う構成例。プロキシが認可フロー + トークン永続化を行い、作業コンテナには OAuth トークンが渡らない。具体例として Atlassian Rovo MCP を用いる。

## 使い方

### 1. ホスト側のディレクトリを準備

```sh
mkdir -p ~/.cache/devsbx/mcp-atlassian
```

トークンはホストの `~/.cache/devsbx/mcp-atlassian/` に保存される。未作成だと起動失敗する。

### 2. 初回 OAuth 認可

```sh
docker compose up proxy --build
# 標準エラーに出る認可 URL をホストブラウザで開く → 承認 → コールバック → トークン永続化
# 以降は再認可不要
```

完了したら Ctrl+C で止め、以降は `docker compose up -d proxy` でよい。

### 3. devcontainer として起動

VS Code / Cursor で開いて「Reopen in Container」。

```sh
env | grep -i atlassian   # 何も出ないこと
```

## 隔離されているもの

| 情報 | host | プロキシ | 作業コンテナ |
|---|---|---|---|
| Atlassian トークン + client_id | `~/.cache/.../mcp-atlassian/` | ✓ | **無し** |
