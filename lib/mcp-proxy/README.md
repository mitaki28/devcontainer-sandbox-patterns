# lib/mcp-proxy/ — MCP プロキシ

devcontainer から MCP の認証情報をバインドマウントから切り離すため、1 つのバックエンド MCP を中継するプロキシ。クライアント (Claude Code 等) からは streamable-HTTP MCP として見え、背後で 1 つのバックエンド MCP (stdio もしくは streamable-HTTP) を起動して中継する。

[`lib/mitm-proxy/`](../mitm-proxy/) と対になる「2 軸構成のもう片方」で、recipes/ から build context 経由で再利用される基本コンポーネント。実装は TypeScript + Node + `@modelcontextprotocol/sdk`。

## 利用例 (examples/)

mcp-proxy を 1 つの MCP バックエンドに被せる典型パターンを `examples/` に置いてある:

- [`examples/api-key/`](./examples/api-key/) — 事前発行の API キー (Bearer) 認証のバックエンドをプロキシ経由で隔離 (具体例: GitHub MCP)
- [`examples/oauth/`](./examples/oauth/) — OAuth 2.1 + DCR 認証のバックエンドをプロキシ経由で隔離 (具体例: Atlassian Rovo MCP)

いずれも build context として `lib/mcp-proxy/` (= `../..`) を取り、本 lib の `Dockerfile` (`node:22-slim` ベース) からプロキシ image を build する。env_file の置き場・`.mcp.json` 形式等のレシピレベルの整合は両 example の README を参照。

## 動作確認 (smoke test)

`compose.yaml` に 7 系統の smoke を用意している。いずれも実バックエンドに依存せず、リポジトリ内のモックだけで完結する。

| 系統 | 検証内容 | コマンド |
|---|---|---|
| stdio | echo MCP (stdio) をプロキシで中継 | `docker compose run --rm --build smoke` |
| bearer | Bearer 認証付き HTTP バックエンドをプロキシで中継 (mock = `test/mocks/bearer-mock.ts`) | `docker compose run --rm --build bearer-smoke` |
| oauth | OAuth 2.1 + DCR バックエンドを `--oauth` で中継 (mock = `test/mocks/oauth-mock.ts`、テストハーネス が認可 URL を自動追従) | `docker compose run --rm --build oauth-smoke` |
| oauth (dedup) | 同上 + `--oauth-refresh-dedup` を有効にして OAuth フロー / tools/list / tools/call が壊れないことを確認 | `docker compose run --rm --build oauth-smoke-dedup` |
| filter | `--deny-tool` 付きで複数ツールを持つバックエンドを叩き、`tools/list` 絞り込み + `tools/call` 拒否 (-32601) を確認 | `docker compose run --rm --build filter-smoke` |
| provoke | server-initiated notification + request を投げるバックエンド (`test/smoke/provoke/provoke-mcp.ts`) で、`sampling/createMessage` がフロント (クライアント) のハンドラで処理されて応答が tool result に戻ること + `tools/list_changed` がクライアントの notification ハンドラに届くことを確認 | `docker compose run --rm --build provoke-smoke` |
| sweep | `--session-idle-timeout 2000` 付きで起動し、アイドル経過後に同 session id への POST が 404 を返すこと (セッションが解放されていること) を確認 | `docker compose run --rm --build sweep-smoke` |

stdio / bearer は SDK Client で 4 ケース (401 / 404 / `tools/list` / `tools/call`)。oauth は テストハーネス がプロキシを子プロセスで起動 → 認可 URL を fetch 追従 → コールバック完了 → `tools/list` + `tools/call` を検証する E2E。

各 smoke の compose 定義は `test/smoke/<name>/compose.yaml` に分離し、ルートの `compose.yaml` が include で集約する。全 smoke を順に回すには `bash scripts/smoke-all.sh` (pass/fail サマリを最後に出力)。

`test/unit/` 配下は docker 不要の単体テストで、`node --test test/unit/*.test.ts` で回せる (フィルタ / oauth プロバイダ / コールバック / 起動引数 / env 受け渡しなど)。

手動デバッグ用に compose は次のサービスをポート公開している:

| サービス | ホストポート | 用途 |
|---|---|---|
| `proxy` | `127.0.0.1:8800:8000` | プロキシへの手動 curl |
| `oauth-mock` | `127.0.0.1:3000:3000` | ブラウザから OAuth フローを手動で試す |

## ランタイムと配布

