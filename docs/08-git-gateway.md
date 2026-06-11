# レシピ: Git transport の隔離

本章は `recipes/git-gateway/` を扱う。これまでの章で扱ってきた基本コンポーネント (mcp-proxy / mitm-proxy) のどちらでも捌けない領域 — git transport — に対して、**用途特化のカスタムプロキシ** を自作するパターン ([02-design.md](./02-design.md) §3.2) に踏み込む。

## 1. 章のスコープ

devcontainer 内で `git fetch` / `git push` / `git clone` を成立させるとき、これまでの章で扱ってきた 2 つの基本コンポーネントではいずれも要件を満たせない:

- **mcp-proxy**: MCP プロトコル軸の境界実装で、git transport は扱えない
- **mitm-proxy**: HTTP 層 (ホスト × HTTP メソッド × パス) までしか見えないため、ref 単位の ACL や commit 内容 (push されるファイルパス・diff 等) に踏み込んだ判定が表現できない (詳細は §2)

これを解決するために、**git transport 用の用途特化カスタムプロキシ** ([02-design.md](./02-design.md) §3.2) を別レイヤとして導入する。本章はその実装である `recipes/git-gateway/` を扱う。

## 2. なぜ専用ゲートウェイが要るか

git transport 隔離の要件は次の通り:

- 作業コンテナ側に PAT を置きたくない
- 特定リポジトリにしか push させない (リポジトリ単位の絞り込み)
- push に対して **ref 単位** で ACL を効かせたい (主分岐への push を禁止、特定の ref パターンのみ許可、等)
- 必要に応じて **commit 内容** (push 対象のファイルパス、diff の中身) も検査したい (秘匿情報スキャン、特定パスへの変更禁止、等)
- fetch / clone は通常通り通したい

このうちリポジトリ単位の絞り込みは URL パスレベル (`/<owner>/<repo>.git/...`) で表現できるため、HTTP 層を見るだけの mitm-proxy 軸でも実装可能 (実例: `alternatives/git-mitm-proxy-addon/`)。一方、**ref 単位の ACL** と **commit 内容の検査** は HTTP body (git protocol の packfile / packet line) を解釈する必要があり、mitm-proxy の粒度を超える。

git push の中身を解釈するには git-http-backend 経由でリクエスト本文を読んで `pre-receive` フックで判定する必要がある。つまりゲートウェイ側で **git プロトコルで (少なくとも push 受信は) やりとりできる** 必要があり、これが「専用ゲートウェイを立てる」根拠になる。

## 3. アプローチ: 読み取り + 書き込み統合ゲートウェイ

`git-gateway` は **fetch URL = push URL = git-gateway** に揃え、作業コンテナの `gitconfig` で `insteadOf: https://github.com/ → http://git-gateway:8080/` と書き換える。作業コンテナから見ると `git fetch` も `git push` も git-gateway を叩いているだけ。

git-gateway 内部では `ALLOWED_REPOS` で **登録済みリポジトリ** と **未登録リポジトリ** を分けて扱う:

- **登録リポジトリの fetch** — Caddy が上流 (github.com) に reverse_proxy。`Authorization: Basic <PAT>` を git-gateway 側で注入する
- **登録リポジトリの push** — Caddy → fcgiwrap → `git-http-backend` でローカルの bare リポジトリに受理。`pre-receive` フックで ref 許可リスト / 拒否リストを判定し、合格すれば bare リポジトリから上流に転送 (atomic に受理 / 巻き戻し)
- **未登録リポジトリの fetch** — git smart HTTP の fetch エンドポイントに限り、`Authorization` / `Cookie` を除去して認証なしで上流に素通し (PAT は注入しない、public な読み取り用途)。git transport 以外の path (web UI / REST API 等) は 404 で、上流の web 領域への透過プロキシ経路は持たない
- **未登録リポジトリの push** — Caddy が 403

`ref / リポジトリ ACL` は `pre-receive` フックで行い、許可された ref だけを上流に転送する。PAT は git-gateway の bare リポジトリの `http.extraHeader` 経由で上流に送られ、作業コンテナ側には届かない。

## 4. 構成

![Git transport の隔離 (git-gateway) の構成図](./git-gateway.excalidraw.png)

ポイント:

- **PAT は git-gateway コンテナの環境変数に閉じる** — `~/.config/devsbx/git-gateway.env` を `env_file` で読み込み、git-gateway が bare リポジトリの `http.extraHeader` に書き込んで上流に送る。作業コンテナ側のファイルシステムにも環境変数にも PAT は入らない (`.git/config` を書き換えても PAT は手に入らない)
- **fetch URL = push URL = git-gateway** — 作業コンテナ側の `.git/config` の `insteadOf` 書き換えで実現。これにより作業コンテナから見える git remote は完全に git-gateway に閉じる
- **ref / リポジトリ ACL は git-gateway 側で評価** — 作業コンテナが `.git/config` に何を書いても、git-gateway の `pre-receive` を迂回する経路は無い

