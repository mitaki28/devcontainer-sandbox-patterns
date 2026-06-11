# alternatives/fetch-mcp/ — 自前 fetch MCP (未完成扱い)

任意 URL の fetch 機能を **作業コンテナ外側の自前 MCP** として提供し、組み込み `WebFetch` を `permissions.deny` で無効化した上でその機能を限定的に復活させる試作。特化 MCP (Context7 / GitHub MCP / DeepWiki 等) で賄えない「未知 URL の調査」用途 (一般のブログ / Stack Overflow 回答 / 新規技術記事等) を補おうとしたもの。

本書の前提と保証 (境界の上流が信頼でき限定列挙されている) と任意ホスト fetch は構造的に相容れないため、本レシピは **未完成扱い** として保持している。採用判断のトレードオフ (プロンプトインジェクションによる攻撃面拡大 / 内部情報の外部流出経路の新設 / 応答品質の低下) と「別の保証の枠組みが要る」議論は docs 付録で扱う:

- [docs/appendix/incomplete-fetch-mcp.md](../../docs/appendix/incomplete-fetch-mcp.md) — 任意ホスト fetch の構造的限界と「未完成」判断の根拠

## 構成

```
alternatives/fetch-mcp/
├── README.md
├── compose.yaml                  # fetch-mcp + workspace (build context = .)
├── .mcp.json                     # 作業コンテナの MCP クライアントが読む
├── .claude/
│   └── settings.json             # WebFetch deny + mcp__fetch__* allow
├── .devcontainer/
│   └── devcontainer.json
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml           # minimumReleaseAge=10080 (7 日下限) / blockExoticSubdeps=true
├── tsconfig.json
├── src/                          # 自前 fetch MCP 本体
│   ├── index.ts                  # MCP HTTP サーバ + fetch ツール
│   ├── fetcher.ts                # HTTP fetch + サイズ上限 + Content-Type 判定
│   ├── filter.ts                 # 静的フィルタ
│   └── sanitize.ts               # HTML→Markdown
└── test/
    ├── fetcher.test.ts           # ユニットテスト
    ├── filter.test.ts            # ユニットテスト
    ├── mcp-smoke.test.ts         # 結合テスト
    ├── sanitize.test.ts          # ユニットテスト
    └── fetch-smoke.test.ts       # docker compose 経由 E2E smoke
```

## 使い方

### smoke で疎通確認

```sh
docker compose run --rm --build smoke
```

`test/fetch-smoke.test.ts` が GET / サイズ上限 / Content-Type 拒否 / リダイレクト不追従の各ケースを通す。

### devcontainer として起動

VS Code / Cursor で `alternatives/fetch-mcp/` を開き「Reopen in Container」。`compose.yaml` の `workspace` サービスが起動し、`fetch-mcp` も `depends_on` で連動起動する。

作業コンテナ内の MCP クライアントは `.mcp.json` を読み、`http://fetch-mcp:8000/mcp` を HTTP MCP として認識する。組み込み `WebFetch` は `.claude/settings.json` の `permissions.deny` で無効化されており、Claude は `mcp__fetch__fetch` 経由でのみ Web 取得が可能。

## 設計方針

### リダイレクト不追従

`fetch` ツールは HTTP のリダイレクト (3xx) を **自動追従しない**。3xx を返した場合は `status` + `location` をそのまま LLM に返し、LLM が「追うか、別 URL に変えるか、諦めるか」を判断する。

効果:

- オープンリダイレクタ・公開プロキシ・クエリパラメータ脆弱性を経由した踏み台は LLM の介入なしには成立しにくくなる (攻撃成立にプロンプトインジェクションが必要になる)
- 静的な迂回パターン検知 (短縮 URL の拒否リスト、`?url=` 等のクエリ検査) を省略し、判断は LLM 側に委ねる
- 同一ドメイン内の HTTPS 化や trailing slash 補完のような無害なリダイレクトも追わない仕様だが、LLM が一手介在で解決可能

### 静的フィルタ

| 項目 | 値 |
|---|---|
| HTTP メソッド | GET のみ |
| URL のスキーム | `https://` のみ (`http://` 不可) |
| 最大ボディサイズ | 既定 1 MB (引数で上書き可) |
| Content-Type 許可リスト | `text/html`, `text/plain`, `text/markdown`, `application/json`, `application/xml`, `application/xhtml+xml` |
| リダイレクト追従 | しない (3xx は status + location を返却) |

### サニタイズ

`text/html` / `application/xhtml+xml` の場合は Markdown 変換 + 実行・埋め込みを伴う要素の除去:

- `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>` を除去
- HTML→Markdown 変換は `turndown` 等の枯れたライブラリを使用

`application/json` 等はそのまま返す (変換しない)。

### プロキシ層を介さない

