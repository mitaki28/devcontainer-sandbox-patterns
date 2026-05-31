# alternatives/git-mitm-proxy-addon/ — mitm-proxy 上のアドオンで github.com の git transport を透過 (軽量代替)

`lib/mitm-proxy/` のベースイメージを継承し、`MITM_EXTRA_ADDONS=github` 環境変数で `GitHubPolicy` アドオンを 1 つだけ載せて github.com の git smart-HTTP を扱う構成。主推奨 [`recipes/git-gateway/`](../../recipes/git-gateway/) (Caddy + fcgiwrap + git-http-backend + 内部の bare リポジトリ + `pre-receive` フックによるフル機能版) に対する軽量代替。

主推奨とのトレードオフ (制御単位 / アトミックなロールバック / 状態のずれ / 構成の複雑さ) と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-git-mitm-proxy-addon.md](../../docs/appendix/alt-git-mitm-proxy-addon.md) — 主推奨 (git-gateway) との比較と採用シナリオ

## このレシピが提供する隔離

`recipes/git-gateway/` と同じく、**作業コンテナ側に GitHub PAT が居ない**:

- 作業コンテナは `HTTPS_PROXY=http://mitm-github:8080` 経由で外部にアクセス
- `GITHUB_PAT` / `ALLOWED_PUSH_REPOS` は mitm-github サービスの環境変数 (env_file 経由) でのみ保持され、作業コンテナには一切届かない
- 作業コンテナの git CLI は **プロキシ経由で github.com を直接叩く** (insteadOf 書き換えは不要)。mitm-github が応答時に Authorization を注入する

## 構成

```
alternatives/git-mitm-proxy-addon/
├── README.md
├── compose.yaml             # build context = リポジトリルート (lib/mitm-proxy/addons/ を COPY するため)
├── Dockerfile               # FROM mitmproxy/mitmproxy@sha256:... + COPY addons + overlay
├── policy.example.json      # github.com を readonly_hosts に含む構成
├── .env.example             # GITHUB_PAT + ALLOWED_PUSH_REPOS
├── .gitignore
├── extra-addons/
│   └── github.py            # GitHubPolicy 本体
└── test/
    ├── compose.yaml         # 閉鎖環境 smoke スタック (mock-upstream + mitm-github + smoke)
    ├── mock-upstream/       # TLS 対応の Caddy + git-http-backend (smoke 専用)
    └── smoke.sh             # 7 ケース (fetch / push 拒否 / readonly フォールバック / push 成功 / Authorization の上書き)
```

### Dockerfile の作り

`lib/mitm-proxy/addons/` (デフォルトアドオン: CommonPolicy / HeaderInjector / AccessLog + 共通ヘルパー) を `/addons` に COPY した上で、レシピ固有の `extra-addons/github.py` を **同じ `/addons` に重ねる** だけ:

```dockerfile
FROM mitmproxy/mitmproxy@sha256:...
COPY lib/mitm-proxy/addons /addons
COPY alternatives/git-mitm-proxy-addon/extra-addons/ /addons/
```

`/addons/policy.py` は lib 側そのままを使い、起動時に環境変数 `MITM_EXTRA_ADDONS=github` を渡すと `import github` が走り、`addon = GitHubPolicy()` 規約で先頭挿入される。この構造により、lib 側の policy.py / config.py / common.py 等を一切上書きする必要がなく、`extra-addons/github.py` 1 ファイルがレシピの主担当モジュールになる。

### MITM_EXTRA_ADDONS 拡張点 (lib 側の小改修)

`lib/mitm-proxy/addons/policy.py` に以下が入っている:

```python
for _name in reversed([n.strip() for n in os.environ.get("MITM_EXTRA_ADDONS", "").split(",") if n.strip()]):
    _mod = importlib.import_module(_name)
    addons.insert(0, _mod.addon)
```

環境変数が空のときは挙動変化なし (lib/mitm-proxy/ デフォルトの smoke / 利用に影響しない)。

## 動作確認

