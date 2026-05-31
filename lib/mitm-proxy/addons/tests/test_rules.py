"""rules.HostMatcher / rules.Match の挙動を unit で検証する。

HostMatcher: exact / glob の振り分け、bool / str 表現
Match.matches: host / method / path / query の各次元と組み合わせ
"""

from __future__ import annotations

import unittest

from rules import HostMatcher, Match
from tests._helpers import make_flow


class HostMatcherTest(unittest.TestCase):
    def test_from_list_splits_exact_and_globs(self):
        m = HostMatcher.from_list(
            ["api.github.com", "*.example.com", "registry-?.docker.io"]
        )
        self.assertEqual(m.exact, frozenset({"api.github.com"}))
        self.assertEqual(
            set(m.globs), {"*.example.com", "registry-?.docker.io"}
        )

    def test_matches_exact(self):
        m = HostMatcher.from_list(["api.github.com"])
        self.assertTrue(m.matches("api.github.com"))
        self.assertFalse(m.matches("github.com"))
        self.assertFalse(m.matches("api.github.com.evil.example"))

    def test_matches_glob_single_label(self):
        # host glob は segment-aware (TLS ワイルドカード証明書 / nginx server_name と同じ慣行)。
        # `*` は 1 ラベル分で `.` を跨がない。
        m = HostMatcher.from_list(["*.example.com"])
        self.assertTrue(m.matches("a.example.com"))
        self.assertFalse(m.matches("foo.bar.example.com"))  # 2 ラベル subdomain は不可
        # bare はマッチしない (明示性を取る方針)
        self.assertFalse(m.matches("example.com"))

    def test_matches_glob_multi_label_with_explicit_pattern(self):
        # 2 ラベル subdomain を許したい場合は `*.*.example.com` を明示する
        m = HostMatcher.from_list(["*.*.example.com"])
        self.assertTrue(m.matches("foo.bar.example.com"))
        self.assertFalse(m.matches("bar.example.com"))

    def test_matches_combined(self):
        m = HostMatcher.from_list(["api.github.com", "*.example.com"])
        self.assertTrue(m.matches("api.github.com"))
        self.assertTrue(m.matches("a.example.com"))
        self.assertFalse(m.matches("other.com"))

    def test_bool(self):
        self.assertFalse(bool(HostMatcher.from_list([])))
        self.assertTrue(bool(HostMatcher.from_list(["a.com"])))
        self.assertTrue(bool(HostMatcher.from_list(["*.a.com"])))

    def test_str_sorted_and_grouped(self):
        m = HostMatcher.from_list(["b.com", "a.com", "*.x.com", "*.a.com"])
        # exact の sort → globs の sort の順
        self.assertEqual(str(m), "a.com,b.com,*.a.com,*.x.com")

    def test_str_empty(self):
        self.assertEqual(str(HostMatcher.from_list([])), "<empty>")

    def test_pattern_lowercased(self):
        # policy.json で mixed-case を書かれても lowercase に揃え、real_host
        # (lowercase) と一致比較できるようにする
        m = HostMatcher.from_list(["API.GitHub.com", "*.Example.COM"])
        self.assertTrue(m.matches("api.github.com"))
        self.assertTrue(m.matches("foo.example.com"))


