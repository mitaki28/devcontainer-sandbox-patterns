# recipes/git-gateway/ — github.com 向け git プロキシ (Caddy + fcgiwrap)

github.com 向け git transport を中継する `git-gateway` サービス。fetch は Caddy が `reverse_proxy` + PAT 注入、push は fcgiwrap 経由で `git-http-backend` を実行し `pre-receive` で ref ACL を評価する。

設計は docs 側で扱う:

- [docs/08-git-gateway.md](../../docs/08-git-gateway.md)

## 挙動の要約

- **登録リポジトリ** (`ALLOWED_REPOS`): fetch / push とも PAT 注入で上流に転送。push は pre-receive で ref ACL を評価
- **未登録リポジトリ**: 匿名 fetch のみ通る (Authorization 除去)。push は 403、git smart HTTP 以外のパスは 404

## 環境変数

- 必須: `UPSTREAM_BASE_URL`, `ALLOWED_REPOS`
- 任意: `GITHUB_PAT`, `ALLOWED_REF_PATTERNS`, `DENIED_REF_PATTERNS`, `DISABLE_POST_RECEIVE_SYNC`

`ALLOWED_REPOS` は csv で複数指定。`ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS` は pre-receive で ref を glob 照合する (両方未設定なら全 ref が通る)。

## 動作確認

```sh
cd recipes/git-gateway && docker compose run --rm --build smoke
```

`test/smoke.sh` が 10 ケースを通す (push / ref 拒否 / non-ff reject / ロールバック / 匿名 fetch / PAT 注入・除去 等)。閉鎖環境で実 GitHub には到達しない。

## 実装の罠

### Caddy + fcgiwrap を選んだ理由

Apache でも機能的には組めるが、設定ミスを取りこぼしやすい:

- **PAT 注入が黙って剥がれうる**: Apache の `<Location>` は出現順にマージされるため、共通の `unset Authorization` がリポジトリごとの `set Authorization` を上書きする順序ミスが起きる。Caddy の `handle` は先勝ち + ブロック内のみ適用なのでこの問題がない
- **上流の TLS 検証がオプトイン**: Apache は `SSLProxyVerify require` を別途書く必要がある。Caddy は既定で検証する

### push 経路の PAT 認証

entrypoint が登録リポジトリの bare リポジトリに `http.extraHeader` で `Authorization: Basic <PAT_B64>` を書き込む。URL に PAT を埋める方式と違い、プロセスリストや git エラーメッセージに PAT が出ない。

### 状態ズレ

ゲートウェイは内部に bare リポジトリを持つため、上流と状態がずれることがある (例: 古いローカルからの push → ゲートウェイ受理 → 上流 reject → pre-receive がロールバック)。`post-receive` の後追い fetch で次回 push 時に自動解消する。
