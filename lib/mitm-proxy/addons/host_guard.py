"""lib/mitm-proxy/ addon: Host ヘッダ整合性ガード + 実宛先ヘルパ。

mitmproxy の `flow.request.pretty_host` は Host ヘッダを優先する spoof 可能な値で、
mitmproxy 本家の docstring も "adversarial environments では実宛先を反映しない" と
明記している。`pretty_host` で ACL すると attacker が absolute-form URI + 偽 Host
ヘッダ (regular mode) や CONNECT 先 ≠ Host (HTTPS) で任意ホストに egress + 注入
secret 窃取できる構造になるため、本 lib では `real_host(flow)` を ACL の判定値に
統一している。

本 module は:

1. `real_host(flow)` — mitmproxy が実際に接続する宛先 (`flow.request.host`) を
   正規化 (lowercase) して返す pure helper。ACL / log は **必ず** これを使う
2. `host_header_host(flow)` — `Host` / `:authority` ヘッダの host 部 (port 除去) を
   正規化して返す。ヘッダ不在なら None
3. `HostGuard` addon — addons list の **先頭** で動作し、real_host と
   host_header_host が不一致なリクエストを 403 で deny する境界

HostGuard を通過した後の addon は `real_host(flow)` を信頼してよい。

mitm.it (mitmproxy onboarding) は upstream へ送られない pseudo host なので
mismatch チェックの例外として skip する。
"""

from __future__ import annotations

from mitmproxy import http

import audit


def real_host(flow: http.HTTPFlow) -> str:
    """mitmproxy が接続する実宛先 host を lowercase で返す。

    `flow.request.host` は URL / CONNECT authority / SNI から mitmproxy が
    確定した接続先で、Host ヘッダの影響を受けない。
    """
    return (flow.request.host or "").lower()


def host_header_host(flow: http.HTTPFlow) -> str | None:
    """`Host` / `:authority` ヘッダの host 部 (port 除去) を lowercase で返す。

    ヘッダ自体が無ければ None。`flow.request.host_header` は mitmproxy が
    HTTP/1 Host / HTTP/2 :authority を吸収した property。
    """
    raw = flow.request.host_header
    if raw is None:
        return None
    return _strip_port(raw).lower()


def host_mismatch(flow: http.HTTPFlow) -> bool:
    """Host ヘッダがあり、かつ実宛先と食い違っているなら True。

    ヘッダ不在は False (整合とみなす)。Spoof でない正常 client は両者一致。
    """
    hdr = host_header_host(flow)
    if hdr is None:
        return False
    return hdr != real_host(flow)


def _strip_port(authority: str) -> str:
    """authority 文字列 (`host`, `host:port`, `[ipv6]`, `[ipv6]:port`) から host 部を取り出す。"""
    if not authority:
        return authority
    if authority.startswith("["):
        end = authority.find("]")
        if end != -1:
            return authority[1:end]
        return authority
    # bracket 無しで `:` が複数あれば bare IPv6 (e.g. `::1`)。port は付かない
    if authority.count(":") > 1:
        return authority
    if ":" in authority:
        return authority.rsplit(":", 1)[0]
    return authority


# mitm.it: mitmproxy 自身の onboarding endpoint。upstream には飛ばないため、
# mismatch 判定の例外として扱う (CA 配布フローを壊さないため)。
_MITM_PSEUDO_HOSTS = frozenset({"mitm.it"})


def is_mitm_pseudo_host(flow: http.HTTPFlow) -> bool:
    """mitmproxy 内部で完結する pseudo host (mitm.it) への request か判定する。

    mitm.it は mitmproxy onboarding が捕まえて CA cert 等を内部生成し、upstream
    には絶対 forward されない。regular proxy mode では絶対形 URI で
    `request.host = mitm.it` として届くため real_host だけで判定すれば足りる。
    """
    return real_host(flow) in _MITM_PSEUDO_HOSTS


class HostGuard:
    """addons list の先頭で動作し、Host ヘッダ詐称リクエストを deny する。

    後段の addon (extras / CommonPolicy / HeaderInjector / AccessLog) はこれを
    通過した flow に対してのみ動くので、`real_host(flow)` を信頼してよい。
    """

    def request(self, flow: http.HTTPFlow) -> None:
        # 既処理 (metadata mark) または既に response が立っている flow は触らない。
        # `flow.response is not None` も見るのは extras が metadata を立て忘れた
        # ケースに対する fail-safe。
        if flow.metadata.get("mitm_proxy_handled") or flow.response is not None:
            return
        if is_mitm_pseudo_host(flow):
            return
        if not host_mismatch(flow):
            return
        audit.deny(
            flow,
            403,
            f"Host header {host_header_host(flow)!r} does not match "
            f"connection target {real_host(flow)!r}",
        )
