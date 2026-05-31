"""config.py の pure ヘルパ (_interpolate / _csv / _build_inject_rules) の unit。

policy.json の読み込み自体は module top-level で確定するので、test では
個別関数のみを直接呼ぶ。env は mock.patch.dict で囲って scope を閉じる。
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

import config
from config import (
    _apply_macros,
    _build_allow_rules,
    _build_inject_rules,
    _csv,
    _interpolate,
    _merge_fragment,
)


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


class MergeFragmentTest(unittest.TestCase):
    def test_appends_each_key_after_handwritten(self):
        # 手書きルールが先、マクロ生成が後 (header_inject の first-match で手書き優先)
        policy = {
            "readonly_hosts": ["existing.com"],
            "header_inject": [{"match": {"host": "a"}, "headers": {"X": "1"}}],
        }
        _merge_fragment(
            policy,
            {
                "readonly_hosts": ["github.com"],
                "allow_rules": [{"host": "github.com", "path": "/x", "method": "POST"}],
                "header_inject": [{"match": {"host": "b"}, "headers": {"Y": "2"}}],
            },
        )
        self.assertEqual(policy["readonly_hosts"], ["existing.com", "github.com"])
        self.assertEqual([r["match"]["host"] for r in policy["header_inject"]], ["a", "b"])
        self.assertEqual(len(policy["allow_rules"]), 1)

    def test_empty_and_missing_keys_are_skipped(self):
        policy = {}
        _merge_fragment(policy, {"readonly_hosts": [], "allow_rules": [{"host": "x"}]})
        # 空 list は追記されず key 自体できない
        self.assertNotIn("readonly_hosts", policy)
        self.assertEqual(policy["allow_rules"], [{"host": "x"}])


class ApplyMacrosTest(unittest.TestCase):
    def test_imports_calls_generate_and_merges(self):
        mod = types.ModuleType("_test_macro_xyz")
        mod.generate = lambda: {"readonly_hosts": ["macro.example.com"]}
        sys.modules["_test_macro_xyz"] = mod
        try:
            with mock.patch.dict(os.environ, {"POLICY_MACROS": "_test_macro_xyz"}):
                policy = {}
                applied = _apply_macros(policy)
        finally:
            del sys.modules["_test_macro_xyz"]
        self.assertEqual(policy["readonly_hosts"], ["macro.example.com"])
        self.assertEqual(applied[0][0], "_test_macro_xyz")

    def test_no_macros_is_noop(self):
        with mock.patch.dict(os.environ, {"POLICY_MACROS": ""}):
            policy = {}
            applied = _apply_macros(policy)
        self.assertEqual(applied, [])
        self.assertEqual(policy, {})


class MacroLinesTest(unittest.TestCase):
    def test_lists_rules_but_masks_header_values(self):
        saved = config.MACROS_APPLIED
        config.MACROS_APPLIED = [
            (
                "github",
                {
                    "readonly_hosts": ["github.com"],
                    "allow_rules": [
                        {
                            "host": "github.com",
                            "path": "/o/r.git/git-receive-pack",
                            "method": "POST",
                        }
                    ],
                    "header_inject": [
                        {
                            "match": {"host": "github.com", "path": "/**"},
                            "headers": {"Authorization": "Basic SUPERSECRET"},
                        }
                    ],
                },
            )
        ]
        try:
            joined = "\n".join(config.macro_lines())
        finally:
            config.MACROS_APPLIED = saved
        # 許可範囲は検査できる
        self.assertIn("github.com", joined)
        self.assertIn("git-receive-pack", joined)
        self.assertIn("Authorization", joined)  # header 名は出る
        # secret は出さない
        self.assertNotIn("SUPERSECRET", joined)


if __name__ == "__main__":
    unittest.main()
