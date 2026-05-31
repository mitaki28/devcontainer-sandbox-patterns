// docker compose 経由で起動した filter-proxy（multi-tool-mcp + --deny-tool delete_*）
// に接続し、tools/list 絞り込み + tools/call 拒否が end-to-end で効くことを確認する。

import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env["PROXY_URL"] ?? "http://localhost:8000/mcp";

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const c = new Client({ name: "filter-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("mcp-proxy filter smoke (deny=delete_*)", () => {
  let client: Client;

  before(async () => {
    client = await connectClient();
  }, { timeout: 30_000 });

  after(async () => {
    await client.close();
  });

  test("tools/list は denied tool を含まない", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("write_file"));
    assert.ok(names.includes("ping"));
    assert.ok(!names.includes("delete_file"));
  });

  test("許可されている tool は呼べる", async () => {
    const res = await client.callTool({ name: "read_file", arguments: { msg: "hello" } });
    const content = res.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.text, "read_file: hello");
  });

  test("拒否された tool 呼び出しは JSON-RPC error -32601 を返す", async () => {
    let caught: unknown;
    try {
      await client.callTool({ name: "delete_file", arguments: { msg: "x" } });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof McpError);
    const err = caught;
    assert.equal(err.code, -32601);
    assert.ok(err.message.includes("delete_file"));
  });
});
