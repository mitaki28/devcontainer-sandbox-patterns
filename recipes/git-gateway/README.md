# recipes/git-gateway/ — github.com への git transport の単一窓口 (Caddy + fcgiwrap 版)

作業コンテナの **github.com 向け git transport の単一窓口** として動く `git-gateway` サービス。Caddy をエッジに置き、push 系のみ fcgiwrap 経由で `git-http-backend` を CGI 実行する。fetch 系は Caddy が直接 `reverse_proxy` + PAT ヘッダ注入する。

設計上の動機 (mcp-proxy / mitm-proxy で git transport が捌けない理由 / ref + リポジトリ ACL をプロキシ側で評価する根拠 / 読み取り + 書き込み統合ゲートウェイの選択) は docs 側で扱う:

- [docs/08-git-gateway.md](../../docs/08-git-gateway.md) — Git transport の隔離

## 構成

```
                                ┌──────────────────────────────────────────┐
GitHub PAT  ────────────────────│  git-gateway (caddy edge + fcgiwrap +    │
   (env_file)                   │  git-http-backend + bare repos + hooks)  │── PAT 付き push / fetch
                                │                                          │── ──▶ github.com/...
                                │  登録リポジトリのハンドラ:                  │
                                │    fetch → reverse_proxy + Authorization 注入│
                                │    push  → fcgiwrap → git-http-backend    │
                                │             → pre-receive で ref ACL       │
                                │               + 上流転送                  │
                                │                                          │
                                │  未登録リポジトリのハンドラ:                │
                                │    info/refs?service=git-upload-pack 等   │── PAT 無し fetch
                                │    の git smart HTTP のみ匿名で透過        │── ──▶ github.com/<repo>.git/...
                                │    (Authorization は必ず除去)              │
                                │    POST(receive-pack) は 403             │
                                │    上記以外の path はすべて 404            │
                                └──────────────────┬───────────────────────┘
                                                   ▲
                                                   │ http://git-gateway:8080/...
                                                   │ (internal docker ネットワーク内)
                                ┌──────────────────┴───────────────────────┐
                                │  workspace                                │
                                │  insteadOf: https://github.com/ → ─────── │
                                │             http://git-gateway:8080/      │
                                │  PAT を持たない                            │
                                └──────────────────────────────────────────┘
```

挙動の要約:

- 登録リポジトリ (`ALLOWED_REPOS`):
  - fetch: Caddy が上流に `reverse_proxy` + Basic 認証 (PAT) 注入
  - push:  Caddy → fcgiwrap → git-http-backend で受理 → `pre-receive` フックで ref の許可リスト + 上流 (実 GitHub) への転送 (bare リポジトリの `http.extraHeader` 経由で PAT) → アトミックに受理 / 巻き戻し
- 未登録リポジトリ:
  - fetch: git smart HTTP の `(GET, info/refs?service=git-upload-pack)` と `(POST, git-upload-pack)` のみ、Authorization / Cookie を除去して上流に透過転送 (PAT は絶対に注入しない、public read 用途)
  - push:  Caddy が 403
  - 上記以外の (HTTP メソッド, パス) はすべて 404 (= 上流の web UI / API への透過プロキシ経路は存在しない)

## ファイル構造

```
recipes/git-gateway/
├── compose.yaml
├── .env.example
├── .gitignore
├── .devcontainer/devcontainer.json
├── gateway/                       # 本番イメージ
│   ├── Dockerfile                 # caddy:2-alpine + fcgiwrap + git-daemon + gettext
│   ├── Caddyfile.gateway          # 静的: snippet + import per-repo + 未登録ハンドラ
│   ├── per-repo.caddy.tmpl        # リポジトリごとのハンドラのテンプレ (envsubst で展開)
│   ├── entrypoint.sh              # テンプレ展開 + bare repo 初期化 + caddy 起動
│   └── hooks/
│       ├── pre-receive            # ref ACL + 上流転送 (アトミック)
│       └── post-receive           # 外部 push 後追い同期 (smoke では off)
├── workspace/
│   ├── Dockerfile                 # devcontainers/base + gitconfig
│   └── gitconfig                  # https://github.com/ → http://git-gateway:8080/
└── test/
    ├── smoke.sh                   # 9 ケースの自動検証
    └── mock-upstream/             # smoke 専用の mock 上流 (本番イメージとは独立)
        ├── Dockerfile
        ├── Caddyfile.mock         # 静的: catch-all で匿名 fcgiwrap
        └── entrypoint.sh          # mock only / PAT 要求 / PAT 禁止マッチャを生成
```

主な環境変数:

