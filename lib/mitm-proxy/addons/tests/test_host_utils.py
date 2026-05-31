"""host helpers の挙動を unit で検証。

- real_host / host_header_host / is_mitm_pseudo_host
"""

from __future__ import annotations

import unittest

from host_utils import (
    host_header_host,
    is_mitm_pseudo_host,
    real_host,
)
from tests._helpers import make_flow


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

    def test_bracketed_ipv6_with_port(self):
        flow = make_flow(host="::1", host_header="[::1]:8443")
        self.assertEqual(host_header_host(flow), "::1")

    def test_bracketed_ipv6_no_port(self):
        flow = make_flow(host="::1", host_header="[::1]")
        self.assertEqual(host_header_host(flow), "::1")

    def test_userinfo_kept_opaque(self):
        # RFC 7230 §5.4 は Host ヘッダの userinfo を禁じる。parse_authority は
        # `check=False` で fail-open するため生値が host 側に残り、後段の
        # mismatch 判定で確実に deny に倒れる (silently 剥がして通さない)。
        flow = make_flow(host="example.com", host_header="user:pass@example.com:443")
        self.assertEqual(host_header_host(flow), "user:pass@example.com:443")

    def test_bare_ipv6_kept_opaque(self):
        # bracket 無し IPv6 は仕様外 (RFC 7230 §5.4)。parse_authority は
        # check=False で生値を host 側に残す (silently 切り詰めない)。
        flow = make_flow(host="fe80::1", host_header="fe80::1")
        self.assertEqual(host_header_host(flow), "fe80::1")

    def test_empty_header_falls_back_to_raw(self):
        flow = make_flow(host="example.com", host_header="")
        self.assertEqual(host_header_host(flow), "")


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


if __name__ == "__main__":
    unittest.main()
