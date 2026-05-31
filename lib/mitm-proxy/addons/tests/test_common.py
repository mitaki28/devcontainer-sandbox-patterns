"""CommonPolicy.request の判定経路を unit で検証する。

検証する分岐:
- 既に mitm_proxy_handled が立っている → 何もしない
- mitm.it (CA bootstrap) → 素通し
- TRUSTED_HOSTS マッチ → method 問わず素通し
- ALLOW_RULES マッチ → 通す (readonly より先に評価される)
- READONLY_HOSTS マッチ + GET → 素通し
- READONLY_HOSTS マッチ + POST → 403 deny
- 未知 host → 403 deny
"""

from __future__ import annotations

import unittest

from mitmproxy import http

from common import CommonPolicy
from rules import HostMatcher, Match
from tests._helpers import make_flow, patched_config


class CommonPolicyTest(unittest.TestCase):
    def setUp(self):
        self.policy = CommonPolicy()

    def test_already_handled_no_op(self):
        flow = make_flow(host="example.com")
        flow.metadata["mitm_proxy_handled"] = True
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        # 未知 host だが handled で skip されるので response は立たない
        self.assertIsNone(flow.response)

    def test_existing_response_not_overwritten(self):
        # extras が flow.response を立てて metadata を立て忘れたケースの fail-safe。
        # CommonPolicy は response を上書きしない。
        flow = make_flow(host="example.com")
        flow.response = http.Response.make(200, b"already set by extras")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        # 既存の 200 response がそのまま残ること
        self.assertEqual(flow.response.status_code, 200)
        self.assertEqual(flow.response.content, b"already set by extras")

    def test_mitm_it_passes_unconditionally(self):
        flow = make_flow(host="mitm.it", path="/cert/pem")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_trusted_host_passes_any_method(self):
        flow = make_flow(method="POST", host="api.anthropic.com")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list(["api.anthropic.com"]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_readonly_host_get_passes(self):
        flow = make_flow(method="GET", host="api.github.com")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["api.github.com"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_readonly_host_head_and_options_pass(self):
        for method in ("HEAD", "OPTIONS"):
            with self.subTest(method=method):
                flow = make_flow(method=method, host="api.github.com")
                with patched_config(
                    READONLY_HOSTS=HostMatcher.from_list(["api.github.com"]),
                    TRUSTED_HOSTS=HostMatcher.from_list([]),
                    ALLOW_RULES=[],
                ):
                    self.policy.request(flow)
                self.assertIsNone(flow.response)

    def test_readonly_host_post_denied(self):
        flow = make_flow(method="POST", host="httpbin.org", path="/post")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["httpbin.org"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        self.assertIn("readonly", body)
        self.assertIn("POST", body)

    def test_readonly_host_via_glob(self):
        flow = make_flow(method="GET", host="raw.githubusercontent.com")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["*.githubusercontent.com"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_unknown_host_denied(self):
        flow = make_flow(host="example.com")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertEqual(flow.response.status_code, 403)
        self.assertIn("not in allowlist", flow.response.content.decode())
        self.assertTrue(flow.metadata.get("mitm_proxy_handled"))

    def test_judges_by_real_host_not_header(self):
        # CommonPolicy は実宛先 (flow.request.host) で判定する。
        # Host ヘッダが allowlist 値でも、実宛先が allowlist 外なら deny される
        # (Spoof bypass 対策。Host 整合チェックは addons 先頭の HostGuard が担当
        # するが、本 module 単体でも real_host で判定することは保たれる)。
        flow = make_flow(
            method="GET",
            host="evil.example.com",
            host_header="api.github.com",
        )
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["api.github.com"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[],
        ):
            self.policy.request(flow)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        self.assertIn("not in allowlist", body)
        # deny log の host も実宛先側であること
        self.assertIn("evil.example.com", body)

    def test_allow_rule_individually_allows_post_on_readonly_host(self):
        # readonly_hosts に居る host でも、allow_rules にマッチする (host, path, method)
        # の組合せなら通る (副作用のない POST の典型ユース)。
        flow = make_flow(method="POST", host="httpbin.org", path="/anything/foo")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["httpbin.org"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[
                Match(host="httpbin.org", path="/anything/foo", method="POST"),
            ],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_allow_rule_does_not_match_other_path_on_same_host(self):
        # 同じ readonly host でも path が違えば allow_rules に載らないため
        # readonly 評価に流れて POST は deny される。
        flow = make_flow(method="POST", host="httpbin.org", path="/post")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list(["httpbin.org"]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[
                Match(host="httpbin.org", path="/anything/foo", method="POST"),
            ],
        ):
            self.policy.request(flow)
        self.assertEqual(flow.response.status_code, 403)
        self.assertIn("readonly", flow.response.content.decode())

    def test_allow_rule_grants_unknown_host(self):
        # allow_rules は host を独立に判定するので、readonly / trusted のどちらにも
        # 載っていない host でもマッチすれば通る。
        flow = make_flow(method="POST", host="webhook.example.com", path="/ingest")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[
                Match(host="webhook.example.com", path="/ingest", method="POST"),
            ],
        ):
            self.policy.request(flow)
        self.assertIsNone(flow.response)

    def test_allow_rule_no_match_falls_through_to_deny(self):
        # 何にもマッチしなければ default deny。
        flow = make_flow(method="POST", host="webhook.example.com", path="/other")
        with patched_config(
            READONLY_HOSTS=HostMatcher.from_list([]),
            TRUSTED_HOSTS=HostMatcher.from_list([]),
            ALLOW_RULES=[
                Match(host="webhook.example.com", path="/ingest", method="POST"),
            ],
        ):
            self.policy.request(flow)
        self.assertEqual(flow.response.status_code, 403)
        self.assertIn("not in allowlist", flow.response.content.decode())


if __name__ == "__main__":
    unittest.main()