`Dockerfile` は `node:22-slim` (digest pin) をベースに `pnpm install --frozen-lockfile` で本体依存を導入し、`node src/index.ts` を ENTRYPOINT にする。非 root ユーザ (node, uid 1000) で実行する。トークンストアをバインドマウントする OAuth 構成では、host 側ディレクトリの所有 uid が 1000 と一致しない環境では書き込めないので、レシピの compose 側で `user:` を上書きする。

`pnpm-workspace.yaml` に `minimumReleaseAge: 10080` (= 7 日) と `blockExoticSubdeps: true` を設定し、サプライチェーン経由で新しいバージョンが install されるまでに猶予を作り、git: / file: 等の registry 外経路を塞ぐ。

## CLI オプション

```
--listen <host:port>          listen アドレス (デフォルト 0.0.0.0:8000、env PROXY_LISTEN)
--token <value>               (必須) プロキシへの接続認証用の Bearer トークン (env
                              PROXY_TOKEN でも可)。未指定で起動拒否 (安全側に倒す)
-t http | stdio               バックエンド transport (デフォルト stdio)
-H "<header>"                 バックエンドに注入する HTTP ヘッダ (繰り返し可)

--oauth                       バックエンドに OAuth 2.1 フローを駆動 (HTTP バックエンドのみ)
--callback-listen <host:port> 内部のコールバックリスナーの bind 範囲 (デフォルト
                              127.0.0.1:3030、env PROXY_CALLBACK_LISTEN)。リバース
                              プロキシを前段に置く等コールバックをループバックの外で
                              受ける構成では 0.0.0.0:3030 等を明示的に指定する。
                              リスナーパスは `/callback` 固定で、`--callback-url` の
                              host:port とは独立に扱う
--callback-url <URL>          DCR redirect_uri に登録する完全 URL (告知専用)。リスナー
                              パスは URL に関わらず `/callback` 固定なので、リバース
                              プロキシ前段の構成では公開パス → `/callback` の rewrite を
                              リバースプロキシ側で書く
--callback-timeout <ms>       コールバックを待つ上限 (デフォルト 300000 = 5 分、env
                              PROXY_CALLBACK_TIMEOUT)
--token-store <dir>           トークン / client / verifier の保存先 (デフォルト /data)
--scope <scope>               OAuth スコープ (DCR で渡す)
--oauth-refresh-dedup         [実験的] 同時発火した refresh_token grant をプロキシ全体で
                              1 本の HTTP request に集約 (`--oauth` 必須、env
                              PROXY_OAUTH_REFRESH_DEDUP=1)

--allow-tool <pattern>        許可するツール名のパターン (繰り返し可、glob `*` 対応)
--deny-tool  <pattern>        拒否するツール名のパターン (繰り返し可、deny が allow より優先)
                              env PROXY_ALLOW_TOOLS / PROXY_DENY_TOOLS でカンマ区切り指定可

--session-idle-timeout <ms>   アイドルセッションを sweep する閾値 (デフォルト 3600000 =
                              1 時間、env PROXY_SESSION_IDLE_TIMEOUT)。0 で sweep を無効化。
                              処理中のリクエストを持つセッションは対象外。

--pass-env <KEY>              プロキシの env からバックエンドに継承する KEY (繰り返し可)
--env KEY=VALUE               値を直接指定してバックエンドに渡す (最優先)
```

末尾の位置引数: `<name> -- <command...>` (stdio バックエンド) または `<name> <url>` (HTTP バックエンド)。

## ツール ACL の使い分け: allow vs deny

`--deny-tool` (拒否リスト) と `--allow-tool` (許可リスト) のどちらを使うかで安全特性が変わる。

**deny パターン** — 「これを deny する」を列挙する。書きやすく、create / update / comment のような実用ツールを残しつつ影響度の高い操作だけ塞ぐ用途に向く。例: GitHub MCP の影響度の高い操作を deny する `lib/mcp-proxy/examples/api-key/`:

```sh
mcp-proxy --token "$PROXY_TOKEN" \
  -t http -H "Authorization: Bearer $GITHUB_PAT" \
  --deny-tool 'delete_*' --deny-tool 'merge_*' --deny-tool 'push_*' \
  github https://api.githubcopilot.com/mcp/
```

**allow パターン** — 「これだけ通す」を列挙する。upstream でツールが増えても自動的には許可されないため、**意図しないタイミングで新しい操作が許可されるリスクを構造的に防げる**。`integrated/multi-workspace/` は事故防止の観点でこちらに切り替えてある:

```sh
mcp-proxy --token "$PROXY_TOKEN" \
  -t http -H "Authorization: Bearer $GITHUB_PAT" \
  --allow-tool 'list_*' --allow-tool 'get_*' --allow-tool 'search_*' \
  --allow-tool '*_read' \
  github https://api.githubcopilot.com/mcp/
```

**使い分けの注意**: deny パターンはバックエンド MCP 側でツール名が増減した場合に、**新しい影響度の高いツール (例: 仮想の `force_*`) が気づかれずに通ってしまう** リスクがある。deny を採用する場合は smoke test 等で「deny の接頭辞が実 `tools/list` の出力と整合しているか」を継続監視する運用とセットになる。allow パターンはこの監視負荷が無い代わりに、新規ツールが即座には使えない (allow リストへの追加が要る) トレードオフがある。

## OAuth バックエンドを手動で立ち上げる

モックを使わない実バックエンド (Atlassian Rovo MCP 等) で認可フローを通す手順:

```sh
mkdir -p ~/.cache/devsbx/mcp-proxy
docker run --rm \
  -p 127.0.0.1:8810:8000 \
  -p 127.0.0.1:3030:3030 \
  -v ~/.cache/devsbx/mcp-proxy:/data \
  mcp-proxy:dev \
  --token "test-proxy-token" \
  -t http --oauth \
  --callback-listen 0.0.0.0:3030 \
  --token-store /data \
  atlassian https://mcp.atlassian.com/v1/mcp/authv2
```

初回起動の流れ: プロキシの標準エラーに認可 URL が出るのでホストブラウザで開く → 認可 → `http://localhost:3030/callback?code=...` にリダイレクト → プロキシが `Authorization complete.` HTML を返す → トークンエンドポイントで交換 → `~/.cache/devsbx/mcp-proxy/<name>/{tokens.json, client.json, verifier.txt}` に保存 → バックエンド接続成功で listen 開始。

2 回目以降は永続化されたトークンを読み込んで即 listen 開始する (コールバックポートは不要)。アクセストークンが期限切れになると SDK がリフレッシュトークンで自動更新する。

## 実装詳細

### プロキシへの接続認証 (Bearer、未指定で起動拒否)

`--token <value>` または env `PROXY_TOKEN` のどちらも未指定ならプロキシは起動拒否で exit する。レシピ側の設定ミスで認証なしの中継状態になるのを防ぐためで、ここを素通しさせない。比較は `crypto.timingSafeEqual` で定数時間。クライアントは `Authorization: Bearer <value>` ヘッダで投げる。

レシピレベルでは `~/.config/devsbx/mcp-proxy.env` に `PROXY_TOKEN=...` 1 行を置き、`env_file` でプロキシ + 作業コンテナ (`.mcp.json` の `headers.Authorization` から `${PROXY_TOKEN}` 展開) の両方に同じ値を渡す。`.env.example` がテンプレ。

### バックエンド中継の transport 構造

`StreamableHTTPServerTransport` を stateful モード (`sessionIdGenerator: () => crypto.randomUUID()`) で使い、**1 クライアントセッションにつき 1 バックエンドインスタンス** を起動する。セッションマップは `Map<sessionId, { front, backend, ... }>` で保持し、受信 HTTP リクエストは `mcp-session-id` ヘッダで lookup して既存 transport の `handleRequest` にディスパッチする。

セッションのライフサイクル:

- **新規 POST initialize**: SDK の `onsessioninitialized` コールバックで `startBackend(args)` を呼んでバックエンドを 1 つ起動 → フロントと双方向に紐付けてセッションマップに登録
- **以降の POST/GET/DELETE**: 同じフロント transport の `handleRequest` で処理 (GET は SDK が standalone SSE channel を張る)
- **セッション終了**: 次の 3 経路を `closeSession()` ヘルパに集約し、`closing` フラグでガードして二重実行を防ぐ
  - `onsessionclosed` (= 正規の DELETE 受信)
  - アイドル sweep (`--session-idle-timeout` を超えて inactive なセッションを `setInterval` で close)
  - `backend.onclose` (= バックエンドがクラッシュした場合)
- **不在セッションへのリクエスト**: sweep 後 / プロキシ再起動後に古い session id 付きで POST されたら、プロキシは spec の `MUST return 404` に従って `{ jsonrpc, error: { code: -32001, ... } }` を 404 で返す。クライアントは新規 initialize に進める