- 本番 (`gateway/entrypoint.sh`):
  - 必須: `UPSTREAM_BASE_URL`, `ALLOWED_REPOS`
  - 任意: `GITHUB_PAT`, `ALLOWED_REF_PATTERNS`, `DENIED_REF_PATTERNS`, `DISABLE_POST_RECEIVE_SYNC`
- mock (`test/mock-upstream/entrypoint.sh`):
  - 必須: `MOCK_REPOS`
  - 任意: `EXPECT_PAT`, `EXPECT_PAT_FOR_REPOS`, `FORBID_PAT_FOR_REPOS`

## 動作確認

```sh
cd recipes/git-gateway && docker compose run --rm --build smoke
```

`test/smoke.sh` が 10 ケース (basic push / ref の拒否リスト / 外部 linear push の自動解消 / 履歴書換による non-ff reject / 古い作業コンテナの push のアトミックなロールバック / 未登録リポジトリの匿名 fetch 透過転送 / 未登録リポジトリの push の 403 / advertise エンドポイントの ACL 不変条件 / PAT 注入 + 除去の不変条件の curl assert / git smart HTTP 以外のパスが 404 になる不変条件) を通す。mock-upstream に `EXPECT_PAT_FOR_REPOS=smoke-org/repo` と `FORBID_PAT_FOR_REPOS=other-org/public` を仕込むことで、PAT 注入 / 除去の end-to-end な不変条件を検証する。

## 設計のキモ

### Caddy + fcgiwrap を選んだ理由

エッジ層に Caddy、CGI 実行に fcgiwrap を分けた構成を選んでいる。Apache + mod_proxy + mod_rewrite + git-http-backend (ScriptAlias) でも機能的には組めるが、Apache 構成は **設定ミスが黙って成立してしまう構造的な落とし穴** を 2 つ抱えるため避けている:

- **PAT 注入が共通設定との競合で黙って剥がれうる**: Apache の `<Location>` は出現順にマージされ、`RequestHeader` は累積適用される。リポジトリごとの Location の `set Authorization` の後ろに共通の `<Location "/">` の `unset Authorization` を置く順序ミスをすると、**PAT が剥がれた状態で起動する** (安全側に倒れて漏洩は起きないが、症状が「private リポジトリの fetch が 401」という間接的なものになり、設定ファイルを読んでも一見では原因が分からない)。Caddy の `handle` ブロックは先勝ち + ブロック内のみ適用なので、この種の競合は構造的に発生しない
- **上流の TLS 検証がオプトインで書き忘れやすい**: Apache の `SSLProxyEngine on` は既定で上流証明書を検証せず、`SSLProxyVerify require` を別途書く必要がある。本番 `UPSTREAM_BASE_URL=https://github.com/` で明示設定を忘れると、PAT を任意の github.com インポスターに渡しうる経路が黙って成立する。Caddy の `reverse_proxy` は既定で検証するため、明示設定無しで防げる

### 静的な Caddyfile + リポジトリごとのファイルの import

`gateway/Caddyfile.gateway` はビルド時に `/etc/caddy/Caddyfile` として COPY される **完全な静的ファイル** で、ALLOWED_REPOS の値に依存しない部分 (snippet、health、未登録ハンドラ、404 フォールバック) はすべてここに書かれている。

ALLOWED_REPOS から生成するリポジトリごとのハンドラは、別ファイルのテンプレ `gateway/per-repo.caddy.tmpl` を entrypoint が `envsubst` で展開して `/etc/caddy/per-repo/<N>.caddy` に 1 リポジトリ 1 ファイルとして書き出し、静的な Caddyfile が

```caddy
import /etc/caddy/per-repo/*.caddy
```

で取り込む。entrypoint が差し込むのは `${REPO}` / `${IDX}` / `${PAT_HEADER_LINE}` (= `    request_header Authorization "Basic <PAT_B64>"` の行、PAT 無し時は空文字列) の 3 変数のみで、`handle` の構造はテンプレ単体で完結する。

重複する fcgiwrap → git-http-backend のブロックと、未登録 repo の anonymous fetch passthrough は静的な Caddyfile 側で

```caddy
(fcgiwrap_backend) { reverse_proxy unix//run/fcgiwrap.sock { ... } }
(anon_upstream_passthrough) { request_header -Authorization; request_header -Cookie; reverse_proxy {$UPSTREAM_HOST_PART} }
```

という snippet として定義し、リポジトリごとのファイル / 未登録 fetch ハンドラから `import` で再利用する。

