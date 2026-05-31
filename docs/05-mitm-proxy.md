# 基本コンポーネント: mitm-proxy — 粗粒度・暗黙的な操作許可

本章はもう 1 つの基本コンポーネント、**粗粒度・暗黙的な操作許可** を担う `lib/mitm-proxy` を扱う。

## 1. 章のスコープ

`lib/mitm-proxy` は、作業コンテナから外部への HTTP(S) 通信を mitmproxy で TLS 終端し、ホスト × HTTP メソッド × パスの単位で許可 / 拒否するプロキシである。

HTTP は API 呼び出しから Web ページの取得まで幅広い操作の基盤で、MCP を介さない通信 (`pnpm install` / レジストリ参照 / ドキュメント取得等) のほとんどはここを通る。AI エージェントに対する通信制御もドメイン単位での許可が典型的だが、[01-problem.md](./01-problem.md) §3.2 で見た通りドメイン粒度では粗すぎるし、秘匿情報もプロキシ側で持ちたい。そこで本プロキシはホスト × HTTP メソッド × パスまで絞れるようにし、秘匿情報の注入機能を足している ([02-design.md](./02-design.md) §3.2)。

実装は mitmproxy + 自作 Python アドオン + 宣言的なポリシー定義。具体的に何ができるかは次節の表を参照。

## 2. 機能スコープ

| できること | 概要 |
|---|---|
| TLS 終端 | mitmproxy が CONNECT を受け、偽証明書を発行して https 通信の内容を監査 |
| CA 注入 (bootstrap) | 作業コンテナ起動時に `mitm.it/cert/pem` を取得し、OS トラストストア + 各言語ランタイムの環境変数 (Node / Python / pip / cargo / git) に統合 |
| ホスト × HTTP メソッド × パスの ACL | policy.json で宣言的に書く。原則拒否をベースに、3 段の区分 (`readonly_hosts` / `trusted_hosts` / `allow_rules`) のいずれかで明示的に許可 (詳細は §3.2) |
| ヘッダ注入 | プライベートレジストリの Bearer など、ホストを限定して `Authorization` をプロキシで足す |
| 監査ログ | 拒否 / ヘッダ注入を 1 行で標準エラーに出す。秘匿値そのものは出さない |
| マクロによるポリシー拡張 | 利用側からポリシー生成マクロを追加し、固有の許可ルールを組み込める |

## 3. 設計

### 3.1 読み取りのみ許可の表現と運用方針

本リポジトリでは `readonly_hosts` を主として使う運用を推奨する ([02-design.md](./02-design.md) §3.2)。`readonly_hosts` はホストを 1 つ書くと、参照系 (GET / HEAD / OPTIONS) をパス無制限で通す。GET 等が副作用を持たない (HTTP の仕様通りに実装されている) 信頼できる通信先 ([02-design.md](./02-design.md) §2) なら、パスごとに見ずホスト単位でまとめて許可できる。一方、更新系を mitm 層で個別に許可しようとすると、ポリシーがツール固有の内部実装に依存しがちで統制が難しくなる。

MCP を介さない更新処理 (例: git push) は、用途特化のカスタムプロキシ ([08-git-gateway.md](./08-git-gateway.md)) に切り出すことで、本プロキシのポリシーは `readonly_hosts` 中心に保てる。

### 3.2 policy.json の 3 区分

policy.json では以下の 3 区分で許可を書く:

| 区分 | 許可範囲 | 用法 |
|---|---|---|
| `readonly_hosts` | ホストを 1 つ書けば参照系 (GET / HEAD / OPTIONS) のみ通す | 大半の API / レジストリの読み取り用 (例: `api.github.com`, `registry.npmjs.org`) |
| `allow_rules` | (ホスト, パス, HTTP メソッド) のマッチング条件リスト | readonly ホストへの副作用のない POST など、特定の書き込みを限定的に許可 (例: pnpm audit の POST) |
| `trusted_hosts` | ホストを 1 つ書けば全 HTTP メソッド素通し | 全 HTTP メソッドの許可が要るエンドポイントだけに絞る (例: `api.anthropic.com`) |

3 区分のいずれにもマッチしないホストは原則拒否で落ちる。

### 3.3 利用側の拡張点: POLICY_MACROS

`POLICY_MACROS` 環境変数で、利用側固有の許可ルールを追加できる。マクロは policy.json と同じ形式のルールを生成し、起動時にポリシーに組み込まれる (例: GitHub の git smart-HTTP に必要な許可 + PAT 注入)。マクロは許可を足すだけで、拒否は原則拒否に任せる。生成されたルールは起動ログで確認できる。

実例として `alternatives/git-mitm-proxy-addon/` が本イメージを継承し、git-gateway を立てずに mitm 1 サービスで git push を通す軽量代替を構成している (詳細は付録 [alt-git-mitm-proxy-addon](./appendix/alt-git-mitm-proxy-addon.md))。

## 4. ポリシー関連ファイルの配置

policy.json やマクロは `COPY` でイメージに焼き込むか、作業コンテナのマウント範囲外のパスに置くこと。作業コンテナから書き換え可能な場所に配置すると ACL を変更する抜け穴になる。

## 5. 詳細は実装側ドキュメントへ

実装詳細 (CA bootstrap / アドオン分割 / policy.json の glob 表現等) は [`lib/mitm-proxy/README.md`](../lib/mitm-proxy/) に集約してある。

## 6. 次の章への接続

ここまでで 2 つの基本コンポーネント ([mcp-proxy](./04-mcp-proxy.md) / mitm-proxy) が揃った。次章以降はこれらを組み合わせたレシピ各論に進む。

- [06-cloud-mcp.md](./06-cloud-mcp.md) — クラウド認証情報の短寿命化
