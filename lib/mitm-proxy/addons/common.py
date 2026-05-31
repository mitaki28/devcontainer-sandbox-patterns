"""lib/mitm-proxy/ addon: 共通 policy。

評価順 (any-match-allows):
1. mitm.it (CA bootstrap) は素通し
2. TRUSTED_HOSTS マッチ → 全 method 素通し
3. ALLOW_RULES (host + path + method + query) のいずれかにマッチ → 通す
   READONLY より先に評価することで、readonly host への POST 等を個別に許可できる
4. READONLY_HOSTS マッチ + GET / HEAD / OPTIONS → 通す。non-safe method は 403 deny
5. それ以外は default deny

`flow.metadata["mitm_proxy_handled"]` が立っている flow (= 上流 addon が response
を立てた / 別 policy で扱った) は本 module の判定をスキップする (skip pattern。
外部 addon (例: alternatives/git-mitm-proxy-addon/) がこの機構で介入する)。

判定 host は `host_guard.real_host(flow)` (= 実宛先) を使う。Host ヘッダ詐称は
addons list 先頭の HostGuard が事前に deny する前提なので、本 module は
real_host を信頼してよい (HostGuard 不在で本 module だけ動かす unit test でも
mitm.it 例外と default deny は壊れない設計)。
"""

from __future__ import annotations

from mitmproxy import http

import audit
import config
from host_guard import is_mitm_pseudo_host, real_host


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class CommonPolicy:
    def request(self, flow: http.HTTPFlow) -> None:
        # 既処理 (metadata mark) または既に response が立っている flow は触らない。
        # `flow.response is not None` も見るのは extras が metadata を立て忘れた
        # ケースに対する fail-safe。
        if flow.metadata.get("mitm_proxy_handled") or flow.response is not None:
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
