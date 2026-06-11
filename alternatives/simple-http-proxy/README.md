# alternatives/simple-http-proxy/ — devcontainer の外向き通信を許可リストで絞る

devcontainer から外部に出るネットワーク通信を、ホスト側に立てた Squid HTTP プロキシ経由の **ホスト名の許可リスト** にだけ通す構成。主推奨の `lib/mitm-proxy/` (TLS 終端 + ホスト × HTTP メソッド × パス ACL) より軽量で、独自 CA を作業コンテナに配布せずにホスト名粒度の外向き通信制御を実現する。Squid `ssl_bump peek + splice` で TLS ClientHello の SNI だけを覗いて許可リストと突合する形を採り、CONNECT 詐称による CDN tenant pivoting をプロキシ層で塞ぐ。

主推奨に対するトレードオフ (ACL 粒度 / domain fronting 耐性 / ECH 普及後にも使い続けられるか) と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-simple-http-proxy.md](../../docs/appendix/alt-simple-http-proxy.md) — 主推奨 (mitm-proxy) との比較と採用シナリオ

## 構成

```
                ┌─────────────────────────────┐
                │ workspace (devcontainer)    │
                │ networks: [internal-net]    │
                │ HTTP(S)_PROXY=proxy:3128    │
                └──────────┬──────────────────┘
                           │ internal-net
                           │ (internal: true、ゲートウェイ無し)
                ┌──────────┴──────────────────┐
                │ proxy (Squid)               │
                │ networks:                   │
                │   - internal-net            │
                │   - external-net            │
                │ 許可リスト:                  │
                │   - api.github.com          │
                │   - registry.npmjs.org      │
                │   - ...                     │
                └──────────┬──────────────────┘
                           │ external-net
                       インターネット
```

```
alternatives/simple-http-proxy/
├── compose.yaml           # proxy + workspace + 2 networks (devcontainer 起動用)
├── Dockerfile.squid       # debian:trixie-slim + squid-openssl + 内部用 CA 生成
├── squid.conf             # peek-and-splice + 二重 ACL (dstdomain / ssl::server_name)
├── allowed-hosts.txt      # 許可リスト単一ソース (dstdomain / ssl::server_name 両方から参照)
├── .devcontainer/
│   └── devcontainer.json  # 作業コンテナを devcontainer として起動
└── test/
    ├── compose.yaml                 # smoke 専用スタック (proxy + mock-target + smoke)
    ├── Dockerfile.mock              # mock-target イメージ (node:22-slim + openssl)
    ├── mock-entrypoint.sh           # 起動時に自己署名証明書を生成 → node /app/mock-server.ts 起動
    ├── mock-server.ts               # node:https.createServer で 443 TLS リスナー
    ├── allowed-hosts.smoke.txt      # smoke 用の許可リスト (mock-target.test のみ)
    └── network-smoke.test.ts        # 4 ケース
```

## 使い方

### smoke で疎通確認

```sh
docker compose -f test/compose.yaml up --build --abort-on-container-exit smoke
```

`test/compose.yaml` は `compose.yaml` (devcontainer 起動用) と独立したスタックで、攻撃シナリオ (CONNECT 詐称) を再現する smoke を devcontainer 側の作業コンテナと compose プロジェクトごと分離する。プロキシの `Dockerfile.squid` / `squid.conf` は `build.context: ..` で共有しているため、smoke 側のプロキシ構成が本体からずれない。

`test/network-smoke.test.ts` が 4 ケース (許可ホストへの HTTPS 到達 / 未許可ホストの拒否 / `internal: true` による直接 TCP の外向き通信失敗 / **CONNECT 詐称が ssl_bump terminate で塞がれる**) を通す。スタック内では:

- プロキシは `allowed-hosts.txt` の代わりに `test/allowed-hosts.smoke.txt` (`mock-target.test` のみ) をバインドマウントで参照
- `mock-target.test` を `mock-target` サービスの Docker ネットワークエイリアスに振り、`external-net` も `internal: true`

ため、smoke 中のトラフィック (正常系の HTTPS / CONNECT 詐称の試行) はいずれも実外部サーバーに到達しない (RFC 6761 で `.test` TLD は予約)。

### devcontainer として起動

VS Code / Cursor で `alternatives/simple-http-proxy/` を開き「Reopen in Container」。`compose.yaml` の `workspace` サービスが起動し、`proxy` も `depends_on` で連動起動する。作業コンテナの `HTTP(S)_PROXY` は環境変数で渡るので、プロキシ設定を読む CLI (curl, wget, git, npm 等) はそのまま許可リスト経由で動く。

