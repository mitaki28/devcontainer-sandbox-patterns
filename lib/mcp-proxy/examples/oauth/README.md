# lib/mcp-proxy/examples/oauth/ — OAuth 2.1 + DCR バックエンドの認証情報をプロキシ側に閉じ込める

OAuth 2.1 + DCR (Dynamic Client Registration) を要求する MCP バックエンドに対して、**OAuth のリフレッシュ / アクセストークンと DCR で発行された client_id を devcontainer に持ち込まない** 構成。[`lib/mcp-proxy/`](../../) の `--oauth` 機能でプロキシが DCR + 認可フロー + トークン永続化を肩代わりし、作業コンテナにはバックエンドの OAuth トークンは届かず、プロキシへの接続認証用の Bearer (`PROXY_TOKEN`) だけが共有される。

具体例として **Atlassian Rovo MCP (`https://mcp.atlassian.com/v1/mcp/authv2`)** を用いる。

mcp-proxy の OAuth フロー / コールバック防御 / state 検証は docs / 本体 README で扱う:

- [docs/04-mcp-proxy.md](../../../../docs/04-mcp-proxy.md) — mcp-proxy の章
- [`../../README.md`](../../README.md) — OAuth フローとコールバック防御の実装詳細

## 構成

```
lib/mcp-proxy/examples/oauth/
├── compose.yaml                # proxy + workspace の定義
├── .mcp.json                   # 作業コンテナ内の MCP クライアントが読む (Bearer ${PROXY_TOKEN})
└── .devcontainer/
    └── devcontainer.json

# OAuth で生成されるトークン / client_id / verifier はホスト側に外出し:
${HOME}/.cache/devsbx/mcp-atlassian/
├── tokens.json
├── client.json
└── verifier.txt
```

`tokens` 系ファイルをレシピ外に置くのは [`../../../../recipes/git-gateway/`](../../../../recipes/git-gateway/) と同じ思想で、作業コンテナのバインドマウント (`.:/workspace`) から分離するため。

## 使い方

### 1. ホスト側のディレクトリと PROXY_TOKEN を準備

```sh
mkdir -p ~/.cache/devsbx/mcp-atlassian
mkdir -p ~/.config/devsbx

# プロキシへの接続認証用の Bearer (作業コンテナとプロキシで共有する 1 つの値)
printf 'PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/devsbx/mcp-proxy.env
chmod 600 ~/.config/devsbx/mcp-proxy.env
```

OAuth で永続化されるトークンなどはホストの `~/.cache/.../mcp-atlassian/` に保存する。`compose.yaml` は `create_host_path: false` で bind しているので、未作成だと起動が失敗する。`PROXY_TOKEN` は全 mcp-* プロキシ / 作業コンテナで共有する 1 値 (`lib/mcp-proxy/README.md` 参照)。

### 2. 初回 OAuth 認可

プロキシをフォアグラウンドで起動して認可 URL を確認する。

```sh
docker compose up proxy --build
```

プロキシの標準エラーに認可 URL (`https://auth.atlassian.com/authorize?client_id=...`) が表示されるので、ホストブラウザにコピペ → Atlassian で認可 → ホストブラウザが `http://localhost:3030/callback?code=...` にリダイレクト → port forward 経由でプロキシに届く → プロキシがブラウザに「Authorization complete」HTML を返す → トークンを `~/.cache/devsbx/mcp-atlassian/` に保存して listen 開始。

Ctrl+C で止めて、以降はバックグラウンド起動でよい:

```sh
docker compose up -d proxy
```

ホスト側の永続化ディレクトリからアクセストークン / リフレッシュトークンを読んで即座に listen に入る。アクセストークンが期限切れになると SDK がリフレッシュトークンで自動更新する。

### 3. devcontainer として起動

VS Code / Cursor で `lib/mcp-proxy/examples/oauth/` を開き「Reopen in Container」。`.devcontainer/devcontainer.json` が `compose.yaml` の `workspace` サービスを起動し、`proxy` も `depends_on` で連動起動する (初回認可済みであれば即座に listen)。

devcontainer 内ターミナルでの最低確認:

```sh
env | grep -i atlassian   # 何も出ないこと (Atlassian のアクセス / リフレッシュトークンは作業コンテナに来ない)
env | grep PROXY_TOKEN    # PROXY_TOKEN=... が 1 行出ること (プロキシ接続に必要)
ls /workspace/            # tokens/ が見えないこと (レシピ外に置いているため)

curl -s -X POST \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  http://proxy:8000/mcp
```

`event: message` の中に Atlassian の `serverInfo` が返れば成功。

## 隔離されているもの

| 情報 | host | プロキシコンテナ | 作業コンテナ |
|---|---|---|---|
| Atlassian アカウント認証 | ✓ (ブラウザ経由) | - (認可後のトークンのみ) | **無し** |
| access_token / refresh_token | `~/.cache/.../mcp-atlassian/tokens.json` | `/data` で読む | **無し** |
| DCR で発行された client_id | `~/.cache/.../mcp-atlassian/client.json` | `/data` で読む | **無し** |
| PROXY_TOKEN | `~/.config/.../mcp-proxy.env` | ✓ | ✓ (プロキシ接続に使用) |

バックエンド認証 (Atlassian のアクセス / リフレッシュトークン) は作業コンテナに届かない。プロキシ接続用の `PROXY_TOKEN` は作業コンテナにも渡るが、これはバックエンドの権限を持たない。

## OAuth に固有の挙動・漏れ余地

mcp-proxy 本体の README ([`../../README.md`](../../README.md)) を参照。本レシピ固有の点:

1. **プロキシのホストの localhost ポートは PROXY_TOKEN で保護されている**: `127.0.0.1:8810` および `127.0.0.1:3030` にホスト上の他プロセスから到達可能 (外部ネットワークからは届かない)。8810 は Bearer 認証必須なのでトークンを知らない他プロセスは弾かれる。3030 は OAuth コールバック (`?code=...` を受ける、トークンなし) だが、`lib/mcp-proxy/README.md`「OAuth フローとコールバック防御」節で state 検証 + `--callback-timeout` (デフォルト 5 分) により偽 code/error インジェクションは静かに弾かれ、認可破壊 DoS には至らない
2. **コールバックポート (3030) は初回認可時のみ必要**: 認可後はこのポートを使わないが、簡素化のため常時公開している
3. **リフレッシュトークンがサーバ側で失効された場合の挙動**: プロキシ起動時に `auth()` が `invalid_grant` で失敗 → `invalidateCredentials("all")` で永続化ディレクトリの内容を破棄 → 新規 DCR + 認可フォールバック。つまり「Atlassian 側で連携を削除した時」は次回起動時に再認可が必要
4. **ホスト側 `~/.cache/devsbx/mcp-atlassian/` は手動管理**: レシピを別マシンに持っていく際は手動で再認可が必要 (キャッシュを共有すべきものでもない)

## 関連

- [`../../`](../../) — mcp-proxy 本体 (OAuth フロー / コールバック防御 / state 検証の実装詳細)
- [`../api-key/`](../api-key/) — API キー (PAT) バックエンドの対応版