`UPSTREAM_HOST_PART` は Caddy の `{$UPSTREAM_HOST_PART}` 構文で Caddy 起動時に環境変数から展開される (envsubst は `${VAR}` 形式のみ展開するため `{$VAR}` 形式とは衝突しない)。entrypoint は環境変数を export するだけで良い。生成された全 caddy ファイル (静的 + リポジトリごと) は起動時に標準エラーに dump する (PAT は redact 済み)。

### 登録リポジトリの fetch ハンドラ (PAT 注入)

```caddy
@fetch_advertise_1 {
    method GET
    path /smoke-org/repo.git/info/refs
    query service=git-upload-pack
}
handle @fetch_advertise_1 {
    request_header -Authorization
    request_header -Cookie
    request_header Authorization "Basic <PAT_B64>"
    reverse_proxy http://mock-upstream:8080
}

@fetch_pack_1 {
    method POST
    path /smoke-org/repo.git/git-upload-pack
}
handle @fetch_pack_1 {
    request_header -Authorization
    request_header -Cookie
    request_header Authorization "Basic <PAT_B64>"
    reverse_proxy http://mock-upstream:8080
}
```

`handle` ブロック内に閉じた `request_header` のみが適用され、共通ブロックからの後勝ち `unset` で剥がれる経路は存在しない。登録 repo の fetch も未登録側と同じく git smart HTTP の `(GET, info/refs?service=git-upload-pack)` と `(POST, git-upload-pack)` の 2 エンドポイントに限定する。

### 登録リポジトリの push ハンドラ (fcgiwrap 経由)

```caddy
@push_1 path /smoke-org/repo.git/git-receive-pack
handle @push_1 {
    reverse_proxy unix//run/fcgiwrap.sock {
        transport fastcgi {
            env SCRIPT_FILENAME /usr/libexec/git-core/git-http-backend
            env SCRIPT_NAME ""
            env PATH_INFO {http.request.uri.path}
            env GIT_PROJECT_ROOT /srv/git
            env GIT_HTTP_EXPORT_ALL 1
        }
    }
}
```

リポジトリごとのハンドラが直接 fcgiwrap へ FastCGI で投げるので、内部 rewrite + ScriptAlias 経由の public な迂回 URL は存在しない。**push の入口はリポジトリごとのハンドラのみ** で、未登録リポジトリは path マッチャの段階でこのハンドラに届かない。

### 未登録リポジトリの handle

```caddy
@unreg_push_advertise {
    path */info/refs
    query service=git-receive-pack
}
handle @unreg_push_advertise { respond 403 }
@unreg_push path */git-receive-pack
handle @unreg_push { respond 403 }

@unreg_fetch_advertise {
    method GET
    path */info/refs
    query service=git-upload-pack
}
handle @unreg_fetch_advertise { import anon_upstream_passthrough }
@unreg_fetch_pack {
    method POST
    path */git-upload-pack
}
handle @unreg_fetch_pack { import anon_upstream_passthrough }

handle { respond 404 }
```

push 系は 403、git smart HTTP の fetch (`(GET, info/refs?service=git-upload-pack)` と `(POST, git-upload-pack)`) のみ Authorization / Cookie を除去して上流に透過転送、それ以外の (HTTP メソッド, パス) はすべて 404。`handle` の先勝ちにより、登録リポジトリのハンドラが先にマッチする。

### push 経路の PAT 認証 (`http.extraHeader`)

`pre-receive` 内の `git push` が上流に Authorization をあらかじめ送るために、entrypoint が登録リポジトリごとに

```sh
git -C /srv/git/<owner>/<repo>.git config http.extraHeader "Authorization: Basic <PAT_B64>"
```

を書き込む。URL に PAT を埋める方式と比べ、

- プロセスリスト / git のエラーメッセージに PAT が出ない
- bare リポジトリの `config` は git-http-backend が外部に serve しない (`info/refs`, `HEAD`, `objects/...` のみ serve)
- 上流が 401 を返してから retry する challenge-response フローを取らない

の利点がある。

### 上流の TLS 検証 (Caddy 既定)

Caddy の `reverse_proxy https://github.com` は既定で上流証明書を検証する (`tls_insecure_skip_verify` を明示しない限り)。Dockerfile で `ca-certificates` を入れるだけでシステムの CA バンドルが使われる。

### ref / リポジトリ ACL

`compose.yaml` の git-gateway サービスの environment で指定:

```yaml
environment:
  UPSTREAM_BASE_URL: http://mock-upstream:8080/
  ALLOWED_REPOS: "smoke-org/repo"
  ALLOWED_REF_PATTERNS: "refs/heads/feature/*,refs/heads/claude/*"
  DENIED_REF_PATTERNS: "refs/heads/main,refs/heads/master,refs/tags/*"
```

