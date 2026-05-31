# 付録: git-gateway の軽量代替 — mitm-proxy マクロによる git transport の開放

`alternatives/git-mitm-proxy-addon/` を扱う付録。git-gateway を立てずに、mitm-proxy のポリシー生成マクロで git transport を扱う軽量代替。

## このパターンの位置付け

`recipes/git-gateway/` は ref / commit 粒度の ACL を備えるが、構成が重い。本付録は mitm-proxy にマクロ 1 ファイルを足すだけで git transport を扱える、細粒度 ACL が不要なケース向けの代替。

## 何を実現するか

- `lib/mitm-proxy` のベースイメージに `macros/github.py` を 1 ファイル追加
- `POLICY_MACROS=github` で、github.com の git smart-HTTP に必要な許可ルールと PAT 注入を生成するマクロが有効になる
- 作業コンテナは `HTTPS_PROXY` 経由で外部に出る (insteadOf 書き換え不要)
- マクロが生成するルールが PAT 注入と `ALLOWED_PUSH_REPOS` によるリポジトリ単位の push ACL を担う。fetch は全リポジトリを通し、push は許可リポジトリのみ通す
- git transport だけを扱い、github.com の web ページは対象外

## `recipes/git-gateway/` に対するトレードオフ

| 観点 | `recipes/git-gateway/` | 本付録 (`git-mitm-proxy-addon`) |
|---|---|---|
| 制御単位 | リポジトリ + ref + branch + commit (diff) | リポジトリ (パス) のみ |
| 構成 | Caddy + fcgiwrap + git-http-backend + 内部リポジトリ (新サービス) | mitm-proxy が既にあるならマクロ追加だけ |
| 想定ユースケース | ref / branch / commit 粒度の ACL が要るケース | リポジトリ単位 ACL で十分なケース |
| 工数 | 1 サービス立ち上げ | 既存サービスにマクロ 1 ファイル追加 |

git-gateway は git プロトコル層の ACL ができるが構成が重い。本付録はサービスを増やさずに済む。両者は排他で、片方を選ぶ。[05-mitm-proxy.md](../05-mitm-proxy.md) §3.3 のマクロ方式の実例でもある。

## 採用シナリオ

- **リポジトリ単位の push ACL で十分** — ref / branch 単位の制御が不要な場合
- **サービスを増やしたくない** — mitm-proxy を既に立てていてマクロ 1 つで済ませたい場合

ref / branch 単位の制御や diff スキャンが必要なら `recipes/git-gateway/` を選ぶ。

## 詳細はレシピ README へ

実装詳細はレシピ README を参照:

- [`alternatives/git-mitm-proxy-addon/README.md`](../../alternatives/git-mitm-proxy-addon/)
