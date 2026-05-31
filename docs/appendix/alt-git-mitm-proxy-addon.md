# 付録: git-gateway の軽量代替 — mitm-proxy アドオンによる git transport の開放

`alternatives/git-mitm-proxy-addon/` を扱う付録。主推奨である [08-git-gateway.md](../08-git-gateway.md) の git-gateway を立てずに、mitm-proxy のアドオンとして github.com の git transport を載せる軽量代替を残す。

## このパターンの位置付け

主推奨の git-gateway は Caddy + fcgiwrap + git-http-backend + 内部の bare リポジトリ + `pre-receive` フックという構成で、ref / branch / commit 粒度の ACL を備えるフル機能版。一方、本付録の `alternatives/git-mitm-proxy-addon/` は **mitm-proxy のアドオン 1 ファイル** を載せるだけで github.com の git transport を扱う、最小構成版。

「mitm-proxy で既にホストへの外向き通信を絞っていて、git に対する細粒度 ACL までは要らない」シンプルケース向けの代替。

## 何を実現するか

- `lib/mitm-proxy` のベースイメージを継承し、`extra-addons/github.py` を 1 ファイル追加する
- `MITM_EXTRA_ADDONS=github` 環境変数で `GitHubPolicy` アドオンを載せ、github.com の git smart-HTTP を扱う
- 作業コンテナは `HTTPS_PROXY=http://git-mitm-proxy-addon:8080` 経由で外部に出る (insteadOf 書き換え不要)
- アドオンが応答時に Authorization (Basic 注入) と `ALLOWED_PUSH_REPOS` によるパスベースの push ACL を効かせる

## 主推奨に対するトレードオフ

| 観点 | 主推奨 (`git-gateway`) | 本付録 (`git-mitm-proxy-addon`) |
|---|---|---|
| 制御単位 | リポジトリ + ref + branch + commit (diff) | リポジトリ (パス) のみ |
| 構成 | Caddy + fcgiwrap + git-http-backend + 内部リポジトリ (新サービス) | mitm-proxy が既にあるならアドオン追加だけ |
| 想定ユースケース | チーム / 中規模、ref ACL が必要 | 個人 / 小規模、ref ACL が不要なケース |
| 工数 | 1 サービス立ち上げ | 既存サービスにアドオン 1 ファイル追加 |

主推奨の方が **git プロトコル層まで踏み込んだ ACL / 監査** (ref / diff スキャン等) ができる一方、本付録は **サービス数を増やさずに済む** 利点がある。両者は互いに排他で、片方を採用する想定。

git-mitm-proxy-addon のもう 1 つの意義は、本リポジトリの [05-mitm-proxy.md](../05-mitm-proxy.md) §3.3 で示した **「基本コンポーネントを薄く保ち、利用側で責務を足す」というプラグイン方式** の **実例** になっていること。`MITM_EXTRA_ADDONS` 拡張点を使ってアドオン 1 ファイルで書き込み系処理を足せる、というデモンストレーションを兼ねる。

## 採用シナリオ

- **個人 / 小規模で git push ACL がリポジトリ単位で十分** — main 直 push の禁止などが要らず、GitHub PAT スコープと `ALLOWED_PUSH_REPOS` の組み合わせで十分塞げる
- **mitm-proxy を既に立てている** — サービスを増やさずアドオン 1 つで完結させたい

逆に、チーム開発で main 保護や ref / branch 単位の push 制御が必要、push 対象の diff をスキャンしたい等のケースは主推奨 (git-gateway) を選ぶ。

## 詳細はレシピ README へ

実装の詳細 (Dockerfile でのアドオンの重ね方、`MITM_EXTRA_ADDONS` 拡張点の仕組み、GitHub PAT スコープの最小化、smoke テストの 7 ケース) と妥協点 (ref / branch ACL なし / smart-HTTP のセマンティクス解釈がプロキシに閉じる) はレシピ README にまとめてある:

- [`alternatives/git-mitm-proxy-addon/README.md`](../../alternatives/git-mitm-proxy-addon/) — git-mitm-proxy-addon の詳細と git-gateway との比較
- [`lib/mitm-proxy/README.md`](../../lib/mitm-proxy/) — ベースイメージ + `MITM_EXTRA_ADDONS` 拡張点の仕組み
