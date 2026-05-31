# 付録: 独自 CA 不要の mitm-proxy 代替 — Squid + SNI 許可リストによる HTTP プロキシ

`alternatives/simple-http-proxy/` を扱う付録。主推奨である [05-mitm-proxy.md](../05-mitm-proxy.md) の mitm-proxy より **軽量** で、**作業コンテナ側への独自 CA 配布を必要としない** SNI 許可リスト方式の外向き通信制御を残す。

## このパターンの位置付け

主推奨の mitm-proxy は TLS 終端 + HTTP メソッド × ホスト × パスの ACL を効かせる構成だが、CA bootstrap や各言語ランタイムへの証明書注入など、構築コストがそれなりにかかる。一方、本付録の `alternatives/simple-http-proxy/` は **Squid HTTP プロキシ + Docker internal ネットワーク** の組み合わせで、TLS は復号せず ClientHello の SNI だけを覗いてホスト名単位の外向き通信の許可リストを実現する。

「ホスト名粒度の許可リストで十分」「mitm の TLS 終端を避けたい」用途に対する代替パターン。

## 何を実現するか

- 作業コンテナは `internal: true` なネットワークに閉じ、`HTTP_PROXY` / `HTTPS_PROXY` 経由で Squid を叩く
- Squid は 2 段の独立した防御層でホスト名を検査:
  - **CONNECT 行 (CONNECT レベル)** を `dstdomain` の許可リストで照合 → 攻撃者制御のホストへの CONNECT を 403 で拒否
  - **TLS ClientHello SNI (TLS レベル)** を `ssl_bump peek step1` で覗き、`ssl::server_name --client-requested` の許可リストで照合 → CDN tenant pivoting を terminate で拒否
- 両 ACL は **同じ許可リスト 1 つ (`allowed-hosts.txt`)** を参照する (ずれを防止)
- TLS 復号は一切行わない (splice = 透過転送)、作業コンテナ側への独自 CA 配布は不要

## 主推奨に対するトレードオフ

| 観点 | 主推奨 (mitm-proxy) | 本付録 (Squid peek-and-splice) |
|---|---|---|
| TLS 終端 | する (内容を ACL) | しない (peek で SNI だけ覗いて splice で透過) |
| **作業コンテナ側 CA 配布** | **必要** (各言語ランタイムへの証明書注入 + 漏れによる動作不安定リスク) | **不要** |
| ACL 粒度 | ホスト × HTTP メソッド × パス | ホストのみ (CONNECT + SNI の両方を検査) |
| CONNECT 詐称耐性 (プロキシ層) | ✓ (TLS 終端時に `Host` / SNI 検証) | ✓ (peek + ssl::server_name --client-requested で SNI 検証) |
| classic domain fronting 耐性 (CDN 層, SNI ≠ `Host`) | ✓ (TLS 内容を ACL) | △ (上流 CDN の SNI = `Host` 検証に依拠) |
| ECH 普及後の生存性 | ◎ (作業コンテナ ⇔ プロキシ間 TLS は ECH 不要) | △ (peek が outer SNI までしか見えない) |
| 構築コスト | 中 (mitmproxy + アドオン + CA bootstrap) | 小〜中 (squid-openssl + 設定ファイル 2 つ、内部用 CA をビルド時に生成) |

主推奨 (mitm) の方が **HTTP メソッド / パス粒度の ACL** が効くため、外部書き込み系を細かく制御したいケースで優位。本付録は **作業コンテナ側に CA を配らない簡素さ** と、CONNECT 詐称対策がプロキシ層で完結する点が利点。

CA 配布の重さは「初期構築コスト」だけでなく、各言語ランタイム (Node / Python / Go / Java / Rust / シェルツール) ごとのトラストストアにそれぞれ注入が必要で、いずれかが漏れると当該ツールが TLS で動かなくなる **運用上の不安定要因** として継続的にコストになる。これを払いたくない用途には本付録は選択肢となりうる。

## プロキシ層と CDN 層の責任分担

トレードオフ表で挙げた攻撃面と防御層の対応:

- **CONNECT 詐称 (プロキシ層)**: CONNECT 行 ≠ ClientHello SNI にしてプロキシを騙す。TLS セッション内では SNI = `Host` で一致するため CDN 側からは正常リクエストに見え、プロキシ側で SNI を独立に検査する以外に塞ぎ手段が無い。本付録は peek + `ssl::server_name --client-requested` で塞ぐ (Squid wiki も [TODO として明示](https://wiki.squid-cache.org/Features/SslPeekAndSplice) していた攻撃面)
- **classic domain fronting (CDN 層)**: 同一 TLS セッション内で SNI ≠ HTTP の `Host` ヘッダにして CDN を騙す。プロキシ側では検出できず、CDN 側の SNI = `Host` 検証に依拠して塞ぐ (主要 CDN は Cloudflare 2015 / AWS CloudFront 2018 / Azure Front Door 2022 / Fastly 2024 で実装済み)。本付録のスコープ外で、自社運用のリバースプロキシを許可リストに入れる場合は要注意
- **ECH 普及後の劣化 (構造的)**: ECH ([Encrypted ClientHello, TLS 1.3 拡張](https://datatracker.ietf.org/doc/draft-ietf-tls-esni/)) 普及後は peek で見える SNI が outer SNI までになり、本構成は「outer SNI を許可 = 同一 ECH プロバイダ上の任意 tenant への pivoting を受け入れる」「outer SNI を不許可 = ECH 使用クライアントを全部止める」の二者択一に劣化する。CDN 側で塞ぐ緩和策も ECH の設計 (outer を generic にして真の宛先を隠す) と両立しない。現時点では主要クライアント / CDN で部分対応にとどまり実害は薄いが、普及後は本構成の選択根拠を見直す必要がある

## 採用シナリオ

- **CA を作業コンテナに配りたくない** — CA bootstrap や各言語ランタイムへの証明書注入の手間を避け、簡素な構成にしたい
- **ホスト名粒度で十分** — 「`api.github.com` への GET / POST を細かく分けたい」のような細粒度 ACL が不要
- **CA 注入を許容できないクライアント** — 自前の証明書バンドルで動くツール (Java の cacerts.jks / cloud SDK 等) を扱う場合
- **学習・検証用** — Squid + internal ネットワークのシンプルな構成で外向き通信制御の最小骨格を確認したい

逆に、HTTP メソッド / パス単位の ACL が要る、上流 CDN の SNI = `Host` 検証に依拠したくない (社内 / 小規模 CDN を許可リストに入れる)、ECH 普及への耐性を重視する、等のケースは主推奨 (mitm-proxy) を選ぶ。

## 詳細はレシピ README へ

実装の詳細 (L3/L4 と L7 の役割分担、二重 ACL の構成、内部用 CA の扱い) と漏れる余地はレシピ README にまとめてある:

- [`alternatives/simple-http-proxy/README.md`](../../alternatives/simple-http-proxy/)
