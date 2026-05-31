# lib/mitm-proxy/ — TLS 終端 MITM プロキシ (ホスト × HTTP メソッド × パス単位 ACL)

devcontainer の外向き通信を mitmproxy で TLS 終端し、自作アドオンモジュール + 宣言的なポリシースキーマでホスト × HTTP メソッド × パス単位の ACL + 静的なトークン注入を一箇所に集約する。

機能としては 3 段の区分 (trusted_hosts / readonly_hosts / allow_rules) のいずれでも許可を書けるが、運用上は **読み取り専用な許可 (`readonly_hosts`) を主として使う** ことを推奨する。外部への更新は mcp-proxy 軸に集約し、git push のような例外は `recipes/git-gateway/` 等に切り出している。[`lib/mcp-proxy/`](../mcp-proxy/) と対になる「2 軸構成のもう片方」で、recipes/ から build context 経由で再利用される基本コンポーネント。

## 構成図

```
                ┌─────────────────────────────┐
                │ workspace (devcontainer)    │
                │ networks: [internal-net]    │
                │ HTTP(S)_PROXY=mitmproxy:8080│
                │ NODE_EXTRA_CA_CERTS=...     │ ← bootstrap-ca.sh が起動時に
                │ SSL_CERT_FILE=...           │   mitm.it/cert/pem を取得
                └──────────┬──────────────────┘
                           │ internal-net (ゲートウェイ無し)
                ┌──────────┴──────────────────┐
                │ mitmproxy                   │
                │ - ホストごとに偽の証明書を発行 │
                │ - addons/policy.py で ACL   │
                │ networks:                   │
                │   - internal-net            │
                │   - external-net            │
                │ volumes:                    │
                │   - mitm-ca (CA 秘密鍵)     │ ← 作業コンテナから read 不可
                └──────────┬──────────────────┘
                           │ external-net
                       インターネット
```

## ファイル構造

```
lib/mitm-proxy/
├── compose.yaml              # mitmproxy + workspace + unit + 2 networks + 名前付きボリューム
├── Dockerfile.mitmproxy      # mitmproxy + addons / policy を COPY (イメージレイヤに焼き込み)
├── Dockerfile.workspace      # bun:1 + ca-certificates + curl + git + bootstrap entrypoint
├── bootstrap-ca.sh           # 起動時に mitm.it/cert/pem 取得 → update-ca-certificates → setpriv で非 root に降格
├── policy.example.json       # trusted_hosts / readonly_hosts / allow_rules / header_inject
├── .env.example              # header_inject 用の秘匿情報テンプレ (デフォルトは空)
├── addons/                   # mitmproxy アドオン群 (Python)
│   ├── policy.py             #   - エントリ (addons リスト + running フック)
│   ├── config.py             #   - JSON + 環境変数からの設定読み込み
│   ├── audit.py              #   - logger + deny() ヘルパ
│   ├── rules.py              #   - Match / InjectRule の汎用プリミティブ
│   ├── host_guard.py         #   - HostGuard (`Host` ヘッダ詐称を拒否) + real_host ヘルパ
│   ├── common.py             #   - CommonPolicy (trusted / allow_rules / readonly / 原則拒否)
│   ├── header_inject.py      #   - HeaderInjector (汎用ヘッダ注入)
│   ├── access_log.py         #   - AccessLog (レスポンスを 1 行 INFO で記録)
│   └── tests/                #   - アドオンの Python ユニットテスト (mitmproxy イメージ内で実行)
├── .devcontainer/
│   └── devcontainer.json     # 「Reopen in Container」で本 lib を直接 devcontainer 化
└── test/                     # smoke 専用の閉鎖環境スタック
    ├── compose.yaml          #   - production と独立したスタック (internal-net / external-net とも internal: true)
    ├── Dockerfile.mock       #   - mock-target イメージ (bun + openssl で複数 SAN 証明書を毎回生成)
    ├── mock-entrypoint.sh    #   - openssl req で .test TLD の SAN を持つ自己署名証明書を生成し mock-server を起動
    ├── mock-server.ts        #   - 複数のエイリアスを 1 つのコンテナで受ける mock upstream
    ├── policy.smoke.json     #   - smoke 用のポリシー (mitmproxy にバインドマウントで /etc/mitm-proxy/policy.json を差し替え)
    └── smoke.test.ts         #   - 閉鎖環境内で CA bootstrap / ACL / HeaderInjector / HostGuard / 攻撃模倣を E2E 検証
```