アイドル sweep の判定は `lastActivity < cutoff && inFlightCount === 0` の二段で、進行中のツール実行を巻き込まないようにする。`lastActivity` は HTTP リクエスト到達時 (GET / DELETE 含む) とフロント / バックエンドの `onmessage` で更新する。

バックエンド → フロントのメッセージは次の 3 系統:

- **クライアントリクエストのレスポンス**: `front.send(msg, { relatedRequestId: id })` で SDK が正しい SSE stream に乗せる。`tools/list` の応答はフィルタを適用
- **server-initiated request** (`sampling/createMessage` 等): バックエンドが出した id をプロキシ内独自の文字列 id (`__proxy_si_<n>__`) に張り替えてフロントに流す。クライアントが返してきたレスポンスの id を逆引きして元 id でバックエンドに戻す双方向の書き換え
- **server-initiated notification** (`notifications/tools/list_changed` 等): `front.send(msg)` でそのまま standalone SSE に流す

### stdio バックエンドへの env 受け渡し

`process.env` を丸ごと stdio バックエンドに継承すると、プロキシ自身の秘匿情報 (`PROXY_TOKEN`、レシピが `environment:` で渡した秘匿情報) がバックエンド MCP に筒抜けになり、バックエンド MCP がサプライチェーンで汚染された場合の漏洩経路になる。プロキシは次の 3 段だけをバックエンドに渡す:

1. デフォルト許可リスト: `PATH` / `HOME` / `LANG` / `TZ` / `TMPDIR` / `TERM` / `USER` / `LOGNAME` / `SHELL` + `LC_*` (locale の接頭辞)
2. `--pass-env <KEY>`: プロキシの env から明示的に許可した KEY を継承
3. `--env KEY=VALUE`: 値を直接指定 (最優先、プロキシの env を経由しない)

レシピ例 (gcp-mcp): `--pass-env CLOUDSDK_CORE_PROJECT` で必要な GCP 系 env だけをバックエンドに通し、`PROXY_TOKEN` や `IMPERSONATE_SERVICE_ACCOUNT` はバックエンドに渡さない。

### OAuth フローとコールバック防御

`--oauth` で起動時にバックエンドの DCR + 認可 + トークン永続化までを駆動する。`StreamableHTTPClientTransport.start()` は AbortController を作るだけで実通信しないため (最初の `send` まで認証チェックが走らない)、SDK の `auth()` 関数を直接呼ぶ。コールバックの HTTP サーバ停止は `setTimeout(200ms)` の遅延後に `server.close()` + `server.closeAllConnections()` を組み合わせる (遅延が無いとレスポンス送信前にソケットが close されてブラウザに `ERR_EMPTY_RESPONSE` が出る。keep-alive 接続が残ると `close()` だけでは shutdown が滞留するので `closeAllConnections()` で強制クリーンアップする)。

`FileOAuthProvider` はプロキシ寿命で 1 つ作り、全セッションのバックエンド transport で共有する。プロキシ起動時に `runOAuthFlow` を 1 回駆動して AUTHORIZED まで進めておくことで、最初のセッション起動時に初めて認可 URL が出る UX を避け、複数セッションが同時に立ち上がっても認可フローが並走しない。`state.txt` / `verifier.txt` 等の短寿命の state も書き込み経路が 1 つに固定される。セッション中の自動リフレッシュは SDK の transport 側に任せる (各 transport が共有プロバイダの `tokens()` / `saveTokens()` を呼ぶ)。

#### refresh_token の同時発火集約 (`--oauth-refresh-dedup`)

