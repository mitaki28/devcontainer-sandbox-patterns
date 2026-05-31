# 基礎技術: Docker + internal ネットワーク

前章 [02-design.md](./02-design.md) において、本書の基盤技術とした Docker ネットワークについて、本リポジトリでどう使われているかを整理する。

## 1. 章のスコープ

本リポジトリの全レシピは、以下 2 つの基盤に依拠している:

- **Docker engine + Docker Compose** — コンテナの起動・停止・ライフサイクル管理 / イメージビルド / ボリュームマウント / バインドマウント
- **Docker ネットワーク (特に `internal: true`)** — コンテナ間 / コンテナ→外部 の通信制御

本章では後者の `internal: true` を中心に、本リポジトリで何度も登場する **二層ネットワークパターン** と、HTTPS_PROXY 設定下での **内部ホスト名の慣習** (`.devsbx.internal`) を扱う。

## 2. Docker ネットワークの `internal: true`

### 2.1 デフォルトの bridge ネットワーク

Docker Compose で `networks:` 指定なしにサービスを起動すると、各サービスはデフォルトの bridge ネットワークに参加し、外部への通信が通る。開発用としては自然なデフォルトだが、[01-problem.md](./01-problem.md) で見た通り、任意の外向き通信は漏洩経路になりうる。

### 2.2 `internal: true` による外部遮断

Docker Compose のネットワーク定義で `internal: true` を付けると、そのネットワークにはデフォルトゲートウェイが無く、外部 IP への経路自体が存在しない:

```yaml
networks:
  internal-net:
    internal: true
```

`internal: true` なネットワークだけに所属するサービスは、ICMP / TCP / UDP どの層でも外部に出られない。プロキシ設定 (HTTPS_PROXY) をコンテナ内から書き換えても、ネットワーク層で経路が無いので結果は変わらない。

DNS トンネリング (`<エンコードした内部データ>.attacker.example` を権威 DNS に問い合わせてデータを渡す手法) も塞がれている。`internal: true` では Docker の埋め込みリゾルバが外部名のクエリを上流へ転送しないため、外部ドメインの解決は `SERVFAIL` で失敗する (内部エイリアス `*.devsbx.internal` は解決できる)[^dns-internal]。

これが「作業コンテナはプロキシ経由でしか外に出られない」のネットワーク層での根拠になる。