## 動作確認

### ユニットテスト (アドオンのロジック)

```sh
cd lib/mitm-proxy && docker compose run --rm unit
```

mitmproxy イメージ内で `python -m unittest discover` を回す (追加の依存はゼロ)。`addons/tests/` 配下に `Match` / `HostMatcher` / `CommonPolicy` / `HeaderInjector` / `audit.deny` / `config` / `AccessLog` / `HostGuard` の純粋なヘルパを単体検証するテストが入っており、pull 不要・ネット疎通不要で完結する。

### smoke (疎通 + ACL + 攻撃模倣)

```sh
cd lib/mitm-proxy && docker compose -f test/compose.yaml up --build --abort-on-container-exit smoke
docker compose -f test/compose.yaml down -v  # 終了後の片付け (mock-certs ボリュームも削除)
```

production スタック (compose.yaml) とは独立した閉鎖環境で実行する。`internal-net` / `external-net` 共に `internal: true` で gateway が無く、smoke 中のトラフィックは一切外部に到達しない。実ホスト (`api.github.com` 等) には依存せず、Docker のネットワークエイリアスで受ける .test TLD (RFC 6761 予約) の仮想ホスト (`api.test` / `registry.test` / `echo.test` / `raw.content.test` / `denied.test` / `git.test`) を叩いて検証する。各エイリアスの役割は [`test/policy.smoke.json`](./test/policy.smoke.json) の `_doc_aliases` を参照。

検証する観点:

- CA 証明書がトラストストアにあり、結合バンドル (`/etc/ssl/certs/ca-certificates.crt`) に統合されている
- ワークロードは非 root (uid=1000) で動いている
- Bun fetch / curl: readonly_hosts に居るホスト (`api.test` / `registry.test`) への GET → 200
- `readonly_hosts` 外 (`denied.test`) は 403
- `readonly_hosts` の glob (`*.content.test`) で `raw.content.test` が許可
- `readonly_hosts`: 非 GET (POST / PUT) は 403
- `git.test` (readonly に居ない、git transport は gateway 経由前提の意図) は 403
- `allow_rules`: readonly ホストでも `/anything/foo` への POST は個別に許可されて通る
- HeaderInjector: policy.json の rule で `echo.test/headers` にヘッダ注入される
- HostGuard: `Host` ヘッダ詐称 (実宛先 ≠ Host) は 403
- 攻撃模倣: 直接の TCP 外向き通信 (1.1.1.1:443) は `internal: true` で経路が無く失敗
- 攻撃模倣: CONNECT 詐称 (CONNECT 行 = 許可リスト内 / SNI + Host = 許可リスト外) は最終的に HostGuard で 403

### devcontainer として起動

VS Code / Cursor で `lib/mitm-proxy/` を開き「Reopen in Container」。`.devcontainer/devcontainer.json` が `workspace` サービスを起動し、`mitmproxy` も `depends_on` で連動起動する。作業コンテナ内で `pnpm info <pkg>` / `pip index versions <pkg>` / `git ls-remote` 等の読み取り操作はそのまま動くが、`pnpm publish` / `git push` 等はアドオンで 403 になる。

## 信頼の前提

このレシピは以下を信頼境界に置く:

