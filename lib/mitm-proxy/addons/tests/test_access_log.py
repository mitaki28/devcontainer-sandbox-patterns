"""AccessLog の挙動を unit で検証。

policy:
- response hook で 1 行 INFO log を出す
- query string は log に含めない (sensitive 値の漏洩防止)
"""

from __future__ import annotations

import unittest

from mitmproxy import http

import access_log
from tests._helpers import make_flow


class AccessLogTest(unittest.TestCase):
    def test_logs_info_with_request_line_and_status(self):
        flow = make_flow(method="POST", host="api.github.com", path="/zen")
        flow.response = http.Response.make(200, b"ok")
        with self.assertLogs("mitm_proxy", level="INFO") as cm:
            access_log.AccessLog().response(flow)
        joined = "\n".join(cm.output)
        self.assertIn("POST", joined)
        self.assertIn("api.github.com", joined)
        self.assertIn("/zen", joined)
        self.assertIn("200", joined)
        self.assertIn("ACCESS", joined)

    def test_strips_query_string(self):
        flow = make_flow(
            method="GET",
            host="example.com",
            path="/cb",
            query={"code": "secret_token_value"},
        )
        flow.response = http.Response.make(200, b"")
        with self.assertLogs("mitm_proxy", level="INFO") as cm:
            access_log.AccessLog().response(flow)
        joined = "\n".join(cm.output)
        self.assertNotIn("secret_token_value", joined)
        self.assertNotIn("?", joined)
        # path 本体は残る
        self.assertIn("/cb", joined)

    def test_records_deny_status(self):
        # CommonPolicy が deny で立てた 403 もログに残ることを確認
        flow = make_flow(method="POST", host="evil.example.com", path="/leak")
        flow.response = http.Response.make(403, b"denied")
        with self.assertLogs("mitm_proxy", level="INFO") as cm:
            access_log.AccessLog().response(flow)
        joined = "\n".join(cm.output)
        self.assertIn("403", joined)
        self.assertIn("evil.example.com", joined)

    def test_skips_when_response_is_none(self):
        flow = make_flow()
        flow.response = None
        # 何も log されないこと
        with self.assertLogs("mitm_proxy", level="INFO") as cm:
            access_log.AccessLog().response(flow)
            # 1 つも INFO が無いと assertLogs が AssertionError を投げるので、
            # ダミーを 1 件出してから比較する。
            import logging
            logging.getLogger("mitm_proxy").info("__sentinel__")
        joined = "\n".join(cm.output)
        self.assertNotIn("ACCESS", joined)


if __name__ == "__main__":
    unittest.main()
