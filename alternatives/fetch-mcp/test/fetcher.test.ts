import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchAndProcess } from "../src/fetcher.ts";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/html") {
        return new Response(
          "<h1>Hello</h1><p>World</p><script>alert('xss')</script>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (path === "/plain") {
        return new Response("plain text body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (path === "/redirect") {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/elsewhere" },
        });
      }
      if (path === "/notfound") {
        return new Response("Not Found body", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/octet") {
        return new Response("binary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (path === "/big") {
        const size = 1024 * 1024 + 100;
        return new Response("a".repeat(size), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  baseUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
});

describe("fetchAndProcess", () => {
  test("2xx HTML is converted to Markdown, script removed", async () => {
    const r = await fetchAndProcess(`${baseUrl}/html`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    expect(r.status).toBe(200);
    expect(r.content_type).toContain("text/html");
    expect(r.body).toContain("# Hello");
    expect(r.body).toContain("World");
    expect(r.body).not.toContain("alert");
    expect(r.truncated).toBe(false);
  });

  test("2xx text/plain is returned as-is (not Markdown-converted)", async () => {
    const r = await fetchAndProcess(`${baseUrl}/plain`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("plain text body");
  });

  test("3xx redirect is not followed, Location is returned", async () => {
    const r = await fetchAndProcess(`${baseUrl}/redirect`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    expect(r.status).toBe(302);
    expect(r.location).toBe("https://example.com/elsewhere");
    expect(r.body).toBe("");
    expect(r.original_size).toBeNull();
  });

  test("4xx returns status without body", async () => {
    const r = await fetchAndProcess(`${baseUrl}/notfound`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    expect(r.status).toBe(404);
    expect(r.body).toBe("");
  });

  test("Content-Type not in allowlist is rejected by filter", async () => {
    const r = await fetchAndProcess(`${baseUrl}/octet`, 1024 * 1024);
    if (!("kind" in r)) throw new Error("expected filter rejection");
    expect(r.kind).toBe("filter");
    expect(r.reason).toContain("octet-stream");
  });

  test("body exceeding max_bytes is truncated", async () => {
    const r = await fetchAndProcess(`${baseUrl}/big`, 1024 * 1024);
    if ("kind" in r) throw new Error(`unexpected failure: ${r.reason}`);
    expect(r.truncated).toBe(true);
    expect(r.original_size).toBe(1024 * 1024);
    expect(r.body.length).toBe(1024 * 1024);
  });

  test("network error (closed port) is reported as network failure", async () => {
    const r = await fetchAndProcess("http://127.0.0.1:1/", 1024 * 1024);
    if (!("kind" in r)) throw new Error("expected network failure");
    expect(r.kind).toBe("network");
  });
});
