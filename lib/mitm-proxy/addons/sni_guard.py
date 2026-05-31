"""lib/mitm-proxy/ addon: SNI と CONNECT target の整合性ガード。

HTTPS-via-CONNECT で client が ClientHello に詐称 SNI を載せると、mitmproxy は
client SNI を upstream の TLS handshake にそのまま forward する。同一 CDN 内で
allowlist host と非 allowlist host が同じ IP に乗る場合、CONNECT target は
allowlist host のまま SNI で別 tenant に routing できてしまう (SNI pivoting)。
これを inner request 段階で `flow.client_conn.sni` と CONNECT target を突き合わせて
deny する。alternatives/simple-http-proxy/ の Squid 構成では
`ssl::server_name --client-requested` で TLS handshake 前に切る経路と対応する防御。

mitmproxy には `tls_clienthello` hook で TLS handshake 自体を deny する明示 API が
無いため、TLS 確立後の request hook で 403 を返す形になる (TLS handshake までは
進むため、上流に SNI が漏れる副作用は残る)。

判定 host は `host_utils.real_host(flow)` (= CONNECT target、`flow.request.host`
が transparent mode で populate される値) を使う。HTTP 平文 / mitm.it / CONNECT
なしの request では `flow.client_conn.sni` が None になるため skip する。
"""

from __future__ import annotations

from mitmproxy import http

import audit
from host_utils import is_mitm_pseudo_host, real_host


class SniGuard:
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.response is not None:
            return
        if is_mitm_pseudo_host(flow):
            return
        sni = (flow.client_conn.sni or "").lower()
        if not sni:
            return
        target = real_host(flow)
        if sni == target:
            return
        audit.deny(
            flow,
            403,
            f"TLS SNI {sni!r} does not match connection target {target!r}",
        )
