"""HostGuard と host helpers の挙動を unit で検証。

- real_host / host_header_host / host_mismatch のヘルパ
- HostGuard.request: 整合・不整合・mitm.it 例外・既処理 skip
"""

from __future__ import annotations

import unittest

import host_guard
from host_guard import (
    HostGuard,
    host_header_host,
    host_mismatch,
    is_mitm_pseudo_host,
    real_host,
)
from tests._helpers import make_flow


class StripPortTest(unittest.TestCase):
    def test_bare_host(self):
        self.assertEqual(host_guard._strip_port("example.com"), "example.com")

    def test_host_with_port(self):
        self.assertEqual(host_guard._strip_port("example.com:443"), "example.com")

    def test_bracketed_ipv6_with_port(self):
        self.assertEqual(host_guard._strip_port("[::1]:8443"), "::1")

    def test_bracketed_ipv6_no_port(self):
        self.assertEqual(host_guard._strip_port("[::1]"), "::1")

    def test_bare_ipv6_no_port_kept(self):
        # bracket 無し IPv6 は port 不可。`:` 複数で port と誤認しない
        self.assertEqual(host_guard._strip_port("fe80::1"), "fe80::1")

    def test_empty(self):
        self.assertEqual(host_guard._strip_port(""), "")


class RealHostTest(unittest.TestCase):
    def test_returns_request_host(self):
        flow = make_flow(host="api.github.com")
        self.assertEqual(real_host(flow), "api.github.com")

    def test_lowercased(self):
        flow = make_flow(host="API.GitHub.Com")
        self.assertEqual(real_host(flow), "api.github.com")

    def test_ignores_host_header(self):
        # Host ヘッダが何であっても real_host は接続先を返す
        flow = make_flow(host="evil.example.com", host_header="api.github.com")
        self.assertEqual(real_host(flow), "evil.example.com")


class HostHeaderHostTest(unittest.TestCase):
    def test_returns_header_host(self):
        flow = make_flow(host="example.com", host_header="api.github.com")
        self.assertEqual(host_header_host(flow), "api.github.com")

    def test_strips_port(self):
        flow = make_flow(host="example.com", host_header="api.github.com:443")
        self.assertEqual(host_header_host(flow), "api.github.com")

    def test_lowercased(self):
        flow = make_flow(host="example.com", host_header="API.GITHUB.COM")
        self.assertEqual(host_header_host(flow), "api.github.com")


class HostMismatchTest(unittest.TestCase):
    def test_consistent_returns_false(self):
        flow = make_flow(host="api.github.com", host_header="api.github.com")
        self.assertFalse(host_mismatch(flow))

    def test_consistent_with_port_returns_false(self):
        flow = make_flow(host="api.github.com", host_header="api.github.com:443")
        self.assertFalse(host_mismatch(flow))

    def test_case_difference_treated_as_consistent(self):
        flow = make_flow(host="api.github.com", host_header="API.GITHUB.COM")
        self.assertFalse(host_mismatch(flow))

    def test_mismatch_returns_true(self):
        flow = make_flow(host="evil.example.com", host_header="api.github.com")
        self.assertTrue(host_mismatch(flow))


class IsMitmPseudoHostTest(unittest.TestCase):
    def test_real_host_mit_it(self):
        flow = make_flow(host="mitm.it", host_header="mitm.it")
        self.assertTrue(is_mitm_pseudo_host(flow))

    def test_host_header_spoof_does_not_qualify(self):
        # real_host が mitm.it でなければ pseudo host 例外は効かない。
        # `Host: mitm.it` 詐称で抜け道を作らないこと。
        flow = make_flow(host="evil.example.com", host_header="mitm.it")
        self.assertFalse(is_mitm_pseudo_host(flow))

    def test_neither_is_mit_it(self):
        flow = make_flow(host="api.github.com", host_header="api.github.com")
        self.assertFalse(is_mitm_pseudo_host(flow))


class HostGuardTest(unittest.TestCase):
    def setUp(self):
        self.guard = HostGuard()

    def test_consistent_passes(self):
        flow = make_flow(host="api.github.com", host_header="api.github.com")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_mismatch_denied_with_403(self):
        flow = make_flow(host="evil.example.com", host_header="api.github.com")
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        # 実宛先と Host ヘッダの両方が reason に載ること (audit 性)
        self.assertIn("evil.example.com", body)
        self.assertIn("api.github.com", body)
        self.assertTrue(flow.metadata.get("mitm_proxy_handled"))

    def test_mitm_it_passes_even_if_header_differs(self):
        # real_host = mitm.it なら mitmproxy onboarding が内部処理する。
        # Host ヘッダが何であっても upstream には forward されない。
        flow = make_flow(host="mitm.it", host_header="evil.example.com")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_mitm_it_header_spoof_still_denied(self):
        # `Host: mitm.it` で real_host が別ホストなら mismatch → 通常の deny
        # (mitm.it 例外は real_host ベースのみ)。
        flow = make_flow(host="evil.example.com", host_header="mitm.it")
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)

    def test_already_handled_no_op(self):
        flow = make_flow(host="evil.example.com", host_header="api.github.com")
        flow.metadata["mitm_proxy_handled"] = True
        self.guard.request(flow)
        # 既処理なので mismatch でも deny を上書きしない
        self.assertIsNone(flow.response)

    def test_existing_response_not_overwritten(self):
        # extras が flow.response を立てて metadata を立て忘れたケースの fail-safe。
        # HostGuard は response を上書きしない。
        from mitmproxy import http as _http
        flow = make_flow(host="evil.example.com", host_header="api.github.com")
        flow.response = _http.Response.make(200, b"already set by extras")
        self.guard.request(flow)
        self.assertEqual(flow.response.status_code, 200)
        self.assertEqual(flow.response.content, b"already set by extras")

    def test_uppercase_mismatch_still_denied(self):
        flow = make_flow(host="evil.example.com", host_header="API.GITHUB.COM")
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
