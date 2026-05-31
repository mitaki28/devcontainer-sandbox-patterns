"""alternatives/git-mitm-proxy-addon/ マクロ: GitHub git smart-HTTP 用ルール生成。

lib/mitm-proxy/addons/policy.py の POLICY_MACROS 拡張点から `generate()` 規約で呼ばれ、
github.com の git transport を通すための宣言的ルール (allow_rules / header_inject) を env から
生成する。マクロは env を読んでルールの dict を返す純粋関数で、flow には触れない。

生成するルール:
- fetch (全 repo): info/refs advert (GET, service=git-upload-pack) / git-upload-pack 本体 (POST) /
  HEAD (clone が空 bare で叩く)
- push (ALLOWED_PUSH_REPOS のみ): info/refs advert (GET, service=git-receive-pack) /
  git-receive-pack 本体 (POST)。許可外の repo は allow に載らず default deny で 403 になる
- PAT 注入 (header_inject): github.com の `.git` path 全体に Basic auth を注入

scope: github.com への git smart-HTTP transport のみ。REST API (api.github.com) や web ページは
CommonPolicy / readonly_hosts 側で扱う。ref/branch 単位の push 制御は宣言的ルールに展開できない
ため recipes/git-gateway/ 側で扱う。

env:
- GITHUB_PAT: 注入する PAT (x-access-token:<PAT> の Basic auth)。未設定なら inject ルールを
  生成しない (public read は通る、push 認証は upstream の 401 に委ねる)
- ALLOWED_PUSH_REPOS: push を許可する `owner/repo` の csv

GIT_HOSTS は他の git host (GitLab / Bitbucket 等) への拡張点。
"""

from __future__ import annotations

import base64
import os


GIT_HOSTS: tuple[str, ...] = ("github.com",)


def _basic_auth(token: str) -> str:
    raw = f"x-access-token:{token}".encode()
    return f"Basic {base64.b64encode(raw).decode()}"


def _load_env() -> tuple[str, set[str]]:
    pat = os.environ.get("GITHUB_PAT", "").strip()
    allowed = {
        x.strip()
        for x in os.environ.get("ALLOWED_PUSH_REPOS", "").split(",")
        if x.strip()
    }
    return pat, allowed


def generate() -> dict:
    """github.com の git transport を通す宣言的ルールを env から生成する (POLICY_MACROS 規約)。"""
    pat, allowed_push = _load_env()

    allow_rules: list[dict] = []
    for host in GIT_HOSTS:
        # fetch (全 repo): advert / negotiation 本体 / clone が空 bare で叩く HEAD。
        allow_rules.append(
            {
                "host": host,
                "path": "/*/*.git/info/refs",
                "method": "GET",
                "query": {"service": "git-upload-pack"},
            }
        )
        allow_rules.append(
            {"host": host, "path": "/*/*.git/git-upload-pack", "method": "POST"}
        )
        allow_rules.append({"host": host, "path": "/*/*.git/HEAD", "method": "GET"})
        # push (ALLOWED_PUSH_REPOS のみ): advert / transfer 本体。許可外 repo は allow に載らず
        # default deny に落ちる。
        for repo in sorted(allowed_push):
            allow_rules.append(
                {
                    "host": host,
                    "path": f"/{repo}.git/info/refs",
                    "method": "GET",
                    "query": {"service": "git-receive-pack"},
                }
            )
            allow_rules.append(
                {"host": host, "path": f"/{repo}.git/git-receive-pack", "method": "POST"}
            )

    header_inject: list[dict] = []
    if pat:
        auth = _basic_auth(pat)
        for host in GIT_HOSTS:
            # `.git` path 全体 (info/refs / git-upload-pack / git-receive-pack / HEAD) に
            # PAT を乗せる。
            header_inject.append(
                {"match": {"host": host, "path": "/*/*.git/**"}, "headers": {"Authorization": auth}}
            )

    fragment: dict = {}
    if allow_rules:
        fragment["allow_rules"] = allow_rules
    if header_inject:
        fragment["header_inject"] = header_inject
    return fragment
