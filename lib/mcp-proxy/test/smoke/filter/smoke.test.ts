// docker compose 経由で起動した filter-proxy（multi-tool-mcp + --deny-tool delete_*）
// に接続し、tools/list 絞り込み + tools/call 拒否が end-to-end で効くことを確認する。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.env["PROXY_URL"] ?? "http://localhost:8000/mcp";
const token = Bun.env["PROXY_TOKEN"];

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      });
      const c = new Client({ name: "filter-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("mcp-proxy filter smoke (deny=delete_*)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("tools/list は denied tool を含まない", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("ping");
    expect(names).not.toContain("delete_file");
  });

  test("許可されている tool は呼べる", async () => {
    const res = await client.callTool({ name: "read_file", arguments: { msg: "hello" } });
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("read_file: hello");
  });

  test("拒否された tool 呼び出しは JSON-RPC error -32601 を返す", async () => {
    let caught: unknown;
    try {
      await client.callTool({ name: "delete_file", arguments: { msg: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain("delete_file");
  });
});
