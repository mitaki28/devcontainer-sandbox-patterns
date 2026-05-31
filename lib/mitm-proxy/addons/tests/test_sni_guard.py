"""SniGuard の挙動を unit で検証。

- SNI と CONNECT target (= flow.request.host) の整合・不整合
- SNI 不在 (HTTP 平文等) は skip
- mitm.it 例外 / response 既設定なら skip
"""

from __future__ import annotations

import unittest

from mitmproxy import http as _http

from sni_guard import SniGuard
from tests._helpers import make_flow


def _set_sni(flow: _http.HTTPFlow, sni: str | None) -> _http.HTTPFlow:
    flow.client_conn.sni = sni
    return flow


class SniGuardTest(unittest.TestCase):
    def setUp(self):
        self.guard = SniGuard()

    def test_consistent_passes(self):
        flow = _set_sni(make_flow(host="api.github.com"), "api.github.com")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_mismatch_denied_with_403(self):
        # 攻撃シナリオ: CONNECT api.github.com (= flow.request.host) に対し、
        # client が ClientHello で詐称 SNI evil.example.com を送る。
        flow = _set_sni(make_flow(host="api.github.com"), "evil.example.com")
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        self.assertIn("evil.example.com", body)
        self.assertIn("api.github.com", body)

    def test_case_difference_treated_as_consistent(self):
        # 比較は lowercase 正規化後に行うので大文字 SNI は一致扱い
        flow = _set_sni(make_flow(host="api.github.com"), "API.GITHUB.COM")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_sni_absent_skips(self):
        # HTTP 平文 / CONNECT 無しの場合は client_conn.sni が None。判定を skip。
        flow = _set_sni(make_flow(host="api.github.com"), None)
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_sni_empty_string_skips(self):
        # 空文字も None と同等に扱う (mitmproxy 実装で None 以外の偽値が来ても安全に)
        flow = _set_sni(make_flow(host="api.github.com"), "")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_mitm_it_passes_even_if_sni_differs(self):
        # real_host = mitm.it は mitmproxy onboarding が内部処理する pseudo host。
        # SNI に何が来ても upstream には forward されないので skip でよい。
        flow = _set_sni(make_flow(host="mitm.it"), "evil.example.com")
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_existing_response_not_overwritten(self):
        flow = _set_sni(make_flow(host="api.github.com"), "evil.example.com")
        flow.response = _http.Response.make(200, b"already set upstream")
        self.guard.request(flow)
        self.assertEqual(flow.response.status_code, 200)
        self.assertEqual(flow.response.content, b"already set upstream")


if __name__ == "__main__":
    unittest.main()
