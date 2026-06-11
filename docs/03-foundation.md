# 基礎技術: Docker + internal ネットワーク

前章 [02-design.md](./02-design.md) では「信頼境界をプロキシ群に置き、作業コンテナ自身は認可を制御できない」設計原則と、それが依拠する信頼前提として 3 層 (基盤 / プロキシ / 上流) を述べた。本章はそのうち **条件 1 (基盤技術)** の中身を解像度を上げて記述する。具体的には Docker + Docker Compose + Docker ネットワークが提供するメカニズムが、本リポジトリで何を担っているかを整理する。

## 1. 章のスコープ

本リポジトリの全レシピは、以下 2 つの基盤に依拠している:

- **Docker engine + Docker Compose** — コンテナの起動・停止・ライフサイクル管理 / イメージビルド / ボリュームマウント / バインドマウント
- **Docker ネットワーク (特に `internal: true`)** — コンテナ間 / コンテナ→外部 の通信制御

このうちレシピが信頼境界の構造として使うのは後者で、本章では `internal: true` を中心に、本リポジトリで何度も登場する **二層ネットワークパターン** と、HTTPS_PROXY 設定下での **内部ホスト名の慣習 (`.devsbx.internal`)** を扱う。

## 2. Docker ネットワークの `internal: true`

### 2.1 デフォルトの bridge ネットワーク

Docker Compose で `networks:` 指定なしにサービスを起動すると、各サービスはプロジェクト名 + `_default` の bridge ネットワークに参加する。bridge ネットワークはデフォルトで **外部への外向き通信を許可** しており、コンテナ内から `curl https://example.com` も `npm install` も通常通り通る。

これは「開発できる devcontainer」としては自然なデフォルトだが、[01-problem.md](./01-problem.md) で見た通り、任意の外向き通信は AI エージェント経由の漏洩経路として無視できない。

### 2.2 `internal: true` による外部遮断

Docker Compose のネットワーク定義で `internal: true` を付けると、そのネットワークは **デフォルトゲートウェイを持たず、コンテナから外部 IP に届く経路自体が消える**:

```yaml
networks:
  internal-net:
    internal: true
```

`internal: true` なネットワークにしか参加していないサービスは、`curl https://example.com` でも `git fetch git@github.com:foo/bar.git` でも、ICMP / TCP / UDP どの層でも外部に出られない。これはプロキシ設定 (HTTPS_PROXY 等) を **コンテナ内から書き換えても変わらない** ことが重要で、ネットワークスタック層で経路が無いため、エージェントがいくら頑張っても外に出る術が無い状態を作れる。

外部 IP への直接経路だけでなく、名前解決を悪用する DNS トンネリング (`<エンコードした内部データ>.attacker.example` の解決を繰り返して攻撃者の権威 DNS にデータを渡す経路) も塞がれている。`internal: true` ネットワークでは Docker の埋め込みリゾルバ (`127.0.0.11`) が外部名のクエリを上流へ転送しないため、外部ドメインの解決は `SERVFAIL` で失敗する (内部エイリアス `*.devsbx.internal` の解決は効く)[^dns-internal]。

これらが本リポジトリの「作業コンテナはプロキシ経由でしか外に出られない」のネットワーク層での根拠となる。

