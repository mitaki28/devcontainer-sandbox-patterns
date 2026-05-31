"""lib/mitm-proxy/ addon: 共通 policy。

評価順 (any-match-allows):
1. mitm.it (CA bootstrap) は素通し
2. TRUSTED_HOSTS マッチ → 全 method 素通し
3. ALLOW_RULES (host + path + method + query) のいずれかにマッチ → 通す
   READONLY より先に評価することで、readonly host への POST 等を個別に許可できる
4. READONLY_HOSTS マッチ + GET / HEAD / OPTIONS → 通す。non-safe method は 403 deny
5. それ以外は default deny

先行 addon (SniGuard / HostSanGuard) が deny して `flow.response` を立てた flow は
本 module の判定をスキップする。mitmproxy は response が立っても各 addon の
request hook を呼び続けるため、ここで明示的に skip する。

判定 host は `host_utils.real_host(flow)` (= 実宛先) を使う。SNI 詐称は addons
list 先頭の SniGuard が事前に deny する前提だが、SniGuard 不在で本 module だけ
動かす unit test でも mitm.it 例外と default deny は壊れない設計にしている。

Host ヘッダの値 (`flow.request.host_header`) は本 module の ACL 判断に使わない。
domain fronting (SNI = CONNECT target = 許可ホスト、Host ヘッダだけ別) は
naive strcmp で塞ぐと HTTP/2 connection coalescing で false positive を出す
ため、主要 CDN の server-side 421 に委ねる方針 (policy.py docstring 参照)。
"""

from __future__ import annotations

from mitmproxy import http

import audit
import config
from host_utils import is_mitm_pseudo_host, real_host


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class CommonPolicy:
    def request(self, flow: http.HTTPFlow) -> None:
        # 先行 addon が deny して response を立てた flow は触らない。
        if flow.response is not None:
            return

        # mitm.it (mitmproxy 自身の CA 配布 endpoint) は常に通す。upstream に
        # forward されない pseudo host で、mitmproxy onboarding が内部処理する。
        if is_mitm_pseudo_host(flow):
            return

        host = real_host(flow)

        # trusted: 全 method 素通し
        if config.TRUSTED_HOSTS.matches(host):
            return

        # allow_rules: 個別許可。readonly より先に評価することで、
        # readonly host への副作用のない POST (pnpm audit 等) を許可できる
        if any(rule.matches(flow) for rule in config.ALLOW_RULES):
            return

        # readonly: GET / HEAD / OPTIONS のみ
        if config.READONLY_HOSTS.matches(host):
            if flow.request.method in SAFE_METHODS:
                return
            audit.deny(
                flow,
                403,
                f"readonly host: {flow.request.method} {host}{flow.request.path} denied",
            )
            return

        # default deny
        audit.deny(flow, 403, f"host not in allowlist: {host}")
