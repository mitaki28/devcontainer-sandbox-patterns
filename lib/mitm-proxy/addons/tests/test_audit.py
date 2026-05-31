"""audit.deny の挙動を unit で検証する。

deny() は (1) flow.response を立て (2) mitm_proxy_handled metadata を立て
(3) WARNING ログを出す、の 3 つが噛み合うことが addon 全体の正しさの基礎。
"""

from __future__ import annotations

import unittest

import audit
from tests._helpers import make_flow


class DenyTest(unittest.TestCase):
    def test_sets_response_with_status_and_body(self):
        flow = make_flow()
        audit.deny(flow, 403, "test reason")
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        self.assertIn("test reason", body)
        self.assertIn("lib/mitm-proxy", body)
        self.assertEqual(
            flow.response.headers.get("Content-Type"),
            "text/plain; charset=utf-8",
        )

    def test_marks_handled(self):
        flow = make_flow()
        audit.deny(flow, 403, "x")
        self.assertTrue(flow.metadata.get("mitm_proxy_handled"))

    def test_logs_warning_with_reason(self):
        flow = make_flow(method="POST", host="example.com", path="/x")
        with self.assertLogs("mitm_proxy", level="WARNING") as cm:
            audit.deny(flow, 418, "teapot reason")
        joined = "\n".join(cm.output)
        self.assertIn("teapot reason", joined)
        self.assertIn("418", joined)
        self.assertIn("POST", joined)
        self.assertIn("example.com", joined)


if __name__ == "__main__":
    unittest.main()
