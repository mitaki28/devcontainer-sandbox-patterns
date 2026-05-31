"""HeaderInjector の挙動を unit で検証する。

- match した rule に従い request にヘッダ注入
- response が既に立っていれば skip (deny 済み request にヘッダを足さない)
- match しなければ何もしない
- 複数 rule が match した場合は最初に一致した rule のみ適用
"""

from __future__ import annotations

import unittest

from mitmproxy import http

from header_inject import HeaderInjector
from rules import InjectRule, Match
from tests._helpers import make_flow


def _injector(rules):
    inj = HeaderInjector()
    inj.rules = rules
    return inj


class HeaderInjectorTest(unittest.TestCase):
    def test_injects_on_match(self):
        rule = InjectRule(
            match=Match(host="httpbin.org", path="/headers"),
            headers=(("X-Test", "value"), ("X-Other", "other")),
        )
        flow = make_flow(host="httpbin.org", path="/headers")
        _injector([rule]).request(flow)
        self.assertEqual(flow.request.headers["X-Test"], "value")
        self.assertEqual(flow.request.headers["X-Other"], "other")

    def test_skips_when_response_already_set(self):
        # CommonPolicy が deny した直後（response が立っている）に inject しない
        rule = InjectRule(
            match=Match(host="httpbin.org"),
            headers=(("X-Test", "value"),),
        )
        flow = make_flow(host="httpbin.org")
        flow.response = http.Response.make(403, b"")
        _injector([rule]).request(flow)
        self.assertNotIn("X-Test", flow.request.headers)

    def test_no_match_leaves_request_unchanged(self):
        rule = InjectRule(
            match=Match(host="other.com"),
            headers=(("X-Test", "value"),),
        )
        flow = make_flow(host="httpbin.org")
        _injector([rule]).request(flow)
        self.assertNotIn("X-Test", flow.request.headers)

    def test_first_match_wins(self):
        rule_a = InjectRule(
            match=Match(host="httpbin.org"),
            headers=(("X-Test", "first"),),
        )
        rule_b = InjectRule(
            match=Match(host="httpbin.org"),
            headers=(("X-Test", "second"),),
        )
        flow = make_flow(host="httpbin.org")
        _injector([rule_a, rule_b]).request(flow)
        self.assertEqual(flow.request.headers["X-Test"], "first")


if __name__ == "__main__":
    unittest.main()
