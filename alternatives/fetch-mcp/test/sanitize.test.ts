import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { htmlToMarkdown } from "../src/sanitize.ts";

describe("htmlToMarkdown", () => {
  test("converts h1 to # heading", () => {
    const md = htmlToMarkdown("<h1>Title</h1>");
    assert.ok(md.includes("# Title"));
  });

  test("converts paragraph", () => {
    const md = htmlToMarkdown("<p>hello world</p>");
    assert.ok(md.includes("hello world"));
  });

  test("removes script tags entirely", () => {
    const md = htmlToMarkdown(
      "<p>safe</p><script>alert('xss')</script><p>also safe</p>",
    );
    assert.ok(!md.includes("alert"));
    assert.ok(md.includes("safe"));
    assert.ok(md.includes("also safe"));
  });

  test("removes style tags", () => {
    const md = htmlToMarkdown("<p>visible</p><style>body { color: red; }</style>");
    assert.ok(!md.includes("color: red"));
    assert.ok(md.includes("visible"));
  });

  test("removes iframe", () => {
    const md = htmlToMarkdown(
      `<p>main</p><iframe src="https://evil.example/inject"></iframe>`,
    );
    assert.ok(!md.includes("evil.example"));
    assert.ok(md.includes("main"));
  });

  test("removes object / embed / noscript", () => {
    const md = htmlToMarkdown(
      `<p>ok</p><object data="bad.swf"></object><embed src="bad.swf"><noscript>fallback</noscript>`,
    );
    assert.ok(!md.includes("bad.swf"));
    assert.ok(!md.includes("fallback"));
    assert.ok(md.includes("ok"));
  });

  test("converts code block to fenced", () => {
    const md = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    assert.ok(md.includes("```"));
    assert.ok(md.includes("const x = 1;"));
  });

  test("converts links", () => {
    const md = htmlToMarkdown(`<a href="https://example.com/">example</a>`);
    assert.ok(md.includes("[example](https://example.com/)"));
  });
});