## 5. 強み: git プロトコル層まで踏み込んだ ACL / 監査

このアプローチの最大の強みは、`pre-receive` フックが **git プロトコル層 (push 内容そのもの) にアクセスできる** ことである。これにより HTTP 層では届かないきめ細かい統制が可能になる:

- **ref / branch 単位の ACL** — `ALLOWED_REF_PATTERNS` / `DENIED_REF_PATTERNS` で「`main` / `master` / tags への push は拒否、`feature/*` / `claude/*` だけ許可」のような表現ができる
- **commit 内容に踏み込んだ監査** — `pre-receive` から `git diff-tree` で push 対象の diff にアクセスできるため、秘匿情報スキャン (トークン / API キーパターンの検出) や特定パスへの変更禁止などを足す土台がある

これらの強みは §2 で示した「HTTP body を解釈する」ことで初めて成立する統制で、軽量代替 [alt-git-mitm-proxy-addon.md](./appendix/alt-git-mitm-proxy-addon.md) では届かない領域。サービス数を減らせる軽量代替を取るか、本節の強みを取って git-gateway を立てるかが採用判断の軸になる。

## 6. 評価軸との対応

[02-design.md](./02-design.md) §4 のレシピ評価軸に対する答え:

| 評価軸 | このレシピがどう満たすか |
|---|---|
| 秘匿情報は作業コンテナ外に置く | `GITHUB_PAT` はホスト側の env ファイル (`~/.config/devsbx/git-gateway.env`) に置き、`env_file` で git-gateway コンテナの環境変数に渡す。作業コンテナ側のファイルシステムにも環境変数にも入らない |
| 作業コンテナはプロキシのみと通信する | 作業コンテナは internal ネットワークに閉じ、git の外向き通信は git-gateway 経由のみ |
| ACL はプロキシ側で評価する | ref / リポジトリの許可リストは git-gateway 側 (`pre-receive` フック) で評価。作業コンテナが `.git/config` を書き換えても迂回できない |
| 境界ドメインは信頼できる先に限定する | git-gateway が出る通信先は github.com (or 設定された UPSTREAM_BASE_URL) だけ |

これまでのレシピと違い、git-gateway は **読み取り + 書き込みを同じプロキシで扱う** 構造である。git の fetch / push を同じ HTTP エンドポイントで受ける必要があるためで、書き込みの許可は `pre-receive` フックの ref ACL で評価する。

## 7. 限界: push を許可することの含意

push を許可した瞬間、そのリポジトリは **隔離の抜け穴になりうる**。現代の git ホスティング環境では、以下の経路で push が情報漏洩 / 任意コード実行の起点となる:

- **public リポジトリへの push** — push 内容がそのまま公開され、情報が露出する
- **push / PR が CI/CD のトリガーになる** — push を起点に CI 環境で任意コード実行が成立し、CI 環境からの外向き通信 / CI 環境内の秘匿情報取得が可能になる
- **CI 設定ファイル (`.github/workflows/` 等) の編集** — push でトリガー条件 / 実行内容自体を書き換えられるため、外向き通信や秘匿情報取得の制限そのものを変更できる

これらは本書のスコープ ([02-design.md](./02-design.md) §2) 外で、git-gateway の ref / commit ACL では塞ぎきれない。**最低限、private リポジトリ + CI 実行が無効化された環境** であることが本レシピの利用前提となる。public リポジトリ / CI 実行が有効な環境では、リポジトリ設定や CI 運用フロー側で別途防ぐ必要があり、それだけで本書と同等の規模のレシピ集が要る領域となる。

## 8. 詳細はレシピ README へ

実装の内部構造 (静的 Caddyfile + リポジトリごとの `import`、`http.extraHeader` 経由の PAT、上流 TLS 検証、ref / リポジトリ ACL の glob 表現、状態ズレの 4 ケース) はレシピ README に集約してある:

- [`recipes/git-gateway/README.md`](../recipes/git-gateway/) — git-gateway の詳細仕様 + 設計検討と他案との比較 + 9 ケースの smoke テストの意味

## 9. 次の章への接続

ここまででアウトバウンド軸の 3 章 (cloud / web-fetch / git) が揃った。次章は方向を反転してインバウンド軸 — 作業コンテナ内の開発サーバをホストブラウザから見る経路 — を扱う。

- [09-ingress.md](./09-ingress.md) — 開発サーバをホストブラウザに見せる
