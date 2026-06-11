// alternatives/fetch-mcp/ の docker compose 経由 smoke。
// docker compose run --rm --build smoke で実行する。
// fetch-mcp は認証を要求しない（同じ docker network 加入が実質的な認証）。

import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env["MCP_URL"] ?? "http://fetch-mcp:8000/mcp";

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const c = new Client({ name: "fetch-mcp-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("alternatives/fetch-mcp smoke", () => {
  let client: Client;

  before(async () => {
    client = await connectClient();
  }, { timeout: 30_000 });

  after(async () => {
    await client.close();
  });

  test("server identifies as fetch-mcp", () => {
    const info = client.getServerVersion();
    assert.equal(info?.name, "fetch-mcp");
  });

  test("tools/list returns the fetch tool with outputSchema", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "fetch");
    assert.notEqual(tools[0]?.outputSchema, undefined);
  });

  test("https filter blocks http://", async () => {
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "http://example.com/" },
    });
    assert.equal(r.isError, true);
    const content = r.content as Array<{ type: string; text?: string }>;
    assert.ok(content[0]?.text?.includes("filter: blocked"));
  });

  test("fetch a known reliable URL (example.com)", async () => {
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "https://example.com/" },
    });
    assert.ok(!r.isError);
    const sc = r.structuredContent as {
      status?: number;
      truncated?: boolean;
      content_type?: string;
    };
    assert.equal(sc?.status, 200);
    assert.equal(sc?.truncated, false);
    assert.ok(sc?.content_type?.includes("text/html"));
  });

  test("redirect is not followed (3xx returns Location)", async () => {
    // example.com 系の安定 redirect が無いので、httpbin.org の redirect を使う。
    // smoke の external dep を最小化したいが、redirect 不追従の確認には
    // 実際の 3xx レスポンスが要る。
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "https://httpbin.org/redirect-to?url=https://example.com/" },
    });
    assert.ok(!r.isError);
    const sc = r.structuredContent as { status?: number; location?: string };
    // httpbin の redirect-to は 302 を返す
    assert.ok((sc?.status ?? 0) >= 300);
    assert.ok((sc?.status ?? 0) < 400);
    assert.ok(sc?.location?.includes("example.com"));
  });
});
