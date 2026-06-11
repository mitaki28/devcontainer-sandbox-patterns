import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { checkContentType, checkUrl } from "../src/filter.ts";

describe("checkUrl", () => {
  test("accepts https://", () => {
    const r = checkUrl("https://example.com/");
    assert.equal(r.ok, true);
  });

  test("rejects http://", () => {
    const r = checkUrl("http://example.com/");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("https"));
  });

  test("rejects file://", () => {
    const r = checkUrl("file:///etc/passwd");
    assert.equal(r.ok, false);
  });

  test("rejects ftp://", () => {
    const r = checkUrl("ftp://example.com/");
    assert.equal(r.ok, false);
  });

  test("rejects malformed URL", () => {
    const r = checkUrl("not-a-url");
    assert.equal(r.ok, false);
  });
});

describe("checkContentType", () => {
  test("accepts text/html", () => {
    const r = checkContentType("text/html");
    assert.equal(r.ok, true);
    assert.equal(r.base, "text/html");
  });

  test("accepts text/html with charset", () => {
    const r = checkContentType("text/html; charset=utf-8");
    assert.equal(r.ok, true);
    assert.equal(r.base, "text/html");
  });

  test("accepts application/json", () => {
    const r = checkContentType("application/json");
    assert.equal(r.ok, true);
  });

  test("accepts application/xhtml+xml", () => {
    const r = checkContentType("application/xhtml+xml");
    assert.equal(r.ok, true);
  });

  test("normalizes case", () => {
    const r = checkContentType("Text/HTML; charset=UTF-8");
    assert.equal(r.ok, true);
    assert.equal(r.base, "text/html");
  });

  test("rejects application/octet-stream", () => {
    const r = checkContentType("application/octet-stream");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("octet-stream"));
  });

  test("rejects image/png", () => {
    const r = checkContentType("image/png");
    assert.equal(r.ok, false);
  });

  test("rejects null / undefined / empty", () => {
    assert.equal(checkContentType(null).ok, false);
    assert.equal(checkContentType(undefined).ok, false);
    assert.equal(checkContentType("").ok, false);
  });
});