1. **Docker network namespace の隔離**: 作業コンテナは `internal: true` ネットワークしか持たず、mitmproxy 以外への直接の外向き通信は L3 段階で不可
2. **mitmproxy の CA 秘密鍵がホスト側の名前付きボリュームに閉じ込められている**: 作業コンテナは公開鍵側 (証明書) しか持たない。秘密鍵が漏れない限り MITM 行為は mitmproxy にしかできない
3. **プロキシが読み込むコード / ポリシーはイメージレイヤ経由でのみ供給する**: アドオン (`addons/`) とデフォルトのポリシー (`policy.example.json`) は `Dockerfile.mitmproxy` で `COPY` によりイメージに焼き込む。バインドマウントにすると作業コンテナの rw マウントと同じホストディレクトリを指してしまった場合に「監視される側 (作業コンテナ内の AI エージェント) が監視コードを編集できる」状態 (mitmproxy の `-s` スクリプトは hot reload する) になり、ACL が自己崩壊する。本不変条件は新規レシピ / コピペ配置でも維持する (`alternatives/git-mitm-proxy-addon/` も同じパターンで `COPY lib/mitm-proxy/addons /addons`)
4. **ワークロードは非 root で動かす**: `bootstrap-ca.sh` は root で起動し、`update-ca-certificates` 完了直後に `setpriv` で `WORKLOAD_USER` (呼び出し側で必須明示、本 lib の `Dockerfile.workspace` では `bun`、devcontainers 系のベースを使う integrated/single-workspace 等では `node`) に drop してから CMD を `exec` する。デフォルトを持たせず fail-fast にしているのは、ベースイメージごとに実在するユーザが異なるため、漏れに気付かず権限降格が壊れたまま動く事故を防ぐため
5. **internal な Docker ネットワーク内の通信は信頼できる**: `mitm.it/cert/pem` の bootstrap での fetch を plain HTTP でやるため、このネットワークに侵入できる第三者がいれば偽 CA を掴ませられる。ただしこの仮定が崩れた時点で他の秘匿情報も全て出るため、本レシピだけ守っても意味がない

## policy.json

`policy.json` (デフォルトは `policy.example.json`) で以下を表現する:

```jsonc
{
  "trusted_hosts": ["api.anthropic.com"],
  "readonly_hosts": [
    "api.github.com",
    "registry.npmjs.org",
    "*.githubusercontent.com"
  ],
  "allow_rules": [
    // readonly ホストへの副作用のない POST の個別許可:
    {"host": "registry.npmjs.org", "path": "*/-/npm/v1/security/audits", "method": "POST"}
  ],
  "header_inject": [
    {
      "match": {"host": "registry.fury.io"},
      "headers": {"Authorization": "Bearer ${FURY_TOKEN}"}
    }
  ]
}
```

### 区分構造

- `trusted_hosts` … **全 HTTP メソッド素通し** (例: `api.anthropic.com` のような Claude Code 自身の外向き通信)。HTTP メソッド ACL をスキップするため、署名付き書き込みが要るエンドポイントだけに絞る
- `readonly_hosts` … **GET / HEAD / OPTIONS のみ通す** (読み取り専用な許可)。それ以外の HTTP メソッドは 403
- `allow_rules` … **(ホスト, パス, HTTP メソッド, クエリ) のマッチリスト**。pnpm audit のような副作用のない POST や、特定のエンドポイントだけ書き込みを許したいケースに使う。`{"host": ..., "path": ..., "method": ...}` の flat dict 形式
- `header_inject` … allow されたリクエストにヘッダを注入する。私的レジストリの Bearer など、ホストを限定して付ける用途

### 評価順

```
mitm.it (CA 配布) → trusted_hosts → allow_rules → readonly_hosts (+safe-method) → 原則拒否
```

any-match-allows。`allow_rules` を `readonly_hosts` より先に評価することで「readonly ホストへの副作用のない POST」が表現できる (readonly を先にすると POST が unsafe-method で即拒否されてしまう)。`deny_rules` は意図的に持たない: 原則拒否の構造下では「allow に書かない」=「拒否」で塞げるため。

### 表現 (ホスト glob / パス glob / マッチャ / 補間)

