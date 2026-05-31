# recipes/

主推奨 recipe ディレクトリ。[`../lib/`](../lib/) の基本コンポーネント (`mcp-proxy/` / `mitm-proxy/`) を組み合わせて、個別ユースケースの隔離を実装する。

リポジトリ全体の構成 / 収録レシピ一覧 / 評価軸 / 思想は以下を参照:

- [`../README.md`](../README.md) — 収録レシピ一覧 (主推奨 + 統合構成 + 代替) と読み物の入口
- [`../docs/`](../docs/) — 思想・設計・各論 (`docs/02-design.md` に本書の安全性モデル)

## 主推奨 recipe

| recipe | 役割 | 説明章 |
|---|---|---|
| [`cloud-mcp-with-short-lived-credential/`](./cloud-mcp-with-short-lived-credential/) | Google Cloud MCP の credential lifetime cap | [docs/06-cloud-mcp.md](../docs/06-cloud-mcp.md) |
| [`git-gateway/`](./git-gateway/) | github.com 向け git transport の単一窓口 | [docs/08-git-gateway.md](../docs/08-git-gateway.md) |
| [`ingress-single-workspace/`](./ingress-single-workspace/) | 単独起動の作業コンテナ向けのインバウンド経路 | [docs/09-ingress.md](../docs/09-ingress.md) |
| [`ingress-multi-workspace/`](./ingress-multi-workspace/) | 並列起動の作業コンテナ向けのインバウンド経路 | [docs/09-ingress.md](../docs/09-ingress.md) |

各 recipe は単独で動作可能で、`docker compose run --rm --build smoke` (または shell script) で動作確認できる。詳細手順は recipe 直下の README を参照。

## 関連

- [`../lib/mcp-proxy/examples/`](../lib/mcp-proxy/examples/) — MCP 認証パターンの具体例 (api-key / oauth)。主推奨 recipe ではなく lib/mcp-proxy の利用例として位置付ける
- [`../integrated/`](../integrated/) — 上記 recipe + lib を 1 つの compose に統合した完成形 (`single-workspace/` 単独起動、`multi-workspace/` 並列起動対応)
- [`../alternatives/`](../alternatives/) — 主推奨に対する代替案 / 軽量版 (simple-http-proxy / dependencies-build-time / git-mitm-proxy-addon / fetch-mcp)
