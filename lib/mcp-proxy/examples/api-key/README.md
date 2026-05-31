# lib/mcp-proxy/examples/api-key/ — 事前発行の API キー認証 MCP の認証情報をプロキシ側に閉じ込める

事前発行された API キーを `Authorization: Bearer <key>` で送る MCP バックエンドに対して、**API キーを devcontainer に持ち込まない** 構成。[`lib/mcp-proxy/`](../../) の設計テンプレに従い、プロキシがキーを保持してバックエンドに注入し、作業コンテナにはバックエンドの API キーは渡らず、プロキシへの接続認証用の Bearer (`PROXY_TOKEN`) だけが共有される (未設定で起動拒否する安全側設計 + 多層防御)。

具体例として **GitHub MCP (`https://api.githubcopilot.com/mcp/`、PAT 認証)** を用いるが、同じテンプレで Context7 (API キー任意) 等の他の API キー認証バックエンドにもそのまま適用できる。

mcp-proxy の設計思想 / 認証パターン全般 / 評価軸との対応は docs 章で扱う:

- [docs/04-mcp-proxy.md](../../../../docs/04-mcp-proxy.md) — mcp-proxy の章 (本例は 4.3「ツール ACL の使いどころ: allow vs deny」で引用)

## 構成

```
lib/mcp-proxy/examples/api-key/
├── compose.yaml                # proxy + smoke + workspace の定義
├── .env.example                # 配置先と中身のテンプレート
├── .mcp.json                   # 作業コンテナ内の MCP クライアントが読む
├── .devcontainer/
│   └── devcontainer.json
└── test/
    └── github-smoke.test.ts    # プロキシ経由の GitHub MCP の疎通確認
```

実値を入れた env ファイルはレシピディレクトリ外 (`~/.config/devsbx/mcp-github.env`) に配置する。`compose.yaml` の `env_file` がこの絶対パスを直接参照する。作業コンテナのバインドマウント (`.:/workspace`) からは分離される。

`compose.yaml` の `proxy` サービスは [`lib/mcp-proxy/Dockerfile.binary`](../../Dockerfile.binary) を `build.context: ../../../lib/mcp-proxy` で参照し、`mcp-proxy:bin` として立ち上がる。

## 使い方

### 1. PAT と PROXY_TOKEN を設定

```sh
mkdir -p ~/.config/devsbx
# GitHub PAT (バックエンド用)
cp .env.example ~/.config/devsbx/mcp-github.env
chmod 600 ~/.config/devsbx/mcp-github.env
# 中身を編集して GITHUB_PAT に PAT を入れる

# プロキシへの接続認証用の Bearer (作業コンテナとプロキシで共有する 1 つの値)
printf 'PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/devsbx/mcp-proxy.env
chmod 600 ~/.config/devsbx/mcp-proxy.env
```

GitHub PAT は **このリポジトリ専用** の fine-grained PAT を強く推奨。最小スコープは `Repository access: This repository only` + `Permissions: Metadata Read-only`。

`PROXY_TOKEN` は全 mcp-* プロキシと作業コンテナで同じ 1 値を共有する設計 (レシピレベルで安全側に倒す設計、`lib/mcp-proxy/README.md` 参照)。

### 2. smoke で疎通確認

```sh
docker compose run --rm --build smoke
```

`test/github-smoke.test.ts` が 3 ケース (サーバが github として識別される / `tools/list` が非空の GitHub ツール群を返す / プロキシ側の拒否フィルタが `delete_*` / `merge_*` / `push_*` を除外している) を通す。実 GitHub PAT が要る (tools/call は実 API を叩くため smoke では呼ばない)。

### 3. devcontainer として起動

VS Code / Cursor で `lib/mcp-proxy/examples/api-key/` を開き「Reopen in Container」。`.devcontainer/devcontainer.json` が `compose.yaml` の `workspace` サービスを起動し、`proxy` も `depends_on` で連動起動する。

作業コンテナ内で起動した MCP クライアントは `.mcp.json` を読み、`http://proxy:8000/mcp` を通常の HTTP MCP として認識する。`.mcp.json` の `headers` で `${PROXY_TOKEN}` を作業コンテナの環境変数から展開し、`Authorization: Bearer ...` でプロキシに渡す。クライアントから見ると GitHub MCP の存在は完全にプロキシの背後に隠れる。