- `readonly_hosts` / `trusted_hosts` は完全一致 + ホスト glob のハイブリッド。`*` / `?` を含むエントリは glob として、それ以外は完全一致として扱う (`HostMatcher` クラス、`addons/rules.py`)
- **ホスト glob はセグメント単位**: `*` は 1 ラベル分のみマッチし `.` を跨がない (TLS ワイルドカード証明書 / nginx server_name と同じ慣行)
  - `*.example.com` → `a.example.com` にマッチ、`a.b.example.com` にはマッチしない、bare `example.com` にもマッチしない (別エントリが要る)
  - 2 ラベルのサブドメインを許したい場合は `*.*.example.com` を明示する
- `allow_rules[]` / `header_inject[].match` は同じ `Match` 型を共有。`host` (上記のホスト glob) / `path` / `method` / `query` (辞書の完全一致) を組み合わせ可能。`method` 省略時は任意の HTTP メソッドにマッチ
- **パス glob もセグメント単位**: `*` は 1 セグメント、`/` を跨がない。`**` で `/` を跨ぐ (ファイル glob / `.gitignore` と同じ慣行)
  - `/foo/*` → `/foo/bar` にマッチ、`/foo/bar/baz` にはマッチしない
  - `**/audits` → `/foo/bar/audits` にマッチ
- `header_inject[].headers` の値は `${VAR}` 形式で環境変数から補間する。秘匿情報を JSON にハードコードしない方針。展開値に CR/LF が含まれる場合は起動失敗 (ヘッダインジェクション防止)

### 差し替え方法

デフォルトのポリシーは `policy.example.json` をイメージビルド時に `/etc/mitm-proxy/policy.json` へ `COPY` で焼き込んでいる (信頼の前提 3)。差し替えは以下のいずれか:

- **編集 + 再ビルド**: `policy.example.json` を編集して `docker compose run --rm --build smoke` (or `docker compose build mitmproxy`) で焼き直す
- **compose.override.yaml で上書きマウント**: レシピ等で別のポリシーを使う場合、作業コンテナのマウント範囲外のパス (例: `~/.config/...` 配下) を `/etc/mitm-proxy/policy.json` にバインドマウントする

  ```yaml
  # compose.override.yaml
  services:
    mitmproxy:
      volumes:
        - ${HOME}/.config/devsbx/my-policy.json:/etc/mitm-proxy/policy.json:ro
  ```

  `docker compose -f compose.yaml -f compose.override.yaml up` で適用。作業コンテナのマウント (`.:/workspace:cached`) と同じホストのパスを指してはいけない (信頼の前提 3)

## アドオンの構造

アドオンは責務ごとに分かれており、`policy.py` がエントリ:

| モジュール | 役割 |
|---|---|
| `policy.py` | mitmdump エントリ (`addons = [...]` + running フック) |
| `config.py` | `policy.json` (POLICY_FILE) + 環境変数からの設定読み込み。秘匿情報の補間も |
| `audit.py` | logger + `deny()` ヘルパ。拒否時は `flow.metadata` を立てて後続のアドオンに伝える |
| `rules.py` | `Match` / `InjectRule` の汎用 (ホスト + パス + HTTP メソッド + クエリ) マッチングプリミティブ |
| `host_guard.py` | `HostGuard`: `Host` ヘッダ詐称 (= 実宛先と不一致) を 403 で拒否。`real_host(flow)` ヘルパも提供 |
| `common.py` | `CommonPolicy`: trusted / allow_rules / readonly / 原則拒否 の 4 段判定 |
| `header_inject.py` | `HeaderInjector`: policy.json の rule に従い、allow されたリクエストにヘッダ注入 |
| `access_log.py` | `AccessLog`: レスポンスフックで (HTTP メソッド, ホスト, パス, ステータス) を 1 行 INFO で記録 |

実行順序: `HostGuard → CommonPolicy → HeaderInjector → AccessLog`

