"""lib/mitm-proxy/ helpers: 実宛先 / Host ヘッダ / mitm.it 判定。

mitmproxy の `flow.request.pretty_host` は Host ヘッダを優先する spoof 可能な値で、
mitmproxy 本家の docstring も "adversarial environments では実宛先を反映しない" と
明記している。本 lib では ACL / log の判定値を `real_host(flow)` に統一する。

提供するもの:

1. `real_host(flow)` — mitmproxy が実際に接続する宛先 (`flow.request.host`) を
   正規化 (lowercase) して返す pure helper。HTTPS-via-CONNECT では inner HttpLayer
   が transparent mode で動くため CONNECT target が反映され、絶対形 URI HTTP では
   URL の host が反映される。ACL / log は **必ず** これを使う
2. `host_header_host(flow)` — `Host` / `:authority` ヘッダの host 部 (port 除去) を
   正規化して返す。ヘッダ不在なら None
3. `is_mitm_pseudo_host(flow)` — mitm.it (CA 配布 endpoint) 判定

mitm.it は upstream に飛ばない pseudo host なので各 ACL の skip 判定に使う。
"""

from __future__ import annotations

from mitmproxy import http
from mitmproxy.net.http.url import parse_authority


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

    parse は mitmproxy 公式の `parse_authority(check=False)` に委ねる。同 helper は
    bracket 付き IPv6 (`[::1]:8443` → `::1`) を剥がし、port を分離し、malformed
    入力 (bare IPv6 `fe80::1`, userinfo 付き `user@host:port` 等) は host 側に
    生値をそのまま残す (`check=False` の fail-open 仕様)。malformed が opaque で
    残ることで、real_host との突合が確実に mismatch して deny 側に倒れる。
    lowercase 化だけ呼び出し側で足す。
    """
    raw = flow.request.host_header
    if raw is None:
        return None
    host, _ = parse_authority(raw, check=False)
    return host.lower()


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


