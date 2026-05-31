# lib/mcp-proxy/ — MCP プロキシ

1 つのバックエンド MCP (stdio or streamable-HTTP) を中継する streamable-HTTP プロキシ。認証情報をプロキシ側に保持し、作業コンテナに渡さない。recipes/ から再利用される基本コンポーネント。実装は TypeScript + Node + `@modelcontextprotocol/sdk`。

## 利用例 (examples/)

- [`examples/api-key/`](./examples/api-key/) — API キー (Bearer) 認証 (具体例: GitHub MCP)
- [`examples/oauth/`](./examples/oauth/) — OAuth 2.1 + DCR 認証 (具体例: Atlassian Rovo MCP)

## 動作確認 (smoke test)

モックで完結する 7 系統の smoke を用意している。

| 系統 | 検証内容 | コマンド |
|---|---|---|
| stdio | stdio バックエンドの中継 | `docker compose run --rm --build smoke` |
| bearer | Bearer 認証付き HTTP バックエンドの中継 | `docker compose run --rm --build bearer-smoke` |
| oauth | OAuth 2.1 + DCR バックエンドの中継 (認可 URL 自動追従の E2E) | `docker compose run --rm --build oauth-smoke` |
| oauth (dedup) | 同上 + `--oauth-refresh-dedup` 有効 | `docker compose run --rm --build oauth-smoke-dedup` |
| filter | `--deny-tool` による `tools/list` 絞り込み + `tools/call` 拒否 | `docker compose run --rm --build filter-smoke` |
| provoke | server-initiated notification + request の双方向中継 | `docker compose run --rm --build provoke-smoke` |
| sweep | `--session-idle-timeout` によるアイドルセッション解放 | `docker compose run --rm --build sweep-smoke` |

全 smoke を順に回すには `bash scripts/smoke-all.sh`。単体テストは `node --test test/unit/*.test.ts` (docker 不要)。

手動デバッグ用ポート:

| サービス | ホストポート | 用途 |
|---|---|---|
| `proxy` | `127.0.0.1:8800:8000` | プロキシへの手動 curl |
| `oauth-mock` | `127.0.0.1:3000:3000` | ブラウザから OAuth フローを手動で試す |

## ランタイム

`node:22-slim` (digest pin) ベース、非 root (node, uid 1000) で実行。OAuth 構成でトークンストアをバインドマウントする場合、host 側ディレクトリの所有 uid が 1000 と一致しないと書き込めないので、compose 側で `user:` を上書きする。

## CLI オプション

```
--listen <host:port>          listen アドレス (デフォルト 0.0.0.0:8000、env PROXY_LISTEN)
-t http | stdio               バックエンド transport (デフォルト stdio)
-H "<header>"                 バックエンドに注入する HTTP ヘッダ (繰り返し可)

--oauth                       OAuth 2.1 フローを駆動 (HTTP バックエンドのみ)
--callback-listen <host:port> コールバックリスナーの bind (デフォルト 127.0.0.1:3030、
                              env PROXY_CALLBACK_LISTEN)
--callback-url <URL>          DCR redirect_uri に登録する URL
--callback-timeout <ms>       コールバック待ち上限 (デフォルト 300000 = 5 分、
                              env PROXY_CALLBACK_TIMEOUT)
--token-store <dir>           トークン保存先 (デフォルト /data)
--scope <scope>               OAuth スコープ (DCR で渡す)
--oauth-refresh-dedup         [実験的] refresh_token grant の同時発火を集約
                              (env PROXY_OAUTH_REFRESH_DEDUP=1)

--allow-tool <pattern>        許可するツール名 (繰り返し可、glob `*` 対応)
--deny-tool  <pattern>        拒否するツール名 (繰り返し可、deny が allow より優先)
                              env PROXY_ALLOW_TOOLS / PROXY_DENY_TOOLS でカンマ区切り指定可

--session-idle-timeout <ms>   アイドルセッションの sweep 閾値 (デフォルト 1 時間、0 で無効、
                              env PROXY_SESSION_IDLE_TIMEOUT)

--pass-env <KEY>              プロキシの env からバックエンドに継承する KEY (繰り返し可)
--env KEY=VALUE               値を直接指定してバックエンドに渡す (最優先)
```

stdio バックエンドにはプロキシの環境変数を丸ごと渡さない (秘匿情報の漏洩を防ぐため)。`--pass-env` / `--env` で明示した変数だけがバックエンドに届く。

位置引数: `<name> -- <command...>` (stdio) または `<name> <url>` (HTTP)。

`--oauth-refresh-dedup` はリフレッシュトークンをローテーションするプロバイダ (Atlassian, Google 等) で必要になる。複数セッションが同時にリフレッシュすると 1 回目だけ成功し 2 回目以降が `invalid_grant` で全セッションが認可前状態に戻る ([typescript-sdk#1760](https://github.com/modelcontextprotocol/typescript-sdk/issues/1760))。このフラグで refresh_token grant を 1 つの HTTP リクエストに集約する。

## ツール ACL: allow vs deny

**deny** — 影響度の高い操作だけ塞ぐ:

```sh
mcp-proxy \
  -t http -H "Authorization: Bearer $GITHUB_PAT" \
  --deny-tool 'delete_*' --deny-tool 'merge_*' --deny-tool 'push_*' \
  github https://api.githubcopilot.com/mcp/
```

**allow** — 列挙したものだけ通す (upstream でツールが増えても自動で許可されない):

```sh
mcp-proxy \
  -t http -H "Authorization: Bearer $GITHUB_PAT" \
  --allow-tool 'list_*' --allow-tool 'get_*' --allow-tool 'search_*' \
  --allow-tool '*_read' \
  github https://api.githubcopilot.com/mcp/
```

## OAuth バックエンドを手動で立ち上げる

```sh
mkdir -p ~/.cache/devsbx/mcp-proxy
docker run --rm \
  -p 127.0.0.1:8810:8000 \
  -p 127.0.0.1:3030:3030 \
  -v ~/.cache/devsbx/mcp-proxy:/data \
  mcp-proxy:dev \
  -t http --oauth \
  --callback-listen 0.0.0.0:3030 \
  --token-store /data \
  atlassian https://mcp.atlassian.com/v1/mcp/authv2
```

標準エラーに認可 URL が出るのでホストブラウザで開く → 認可 → コールバック → トークン保存 → listen 開始。2 回目以降は保存済みトークンで即起動する。

## 既知の挙動

- 1 セッション = 1 バックエンドインスタンス。複数クライアントから同時接続するとバックエンドもその数だけ起動する
- クライアントが DELETE を送らず消えた場合はアイドル sweep で解放される (`--session-idle-timeout`)
