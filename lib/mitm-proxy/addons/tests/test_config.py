"""config.py の pure ヘルパ (_interpolate / _csv / _build_inject_rules) の unit。

policy.json の読み込み自体は module top-level で確定するので、test では
個別関数のみを直接呼ぶ。env は mock.patch.dict で囲って scope を閉じる。
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from config import _build_allow_rules, _build_inject_rules, _csv, _interpolate


class InterpolateTest(unittest.TestCase):
    def test_substitutes_existing_var(self):
        with mock.patch.dict(os.environ, {"FOO": "bar"}):
            self.assertEqual(_interpolate("X${FOO}Y"), "XbarY")

    def test_multiple_vars(self):
        with mock.patch.dict(os.environ, {"A": "1", "B": "2"}):
            self.assertEqual(_interpolate("${A}-${B}"), "1-2")

    def test_undefined_becomes_empty(self):
        os.environ.pop("UNDEFINED_VAR_FOR_INTERPOLATE_TEST", None)
        self.assertEqual(
            _interpolate("X${UNDEFINED_VAR_FOR_INTERPOLATE_TEST}Y"), "XY"
        )

    def test_no_placeholder(self):
        self.assertEqual(_interpolate("plain"), "plain")
        self.assertEqual(_interpolate(""), "")

    def test_rejects_crlf_in_interpolated_value(self):
        # env 由来の値に CR/LF が紛れ込むと header injection になりうるので fail-closed。
        with mock.patch.dict(os.environ, {"BAD": "abc\r\nX-Injected: yes"}):
            with self.assertRaises(ValueError):
                _interpolate("Bearer ${BAD}")
        with mock.patch.dict(os.environ, {"BAD": "abc\nfoo"}):
            with self.assertRaises(ValueError):
                _interpolate("Bearer ${BAD}")

    def test_rejects_crlf_in_literal_too(self):
        # 元の string に直接 CR/LF があっても reject (policy.json に書かれた値の defence)。
        with self.assertRaises(ValueError):
            _interpolate("foo\r\nbar")


class CsvTest(unittest.TestCase):
    def test_splits_and_strips(self):
        with mock.patch.dict(os.environ, {"X_TEST_CSV": " a, b ,c "}):
            self.assertEqual(_csv("X_TEST_CSV"), {"a", "b", "c"})

    def test_drops_empty_entries(self):
        with mock.patch.dict(os.environ, {"X_TEST_CSV": "a,,b,"}):
            self.assertEqual(_csv("X_TEST_CSV"), {"a", "b"})

    def test_empty_string(self):
        with mock.patch.dict(os.environ, {"X_TEST_CSV": ""}):
            self.assertEqual(_csv("X_TEST_CSV"), set())

    def test_unset(self):
        os.environ.pop("UNSET_TEST_CSV_VAR", None)
        self.assertEqual(_csv("UNSET_TEST_CSV_VAR"), set())


class BuildInjectRulesTest(unittest.TestCase):
    def test_full_match_and_headers(self):
        with mock.patch.dict(os.environ, {"TOK": "abc"}):
            rules = _build_inject_rules(
                [
                    {
                        "match": {
                            "host": "example.com",
                            "path": "/x",
                            "method": "GET",
                            "query": {"k": "v"},
                        },
                        "headers": {"Authorization": "Bearer ${TOK}"},
                    }
                ]
            )
        self.assertEqual(len(rules), 1)
        rule = rules[0]
        self.assertEqual(rule.match.host, "example.com")
        self.assertEqual(rule.match.path, "/x")
        self.assertEqual(rule.match.method, "GET")
        self.assertEqual(rule.match.query, (("k", "v"),))
        self.assertEqual(rule.headers, (("Authorization", "Bearer abc"),))

    def test_missing_match_fields_become_none(self):
        rules = _build_inject_rules([{"match": {}, "headers": {}}])
        self.assertIsNone(rules[0].match.host)
        self.assertIsNone(rules[0].match.path)
        self.assertIsNone(rules[0].match.method)
        self.assertEqual(rules[0].match.query, ())
        self.assertEqual(rules[0].headers, ())

    def test_undefined_secret_interpolated_to_empty(self):
        # secret 未設定でも build 自体は成功し、値が空文字になる。
        # （deny は addon 側でなく、後段で 401 等で発覚させる方針）
        os.environ.pop("UNDEFINED_SECRET_FOR_TEST", None)
        rules = _build_inject_rules(
            [
                {
                    "match": {"host": "x.com"},
                    "headers": {"Authorization": "Bearer ${UNDEFINED_SECRET_FOR_TEST}"},
                }
            ]
        )
        self.assertEqual(rules[0].headers, (("Authorization", "Bearer "),))

    def test_multiple_entries(self):
        rules = _build_inject_rules(
            [
                {"match": {"host": "a.com"}, "headers": {"X-A": "1"}},
                {"match": {"host": "b.com"}, "headers": {"X-B": "2"}},
            ]
        )
        self.assertEqual(len(rules), 2)
        self.assertEqual(rules[0].match.host, "a.com")
        self.assertEqual(rules[1].match.host, "b.com")


class BuildAllowRulesTest(unittest.TestCase):
    def test_full_match(self):
        rules = _build_allow_rules(
            [
                {
                    "host": "example.com",
                    "path": "/x",
                    "method": "POST",
                    "query": {"k": "v"},
                }
            ]
        )
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].host, "example.com")
        self.assertEqual(rules[0].path, "/x")
        self.assertEqual(rules[0].method, "POST")
        self.assertEqual(rules[0].query, (("k", "v"),))

    def test_missing_fields_become_none(self):
        rules = _build_allow_rules([{"host": "example.com"}])
        self.assertEqual(rules[0].host, "example.com")
        self.assertIsNone(rules[0].path)
        self.assertIsNone(rules[0].method)
        self.assertEqual(rules[0].query, ())

    def test_doc_key_is_ignored(self):
        # `_doc` 等の追加 key は Match に渡されず、副作用を起こさない。
        rules = _build_allow_rules(
            [{"_doc": "explanation", "host": "example.com", "method": "POST"}]
        )
        self.assertEqual(rules[0].host, "example.com")
        self.assertEqual(rules[0].method, "POST")

    def test_multiple_entries_preserve_order(self):
        rules = _build_allow_rules(
            [
                {"host": "a.com"},
                {"host": "b.com"},
            ]
        )
        self.assertEqual([r.host for r in rules], ["a.com", "b.com"])

    def test_empty_input(self):
        self.assertEqual(_build_allow_rules([]), [])


if __name__ == "__main__":
    unittest.main()
