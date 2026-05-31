import { describe, expect, test } from "bun:test";
import { checkContentType, checkUrl } from "../src/filter.ts";

describe("checkUrl", () => {
  test("accepts https://", () => {
    const r = checkUrl("https://example.com/");
    expect(r.ok).toBe(true);
  });

  test("rejects http://", () => {
    const r = checkUrl("http://example.com/");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("https");
  });

  test("rejects file://", () => {
    const r = checkUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });

  test("rejects ftp://", () => {
    const r = checkUrl("ftp://example.com/");
    expect(r.ok).toBe(false);
  });

  test("rejects malformed URL", () => {
    const r = checkUrl("not-a-url");
    expect(r.ok).toBe(false);
  });
});

describe("checkContentType", () => {
  test("accepts text/html", () => {
    const r = checkContentType("text/html");
    expect(r.ok).toBe(true);
    expect(r.base).toBe("text/html");
  });

  test("accepts text/html with charset", () => {
    const r = checkContentType("text/html; charset=utf-8");
    expect(r.ok).toBe(true);
    expect(r.base).toBe("text/html");
  });

  test("accepts application/json", () => {
    const r = checkContentType("application/json");
    expect(r.ok).toBe(true);
  });

  test("accepts application/xhtml+xml", () => {
    const r = checkContentType("application/xhtml+xml");
    expect(r.ok).toBe(true);
  });

  test("normalizes case", () => {
    const r = checkContentType("Text/HTML; charset=UTF-8");
    expect(r.ok).toBe(true);
    expect(r.base).toBe("text/html");
  });

  test("rejects application/octet-stream", () => {
    const r = checkContentType("application/octet-stream");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("octet-stream");
  });

  test("rejects image/png", () => {
    const r = checkContentType("image/png");
    expect(r.ok).toBe(false);
  });

  test("rejects null / undefined / empty", () => {
    expect(checkContentType(null).ok).toBe(false);
    expect(checkContentType(undefined).ok).toBe(false);
    expect(checkContentType("").ok).toBe(false);
  });
});
