"""lib/mitm-proxy/ mitmproxy addon entry point。

mitmdump は `-s policy.py` で本ファイルを読み込み、`addons` リストに並んだ
各 class の `request` hook を順に呼ぶ。

default 順序:
  1. HostGuard      : Host ヘッダと実宛先の不一致を 403 deny (Spoof 対策の境界)
  2. CommonPolicy   : trusted / allow_rules / readonly / default deny の 4 段判定
  3. HeaderInjector : allow された request にヘッダを inject
  4. AccessLog      : (request, status) を 1 行 INFO で記録 (response hook)

HostGuard を最初に置く理由: `flow.request.pretty_host` は Host ヘッダ優先の
spoof 可能な値で、これに依存した ACL は absolute-form URI + 偽 Host や CONNECT
先 ≠ Host で bypass できる。HostGuard で実宛先と Host を整合チェックし、後段
addon は `host_guard.real_host(flow)` を信頼する設計に統一している。

mitmproxy の `-s` は単一ファイルとして読むため `from .X import` の package
relative import が効かない。同ディレクトリの兄弟 module を import するために
sys.path を 1 行だけ書き換えている。

外部 addon 拡張点 (`MITM_EXTRA_ADDONS`):
  env `MITM_EXTRA_ADDONS` に csv で module 名を並べると、それらを import して
  各 module の `addon` 属性を addons list の **HostGuard の直後** に追加する
  (CommonPolicy より前で動かす想定、deny 判定を上書きしたい addon 向け)。
  HostGuard は extras より先に常に動くため、extras も `real_host(flow)` を
  信頼できる。
  例: `MITM_EXTRA_ADDONS=github` で /addons/github.py を読み、その中の
  `addon = GitHubPolicy()` を addons list の index 1 に挿入。
  PYTHONPATH or addon dir (sys.path に追加済) に target module を置く。
  本拡張点は alternatives/git-mitm-proxy-addon/ のような「lib base + 1 addon overlay」
  パターン用。

note: lib/mitm-proxy/ は read-only 許可を主とする最小構成に絞り、github.com の git smart-HTTP
に対する path-based ACL + PAT 注入は recipes/git-gateway/ 側 (ref/branch 単位) で扱う
(recipes/git-gateway/README.md 参照)。軽量代替が要る場合は alternatives/git-mitm-proxy-addon/
で本 image を継承して `MITM_EXTRA_ADDONS=github` 経由で addon を載せるパターンを用意している。
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

import audit  # noqa: E402
import config  # noqa: E402
from access_log import AccessLog  # noqa: E402
from common import CommonPolicy  # noqa: E402
from header_inject import HeaderInjector  # noqa: E402
from host_guard import HostGuard  # noqa: E402


# HostGuard を index 0 に固定する。extras はその直後に入る。
addons = [HostGuard(), CommonPolicy(), HeaderInjector(), AccessLog()]


# 外部 addon を env から動的 load。各 module は末尾で `addon = SomeClass()` を
# expose する規約。複数指定時は csv の **左** が extras 内の先頭に来る
# (= addons list の index 1)。HostGuard より先には入らない (Spoof 検査を
# 必ず先に通すため)。
_extra_csv = os.environ.get("MITM_EXTRA_ADDONS", "")
for _name in reversed([n.strip() for n in _extra_csv.split(",") if n.strip()]):
    _mod = importlib.import_module(_name)
    addons.insert(1, _mod.addon)


def running() -> None:
    """mitmproxy 起動時に config を 1 行 dump する。env_file の反映確認の起点。"""
    audit.logger.info("[mitm-proxy] config loaded: %s", config.summary())
    # HostGuard (index 0) + CommonPolicy / HeaderInjector / AccessLog (末尾 3 個) を除いた
    # 中間 range が extras。
    extras = addons[1:-3]
    if extras:
        audit.logger.info(
            "[mitm-proxy] extra addons loaded: %s",
            ",".join(type(a).__name__ for a in extras),
        )