- **HostGuard** が最初に動作し、`flow.request.host` (mitmproxy の実宛先) と `Host` ヘッダ (`:authority` 含む) の不一致を 403 で拒否する。`pretty_host` 経由の詐称バイパスを境界で塞ぐ層 (詳細は `addons/host_guard.py` の docstring)
- **CommonPolicy** が trusted / allow_rules / readonly / 原則拒否 の順に判定。allow なら何もせず流し、拒否ならレスポンスを立てる。判定ホストは `host_guard.real_host(flow)` (実宛先) を使う
- **HeaderInjector** は CommonPolicy が allow した (レスポンス未設定の) リクエストにだけヘッダを足す
- **AccessLog** はレスポンスフックで (HTTP メソッド, ホスト, パス, ステータス) を 1 行 INFO で記録

レシピ側で固有のアドオンを 1 ファイル単位で追加する拡張点として `MITM_EXTRA_ADDONS` 環境変数を持つ (`alternatives/git-mitm-proxy-addon/` が利用例)。

## 観測性 (audit log)

addon の判定は Python `logging` 経由で mitmproxy のログストリーム (標準エラー) に出る。`docker compose logs -f mitmproxy` でリアルタイム確認できる。

出力の接頭辞:

| 接頭辞 | 意味 | レベル |
|---|---|---|
| `[mitm-proxy] config loaded: ...` | 起動時にアドオンが読んだ policy + env 状態 | INFO |
| `[mitm-proxy DENY <status>] <method> <host><path> — <reason>` | アドオンが拒否したリクエスト | WARNING |
| `[mitm-proxy INJECT] <host> <path> — headers=[<name>, ...]` | HeaderInjector が rule 一致でヘッダを足したリクエスト。値は出さずヘッダ名のみ | INFO |

mitmproxy 自身のアクセスログ (各リクエストの URL + ステータスコード) と同じストリームに出るので、アドオンの判定と上流とのやり取りが時系列で並んで見える。PAT 値そのものや Authorization ヘッダの値はログに含めない方針。

デバッグ例:

```
[mitm-proxy] config loaded: POLICY_FILE=/etc/mitm-proxy/policy.json TRUSTED_HOSTS=api.anthropic.com,... READONLY_HOSTS=api.github.com,registry.npmjs.org,... ALLOW_RULE_HOSTS=httpbin.org HEADER_INJECT_HOSTS=httpbin.org
[mitm-proxy DENY 403] POST httpbin.org/post — readonly host: POST httpbin.org/post denied
[mitm-proxy DENY 403] GET github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack — host not in allowlist
```

## env_file

```
~/.config/devsbx/mitm-proxy.env
```

形式は [`./.env.example`](./.env.example) を参照。lib/mitm-proxy/ 自体のデフォルトでは何も注入しないため env_file は **必須ではない**。レシピが `header_inject` ルールで `${VAR}` を参照する場合のみ秘匿情報をここに書く。

```sh
mkdir -p ~/.config/devsbx
cp lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env
# 必要に応じて header_inject 用の秘匿情報を埋める
```

`required: false` で読むため、env_file 不在でも smoke は通る。

## 起動時の挙動

### CA bootstrap

