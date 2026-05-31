# lib/mitm-proxy/ — TLS 終端 MITM プロキシ (ホスト × HTTP メソッド × パス単位 ACL)

mitmproxy で TLS 終端し、アドオン + ポリシーファイルでホスト × HTTP メソッド × パス単位の ACL + トークン注入を行う基本コンポーネント。recipes/ から再利用される。

## 動作確認

### ユニットテスト

```sh
cd lib/mitm-proxy && docker compose run --rm unit
```

### smoke (疎通 + ACL + 攻撃模倣)

```sh
cd lib/mitm-proxy && docker compose -f test/compose.yaml up --build --abort-on-container-exit smoke
docker compose -f test/compose.yaml down -v
```

閉鎖環境で実行され、外部には到達しない。検証観点は `test/smoke.test.ts` を参照。

### devcontainer として起動

VS Code / Cursor で `lib/mitm-proxy/` を開いて「Reopen in Container」。読み取り操作は通り、`pnpm publish` / `git push` 等は 403 になる。

## policy.json

`policy.json` (デフォルトは `policy.example.json`) で ACL を定義する:

```jsonc
{
  "trusted_hosts": ["api.anthropic.com"],
  "readonly_hosts": [
    "api.github.com",
    "registry.npmjs.org",
    "*.githubusercontent.com"
  ],
  "allow_rules": [
    {"host": "registry.npmjs.org", "path": "*/-/npm/v1/security/audits", "method": "POST"}
  ],
  "header_inject": [
    {
      "match": {"host": "npm.pkg.github.com"},
      "headers": {"Authorization": "Bearer ${GITHUB_PACKAGES_TOKEN}"}
    }
  ]
}
```

### 各区分

- `trusted_hosts` — 全 HTTP メソッド素通し。Claude Code 自身の通信先等に限定する
- `readonly_hosts` — GET / HEAD / OPTIONS のみ通す。それ以外は 403
- `allow_rules` — (ホスト, パス, HTTP メソッド, クエリ) のマッチリスト。readonly ホストへの個別 POST 許可等に使う
- `header_inject` — allow されたリクエストにヘッダを注入する。`${VAR}` で環境変数から補間

### 評価順

```
mitm.it (CA 配布) → trusted_hosts → allow_rules → readonly_hosts (+safe-method) → 原則拒否
```

`allow_rules` を `readonly_hosts` より先に評価するので「readonly ホストへの POST」を個別許可できる。`deny_rules` は持たない。

### glob と補間

- ホスト glob: `*` は 1 ラベル分のみ (`.` を跨がない)。`*.example.com` → `a.example.com` にマッチ、`a.b.example.com` にはマッチしない
- パス glob: `*` は 1 セグメント (`/` を跨がない)。`**` で `/` を跨ぐ
- `header_inject[].headers` の値は `${VAR}` で環境変数から補間。CR/LF を含むと起動失敗する

### 差し替え方法

デフォルトは `policy.example.json` をビルド時に `/etc/mitm-proxy/policy.json` へ COPY している。差し替えは編集 + 再ビルドか、compose.override.yaml でバインドマウント:

```yaml
services:
  mitmproxy:
    volumes:
      - ${HOME}/.config/devsbx/my-policy.json:/etc/mitm-proxy/policy.json:ro
```

作業コンテナのマウント範囲と同じパスを指してはいけない。mitmproxy の `-s` スクリプトは hot reload するため、作業コンテナからアドオンを編集できると ACL が効かなくなる。

## アドオンの構造

`policy.py` がエントリ。実行順序: `SniGuard → HostSanGuard → CommonPolicy → HeaderInjector → AccessLog`

| モジュール | 役割 |
|---|---|
| `policy.py` | mitmdump エントリ |
| `config.py` | policy.json + 環境変数からの設定読み込み |
| `audit.py` | logger + `deny()` ヘルパ |
| `rules.py` | `Match` / `InjectRule` のマッチングプリミティブ |
| `host_utils.py` | `real_host` / `host_header_host` / mitm.it 判定の helper |
| `sni_guard.py` | TLS SNI と CONNECT target の不一致を 403 で拒否 |
| `host_san_guard.py` | Host ヘッダが上流 cert SAN に無い場合を 403 で拒否 |
| `common.py` | trusted / allow_rules / readonly / 原則拒否 の 4 段判定 |
| `header_inject.py` | allow されたリクエストにヘッダ注入 |
| `access_log.py` | レスポンスを 1 行 INFO で記録 |

レシピ側で policy 生成マクロを追加するには `POLICY_MACROS` 環境変数を使う。マクロは環境変数からルール (`allow_rules` / `header_inject` 等) を生成し、起動時に policy へマージされる。

## audit log

`docker compose logs -f mitmproxy` で確認できる。

| 接頭辞 | 意味 | レベル |
|---|---|---|
| `[mitm-proxy] config loaded: ...` | 起動時の policy + env 状態 | INFO |
| `[mitm-proxy] macro rule: ...` | マクロが生成したルール (起動時の確認用、secret は伏せる) | INFO |
| `[mitm-proxy DENY <status>] ...` | 拒否したリクエスト | WARNING |
| `[mitm-proxy INJECT] ...` | ヘッダ注入したリクエスト (値は出さずヘッダ名のみ) | INFO |

## env_file

```
~/.config/devsbx/mitm-proxy.env
```

デフォルトでは何も注入しないため必須ではない。`header_inject` で `${VAR}` を使う場合のみ必要。`required: false` で読むため、不在でも起動する。

```sh
mkdir -p ~/.config/devsbx
cp lib/mitm-proxy/.env.example ~/.config/devsbx/mitm-proxy.env
chmod 600 ~/.config/devsbx/mitm-proxy.env
```

## 起動時の挙動

### CA bootstrap

- mitmproxy が名前付きボリューム上に CA を自動生成 (初回のみ)
- 作業コンテナが `http://mitm.it/cert/pem` から CA 証明書を取得 → `update-ca-certificates` で統合
- 言語ランタイム別に環境変数をセット (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`)
- CA 取得に失敗したら `exit 1` で停止する
