import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchAndProcess } from "../src/fetcher.ts";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    if (path === "/html") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<h1>Hello</h1><p>World</p><script>alert('xss')</script>");
      return;
    }
    if (path === "/plain") {
      res.writeHead(200, { "content-type": "text/plain" }).end("plain text body");
      return;
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: "https://example.com/elsewhere" }).end("");
      return;
    }
    if (path === "/notfound") {
      res.writeHead(404, { "content-type": "text/html" }).end("Not Found body");
      return;
    }
    if (path === "/octet") {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end("binary");
      return;
    }
    if (path === "/big") {
      const size = 1024 * 1024 + 100;
      res.writeHead(200, { "content-type": "text/plain" }).end("a".repeat(size));
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

describe("fetchAndProcess", () => {
  test("2xx HTML is converted to Markdown, script removed", async () => {
    const r = await fetchAndProcess(`${baseUrl}/html`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    assert.equal(r.status, 200);
    assert.ok(r.content_type?.includes("text/html"));
    assert.ok(r.body.includes("# Hello"));
    assert.ok(r.body.includes("World"));
    assert.ok(!r.body.includes("alert"));
    assert.equal(r.truncated, false);
  });

  test("2xx text/plain is returned as-is (not Markdown-converted)", async () => {
    const r = await fetchAndProcess(`${baseUrl}/plain`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    assert.equal(r.status, 200);
    assert.equal(r.body, "plain text body");
  });

  test("3xx redirect is not followed, Location is returned", async () => {
    const r = await fetchAndProcess(`${baseUrl}/redirect`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, "https://example.com/elsewhere");
    assert.equal(r.body, "");
    assert.equal(r.original_size, null);
  });

  test("4xx returns status without body", async () => {
    const r = await fetchAndProcess(`${baseUrl}/notfound`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    assert.equal(r.status, 404);
    assert.equal(r.body, "");
  });

  test("Content-Type not in allowlist is rejected by filter", async () => {
    const r = await fetchAndProcess(`${baseUrl}/octet`, 1024 * 1024);
    if (!("kind" in r)) throw new Error("expected filter rejection");
    assert.equal(r.kind, "filter");
    assert.ok(r.reason.includes("octet-stream"));
  });

  test("body exceeding max_bytes is truncated", async () => {
    const r = await fetchAndProcess(`${baseUrl}/big`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    assert.equal(r.truncated, true);
    assert.equal(r.original_size, 1024 * 1024);
    assert.equal(r.body.length, 1024 * 1024);
  });

  test("network error (closed port) is reported as network failure", async () => {
    const r = await fetchAndProcess("http://127.0.0.1:1/", 1024 * 1024);
    if (!("kind" in r)) throw new Error("expected network failure");
    assert.equal(r.kind, "network");
  });
});
