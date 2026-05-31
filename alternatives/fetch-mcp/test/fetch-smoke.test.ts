// alternatives/fetch-mcp/ の docker compose 経由 smoke。
// docker compose run --rm --build smoke で実行する。
// fetch-mcp は認証を要求しない（同じ docker network 加入が実質的な認証）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.env["MCP_URL"] ?? "http://fetch-mcp:8000/mcp";

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
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("alternatives/fetch-mcp smoke", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("server identifies as fetch-mcp", () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe("fetch-mcp");
  });

  test("tools/list returns the fetch tool with outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("fetch");
    expect(tools[0]?.outputSchema).toBeDefined();
  });

  test("https filter blocks http://", async () => {
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "http://example.com/" },
    });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("filter: blocked");
  });

  test("fetch a known reliable URL (example.com)", async () => {
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "https://example.com/" },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as {
      status?: number;
      truncated?: boolean;
      content_type?: string;
    };
    expect(sc?.status).toBe(200);
    expect(sc?.truncated).toBe(false);
    expect(sc?.content_type).toContain("text/html");
  });

  test("redirect is not followed (3xx returns Location)", async () => {
    // example.com 系の安定 redirect が無いので、httpbin.org の redirect を使う。
    // smoke の external dep を最小化したいが、redirect 不追従の確認には
    // 実際の 3xx レスポンスが要る。
    const r = await client.callTool({
      name: "fetch",
      arguments: { url: "https://httpbin.org/redirect-to?url=https://example.com/" },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { status?: number; location?: string };
    // httpbin の redirect-to は 302 を返す
    expect(sc?.status).toBeGreaterThanOrEqual(300);
    expect(sc?.status).toBeLessThan(400);
    expect(sc?.location).toContain("example.com");
  });
});
