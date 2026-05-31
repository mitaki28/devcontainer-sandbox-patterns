# lib/mcp-proxy/examples/api-key/ — API キー認証 MCP の利用例 (GitHub MCP)

API キー (`Authorization: Bearer`) 認証の MCP バックエンドをプロキシ経由で使う構成例。具体例として GitHub MCP を用いる。

## 使い方

### 1. PAT を設定

```sh
mkdir -p ~/.config/devsbx
cp .env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env
# 中身を編集して GITHUB_PAT に PAT を入れる
```

fine-grained PAT でスコープを最小に絞ること。

### 2. smoke で疎通確認

```sh
docker compose run --rm --build smoke
```

3 ケース (サーバ識別 / `tools/list` / deny フィルタ) を通す。実 GitHub PAT が要る。

### 3. devcontainer として起動

VS Code / Cursor で開いて「Reopen in Container」。

```sh
env | grep -i pat       # 何も出ないこと
env | grep -i github    # 何も出ないこと
```

## deny フィルタ

`compose.yaml` で以下の deny を設定している:

```
--deny-tool 'delete_*'
--deny-tool 'merge_*'
--deny-tool 'push_*'
```

deny されたツールは `tools/list` からも消える。

## 隔離されているもの

| 情報 | host | プロキシ | 作業コンテナ |
|---|---|---|---|
| GitHub PAT | `~/.config/.../mcp-github.env` | ✓ | **無し** |
