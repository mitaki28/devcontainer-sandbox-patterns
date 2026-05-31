"""lib/mitm-proxy/ addon: 汎用 (host + path + method + query) マッチング。

glob セマンティクス (segment-aware。URL ルーティング / TLS
ワイルドカード証明書 / file glob の慣例に揃えた):

- host:
  - `*`  : 1 ラベル分にマッチ。`.` は跨がない (TLS ワイルドカード証明書と同じ)。
           例: `*.example.com` は `a.example.com` に match、`a.b.example.com` には match しない
  - `?`  : 1 文字。`.` は跨がない
  - 判定値は `host_utils.real_host(flow)` (Host ヘッダ詐称不可な実宛先)。
    pattern 側は lowercase に正規化される
  - bare hostname は別 entry が要る (`*.example.com` は `example.com` には match しない)
- path:
  - `*`  : 1 segment 分にマッチ。`/` は跨がない。例: `/foo/*` は `/foo/bar` に match、
           `/foo/bar/baz` には match しない
  - `**` : 任意 segment にマッチ。`/` を跨ぐ。例: `**/audits` は `/foo/bar/audits` に match
  - `?`  : 1 文字。`/` は跨がない
- method: 完全一致 or "*"
- query: dict[str, str]、すべての key/value が一致した場合に match

跨ぎが必要な entry は `**` (path) または `*.*.example.com` 等 (host) を使う。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from mitmproxy import http

from host_utils import real_host


# glob 文字 (re.escape したくない、特別扱いする文字)
_GLOB_META = set("*?")
# regex special character のうち、glob では literal として扱いたい文字
_REGEX_META_TO_ESCAPE = set(".+()[]{}\\|^$")


@lru_cache(maxsize=512)
def _compile_path_glob(pattern: str) -> re.Pattern[str]:
    """path 用 glob → regex。`*` は `/` 跨がず、`**` は `/` 跨ぐ、`?` は 1 文字 (`/` 跨がず)。"""
    out: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                out.append(".*")  # ** = / 含む任意
                i += 2
            else:
                out.append("[^/]*")  # * = / 跨がない
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c in _REGEX_META_TO_ESCAPE:
            out.append(re.escape(c))
            i += 1
        else:
            out.append(c)
            i += 1
    return re.compile("^" + "".join(out) + "$")


@lru_cache(maxsize=512)
def _compile_host_glob(pattern: str) -> re.Pattern[str]:
    """host 用 glob → regex。`*` は `.` 跨がない、`?` は 1 文字 (`.` 跨がない)。

    TLS ワイルドカード証明書 / nginx server_name の慣例に揃え、1 ラベルのみマッチ。
    """
    out: list[str] = []
    for c in pattern:
        if c == "*":
            out.append("[^.]*")
        elif c == "?":
            out.append("[^.]")
        elif c in _REGEX_META_TO_ESCAPE:
            out.append(re.escape(c))
        else:
            out.append(c)
    return re.compile("^" + "".join(out) + "$")


def host_glob_match(host: str, pattern: str) -> bool:
    """host (lowercase) を host pattern にマッチさせる。`*` は 1 ラベル、`.` は跨がない。"""
    return _compile_host_glob(pattern.lower()).match(host) is not None


def path_glob_match(path: str, pattern: str) -> bool:
    """path を path pattern にマッチさせる。`*` は 1 segment、`**` で `/` 跨ぐ。"""
    return _compile_path_glob(pattern).match(path) is not None


@dataclass(frozen=True)
class Match:
    host: str | None = None
    path: str | None = None
    method: str | None = None
    query: tuple[tuple[str, str], ...] = ()  # frozen にするため tuple of tuple

    def matches(self, flow: http.HTTPFlow) -> bool:
        req = flow.request
        if self.host is not None:
            if not host_glob_match(real_host(flow), self.host):
                return False
        if self.method is not None and self.method != "*":
            if req.method != self.method:
                return False
        if self.path is not None:
            path_only = req.path.split("?", 1)[0]
            if not path_glob_match(path_only, self.path):
                return False
        for k, v in self.query:
            if req.query.get(k) != v:
                return False
        return True


@dataclass(frozen=True)
class InjectRule:
    """ヘッダ注入専用 rule。HeaderInjector が JSON config から読み込んで使う。

    headers は frozen にしたいので tuple of tuple。policy.json から build する
    タイミングで `${VAR}` を env で interpolate 済みの値が入る。
    """

    match: Match
    headers: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class HostMatcher:
    """readonly_hosts / trusted_hosts 用の hybrid matcher。

    1 entry に `*` `?` のいずれかが含まれていれば host glob として扱い、それ以外は
    exact match する。これで `api.github.com` のような既存 entry はそのまま動きつつ、
    `*.devsbx.internal` 等の glob も同 list に並べて書ける。

    glob セマンティクス (segment-aware):
      `*.example.com`         1 ラベル subdomain にマッチ (`a.example.com` のみ、
                              `a.b.example.com` は不可)。TLS ワイルドカード証明書と同じ
      `*.devsbx.internal`     project namespace alias の 1 段下まで許可
      `registry-*.docker.io`  prefix 別の 1 ラベル subdomain 群
      `*.*.example.com`       2 段下の subdomain (`a.b.example.com`) にマッチ
    """

    exact: frozenset[str]
    globs: tuple[str, ...]

    @classmethod
    def from_list(cls, patterns: list[str]) -> "HostMatcher":
        exact: set[str] = set()
        globs: list[str] = []
        for p in patterns:
            # 比較は real_host(flow) (lowercase) で行うため pattern も lowercase に揃える
            p_lower = p.lower()
            if any(c in p_lower for c in "*?"):
                globs.append(p_lower)
            else:
                exact.add(p_lower)
        return cls(exact=frozenset(exact), globs=tuple(globs))

    def matches(self, host: str) -> bool:
        if host in self.exact:
            return True
        return any(host_glob_match(host, g) for g in self.globs)

    def __bool__(self) -> bool:
        return bool(self.exact) or bool(self.globs)

    def __str__(self) -> str:
        all_patterns = sorted(self.exact) + sorted(self.globs)
        return ",".join(all_patterns) if all_patterns else "<empty>"