devcontainer 内ターミナルでの最低確認:

```sh
env | grep -i pat       # 何も出ないこと (GitHub PAT は作業コンテナに来ない)
env | grep -i github    # 何も出ないこと
env | grep PROXY_TOKEN  # PROXY_TOKEN=... が 1 行出ること (プロキシ接続に必要)

curl -s -X POST \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  http://proxy:8000/mcp
```

`event: message` の中に `"serverInfo":{"name":"github",...}` が返れば成功。

## 破壊的操作を拒否する safe-write プロファイル

`compose.yaml` のプロキシのコマンドで **mcp-proxy 側にツール名フィルタ** を効かせている:

```
--deny-tool 'delete_*'   # delete_file / delete_pending_pull_request_review / delete_workflow_run_logs
--deny-tool 'merge_*'    # merge_pull_request
--deny-tool 'push_*'     # push_files
```

意図:

- 作業コンテナに居るエージェントが誤ってリポジトリに破壊的操作を行う経路をプロキシ層で断つ (PAT スコープだけに頼らない多層防御)
- 副次効果として `tools/list` の応答からこれらが消えるので、LLM のコンテキストにも乗らない

「create / update / comment 系」はあえて残している。issue 整理・PR レビュー・ファイル編集のような実用シナリオを潰さないため。完全に読み取り専用にしたい場合は `--deny-tool 'create_*' --deny-tool 'update_*' --deny-tool 'add_*'` 等を足すか、`--allow-tool 'list_*' --allow-tool 'get_*' --allow-tool 'search_*'` の許可リスト形に切り替える (allow パターンの方が新ツール追加時の暗黙の解禁を防げる)。

> **注意: GitHub MCP のツール名は upstream で増減する。** 新しい破壊的操作系 (例: 仮想の `force_*` / `reset_*`) が追加された場合、現フィルタは気づかないまま通してしまう。`test/github-smoke.test.ts` の `destructive tools are filtered out by proxy` ケースで「現状の deny の接頭辞が実リストと整合しているか」を smoke 上で監視している。upstream を追って接頭辞を増減させる前提で運用する。

## 隔離されているもの

| 情報 | host | プロキシ | 作業コンテナ |
|---|---|---|---|
| GitHub PAT | `~/.config/.../mcp-github.env` | ✓ | **無し** |
| PROXY_TOKEN | `~/.config/.../mcp-proxy.env` | ✓ | ✓ (プロキシ接続に使用) |

バックエンド認証 (GitHub PAT) は作業コンテナに届かない。プロキシ接続用の `PROXY_TOKEN` は作業コンテナにも渡るが、これはバックエンドの権限を持たない。作業コンテナが侵害されても攻撃者がプロキシ経由で行えるのは PAT スコープ内の GitHub 操作だけで、PAT そのものを盗み出すことはできない。

## このレシピ固有の漏れ余地

mcp-proxy 本体の README ([`../../README.md`](../../README.md)) を参照。本レシピに固有の点:

1. **PAT 範囲が広いとプロキシ経由で全部使える**: 作業コンテナに居られる攻撃者は PAT スコープ内の任意 GitHub 操作が可能。緩和策: PAT を「該当リポジトリのみ + Metadata Read-only」等に絞る
2. **プロキシのホストの localhost ポートは PROXY_TOKEN で保護されている**: `127.0.0.1:8810` にホスト上の他プロセスから到達可能 (外部ネットワークからは届かない)。Bearer 認証必須なのでトークンを知らない他プロセスは弾かれる。必要なら `compose.yaml` の `ports:` を消す (手動 curl デバッグはできなくなる)
3. **プロキシと GitHub MCP 間は HTTPS のみ**: GitHub 側の証明書検証で MITM は防げるが、プロキシのホスト OS が侵害された場合は突破される

## 関連

- [`../../`](../../) — mcp-proxy 本体
- [`../oauth/`](../oauth/) — OAuth 認証バックエンドの対応版
