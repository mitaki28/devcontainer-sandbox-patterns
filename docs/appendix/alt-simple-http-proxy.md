# 付録: 独自 CA 不要の mitm-proxy 代替 — Squid + SNI 許可リストによる HTTP プロキシ

`alternatives/simple-http-proxy/` を扱う付録。mitm-proxy より軽量で、作業コンテナへの独自 CA 配布が不要な SNI 許可リスト方式の代替。

## このパターンの位置付け

mitm-proxy は HTTP メソッド × パス粒度の ACL が効くが、CA bootstrap や各言語ランタイムへの証明書注入にコストがかかる。本付録は Squid で TLS を復号せず SNI だけ覗いてホスト名単位の許可リストを実現する、CA 配布不要の代替。

## 何を実現するか

- 作業コンテナは `internal: true` に閉じ、`HTTPS_PROXY` 経由で Squid を叩く
- Squid が CONNECT 行と TLS ClientHello の SNI の両方でホスト名を検査し、許可リストに無いホストを拒否する
- TLS 復号は行わない (透過転送)。作業コンテナへの独自 CA 配布は不要

## `lib/mitm-proxy/` に対するトレードオフ

| 観点 | `lib/mitm-proxy/` | 本付録 (Squid) |
|---|---|---|
| TLS 終端 | する | しない (SNI だけ覗いて透過転送) |
| 作業コンテナ側 CA 配布 | **必要** | **不要** |
| ACL 粒度 | ホスト × HTTP メソッド × パス | ホストのみ |
| CONNECT 詐称耐性 | ✓ (SniGuard で SNI 不一致を deny) | ✓ (`ssl::server_name --client-requested`) |
| domain fronting 耐性 | ✓ (HostSanGuard で上流 cert SAN 照合) | △ (CDN 側の検証に依拠) |
| ECH 普及後 | ◎ | △ (outer SNI しか見えない) |
| 構築コスト | 中 | 小〜中 |

mitm-proxy は HTTP メソッド / パス粒度の ACL で優位。本付録は CA を配らない簡素さが利点。CA 配布は初期構築だけでなく、各言語ランタイムのトラストストアにそれぞれ注入が要る継続コストでもあり、これを避けたい場合に本付録が選択肢になる。

CONNECT 詐称 (CONNECT 行と SNI の不一致) は両者ともプロキシ側で塞ぐ。domain fronting (SNI = CONNECT target、内側 `Host` だけ別) は扱いが異なる: mitm-proxy は TLS 復号できるため HostSanGuard が上流証明書の SAN と Host ヘッダを照合して deny する。本付録は TLS を復号しないので Host ヘッダが見えず、主要 CDN の server-side 拒否に依拠する。ECH ([Encrypted ClientHello](https://datatracker.ietf.org/doc/draft-ietf-tls-esni/)) が普及すると peek で outer SNI しか見えなくなるため、普及後は見直しが要る (両者共通)。

## 採用シナリオ

- **CA 配布を避けたい** — 各言語ランタイムへの証明書注入の手間を省きたい場合
- **ホスト名粒度で十分** — HTTP メソッド / パス単位の細粒度 ACL が不要な場合
- **学習・検証用** — 外向き通信制御の最小構成を確認したい場合

HTTP メソッド / パス単位の ACL や ECH 耐性が要る場合は `lib/mitm-proxy/` を選ぶ。

## 詳細はレシピ README へ

実装詳細はレシピ README を参照:

- [`alternatives/simple-http-proxy/README.md`](../../alternatives/simple-http-proxy/)