```sh
cd alternatives/git-mitm-proxy-addon && docker compose -f test/compose.yaml run --rm --build smoke
```

`test/smoke.sh` が 7 ケース (github.com fetch の許可 / `ALLOWED_PUSH_REPOS` 外の push advert + transfer の 403 / github.com 非 git GET の readonly 許可 / 非 git POST の 403 / `ALLOWED_PUSH_REPOS` 内 push 成功 / 作業コンテナの偽 Authorization の上書き) を通す。`test/compose.yaml` は `internal-net` / `external-net` とも `internal: true` の閉鎖環境で、`mock-upstream` を Docker のネットワークエイリアスで `github.com` として受けて hijack するため、実 GitHub には一切到達しない。

`mock-upstream` は `EXPECT_PAT_FOR_REPOS` で「指定リポジトリの `/<repo>.git/*` 全パスに正しい Authorization が乗っていなければ 401」を返す。したがって fetch / push が 200 で通ること自体が、アドオンの **PAT 注入がパス漏れなく機能していること** の構造的検証になる (`info/refs` だけでなくプロトコルフォールバックの `/HEAD` や dumb HTTP の `/objects/*` でも PAT が乗ること)。注入に漏れがあれば 401 が返り smoke が落ちる。

CA bootstrap / 起動性 / アドオン読み込み機構 (`MITM_EXTRA_ADDONS`) 自体は [`lib/mitm-proxy/`](../../lib/mitm-proxy/) 本家 smoke でカバーされているので本レシピの smoke では割愛している。

## env_file の配置

```sh
mkdir -p ~/.config/devsbx
cp alternatives/git-mitm-proxy-addon/.env.example ~/.config/devsbx/mitm-github.env
chmod 600 ~/.config/devsbx/mitm-github.env
# 編集して GITHUB_PAT と ALLOWED_PUSH_REPOS を埋める
```

`required: false` で読むため、env_file 不在でも通常の `docker compose up` は通る (通常の smoke は `test/compose.yaml` の閉鎖スタックに分離されており、env_file ではなく compose 内のリテラルでダミー PAT を渡して完結する)。

### GitHub PAT スコープの最小化

- Repository access: 「Only select repositories」で push 先リポジトリを選ぶ
- Repository permissions:
  - Contents: read (or read+write、push 先のみ write を有効化)
  - Metadata: read (常時必須)

GitHub PAT スコープの最小化 = `ALLOWED_PUSH_REPOS` との多層防御。

## 漏れる余地 / git-gateway/ と比べたときの妥協点

1. **ref / branch 単位の ACL が無い**: `ALLOWED_PUSH_REPOS` でリポジトリ単位までしか絞れない。許可リポジトリ内では PAT スコープ (書き込みが許されるリポジトリ / branch) が許す範囲で任意 ref に push できる。`git push origin main` を許可リポジトリに対して防ぐには PAT スコープ側で書き込みを許す ref を絞る必要がある
2. **smart-HTTP のプロトコル解釈がプロキシ側に閉じる**: アドオンが `_FETCH_MATCHERS` / `_PUSH_MATCHERS` でパス + query を判定する。マッチ漏れがあると素通しになる
3. **その他 lib/mitm-proxy/ 由来の漏れ余地**: TLS 終端 / CA 秘密鍵保管 / 等は [`lib/mitm-proxy/`](../../lib/mitm-proxy/) の同節と共通

これらが妥協できないユースケース (チーム開発で main を保護したい、ref 別に承認を要する 等) は `recipes/git-gateway/` を採用する。なお本構成は作業コンテナ → mitm → 上流 (github.com) を透過するため内部状態を持たず、git-gateway で必要なアトミックなロールバックの概念は本構成では**原理的に発生せず不要** (上流の拒否は作業コンテナに直接届く)。

## 関連

- [`../../recipes/git-gateway/`](../../recipes/git-gateway/) — フル機能版 (ref / branch 単位 ACL + アトミックなロールバック)
- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — ベースイメージ + アドオンの仕組み (`MITM_EXTRA_ADDONS` 拡張点も含む)
