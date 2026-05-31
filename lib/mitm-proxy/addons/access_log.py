"""lib/mitm-proxy/ addon: access log。

各 request の (method, host, path, status) を INFO で 1 行出す。事後 audit 用。

policy:
- body / header の中身は出さない (PAT / OAuth token 等 secret 混入を避ける)
- path の query string も出さない (`?code=...` 等で sensitive 値が乗る provider もある)
- host は **実宛先** (`host_utils.real_host`) を出す。`pretty_host` は Host ヘッダ
  詐称で偽装可能なので audit log には不適

順序: addons リストの末尾に置き、deny / allow / inject 後の最終 response 段階で 1 度だけ書く。
CommonPolicy が deny() で response を立てた場合、mitmproxy は upstream に request を送らないが
addon の response hook 自体は発火するため、deny も access log に乗る。
"""

from __future__ import annotations

from mitmproxy import http

import audit
from host_utils import real_host


class AccessLog:
    def response(self, flow: http.HTTPFlow) -> None:
        if flow.response is None:
            return
        path_no_query = flow.request.path.split("?", 1)[0]
        audit.logger.info(
            "[mitm-proxy ACCESS] %s %s%s -> %d",
            flow.request.method,
            real_host(flow),
            path_no_query,
            flow.response.status_code,
        )
