"""lib/mitm-proxy/ addon: Host ヘッダと上流 cert SAN の整合性ガード。

HTTPS-via-CONNECT で client が inner request の Host ヘッダに、上流が cert で
自己主張していない host を載せると、proxy はそれを smuggling / domain fronting の
試行として 403 deny する。上流が cert で `api.example.com` だけを serve すると
暗号的に主張している接続に、client が `Host: evil.example.com` で request を
混ぜ込む経路を塞ぐ層。

squid の `SQUID_X509_V_ERR_DOMAIN_MISMATCH` (bump 構成で動く) と意味的に対応する。
HTTP/2 connection coalescing (RFC 7540 §9.1.1) のように、同一 cert SAN 内で
複数 host を再利用する正当な request は通る (= 副作用無しに本丸の domain fronting
だけを catch する)。

塞げない残存リスク:
  - 上流が evil.example.com を本当に同一 multi-SAN cert に同居させて発行している
    ケース (= 上流自身が「両方私のもの」と暗号的に主張済み)
  - cert 検証無効化 (ssl_verify_upstream off) で proxy が握る上流 cert が偽物
    で済んでしまうケース

判定:
  - Host ヘッダが無ければ skip
  - Host が CONNECT target と一致なら skip (= 上流 TLS handshake で OpenSSL の
    hostname verification が既に通っており、SAN 包含は保証済み)
  - mitm.it pseudo host は skip
  - 上流 cert (flow.server_conn.certificate_list) が無いケース (HTTP 平文等) は
    skip (= 暗号身元を持たない接続なので照合できない)
  - 上記以外: service_identity.cryptography.verify_certificate_hostname で
    Host ヘッダが leaf cert SAN に含まれるか検証。raise なら 403

実装の補足:
  - leaf cert は certificate_list[0] (chain の先頭、上流が presented した cert)
  - service_identity は `cryptography` 経由依存で、mitmproxy image に
    aioquic transitive で既に居る (新規依存なし)
  - service_identity は trust chain は検証しない (mitmproxy 側で
    ssl_verify_upstream_trusted_ca で済ませる前提)
"""

from __future__ import annotations

from mitmproxy import http
from service_identity import CertificateError, VerificationError
from service_identity.cryptography import verify_certificate_hostname

import audit
from host_utils import host_header_host, is_mitm_pseudo_host, real_host


class HostSanGuard:
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.response is not None:
            return
        if is_mitm_pseudo_host(flow):
            return

        host = host_header_host(flow)
        if host is None:
            return

        target = real_host(flow)
        if host == target:
            # 上流 TLS handshake の hostname verification で SAN ⊇ target は確認済み
            return

        certs = flow.server_conn.certificate_list
        if not certs:
            # 上流 cert が無い接続 (HTTP 平文 等): 照合根拠が無いので skip。
            # HTTP 絶対形 URI の Host ヘッダ詐称は CommonPolicy の default deny
            # (= real_host で allowlist 判定) が塞ぐので、ここで重複 deny しない。
            return

        leaf = certs[0].to_cryptography()
        try:
            verify_certificate_hostname(leaf, host)
        except (VerificationError, CertificateError, ValueError) as e:
            # ValueError は service_identity の DNS_ID 構築で IP リテラル等が来た時に
            # raise される (例: `Host: [::1]` → 抽出後 "::1" を DNS 名前として扱えない)。
            # 種別を判別して verify_certificate_ip_address に振り分けるのが本筋だが、
            # 本 lib の threat model では Host に IP リテラルを載せるパターンは想定外
            # なので fail-closed に倒す (= 仕様外 Host は全部 deny)。
            audit.deny(
                flow,
                403,
                f"Host header {host!r} not covered by upstream cert SAN "
                f"(connection target {target!r}): {e}",
            )