## 信頼の前提

このレシピは **「Docker (dockerd / network namespace) の隔離を信頼する」** 前提に立つ。

- 作業コンテナを Docker の internal ネットワークに閉じ込めている限り、作業コンテナ内の root であっても外部 IP に直接ソケットを開けない
- 漏れるのはプロキシ経由で許可された通信だけ
- 「カーネルの脆弱性 / docker socket への不正アクセスで netns を抜けられる」ケースは **本レシピのスコープ外**

devcontainer を使うこと自体が docker のセキュリティ前提に乗っているため、ここに信頼境界を置くのが自然。少数の前提を明示して上に積む方が、限界が分かりやすい。

## 採用方式

### L3/L4 部分: Docker `internal: true` ネットワーク

- compose で作業コンテナは `internal: true` なネットワークのみに所属させる
- internal ネットワークはデフォルトゲートウェイを作らないため、外部 IP 宛のパケットはルーティングテーブル上送り先がなく `ENETUNREACH` で即時失敗する
- iptables / nftables のルールを書かずに、宣言的に「作業コンテナを外に出させない」状態を作れる
- 本質的に `iptables -A OUTPUT -j DROP` 相当だが、netns 単位で効くためコンテナ内の root でも回避できない

### L7 部分: Squid (二重 ACL: dstdomain + ssl::server_name)

- プロキシコンテナは internal-net + external-net の両方に足を持つ
- 作業コンテナは `HTTP_PROXY` / `HTTPS_PROXY` 環境変数経由でプロキシにアクセス
- Squid は **CONNECT 行 (CONNECT レベル) と ClientHello SNI (TLS レベル) の両方** を独立に検査する。これらは異なる脅威を防ぐ独立した防御層:
  - `dstdomain` で CONNECT 行のホスト名 (= TCP の実宛先を決める値) を許可リストと照合し、合致しなければ http_access が 403 で拒否。**攻撃者が制御する任意ホストへの CONNECT をプロキシが中継してしまう経路** を塞ぐ
  - `ssl_bump peek step1 + splice/terminate` で ClientHello の SNI を覗き、`ssl::server_name --client-requested` で **クライアントが送った SNI 値だけ** を許可リストと照合。合致したら `splice` (透過転送)、合致しなければ `terminate` (TCP 切断)。**許可ホストの IP に届いた後、SNI で同一 CDN 上の攻撃者の tenant に飛ぶ CONNECT 詐称 (= CDN tenant pivoting)** を塞ぐ
- TLS 復号は一切行わない (splice = 透過転送) ため、**作業コンテナ側への独自 CA 配布は不要**
- Docker ネットワーク DNS がホスト名 → IP 解決を握っているため、CONNECT 引数を偽装して別 IP に飛ばす経路は無い (DNS hijack 不可前提)

### 許可リストの単一ソース化

dstdomain と ssl::server_name は **同じホストリスト (`allowed-hosts.txt`)** を参照する。両者は異なるレイヤで異なる脅威を防ぐ独立した防御層だが、ホストリスト自体は同じものを使うのが自然。外部ファイル化することで:

- 許可リスト更新時の編集箇所が 1 個所に集約
- 「dstdomain 側と ssl::server_name 側でホストがずれる」事故を構造的に防ぐ
- `acl ... --client-requested "/path"` 形式でパス指定するだけ

### `ssl::server_name --client-requested` の意義

`ssl::server_name` はデフォルトでは **CONNECT URI / SNI / サーバ証明書の subject の OR でマッチ** する (= 複数の判定軸を 1 つの ACL 名で兼ねた挙動を持つ) ため、知らないうちに CONNECT URI とマッチしてしまい dstdomain と機能重複し、SNI 検査軸の独立性が崩れる落とし穴がある。`--client-requested` フラグで **「クライアントが ClientHello で送ってきた SNI 値のみ」** に判定根拠を限定することで、`dstdomain = CONNECT 検査` / `ssl::server_name --client-requested = SNI 検査` の役割分担が明示的に保たれる。

### `squid-openssl` パッケージと内部用 CA

`ssl_bump` を有効化するため debian の `squid-openssl` パッケージが必要 (`squid` ではなく openssl リンク版)。Dockerfile で内部用 CA を自己署名生成しているが、これは `ssl_bump` モード起動時の `cert= / key=` 引数を満たすための体裁であり、splice-only 動作中は実際にクライアント / サーバに提示されない (= 作業コンテナへの CA 配布は不要)。

## L3/L4 と L7 の役割分担

