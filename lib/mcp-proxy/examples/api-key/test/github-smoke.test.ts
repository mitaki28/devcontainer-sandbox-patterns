// lib/mcp-proxy/examples/api-key/ の smoke test。
// proxy 経由で GitHub MCP に initialize + tools/list が通ることを確認する。
// 実 API への副作用を避けるため tools/call は呼ばない（rate limit 配慮）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.env["PROXY_URL"] ?? "http://proxy:8000/mcp";
const token = Bun.env["PROXY_TOKEN"];

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(url),
        token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
      );
      const c = new Client({ name: "recipes-mcp-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("lib/mcp-proxy/examples/api-key smoke (proxy → GitHub MCP)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("server identifies as github", () => {
    const info = client.getServerVersion();
    expect(info?.name).toMatch(/github/i);
  });

  test("tools/list returns non-empty GitHub tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    // GitHub MCP は repo / issue / pr 系のツールを必ず提供している
    const names = tools.map((t) => t.name).join(",");
    expect(names).toMatch(/repo|issue|pull|search/i);
  });

  // proxy 側の --deny-tool で destructive 系を弾いている前提。
  // upstream で tool 名が変わると silent に効かなくなるため、smoke で常時監視する。
  test("destructive tools are filtered out by proxy (delete_* / merge_* / push_*)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    const denied = names.filter(
      (n) => n.startsWith("delete_") || n.startsWith("merge_") || n.startsWith("push_"),
    );
    expect(denied).toEqual([]);

    // 同時に「絞り込みすぎていない」ことの sanity check として、read 系が残っているのを確認。
    expect(names.some((n) => n.startsWith("get_") || n.startsWith("list_"))).toBe(true);
  });
});