[^dns-internal]: 内部ネットワークからの上流転送停止は Moby 26.0.0 / 25.0.5 / 23.0.11 で CVE-2024-29018 の対策として入った ([moby/moby#46609](https://github.com/moby/moby/pull/46609))。それ以前は、ホスト OS が loopback 上の forwarding resolver (`127.0.0.53` 等) を使う構成だと internal ネットワークからの DNS がホスト OS 側の namespace 経由で外部へ転送されえた。Docker Desktop は RFC 1918 アドレス上で内部リゾルバを動かすため元々影響を受けない。バージョン依存である以上、新しい Docker / Docker Desktop を保つことが §5 の条件 1 (Docker ネットワーク隔離に脆弱性がない) の運用面の前提となる。

## 3. 二層ネットワークパターン

実際のレシピでは、`internal: true` だけでは作業コンテナがプロキシにも到達できないので、**作業コンテナとプロキシの間の通信路** を別途用意する。基本形は以下:

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

注意したいのは、本リポジトリの隔離が **プロキシ設定 (HTTPS_PROXY) でプロキシ経由を強制している** のではなく、**外部 IP への経路自体を消している** という点である。HTTPS_PROXY 設定だけだと、エージェントが `unset HTTPS_PROXY` してからソケットを直接開けば迂回可能になる。

`internal: true` はネットワーク層でこの迂回経路を消し、HTTPS_PROXY 設定は「プロキシにどうリクエストを投げるか」のクライアント側都合に過ぎなくなる。

```bash
# 作業コンテナ内でエージェントがプロキシ設定をバイパスして直接ソケットを開いても、
# 外部に届く経路自体が無いため失敗する
unset HTTPS_PROXY HTTP_PROXY
curl https://1.1.1.1
# → Network unreachable (ENETUNREACH、外部 IP 宛の経路自体が存在しない)
```

これが [02-design.md](./02-design.md) §4 の評価軸 (「作業コンテナはプロキシのみと通信する」「ACL はプロキシ側で評価する」) でいう「作業コンテナ内で迂回できない」の根拠。

## 4. 補助: HTTPS_PROXY と内部ホスト名

二層ネットワークパターンではプロキシ経由の外向き通信を促すため、作業コンテナに HTTPS_PROXY を渡す:

```yaml
environment:
  HTTP_PROXY: http://proxy:3128
  HTTPS_PROXY: http://proxy:3128
  NO_PROXY: ""
```

この設定下では、**プロキシ自身を含む内部サービスへのリクエストもプロキシ経由になる** という副作用がある。たとえば作業コンテナ内から `http://mcp-github-proxy:8000/mcp` を叩くと、そのリクエストは `HTTPS_PROXY` 経由で外部プロキシに送られ、外部プロキシが `mcp-github-proxy` を解決できずに失敗する。

### 4.1 `.devsbx.internal` 慣習

これを避けるために、本リポジトリでは内部サービスに **`.devsbx.internal` 接尾辞** を持つネットワークエイリアスを付与する慣習を採用している:

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

[02-design.md](./02-design.md) §2.1 で信頼する 3 層の条件 1 を、本章のメカニズムに対応させて具体化する。本リポジトリのレシピがこの前提を保つには、以下が成立している必要がある:

- **Docker engine / Docker Compose のネットワーク隔離に脆弱性がない** — `internal: true` なネットワークからデフォルトゲートウェイ経由で外に出る抜け道が無いこと
- **コンテナランタイム (containerd / runc 等) のプロセス分離に脆弱性がない** — 作業コンテナからホスト OS のネットワークスタックを直接操作できないこと
- **ホスト OS のカーネルが信頼できる** — Linux カーネルの network namespace 分離が機能していること

これらは Docker / containerd / カーネルエコシステムの責任範囲で、本リポジトリのレシピが個別に検証する対象ではない。CVE 等で破られた場合、本リポジトリの前提 ([02-design.md](./02-design.md) §2.1) も同時に成立しなくなる。

実用上は: **ホスト OS (カーネル) / 公式 Docker engine / Docker Compose を最新に保つこと** が条件 1 の運用面の実装となる。

## 6. 次の章への接続

次章以降は本章で導入した二層ネットワークパターンを **どう活用するか** に進む。

- [04-mcp-proxy.md](./04-mcp-proxy.md) — 基本コンポーネント mcp-proxy の設計
- [05-mitm-proxy.md](./05-mitm-proxy.md) — 基本コンポーネント mitm-proxy の設計
- [06-cloud-mcp.md](./06-cloud-mcp.md) 以降 — レシピ各論