`lib/mcp-proxy/examples/` の構造 (mcp-proxy で外部バックエンドを転送) と異なり、fetch-mcp は自前バックエンドなのでプロキシ層を挟む価値がない (隔離する認証が存在しない)。fetch-mcp サービス自身が HTTP MCP として listen し、作業コンテナから直接接続する。

## ツール API

### 入力

提供するツールは 1 つのみ:

- name: `fetch`
- description: Fetch a URL and return its content. Does not follow redirects (3xx returns status + Location for the LLM to decide).
- 引数:
  - `url: string` — `https://` で始まる URL
  - `max_bytes?: number` — 取得上限 (既定 1048576 = 1 MB)

### 出力

MCP の **`content[]` + `structuredContent` 併用** で返す (MCP 2025-06-18 仕様):

- `content[0].text` — ヘッダ風メタ情報 + 本文 Markdown (人間 / LLM 可読)
- `structuredContent` — メタ情報のみ (プログラム可読 / `outputSchema` で SDK 自動検証)

本文を JSON にラップしない理由: 巨大テキストの JSON エンコード膨張と二重パースを避けるため。仕様の「後方互換のため structuredContent と同データを text にも置く SHOULD」は本レシピでは **メタ情報のみ** に適用する (本文を JSON 化すると膨張するため、SHOULD の精神である「後方互換クライアントが必要情報を text からも読める」状態は維持されている)。

### outputSchema

```json
{
  "type": "object",
  "properties": {
    "status":        { "type": "integer" },
    "location":      { "type": ["string", "null"] },
    "content_type":  { "type": ["string", "null"] },
    "original_size": { "type": ["integer", "null"] },
    "truncated":     { "type": "boolean" }
  },
  "required": ["status", "truncated"]
}
```

### `content[0].text` の形式

#### 2xx 成功

```
HTTP 200 OK
Content-Type: text/html; charset=utf-8
Original-Size: 23456 bytes
Truncated: no

---

# Markdown 化された本文
...
```

#### 3xx リダイレクト (追従しない)

```
HTTP 302 Found
Location: https://example.com/new-path

This URL returned a redirect. fetch-mcp does not follow redirects automatically.
Call fetch again with the new URL if appropriate.
```

#### 4xx / 5xx (HTTP エラーレスポンス)

```
HTTP 404 Not Found
Content-Type: text/html

(body omitted: error response)
```

`isError: true` ではなく **成功扱い** で status / メタを含めて返す (LLM がステータスコードを見て次の判断をできるように)。

#### フィルタで拒否 (HTTP リクエストを発行しない)

```
fetch-mcp filter: blocked
Reason: URL scheme is "http"; only "https" is allowed.
```

MCP の `isError: true` で返し、`structuredContent` は含めない (実 HTTP メタが存在しない)。

#### ネットワークエラー (DNS 失敗 / 接続拒否 / タイムアウト等)

```
fetch-mcp error: network failure
Reason: getaddrinfo ENOTFOUND example.invalid
```

同じく `isError: true`、`structuredContent` 無し。

## 残るリスクと判断

「実装で踏み込む範囲、受容する範囲」の判断基準:

| ケース | 扱い |
|---|---|
| 未知のオープンリダイレクタ経由の踏み台 | 受容 (リダイレクト不追従により LLM が判断に介在する経路に倒している) |
| 既知のフィッシング / マルウェアホスト | 静的フィルタでは扱えない (別の保証の枠組みの領域、[docs/appendix/incomplete-fetch-mcp.md](../../docs/appendix/incomplete-fetch-mcp.md) §4) |
| Web サーバ自身の侵害 / DNS hijack | 受容 (個人開発スコープ外、TLS 検証の範囲で扱う) |
| fetch-mcp コンテナ自身の侵害 | 受容 (fetch-mcp は別コンテナとして隔離されている) |
| プロンプトインジェクションで誘導された情報持ち出し | 構造的リスクとして受容 (採用判断の対象、[docs/appendix/incomplete-fetch-mcp.md](../../docs/appendix/incomplete-fetch-mcp.md) §3) |

## 関連

- [`../../docs/appendix/incomplete-fetch-mcp.md`](../../docs/appendix/incomplete-fetch-mcp.md) — 「未完成」判断の根拠 + 採用判断のフレームワーク
- [`../../lib/mcp-proxy/examples/api-key/`](../../lib/mcp-proxy/examples/api-key/) — MCP テンプレ (compose 構造の参考)
- [`../../integrated/single-workspace/`](../../integrated/single-workspace/) — 統合レシピ (主推奨、本レシピは組み込まれていない)
- [`../../lib/mcp-proxy/`](../../lib/mcp-proxy/) — MCP 軸の自作プロキシ (fetch-mcp は別系統)
