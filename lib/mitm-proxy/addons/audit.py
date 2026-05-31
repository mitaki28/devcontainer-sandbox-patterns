"""lib/mitm-proxy/ addon: ロガー + 拒否ヘルパ。

deny / allow の判定は addon 全体で共通の log prefix を持たせる。PAT 値や
Authorization ヘッダの中身は出さない方針。

ログの host は **実宛先 (`flow.request.host`)** を出す。`pretty_host` (Host ヘッダ
優先の spoof 可能値) を使うと監査ログ自体が偽装されるため。
"""

from __future__ import annotations

import logging
from mitmproxy import http


logger = logging.getLogger("mitm_proxy")


def deny(flow: http.HTTPFlow, status: int, reason: str) -> None:
    logger.warning(
        "[mitm-proxy DENY %d] %s %s%s — %s",
        status,
        flow.request.method,
        (flow.request.host or "").lower(),
        flow.request.path,
        reason,
    )
    flow.response = http.Response.make(
        status,
        f"lib/mitm-proxy: {reason}\n".encode(),
        {"Content-Type": "text/plain; charset=utf-8"},
    )
