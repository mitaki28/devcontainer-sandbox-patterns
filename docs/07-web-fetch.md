# レシピ: web fetch を特化 MCP に集約する

本章は **任意ホスト fetch を諦める** 設計判断が主題。

## 1. 任意ホスト fetch は本リポジトリの枠外

本書は原則拒否 + 許可リスト方式を取り ([02-design.md](./02-design.md) §3.1)、通信先を信頼できる対象として限定列挙する前提に立っている (同 §2)。任意 URL の HTTP GET は通信先が任意になる時点でこの前提が崩れるので、本章では任意ホスト fetch を諦めるという選択を採る。

## 2. 方針: 特化 MCP に集約する

「検索 + 取得をワンセットで提供する特化 MCP」だけを許可する。Context7 (パッケージドキュメント) / GitHub MCP (リポジトリ / issue / PR) / DeepWiki (ドメイン特化) などが該当する。

「検索 + 取得がワンセット」が要点で、検索と取得を別々の MCP に分けると、検索結果が任意ドメインを返してきて結局任意ホストへの fetch が必要になる。

## 3. 実装手段

認証パターンは [04-mcp-proxy.md](./04-mcp-proxy.md) の api-key パターンと同じなのでレシピディレクトリは持たない。[`lib/mcp-proxy/examples/api-key/`](../lib/mcp-proxy/examples/api-key/) と同様の構成で Context7 バックエンドに差し替えれば動く。`integrated/single-workspace/` には組み込み済み。

## 4. 限界とフォールバック

特化 MCP のカバレッジに収まる用途に限られる。一般のブログや Stack Overflow、個別企業のドキュメントのような未知領域の調査はできない。任意ホスト fetch を扱うには別の保証の枠組み (Safe Browsing / LLM ベースの URL 判定等) が要り、本書のスコープ外になる。

## 5. 次の章への接続

次章は git transport 専用の用途特化プロキシを扱う。

- [08-git-gateway.md](./08-git-gateway.md) — Git 向けのカスタムプロキシ