複数セッションのバックエンド transport は同じ `token-store/<name>/tokens.json` を共有する。アクセストークンの TTL の経過直後に複数セッションがほぼ同時にリクエストを打つと、各 transport の SDK auth() が独立に同じリフレッシュトークンでトークンエンドポイントを叩く。リフレッシュトークンをローテーションするプロバイダ (Atlassian, Google など) では 1 回目だけ成功して 2 回目以降が `invalid_grant` で失敗し、SDK が認証情報を invalidate して全セッションが認可前状態に戻る ([typescript-sdk#1760](https://github.com/modelcontextprotocol/typescript-sdk/issues/1760))。

`--oauth-refresh-dedup` でプロキシ全体に 1 つの fetch ラッパーを被せ、`grant_type=refresh_token` の POST を処理中の Promise で coalescing する (`Response.clone()` で各呼び出し元に独立に渡す)。判定はボディが `URLSearchParams` か `application/x-www-form-urlencoded` 形式の文字列であることを見るだけで、OAuth 2.1 spec 準拠のトークンリクエスト以外には触らない。

実験的な機能なのでデフォルトで OFF。fetch ラッパーが送出 HTTP リクエスト全体を通る形になるため、判定ロジック (refresh_token grant のみ coalescing、他は素通し) は spec 準拠で安定だが、レシピ側への副作用範囲を限定するため明示的な有効化を要求している。

コールバックリスナーの bind はデフォルトでループバック (`127.0.0.1:3030`)、`--callback-listen 0.0.0.0:3030` 等を明示してループバックの外に開いた構成 (ホストへのポート公開 / リバースプロキシを前段に置く等) のときだけ外部から到達できる。後者の構成では他プロセス / 他ホストから偽 code/error を投げ込まれる経路があるため、認可フローを不成立にさせない目的で 2 段の防御を入れている:

- **state 検証**: `FileOAuthProvider.state()` で 32 byte の nonce を生成して `state.txt` に保存し、SDK が認可 URL の `state` パラメータに乗せる。コールバック側は `verifyAndClearState` で timing-safe 比較し、不一致 / 不在は静かに 400 を返してリスナーを継続する (Promise は settle しない)。正規のコールバックがまだ届く余地を残すのが狙い
- **タイムアウト**: `--callback-timeout` (デフォルト 5 分) で `CallbackTimeoutError` を投げる。タイムアウトは認証情報起因ではないため `runOAuthFlow` は `invalidateCredentials` を呼ばずにエスカレートしてプロキシを停止する。攻撃者がコールバックを吊らせて保存された認証情報を wipe させる経路を遮断するため

`runOAuthFlow` のリトライは `invalid_grant` / `invalid_client` / `invalid_token` を message に含むエラーだけを認証情報起因と判定して `invalidateCredentials("all")` する。それ以外 (タイムアウト / ネットワークエラー等) は wipe せず throw する。

### 秘匿情報の保存

トークンストアの保存ディレクトリは `0o700`、`tokens.json` / `client.json` / `verifier.txt` / `state.txt` は `0o600` で固定する。`writeFileSync` の `mode` は新規作成時にしか効かないため、既存ファイルにも `chmodSync` で必ず矯正する (`FileOAuthProvider.writeSecret`)。

PKCE `verifier.txt` と `state.txt` は認可完了時点で用済みなので、`runOAuthFlow` が AUTHORIZED に達したら `invalidateCredentials("verifier")` で破棄し、ディスク上の攻撃面を残さない。プロキシコンテナは非 root ユーザ (uid 1000) で実行する。

## 既知の挙動

- 1 クライアントセッション = 1 バックエンドインスタンスなので、複数クライアントから同じプロキシを共有する構成で同時起動するとバックエンドプロセスもその数だけ起動する。stdio バックエンドで起動コストが重いもの (例: Python venv の MCP) を多数クライアントから繋ぐ構成では、起動レイテンシとメモリを見ておく必要がある
- DELETE `/mcp` が来ないままクライアントが消えた場合 (ネットワーク切断・コンテナの強制停止等) はアイドル sweep でセッションが解放される (`--session-idle-timeout` で閾値を制御)。短いタイムアウトは長時間実行のツールを巻き込む + Claude 系クライアントが 404 自動再 initialize を実装していないケースがあるため、デフォルトは 1 時間と余裕めに置く

## 残存リスク

- **トークンストアの path traversal**: CLI 引数 `<name>` が無検証で `join(storeDir, name)` に使われる。起動引数は信頼境界内 (レシピ作者の責任範囲) のため現状未対応
- **コールバックリスナーをループバックの外に開いた構成での公開範囲**: デフォルトはループバック (`127.0.0.1:3030`) bind で外部から到達できない。`--callback-listen 0.0.0.0:3030` 等を明示した構成 (ホストへのポート公開 / リバースプロキシを前段に置く等) のときだけ外部から到達可能になる。その場合も state 検証 (32 byte nonce + timing-safe) + タイムアウトで偽コールバックは弾ける

## 参考

- [open-webui/mcpo](https://github.com/open-webui/mcpo) — OAuth 肩代わりの方式論を参考
- [mcpo OAuth Guide](https://github.com/open-webui/mcpo/blob/main/OAUTH_GUIDE.md)
- [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) — 1MCP1proxy 思想が近い
- [Model Context Protocol 仕様](https://spec.modelcontextprotocol.io/)
