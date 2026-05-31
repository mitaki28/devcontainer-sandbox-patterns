"""lib/mitm-proxy/ addon: 汎用ヘッダ注入。

policy.json の `header_inject` エントリで定義した (host + path + method + query) →
headers の rule を request に適用する。secret は `${VAR}` 形式で env から
interpolate された後の値が config.HEADER_INJECT_RULES に入っている前提。

allow/deny の判定は CommonPolicy が行うので、本 module は単に「先行 addon が
処理済みでなく、まだ response が立っていない request」に対してヘッダを足すだけ。
最初に一致した rule のみ適用する。

順序: addons リストの末尾近くに置き、CommonPolicy が allow した request だけに
inject が走るようにする。CommonPolicy が deny した場合は metadata or response が
立つので skip。
"""

from __future__ import annotations

from mitmproxy import http

import audit
import config
from host_guard import real_host


class HeaderInjector:
    def __init__(self) -> None:
        self.rules = config.HEADER_INJECT_RULES

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("mitm_proxy_handled"):
            return
        if flow.response is not None:
            return
        for rule in self.rules:
            if rule.match.matches(flow):
                for k, v in rule.headers:
                    flow.request.headers[k] = v
                # secret 値を log に出さないよう header 名のみ列挙
                audit.logger.info(
                    "[mitm-proxy INJECT] %s %s — headers=[%s]",
                    real_host(flow),
                    flow.request.path,
                    ", ".join(k for k, _ in rule.headers),
                )
                return