class MatchTest(unittest.TestCase):
    def test_no_constraint_matches_anything(self):
        self.assertTrue(Match().matches(make_flow()))

    def test_host_exact(self):
        m = Match(host="github.com")
        self.assertTrue(m.matches(make_flow(host="github.com")))
        self.assertFalse(m.matches(make_flow(host="api.github.com")))

    def test_host_glob(self):
        m = Match(host="*.github.com")
        self.assertTrue(m.matches(make_flow(host="api.github.com")))
        self.assertFalse(m.matches(make_flow(host="github.com")))
        # segment-aware: 2 ラベル subdomain は別 entry が要る
        self.assertFalse(m.matches(make_flow(host="raw.api.github.com")))

    def test_host_matches_real_host_not_header(self):
        # Match は実宛先 (flow.request.host) で判定し、Host ヘッダの詐称に
        # 騙されてはならない。pattern 一致は real_host 側にだけ依存する。
        m = Match(host="api.github.com")
        self.assertTrue(
            m.matches(
                make_flow(host="api.github.com", host_header="evil.example.com")
            )
        )
        self.assertFalse(
            m.matches(
                make_flow(host="evil.example.com", host_header="api.github.com")
            )
        )

    def test_host_case_insensitive(self):
        # pattern / real_host とも lowercase 正規化される
        m = Match(host="API.github.com")
        self.assertTrue(m.matches(make_flow(host="api.GitHub.COM")))

    def test_method_exact(self):
        m = Match(method="POST")
        self.assertTrue(m.matches(make_flow(method="POST")))
        self.assertFalse(m.matches(make_flow(method="GET")))

    def test_method_wildcard(self):
        m = Match(method="*")
        self.assertTrue(m.matches(make_flow(method="GET")))
        self.assertTrue(m.matches(make_flow(method="DELETE")))

    def test_path_glob_single_segment(self):
        # `*` は 1 segment、`/` を跨がない。`/octocat/Hello-World.git/git-upload-pack`
        # は segment 数が合わない (`*` = 1 segment 想定なので 1 segment 前置のみ)
        m = Match(path="*/git-upload-pack")
        self.assertTrue(m.matches(make_flow(path="foo/git-upload-pack")))
        self.assertFalse(m.matches(make_flow(path="/octocat/Hello-World.git/git-upload-pack")))
        self.assertFalse(m.matches(make_flow(path="/foo")))

    def test_path_glob_double_star_spans_slashes(self):
        # `**` は `/` 跨ぐ。任意 segment 数の prefix にマッチ
        m = Match(path="**/git-upload-pack")
        self.assertTrue(m.matches(make_flow(path="/octocat/Hello-World.git/git-upload-pack")))
        self.assertTrue(m.matches(make_flow(path="/foo/git-upload-pack")))
        self.assertTrue(m.matches(make_flow(path="/git-upload-pack")))
        self.assertFalse(m.matches(make_flow(path="/foo")))

    def test_path_strips_query_before_match(self):
        # path は query を除去した上で glob する
        m = Match(path="**/info/refs")
        self.assertTrue(
            m.matches(
                make_flow(
                    path="/foo/info/refs", query={"service": "git-upload-pack"}
                )
            )
        )

    def test_query_all_must_match(self):
        m = Match(query=(("service", "git-upload-pack"),))
        self.assertTrue(
            m.matches(make_flow(query={"service": "git-upload-pack"}))
        )
        self.assertFalse(
            m.matches(make_flow(query={"service": "git-receive-pack"}))
        )
        self.assertFalse(m.matches(make_flow()))

    def test_query_multiple_keys(self):
        m = Match(query=(("a", "1"), ("b", "2")))
        self.assertTrue(m.matches(make_flow(query={"a": "1", "b": "2"})))
        self.assertFalse(m.matches(make_flow(query={"a": "1"})))
        self.assertFalse(m.matches(make_flow(query={"a": "1", "b": "3"})))

    def test_combined(self):
        m = Match(
            host="github.com",
            method="GET",
            path="**/info/refs",
            query=(("service", "git-receive-pack"),),
        )
        push_advertise = make_flow(
            host="github.com",
            method="GET",
            path="/me/repo.git/info/refs",
            query={"service": "git-receive-pack"},
        )
        self.assertTrue(m.matches(push_advertise))

        # method 違い
        self.assertFalse(
            m.matches(
                make_flow(
                    host="github.com",
                    method="POST",
                    path="/me/repo.git/info/refs",
                    query={"service": "git-receive-pack"},
                )
            )
        )
        # query 違い
        self.assertFalse(
            m.matches(
                make_flow(
                    host="github.com",
                    method="GET",
                    path="/me/repo.git/info/refs",
                    query={"service": "git-upload-pack"},
                )
            )
        )


if __name__ == "__main__":
    unittest.main()