- `ALLOWED_REPOS`: リポジトリごとのハンドラを生成する対象。csv で複数指定。未登録リポジトリは匿名 fetch のみ通る
- `ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS`: pre-receive で ref を glob 照合。両方未設定なら全 ref が通る (gate なし)、`ALLOWED_REF_PATTERNS` が未設定なら deny only モード

## 状態ズレの原理

fetch URL = push URL = git-gateway に揃ったが、ゲートウェイ内部では fetch (リバースプロキシで上流の状態) と push (内部の bare リポジトリの状態) が分かれるため、以下のケースがあり得る:

| ケース | 上流 ref | ゲートウェイ ref | 作業コンテナのローカル | 観察される挙動 |
|---|---|---|---|---|
| a. 通常進行 | A → B (linear) | A | A → C (B 経由) | 自動解消 (ゲートウェイも B 経由で C に追従) |
| b. 履歴書換 | A → B' (orphan) | A | A → C' (B' 経由) | 作業コンテナのローカルで non-ff reject (サーバ到達せず) |
| c. 作業コンテナが古いまま | A → B | A | A → C (B 未認識) | ゲートウェイ受理 → 上流 reject → pre-receive 巻き戻し |
| d. クラッシュ系 | ─ | ─ | ─ | pre-receive exit 0 直後のプロセス障害でのみ発生 (確率小) |

「上流は受理 + ゲートウェイは受理しない」が起きるのは **クラッシュ系 (d) のみ**。これは `post-receive` で `git fetch $UPSTREAM` を後追い実行することで次回 push 時に解消する (`DISABLE_POST_RECEIVE_SYNC` で smoke では off)。

## 漏れる余地 / 残るリスク

1. **PAT スコープ範囲内の任意 ref への push**: ref の許可リストで絞れるが、PAT が許可するリポジトリへの push 自体は当然可能 (git push を許す以上の根本的制約)
2. **未登録リポジトリの匿名 git fetch はスコープ制限不可**: ゲートウェイが git smart HTTP (`info/refs?service=git-upload-pack` と `git-upload-pack` の POST) を匿名で上流に素通しするため、PAT 無しで `git clone` / `git fetch` できる public なリポジトリは作業コンテナから読める。git smart HTTP 以外の path (web UI / REST API / raw コンテンツ等) は 404 になるため、上流の web 領域への透過プロキシ経路は存在しない
3. **クラッシュ系の状態ズレ**: 上記 (d)。`post-receive` の自動 fetch で次回 push 時に解消するが、その間 ls-remote 等で見える状態は乖離する
4. **`.git/config` 由来の URL 書換 → 攻撃者先への push**: PAT が作業コンテナに居ないため **PAT 漏洩は起きない** が、コミット内容は攻撃者先に流出しうる。本構成では `internal: true` ネットワーク + 上流ホスト名の許可リスト (本番では `integrated/multi-workspace/` で実装) で作業コンテナから git-gateway 以外への TCP を Docker ネットワーク設定で塞ぐ前提
5. **コミット内容自体のスキャン (秘匿情報等) は未実装**: `pre-receive` 内で `git diff-tree` ベースのスキャンを足せば可能
6. **本レシピは smoke 単独構成**: 実 GitHub への push 経路を組むには `UPSTREAM_BASE_URL=https://github.com/` + `GITHUB_PAT` を env_file で設定 + ネットワークで `github.com` への外向き通信を絞る統合が必要 (統合構成は `integrated/single-workspace/` / `integrated/multi-workspace/` の役割)
7. **fcgiwrap / caddy のプロセス監視は最小限**: entrypoint は fcgiwrap をバックグラウンド、caddy をフォアグラウンドで動かすだけで、fcgiwrap が落ちても caddy は気付かない (push が 502 になるのみ)。本番運用ではスーパーバイザ (s6, runit, tini --) を挟むのが望ましい

## 関連

- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — 読み取り専用許可を主とするベース lib (github 関連のアドオンは持たない)
- [`../../alternatives/git-mitm-proxy-addon/`](../../alternatives/git-mitm-proxy-addon/) — 本 lib を継承して `MITM_EXTRA_ADDONS=github` で `GitHubPolicy` を載せる軽量代替 (リポジトリ単位 ACL のみ、ref 単位は PAT スコープに委ねる)
- [`../../integrated/single-workspace/`](../../integrated/single-workspace/) — git-gateway を組み込んだ単独起動向け統合構成
- [`../../integrated/multi-workspace/`](../../integrated/multi-workspace/) — git-gateway を組み込んだ並列起動対応の統合構成
