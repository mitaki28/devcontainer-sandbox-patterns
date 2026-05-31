import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/sanitize.ts";

describe("htmlToMarkdown", () => {
  test("converts h1 to # heading", () => {
    const md = htmlToMarkdown("<h1>Title</h1>");
    expect(md).toContain("# Title");
  });

  test("converts paragraph", () => {
    const md = htmlToMarkdown("<p>hello world</p>");
    expect(md).toContain("hello world");
  });

  test("removes script tags entirely", () => {
    const md = htmlToMarkdown(
      "<p>safe</p><script>alert('xss')</script><p>also safe</p>",
    );
    expect(md).not.toContain("alert");
    expect(md).toContain("safe");
    expect(md).toContain("also safe");
  });

  test("removes style tags", () => {
    const md = htmlToMarkdown("<p>visible</p><style>body { color: red; }</style>");
    expect(md).not.toContain("color: red");
    expect(md).toContain("visible");
  });

  test("removes iframe", () => {
    const md = htmlToMarkdown(
      `<p>main</p><iframe src="https://evil.example/inject"></iframe>`,
    );
    expect(md).not.toContain("evil.example");
    expect(md).toContain("main");
  });

  test("removes object / embed / noscript", () => {
    const md = htmlToMarkdown(
      `<p>ok</p><object data="bad.swf"></object><embed src="bad.swf"><noscript>fallback</noscript>`,
    );
    expect(md).not.toContain("bad.swf");
    expect(md).not.toContain("fallback");
    expect(md).toContain("ok");
  });

  test("converts code block to fenced", () => {
    const md = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    expect(md).toContain("```");
    expect(md).toContain("const x = 1;");
  });

  test("converts links", () => {
    const md = htmlToMarkdown(`<a href="https://example.com/">example</a>`);
    expect(md).toContain("[example](https://example.com/)");
  });
});
