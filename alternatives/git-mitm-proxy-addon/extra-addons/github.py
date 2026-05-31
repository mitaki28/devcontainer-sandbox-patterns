"""alternatives/git-mitm-proxy-addon/ addon: GitHub git smart-HTTP 専用 module。

lib/mitm-proxy/ は read-only 許可を主とする最小構成に絞られているため、本 module は recipe 側で
overlay する形 (lib/mitm-proxy/addons/policy.py の MITM_EXTRA_ADDONS 拡張点
から `addon = GitHubPolicy()` 規約で load される)。

scope: github.com への git transport (fetch / push) のみ。REST API (api.github.com)
は lib/mitm-proxy/ の CommonPolicy 側で扱う方針 (MCP 経由前提なので proxy では特別扱いしない)。

実装:
- path が `/<owner>/<repo>.git/...` 形式かどうか (= _extract_repo が成功するか) を addon の
  処理境界とする。git smart-HTTP の全 path (`info/refs`, `git-upload-pack`,
  `git-receive-pack`, `HEAD`, `objects/*` の dumb HTTP fallback 等) をまとめて扱う
- push か fetch かは `_PUSH_MATCHERS` で識別: GET `info/refs?service=git-receive-pack` か
  POST `git-receive-pack` なら push、それ以外 (info/refs?service=git-upload-pack, HEAD,
  objects/* 等) はすべて fetch 扱い
- push: ALLOWED_PUSH_REPOS にある repo にのみ allow + Basic auth 注入。外なら 403
- fetch: 常に Basic auth 注入 (上流が public read を許す repo でも PAT が乗る)
- path が `/<owner>/<repo>.git/...` 形式でない request (`/`, `/<user>`, 等 marketing /
  profile path) は本 module が関与せず、CommonPolicy の readonly_hosts 評価に流れる

設計の補足:
- 「git transport の path 集合を 1 か所で決める」ために path 判定を `_extract_repo` に
  集約。protocol v0/v1 fallback で v2 の主要 path 以外を叩かれても (例: empty bare repo に
  対する `git clone` の `/HEAD` 追加 fetch) PAT 注入が漏れない
- recipes/git-gateway/ の per-repo handler (`path /<repo>.git/*` catch-all で PAT を付与)
  と整合する戦略

実装の補足:
- config.py 経由ではなく os.environ から直接 GITHUB_PAT / ALLOWED_PUSH_REPOS を読む
- 末尾に `addon = GitHubPolicy()` を expose (MITM_EXTRA_ADDONS 規約)
- log prefix は `mitm-github` (lib 側 layer との出所区別)

GIT_HOSTS は他の git host (GitLab / Bitbucket 等) への拡張点。
"""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path


# policy.py が読み込まれた後に importlib 経由で本 module が load される時点では
# sys.path に lib/mitm-proxy/addons/ が既に入っている (policy.py が insert 済) が、
# unit test 等で直接 import される場合のための idempotent 操作。
sys.path.insert(0, str(Path(__file__).parent))

from mitmproxy import http

import audit  # lib/mitm-proxy/addons/audit.py
from rules import Match  # lib/mitm-proxy/addons/rules.py


GIT_HOSTS: set[str] = {"github.com"}

# push リクエストの match 集合 (ALLOWED_PUSH_REPOS で個別判定)。
# path の `**` は `/` を跨ぐ任意 segment (`/octocat/Hello-World.git/...` のような
# multi-segment prefix にマッチさせる用、segment-aware glob)。
# fetch 側は path 判定を `_extract_repo` に一元化 (上記 docstring 参照)。
_PUSH_MATCHERS: tuple[Match, ...] = (
    Match(method="GET", path="**/info/refs", query=(("service", "git-receive-pack"),)),
    Match(method="POST", path="**/git-receive-pack"),
)


def _basic_auth(token: str) -> str:
    raw = f"x-access-token:{token}".encode()
    return f"Basic {base64.b64encode(raw).decode()}"


def _extract_repo(flow: http.HTTPFlow) -> str | None:
    """github.com の git path から `owner/repo` を取り出す。

    git smart-HTTP の path は必ず `/<owner>/<repo>.git/...` 形式で、second segment が
    `.git` で終わる。これを満たさない path (`/`, `/<user>`, `/<owner>/<repo>/issues` 等)
    は git transport ではないので None を返す。本判定が addon の処理境界そのもの。

    例:
      `/octocat/Hello-World.git/info/refs` → `octocat/Hello-World`
      `/octocat/Hello-World.git/HEAD`      → `octocat/Hello-World`
      `/octocat/Hello-World/issues/1`      → None (`.git` suffix が無い)
      `/`                                   → None (segment 不足)
    """
    parts = flow.request.path.split("?", 1)[0].lstrip("/").split("/")
    if len(parts) < 3:
        return None
    owner = parts[0]
    if not parts[1].endswith(".git"):
        return None
    repo = parts[1][: -len(".git")]
    if not owner or not repo:
        return None
    return f"{owner}/{repo}"


def _load_env() -> tuple[str, set[str]]:
    pat = os.environ.get("GITHUB_PAT", "").strip()
    allowed = {
        x.strip()
        for x in os.environ.get("ALLOWED_PUSH_REPOS", "").split(",")
        if x.strip()
    }
    return pat, allowed


class GitHubPolicy:
    def __init__(self) -> None:
        self._pat, self._allowed_push = _load_env()
        audit.logger.info(
            "[mitm-github] GitHubPolicy loaded: GITHUB_PAT=%s ALLOWED_PUSH_REPOS=%s",
            "<set>" if self._pat else "<empty>",
            ",".join(sorted(self._allowed_push)) or "<empty>",
        )

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("mitm_proxy_handled"):
            return

        if flow.request.pretty_host not in GIT_HOSTS:
            return

        repo = _extract_repo(flow)
        if not repo:
            # `/<owner>/<repo>.git/...` 形式でない (marketing page 等) request は
            # 本 module の処理境界外。CommonPolicy の readonly_hosts 評価に委ねる。
            return

        is_push = any(m.matches(flow) for m in _PUSH_MATCHERS)

        if is_push:
            if repo not in self._allowed_push:
                audit.deny(
                    flow,
                    403,
                    f"git push: {repo} is not in ALLOWED_PUSH_REPOS",
                )
                return
            if not self._pat:
                audit.deny(
                    flow,
                    403,
                    "git push: GITHUB_PAT is not set on the proxy",
                )
                return
            audit.logger.info(
                "[mitm-github PUSH-ALLOW] repo=%s phase=%s",
                repo,
                "advertise" if flow.request.method == "GET" else "transfer",
            )

        # fetch (push 以外の git path) / allowed-push: PAT があれば auth 注入。
        # path 種類 (info/refs, git-upload-pack, HEAD, objects/* の dumb HTTP fallback 等)
        # に依らず、本 addon の処理境界に入った request はすべて Authorization を
        # 上書き設定する (client 側偽 Authorization の上書き不変条件も同時に成立する)。
        # fetch は public read repo なら PAT 無しでも通るので fatal にしない。
        if self._pat:
            flow.request.headers["Authorization"] = _basic_auth(self._pat)
        flow.metadata["mitm_proxy_handled"] = True


# MITM_EXTRA_ADDONS 規約: lib/mitm-proxy/addons/policy.py が
# importlib.import_module + module.addon 属性で取り出して addons list の先頭に挿入する。
addon = GitHubPolicy()
