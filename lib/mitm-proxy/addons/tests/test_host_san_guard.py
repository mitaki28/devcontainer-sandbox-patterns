"""HostSanGuard の挙動を unit で検証。

self-signed cert を即席生成して flow.server_conn.certificate_list に注入し、
service_identity 経由の SAN 照合が期待通りに deny / allow するかを見る。
"""

from __future__ import annotations

import datetime
import unittest

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from mitmproxy import certs as mitm_certs
from mitmproxy import http as _http

from host_san_guard import HostSanGuard
from tests._helpers import make_flow


def _make_cert(sans: list[str]) -> mitm_certs.Cert:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "mock")])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(datetime.datetime(2020, 1, 1))
        .not_valid_after(datetime.datetime(2030, 1, 1))
    )
    if sans:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]),
            critical=False,
        )
    return mitm_certs.Cert(builder.sign(key, hashes.SHA256()))


def _attach_cert(flow: _http.HTTPFlow, cert: mitm_certs.Cert | None) -> _http.HTTPFlow:
    flow.server_conn.certificate_list = [cert] if cert is not None else []
    return flow


class HostSanGuardTest(unittest.TestCase):
    def setUp(self):
        self.guard = HostSanGuard()

    def test_host_equals_target_skips(self):
        # Host = CONNECT target は上流 hostname verification 済とみなし照合不要
        cert = _make_cert(["api.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="api.github.com"), cert
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_host_in_cert_san_passes(self):
        # 同一 cert に複数 SAN が乗っている coalescing 正当ケース
        cert = _make_cert(["api.github.com", "codeload.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="codeload.github.com"), cert
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_host_not_in_cert_san_denied(self):
        cert = _make_cert(["api.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="evil.example.com"), cert
        )
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        body = flow.response.content.decode()
        self.assertIn("evil.example.com", body)

    def test_wildcard_san_matches(self):
        cert = _make_cert(["*.content.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="raw.content.github.com"),
            cert,
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_wildcard_san_does_not_match_extra_label(self):
        # `*.content.github.com` は単一 label のみ match (RFC 6125)
        cert = _make_cert(["*.content.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="a.b.content.github.com"),
            cert,
        )
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)

    def test_host_header_absent_skips(self):
        # tflow デフォルトでは host_header は自動 set されるが、空にするケース
        flow = make_flow(host="api.github.com")
        flow.request.headers.pop("Host", None)
        _attach_cert(flow, _make_cert(["api.github.com"]))
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_no_upstream_cert_skips(self):
        # HTTP 平文等で上流 cert を握っていないケース。CommonPolicy が default deny で
        # 塞ぐので本 guard は判定根拠が無く skip する。
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="evil.example.com"), None
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_mitm_it_pseudo_host_skips(self):
        # mitm.it は CA 配布 endpoint で upstream に飛ばないので照合不要
        cert = _make_cert(["api.github.com"])
        flow = _attach_cert(
            make_flow(host="mitm.it", host_header="evil.example.com"), cert
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_ip_literal_host_header_denied(self):
        # `Host: [::1]` (= 抽出後 "::1") は service_identity の DNS_ID 構築で
        # ValueError になる。HostSanGuard が ValueError も catch して 403 で
        # 倒す (fail-closed) ことを確認。
        cert = _make_cert(["api.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="[::1]"), cert
        )
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)

    def test_cert_without_sans_denied(self):
        # 上流 cert に SAN が無いケース (legacy / 例外的)。service_identity は
        # CertificateError を raise する。403 で deny する。
        cert = _make_cert([])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="evil.example.com"), cert
        )
        self.guard.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)

    def test_case_insensitive(self):
        cert = _make_cert(["api.github.com", "codeload.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="CODELOAD.GITHUB.COM"), cert
        )
        self.guard.request(flow)
        self.assertIsNone(flow.response)

    def test_existing_response_not_overwritten(self):
        cert = _make_cert(["api.github.com"])
        flow = _attach_cert(
            make_flow(host="api.github.com", host_header="evil.example.com"), cert
        )
        flow.response = _http.Response.make(200, b"already set upstream")
        self.guard.request(flow)
        self.assertEqual(flow.response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
