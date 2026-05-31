"""lib/mitm-proxy/ mitmproxy addon entry point。

mitmdump は `-s policy.py` で本ファイルを読み込み、`addons` リストに並んだ
各 class の `request` hook を順に呼ぶ。

default 順序:
  1. SniGuard       : TLS SNI と CONNECT target の不一致を 403 deny (SNI pivoting 対策)
  2. HostSanGuard   : Host ヘッダが上流 cert SAN に含まれない場合 403 deny (domain fronting 対策)
  3. CommonPolicy   : trusted / allow_rules / readonly / default deny の 4 段判定
  4. HeaderInjector : allow された request にヘッダを inject
  5. AccessLog      : (request, status) を 1 行 INFO で記録 (response hook)

ACL の判定値は `host_utils.real_host(flow)` (= 実宛先, lowercase) に統一する。
HTTPS-via-CONNECT では mitmproxy が inner HttpLayer を transparent mode で作る
ため CONNECT target が反映され、絶対形 URI HTTP では URL の host が反映される。

SniGuard / HostSanGuard は alternatives/simple-http-proxy/ の Squid bump 構成の
2 段 ACL (CONNECT 行 → SNI → cert SAN) を mitm-proxy 側で対称に張る防御層:
  - SniGuard: 詐称 SNI が upstream に forward され CDN tenant が別 routing される
    経路を塞ぐ (Squid の `ssl::server_name --client-requested` に対応)
  - HostSanGuard: 内側 Host ヘッダが上流 cert SAN に無いなら domain fronting /
    request smuggling 試行として deny (Squid bump の
    `SQUID_X509_V_ERR_DOMAIN_MISMATCH` に対応)。同一 cert 内の SAN 共有による
    HTTP/2 connection coalescing は通る (= 副作用無し)

mitmproxy の `-s` は単一ファイルとして読むため `from .X import` の package
relative import が効かない。同ディレクトリの兄弟 module を import するために
sys.path を 1 行だけ書き換えている。

利用側拡張点 (`POLICY_MACROS`):
  env `POLICY_MACROS` に csv で module 名を並べると、config.py がそれらを import して
  各 module の `generate() -> dict` を呼び、返り値 (policy.json と同じスキーマの宣言的
  ルール) を手書き policy にマージする。マクロは flow を直接操作せず、ユーザーが
  policy.json に書けるのと同じ allow / readonly / inject ルールを生成するだけ。生成物は
  running() で 1 行ずつ展開ログされ、利用側は許可範囲を起動時に検査できる。
  例: `POLICY_MACROS=github` で /addons/github.py を読み、その `generate()` が返す
  github.com の git transport 向け readonly / push allow / PAT inject ルールを取り込む。
  PYTHONPATH or addon dir (sys.path に追加済) に target module を置く。
  本拡張点は alternatives/git-mitm-proxy-addon/ のような「lib base + 1 マクロ overlay」
  パターン用。

note: lib/mitm-proxy/ は read-only 許可を主とする最小構成に絞り、github.com の git smart-HTTP
に対する path-based ACL + PAT 注入は recipes/git-gateway/ 側 (ref/branch 単位) で扱う
(recipes/git-gateway/README.md 参照)。軽量代替が要る場合は alternatives/git-mitm-proxy-addon/
で本 image を継承して `POLICY_MACROS=github` でマクロを載せるパターンを用意している。
宣言的ルールに展開できない制御 (smart-HTTP body を見る ref 単位の push 制御等) は
マクロでは表現できないため git-gateway 側に残す。
"""

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

import audit  # noqa: E402
import config  # noqa: E402
from access_log import AccessLog  # noqa: E402
from common import CommonPolicy  # noqa: E402
from header_inject import HeaderInjector  # noqa: E402
from host_san_guard import HostSanGuard  # noqa: E402
from sni_guard import SniGuard  # noqa: E402


# addon は固定の 5 段。利用側拡張は addon を増やすのではなく、config が POLICY_MACROS から
# 生成・マージする宣言的ルールで行う (docstring「利用側拡張点」参照)。
addons = [SniGuard(), HostSanGuard(), CommonPolicy(), HeaderInjector(), AccessLog()]


def running() -> None:
    """mitmproxy 起動時に config を 1 行 dump する。env_file の反映確認の起点。"""
    audit.logger.info("[mitm-proxy] config loaded: %s", config.summary())
    # マクロが生成したルールを 1 行ずつ展開ログする (利用側が許可範囲を起動時に検査できる)。
    for line in config.macro_lines():
        audit.logger.info("[mitm-proxy] macro rule: %s", line)