| 層 | 担当 | 性質 |
|---|---|---|
| L3/L4 (Docker internal ネットワーク) | プロキシ以外への外向き通信を全拒否 | 粗い網、しかし破られない |
| L7 (Squid + SNI 許可リスト) | ホスト名単位の許可リスト | 細かい網、動的 IP / 共用 IP / パス ACL に対応 |

両者は併用前提で、片方だけだと穴が残る:

- **L3/L4 単独**: 「動的 IP の追従」を自前で書く必要がある。CDN / Anycast IP では起動時 `dig` のスナップショットだけだと TTL 切れ後の新 IP に追従できない
- **L7 単独**: `HTTP_PROXY` を尊重しないアプリはプロキシをバイパスできる

L7 が解決する、L3/L4 では原理的に困る問題:

| 問題 | L3/L4 の限界 | L7 がやれること |
|---|---|---|
| 動的 IP (CDN/Anycast) | 起動時のスナップショットしか持てない | ホスト名でマッチするので IP 変化に追従 |
| 共用 IP | `api.github.com` と `attacker.github.io` が同じ Fastly IP | SNI / Host で宛先ホスト名を識別 |
| パス単位のポリシー | 不可能 | URL パスで ACL 可能 |
| DNS 漏洩経路 | 53 を塞ぐと正常な名前解決まで使えなくなる | プロキシ側で名前解決し、作業コンテナに DNS させない設計が可能 |
| 監査ログ | パケットメタデータのみ | URL レベルのアクセスログ |

## 漏れる余地 / 限界

1. **classic domain fronting (CDN 層)**: 同一 TLS セッション内で SNI ≠ `Host` ヘッダを送って CDN を騙す古典的な攻撃。プロキシ側では検出できず、上流 CDN の SNI = `Host` 検証に依拠して塞ぐ (主要 CDN は実装済み、小規模 / 自社運用のリバースプロキシを許可リストに入れる場合は要注意)。詳細は [docs 付録「プロキシ層と CDN 層の責任分担」](../../docs/appendix/alt-simple-http-proxy.md#プロキシ層と-cdn-層の責任分担)
2. **HTTP メソッド / パス粒度の ACL は無い**: ssl_bump splice = TLS 透過なので、許可したホストに対する個別エンドポイントの制御はできない (例: github.com の特定リポジトリだけ許可、は不可能)。粒度が要るなら主推奨 `lib/mitm-proxy/` (TLS 終端してホスト × HTTP メソッド × パス ACL)
3. **ECH 普及後の機能後退**: ECH (Encrypted ClientHello, TLS 1.3 拡張) 普及後は peek で見える SNI が outer SNI までになり、tenant 粒度の許可リストが構造的に成立しなくなる。本構成の選択根拠そのものを見直す必要が出る。詳細は [docs 付録「プロキシ層と CDN 層の責任分担」](../../docs/appendix/alt-simple-http-proxy.md#プロキシ層と-cdn-層の責任分担)
4. **プロキシ自身の侵害**: プロキシコンテナは両ネットワークに足を持つので、ここを取られると外に直接出られる。緩和: イメージを最小化、プロキシに PAT 等の秘匿情報を載せない (`lib/mcp-proxy/examples/` の責務と分離)
5. **アクセスログを無効化している**: `proxy` ユーザは `/dev/stdout` を直接書けないため、`access_log none` で起動している。`docker logs` には Squid の起動メッセージは出るが、誰がいつ何の URL を叩いたかは残らない。必要なら `access_log /var/log/squid/access.log` に切り替えて `docker compose exec proxy tail -f /var/log/squid/access.log` で見る
6. **ビルドフェーズの外向き通信**: devcontainer のイメージビルド / features インストール時に必要な外向き通信は別途考慮が必要。プロキシ経由にするには `docker build --build-arg HTTP_PROXY=...` や buildkit 設定が要る
7. **Docker / カーネルそのものの侵害**: 上述の通り本レシピのスコープ外。これを心配する場合は VM 隔離など別アプローチが必要

## 関連

- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — 主推奨 (TLS 終端 + ホスト × HTTP メソッド × パス ACL)。本レシピがホスト粒度の splice で止まるのに対し HTTP メソッド / パス単位の細粒度 ACL + 書き込みの個別許可まで踏み込める
- [`../../lib/mcp-proxy/`](../../lib/mcp-proxy/) — MCP 軸の自作プロキシ (直接の依存関係はない、同じ「信頼境界をプロキシ群に置く」思想)
- [`../../lib/mcp-proxy/examples/`](../../lib/mcp-proxy/examples/) — MCP トークンの隔離 (同じ思想の応用)
