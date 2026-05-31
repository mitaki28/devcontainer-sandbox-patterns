# レシピ: web fetch を特化 MCP に集約する

本章は **「任意ホスト fetch を諦める」設計判断** が主題。前章 ([06-cloud-mcp.md](./06-cloud-mcp.md)) と同じく mcp-proxy の応用だが、こちらは設計判断そのものを語る思想寄りの章になる。

## 1. 任意ホスト fetch は本リポジトリの枠外

本書の安全性モデル ([02-design.md](./02-design.md) §2) は「境界の上流が信頼でき、限定列挙されている」ことを前提にしている。web fetch (= 任意 URL の HTTP GET) はこの前提と構造的に相容れない。ホスト集合が任意である時点で「境界ドメインを信頼できる先に限定する」評価軸が成立しないからで、これは [02-design.md](./02-design.md) §2.3 で既に「対象外」として明示してある。

任意ホスト fetch を安全に扱うには別の保証の枠組み (Safe Browsing 等の事前チェック、LLM ベースの URL 判定など) が要るが、これは本リポジトリの責任範囲外。本章では代わりに、**任意ホスト fetch を諦める** という選択を採る。

## 2. アプローチ: 特化 MCP に集約 + 組み込み WebFetch を無効化する

考え方はシンプルで、**「検索 + 取得をワンセットで提供する特化 MCP」だけを許可する** 形に倒す。Context7 (パッケージドキュメント) / GitHub MCP (リポジトリ / issue / PR) / DeepWiki (ドメイン特化) などが該当する。

ここで「検索 + 取得をワンセット」が要点で、検索だけ MCP と取得だけ MCP を別々に組み合わせると、検索結果が任意ドメインを返してきて任意ホストに対する fetch が必要になる。検索の結果が取得の許可リストに収まるよう、同じ MCP に閉じている必要がある。

これと併せて、Claude Code 組み込みの `WebFetch` (任意 URL の HTTP GET) は `.claude/settings.json` の `permissions.deny` で無効化する:

```json
{
  "permissions": {
    "deny": ["WebFetch"],
    "allow": ["mcp__context7__resolve-library-id", "mcp__context7__query-docs"]
  }
}
```

`deny` は `allow` より優先されるため、組み込み `WebFetch` は確実に塞がれる。MCP ツール側は `mcp__<server>__<tool>` 形式の別軸で、ここに特化 MCP のツールだけを明示的に許可しておくと、他の MCP ツールが増えても自動許可されない。

なお `WebSearch` は Anthropic サーバ側で完結し devcontainer からの外向き通信を経由しないため、本レシピでは拒否しない。

## 3. 実装手段

本章のアプローチは認証パターン的には [04-mcp-proxy.md](./04-mcp-proxy.md) の api-key パターンと同じなのでレシピディレクトリは持たない。実際に Context7 を組むには、[`lib/mcp-proxy/examples/api-key/`](../lib/mcp-proxy/examples/api-key/) のテンプレを Context7 バックエンド (`https://mcp.context7.com/mcp`) に差し替え、`.claude/settings.json` を上記 (§2) の形にすればよい。`integrated/single-workspace/` には Context7 バックエンドを組み込み済みなので、動作する具体例はそちらを参照。

## 4. 限界とフォールバック

このアプローチが届く範囲は **特化 MCP のカバレッジに収まる用途** に限られる。公式パッケージドキュメント / GitHub リポジトリ / 各種ドメイン特化情報などはここに乗るが、一般のブログや Stack Overflow 回答、個別企業のドキュメントのような未知領域の調査には届かない。

その場合のフォールバックは作業を中断してホスト側で自分で調べることになる。任意ホスト fetch を本書の枠内に取り込もうとする場合は、別の保証の枠組み (Safe Browsing 等の事前チェック、LLM ベースの URL 判定など) と組み合わせる必要があり、本書の安全性モデルでは扱えない領域となる。詳細は付録 [incomplete-fetch-mcp.md](./appendix/incomplete-fetch-mcp.md) を参照。

## 5. 次の章への接続

本章と前章 (cloud) はどちらも mcp-proxy の応用だった。次章は同じアウトバウンド軸でもプロキシの種類を切り替え、git transport 専用の用途特化プロキシを扱う。

- [08-git-gateway.md](./08-git-gateway.md) — Git transport の隔離
