"""lib/mitm-proxy/ addon: 設定の読み込み集約。

役割分担:
- policy.json (POLICY_FILE env で path 指定可、default /etc/mitm-proxy/policy.json):
  trusted_hosts / readonly_hosts / allow_rules / header_inject ルール
- env_file (~/.config/devsbx/mitm-proxy.env):
  header_inject の `${VAR}` interpolation で参照される secret (recipe 側で任意に追加)
- env:
  - POLICY_FILE: policy.json のパス
  - POLICY_MACROS: csv で指定したマクロ module を import し、generate() が返す宣言的ルール
    (policy.json と同じスキーマ) を手書き policy にマージする。マクロは flow を直接操作せず
    ルールを生成するだけで、生成物は起動時に全展開ログされる (拡張点の詳細は policy.py 参照)

policy.json の allow 区分 (CommonPolicy はこの順に評価):
- trusted_hosts: 全 method 素通し (Claude Code 自身の egress など)
- allow_rules: (host, path, method, query) の matcher list。readonly より先に
  評価する個別許可 (副作用のない POST 等)
- readonly_hosts: GET / HEAD / OPTIONS のみ (read-only な許可)

policy.json の header_inject の値は `${VAR}` 形式で env から interpolate される。
secret 値そのものを JSON にハードコードしない方針。
"""

from __future__ import annotations

import importlib
import json
import os
import re
from pathlib import Path

from rules import HostMatcher, InjectRule, Match


_POLICY_FILE = os.environ.get("POLICY_FILE", "/etc/mitm-proxy/policy.json")


def _csv(name: str) -> set[str]:
    return {x.strip() for x in os.environ.get(name, "").split(",") if x.strip()}


def _load_policy_dict() -> dict:
    p = Path(_POLICY_FILE)
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def _interpolate(s: str) -> str:
    """`${VAR}` を env で展開。未定義変数は空文字に置換する。

    展開後の値に CR (`\\r`) / LF (`\\n`) が含まれていたら ValueError を投げる。
    HTTP header value に改行が入ると header injection (後続ヘッダ追加 /
    response splitting 等) に化けるため、env の値に紛れ込んだ改行は起動時に
    fail-closed で検知する。
    """
    result = re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), ""), s)
    if "\r" in result or "\n" in result:
        raise ValueError(
            "interpolated header value contains CR/LF (potential header injection)"
        )
    return result


def _build_allow_rules(entries: list) -> list[Match]:
    """allow_rules の flat dict を Match list に変換する。

    header_inject と異なり action / headers が無いため、entry そのものが Match
    フィールドを直接持つ flat 形式 (`{"host": ..., "path": ..., "method": ...}`)。
    `_doc` 等の追加 key は単に無視される。
    """
    rules: list[Match] = []
    for entry in entries:
        rules.append(
            Match(
                host=entry.get("host"),
                path=entry.get("path"),
                method=entry.get("method"),
                query=tuple((k, v) for k, v in entry.get("query", {}).items()),
            )
        )
    return rules


def _build_inject_rules(entries: list) -> list[InjectRule]:
    rules: list[InjectRule] = []
    for entry in entries:
        m = entry.get("match", {})
        match = Match(
            host=m.get("host"),
            path=m.get("path"),
            method=m.get("method"),
            query=tuple((k, v) for k, v in m.get("query", {}).items()),
        )
        headers = tuple(
            (k, _interpolate(v)) for k, v in entry.get("headers", {}).items()
        )
        rules.append(InjectRule(match=match, headers=headers))
    return rules


_MACRO_MERGE_KEYS = ("trusted_hosts", "readonly_hosts", "allow_rules", "header_inject")


def _macro_names() -> list[str]:
    return [n.strip() for n in os.environ.get("POLICY_MACROS", "").split(",") if n.strip()]


def _merge_fragment(policy: dict, fragment: dict) -> None:
    """マクロ生成 fragment を policy dict に追記する。

    手書き policy の後ろに append するので、header_inject の first-match では手書きルールが
    優先される。fragment は policy.json と同一スキーマ (該当 key だけ持てばよい)。
    """
    for key in _MACRO_MERGE_KEYS:
        items = fragment.get(key)
        if items:
            policy.setdefault(key, []).extend(items)


def _apply_macros(policy: dict) -> list:
    """POLICY_MACROS のマクロを import → generate() → policy にマージする。

    各マクロ module は `generate() -> dict` を expose する規約 (返り値は policy.json と同じ
    スキーマ)。マクロは flow を操作せず宣言的ルールを返すだけ。(name, fragment) のリストを
    返す (起動時の検査ログ用)。
    """
    applied = []
    for name in _macro_names():
        mod = importlib.import_module(name)
        fragment = mod.generate()
        _merge_fragment(policy, fragment)
        applied.append((name, fragment))
    return applied


_policy = _load_policy_dict()
MACROS_APPLIED = _apply_macros(_policy)

# ── policy.json (+ マクロ生成分) から ──
# READONLY_HOSTS / TRUSTED_HOSTS は exact + glob (`*.example.com` 等) の hybrid。
# `*` `?` `[seq]` を含む entry は fnmatch glob として扱われる (rules.HostMatcher 参照)。
READONLY_HOSTS: HostMatcher = HostMatcher.from_list(_policy.get("readonly_hosts", []))
TRUSTED_HOSTS: HostMatcher = HostMatcher.from_list(_policy.get("trusted_hosts", []))
ALLOW_RULES: list[Match] = _build_allow_rules(_policy.get("allow_rules", []))
HEADER_INJECT_RULES: list[InjectRule] = _build_inject_rules(
    _policy.get("header_inject", [])
)

def summary() -> str:
    """起動時に出す config の要約。secret 値は出さない。"""
    inject_targets = ",".join(
        sorted(r.match.host or "*" for r in HEADER_INJECT_RULES)
    ) or "<empty>"
    allow_targets = ",".join(
        sorted(r.host or "*" for r in ALLOW_RULES)
    ) or "<empty>"
    macros = ",".join(name for name, _ in MACROS_APPLIED) or "<none>"
    return (
        f"POLICY_FILE={_POLICY_FILE} "
        f"MACROS={macros} "
        f"TRUSTED_HOSTS={TRUSTED_HOSTS} "
        f"READONLY_HOSTS={READONLY_HOSTS} "
        f"ALLOW_RULE_HOSTS={allow_targets} "
        f"HEADER_INJECT_HOSTS={inject_targets}"
    )


def macro_lines() -> list[str]:
    """適用マクロが生成したルールを secret を伏せて 1 行ずつ列挙する (起動時の検査用)。

    header_inject は host + header 名のみを出し、値 (secret を含みうる) は出さない。
    """
    lines: list[str] = []
    for name, fragment in MACROS_APPLIED:
        for host in fragment.get("trusted_hosts", []):
            lines.append(f"[{name}] trusted_host {host}")
        for host in fragment.get("readonly_hosts", []):
            lines.append(f"[{name}] readonly_host {host}")
        for r in fragment.get("allow_rules", []):
            lines.append(
                f"[{name}] allow {r.get('method', '*')} "
                f"{r.get('host', '*')}{r.get('path', '')}"
            )
        for r in fragment.get("header_inject", []):
            m = r.get("match", {})
            header_names = ",".join(r.get("headers", {}).keys())
            lines.append(
                f"[{name}] inject {m.get('host', '*')}{m.get('path', '')} "
                f"headers=[{header_names}]"
            )
    return lines
