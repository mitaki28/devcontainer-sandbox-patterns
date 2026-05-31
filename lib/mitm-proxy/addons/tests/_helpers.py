"""unit test 用の共通ヘルパ。

mitmproxy の `tutils.treq` + `tflow.tflow` の薄いラッパ。各 test から `make_flow`
を呼ぶだけで host / method / path / query を持つ HTTPFlow を組める。

config の global を一時差し替えするための context manager もここに置く。
addon 群 (CommonPolicy / HeaderInjector) は import 時に `config.READONLY_HOSTS`
等を直接参照するので、test では addCleanup より `with patched_config(...)` で
囲った方がスコープが明確。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from urllib.parse import urlencode

from mitmproxy import http
from mitmproxy.test import tflow, tutils

import config


def make_flow(
    *,
    method: str = "GET",
    host: str = "example.com",
    path: str = "/",
    query: dict[str, str] | None = None,
    scheme: str = "https",
    port: int = 443,
    host_header: str | None = None,
) -> http.HTTPFlow:
    """テスト用 HTTPFlow を作る。

    `host` は mitmproxy が接続する実宛先 (= `flow.request.host`)。
    `host_header` を渡すと Host ヘッダを明示上書きする (HostGuard の mismatch
    テスト用)。None なら treq が host から自動設定する整合な Host を使う。
    """
    full_path = path
    if query is not None:
        sep = "&" if "?" in path else "?"
        full_path = f"{path}{sep}{urlencode(query)}"
    req = tutils.treq(
        method=method.encode(),
        host=host,
        port=port,
        scheme=scheme.encode(),
        path=full_path.encode(),
    )
    flow = tflow.tflow(req=req)
    if host_header is not None:
        flow.request.headers["Host"] = host_header
    return flow


@contextmanager
def patched_config(**overrides: Any):
    """config module の global を一時差し替えする。

    addon は `config.READONLY_HOSTS` のように属性参照で読むため、ここを
    setattr で書き換えれば addon の挙動を制御できる。tearDown で必ず元に戻す。
    """
    saved = {k: getattr(config, k) for k in overrides}
    try:
        for k, v in overrides.items():
            setattr(config, k, v)
        yield
    finally:
        for k, v in saved.items():
            setattr(config, k, v)