- mitmproxy は起動時に `~/.mitmproxy/mitmproxy-ca-cert.pem` を **名前付きボリューム上に自動生成** (初回のみ)。以降は永続化される
- 作業コンテナは mitmproxy の特別なホスト名 `mitm.it` に対してプロキシ経由で `http://mitm.it/cert/pem` を GET する → mitmproxy 自身がレスポンスを生成して PEM を返す
- 取得した証明書を `/usr/local/share/ca-certificates/mitmproxy.crt` に保存し、Debian の `update-ca-certificates` で `/etc/ssl/certs/ca-certificates.crt` に統合
- 言語ランタイム別に環境変数を全種類セット (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`)

### bootstrap 失敗時の停止 (安全側に倒す)

`bootstrap-ca.sh` は CA 取得に失敗したら `exit 1`。mitmproxy が落ちている / ネットワーク不通の状態で TLS 検証なしで動かすと事故るため、必ず停止する。

### ヘルスチェック

mitmproxy のヘルスチェックは `mitmproxy-ca-cert.pem` の存在で「立ち上がって CA 生成済み」を判定する。listen 完了の確認は別途取れるとより堅いが、smoke で実 fetch が通ることで事実上検証されている。

## git transport の切り出し

`github.com` 向け git smart-HTTP の処理 (POST `/git-upload-pack` は副作用がないので許可 / パスベースの push ACL / Basic auth 注入) は本 lib では扱わず、`recipes/git-gateway/` (主推奨) または `alternatives/git-mitm-proxy-addon/` (本イメージを継承してアドオンを追加する軽量代替) に切り出している。本 lib では:

- `github.com` は `readonly_hosts` に含めない (作業コンテナは git-gateway 経由が前提)
- `api.github.com` は `readonly_hosts` に残し、PAT 注入なしで GET のみ通す (REST API は GitHub MCP 経由が主、直接の GET は匿名で zen / 公開情報のみ取れる程度)

「HTTP メソッド = 読み取り / 書き込みで分類できない smart-HTTP の意味解釈」「PAT 注入」「ref / リポジトリ ACL」を切り出すことで、本 lib は読み取り専用許可を主とする運用に向いた最小構成を維持している。

## 残存リスク (漏れる余地)

1. **mitmproxy 自身の侵害**: mitmproxy コンテナは両ネットワークに足を持つ + CA 秘密鍵を保持しているため、ここを取られると外への直接の外向き通信 + 任意ドメインの偽証明書発行が可能になる。緩和: イメージ最小化、アドオン経由で実行されるコードを最小化、トークンは読み取り専用に絞る
2. **CA 秘密鍵のローテーション戦略未整備**: 鍵をローテートすると作業コンテナ側の `NODE_EXTRA_CA_CERTS` 等を再読み込みするためコンテナの再起動が要。緩和: 個人 PJ では日常的にローテートしない前提で十分。侵害時のみ `mitm-ca` ボリュームを消して再生成 → 全作業コンテナを再ビルド
3. **CA 証明書を OS のトラストストアでなく自前のバンドルで読むツール**: Java の `cacerts.jks`、Python の `certifi`、AWS CLI の `AWS_CA_BUNDLE` 等。本レシピでは Node / Python (requests) / pip / cargo / git の環境変数を一通りセット済み。それ以外のツールは `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` が読まれることを期待する (OpenSSL ベースのツールは読む)。完全にピンニングするツール (cloud SDK の一部) はそもそも MITM 不可で、SNI 許可リストで個別例外を設ける運用に倒すしかない
4. **`HTTPS_PROXY` を尊重しないツール**: 一部のツールがプロキシ設定を無視する場合、internal ネットワークがゲートウェイ無しで塞いでくれるため最終的には失敗になるが、デバッグ工数は増える
5. **ビルド時の外向き通信**: 作業コンテナのイメージビルド時の `apt-get` / `bun install` 等はビルド時の外向き通信を要する。本レシピでは `Dockerfile.workspace` が build context で外に出るのを許容している (`alternatives/dependencies-build-time/` のように実行時にゼロにはしていない)

## 関連

- [lib/mcp-proxy/](../mcp-proxy/) — MCP 軸のプロキシ。本 lib と対になる「もう片方の軸」
- [alternatives/simple-http-proxy/](../../alternatives/simple-http-proxy/) — SNI ACL 版 (軽量、ECH 普及前の暫定)
- [alternatives/dependencies-build-time/](../../alternatives/dependencies-build-time/) — 実行時の外向き通信ゼロ版
- [recipes/git-gateway/](../../recipes/git-gateway/) — github.com 向け git transport の単一窓口 (読み取り + 書き込み統合、ref/branch ACL)
- [alternatives/git-mitm-proxy-addon/](../../alternatives/git-mitm-proxy-addon/) — 本 lib を継承して `MITM_EXTRA_ADDONS=github` で `GitHubPolicy` を載せる軽量代替版