[^dns-internal]: 内部ネットワークからの上流転送停止は Moby 26.0.0 / 25.0.5 / 23.0.11 で CVE-2024-29018 の対策として入った ([moby/moby#46609](https://github.com/moby/moby/pull/46609))。それ以前は、ホスト OS が loopback 上の forwarding resolver (`127.0.0.53` 等) を使う構成だと internal ネットワークからの DNS がホスト OS 側の namespace 経由で外部へ転送されえた。Docker Desktop は RFC 1918 アドレス上で内部リゾルバを動かすため元々影響を受けない。バージョン依存である以上、新しい Docker / Docker Desktop を保つことが §5 の条件 1 (Docker ネットワーク隔離に脆弱性がない) の運用面の前提となる。

## 3. 二層ネットワークパターン

`internal: true` だけでは作業コンテナがプロキシにも到達できないので、作業コンテナとプロキシの間の通信路を別途用意する。基本形は以下:

```yaml
networks:
  # 作業コンテナとプロキシが共有する内部ネットワーク。外部に出られない
  internal-net:
    internal: true
  # プロキシだけが外に出るためのネットワーク
  external-net:

services:
  proxy:
    networks:
      - internal-net    # 作業コンテナからのリクエストを受ける
      - external-net    # 上流に出る経路

  workspace:
    networks:
      - internal-net    # プロキシにしか届かない
```

このパターンで:

- 作業コンテナは `internal-net` にしか参加しないので、外部 IP には届かない
- プロキシは両ネットワークに参加し、作業コンテナからのリクエストを受けて上流に転送する
- プロキシが ACL を評価する位置に置かれる (作業コンテナから見て迂回不能)

`lib/mcp-proxy/examples/api-key` がこの最小形を直接示しており、`recipes/git-gateway/` / `integrated/single-workspace/` 等のレシピもすべてこのパターンの拡張形である。

### 3.1 「プロキシ経由を強制する」 vs 「経路自体を消す」

本リポジトリの隔離はプロキシ設定 (HTTPS_PROXY) でプロキシ経由を強制しているのではなく、**外部 IP への経路自体が無い** 点がポイントである。HTTPS_PROXY だけだとエージェントが `unset HTTPS_PROXY` して直接ソケットを開けば迂回できるが、`internal: true` ではネットワーク層に経路が無いのでそれも通らない。

```bash
# 作業コンテナ内でエージェントがプロキシ設定をバイパスして直接ソケットを開いても、
# 外部に届く経路自体が無いため失敗する
unset HTTPS_PROXY HTTP_PROXY
curl https://1.1.1.1
# → Network unreachable (ENETUNREACH、外部 IP 宛の経路自体が存在しない)
```

これが [02-design.md](./02-design.md) §1 の基本設計が成立する基盤で、プロキシ側の許可判定を作業コンテナから迂回できない構造になっている。

## 4. 補助: HTTPS_PROXY と内部ホスト名

二層ネットワークパターンでは、外向き通信をプロキシ経由にするために作業コンテナに HTTPS_PROXY を渡す:

```yaml
environment:
  HTTP_PROXY: http://proxy:3128
  HTTPS_PROXY: http://proxy:3128
  NO_PROXY: ""
```

ただし、この設定では内部サービスへのリクエストもプロキシ経由になってしまう。例えば `http://mcp-github-proxy:8000/mcp` を叩くと HTTPS_PROXY 経由で送られ、プロキシが `mcp-github-proxy` を解決できずに失敗する。

### 4.1 `.devsbx.internal` 慣習

これを避けるため、本リポジトリでは内部サービスに `.devsbx.internal` 接尾辞のネットワークエイリアスを付ける:

```yaml
services:
  mcp-github-proxy:
    hostname: github.mcp.devsbx.internal
    networks:
      internal:
        aliases:
          - github.mcp.devsbx.internal
```

MCP プロキシ群は `<provider>.mcp.devsbx.internal` の 2 段サブドメインで命名しており、`*.mcp.devsbx.internal` glob で MCP 群を一括識別できる。git-gateway や mitmproxy のような 1 種 1 個のサービスは `<svc>.devsbx.internal` の 1 段で命名する。

そして作業コンテナ側で `NO_PROXY` に `.devsbx.internal` 接尾辞を一括登録する:

```yaml
environment:
  HTTPS_PROXY: http://mitmproxy.devsbx.internal:8080
  NO_PROXY: localhost,127.0.0.1,.devsbx.internal
```

これで内部サービスへのリクエストだけ HTTPS_PROXY をバイパスし、Docker DNS で解決される。

新しい内部サービスを追加するときも、`<svc>.devsbx.internal` というエイリアスを付けるだけで NO_PROXY 設定を触らずに済む。

### 4.2 `.devsbx.internal` を選んだ理由

`.local` は mDNS (Multicast DNS) で予約されており、ホスト OS 上のリゾルバと衝突する可能性がある (macOS の `.local` 解決順序が特に厄介)。`.internal` は ICANN によって private-use TLD として予約されており [^1]、衝突リスクが低い。

「衝突しなさそうな接尾辞 + プロジェクト固有の接頭辞」という方針で `.devsbx.internal` を採用している。

[^1]: `.internal` は 2024 年 7 月 29 日の [ICANN board resolution](https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-special-meeting-of-the-icann-board-29-07-2024-en#section2.a) で private-use TLD として予約された。IETF / IANA 側の正式な Special-Use Domain Names registry への登録は別プロセスだが、慣習として広く使われている。

## 5. 本章が依拠する条件

[02-design.md](./02-design.md) §2 で前提とした Docker のネットワーク隔離について、具体的には以下が成立している必要がある:

- **Docker engine / Docker Compose のネットワーク隔離に脆弱性がない** — `internal: true` なネットワークからデフォルトゲートウェイ経由で外に出る抜け道が無いこと
- **コンテナランタイム (containerd / runc 等) のプロセス分離に脆弱性がない** — 作業コンテナからホスト OS のネットワークスタックを直接操作できないこと
- **ホスト OS のカーネルが信頼できる** — Linux カーネルの network namespace 分離が機能していること

これらは Docker / containerd / カーネル側の責任範囲で、CVE 等で破られれば本リポジトリの前提 ([02-design.md](./02-design.md) §2) も崩れる。実用上は Docker / Docker Desktop / ホスト OS を最新に保つことが本書の前提になる。

## 6. 次の章への接続

次章以降は二層ネットワークパターンの上に基本コンポーネントを載せていく。

- [04-mcp-proxy.md](./04-mcp-proxy.md) — 基本コンポーネント mcp-proxy の設計
- [05-mitm-proxy.md](./05-mitm-proxy.md) — 基本コンポーネント mitm-proxy の設計
- [06-cloud-mcp.md](./06-cloud-mcp.md) 以降 — レシピ各論
