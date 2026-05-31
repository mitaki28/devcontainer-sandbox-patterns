// proxy の smoke test。
// PROXY_URL を介して mcp-proxy に接続し、echo backend が
// initialize / tools/list / tools/call を透過 forward できることを確認する。

import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env["PROXY_URL"] ?? "http://localhost:8000/mcp";

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const c = new Client({ name: "smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("mcp-proxy smoke", () => {
  let client: Client;

  before(async () => {
    client = await connectClient();
  }, { timeout: 30_000 });

  after(async () => {
    await client.close();
  });

  test("rejects /unknown path", async () => {
    const res = await fetch(url.replace(/\/mcp$/, "/foo"));
    assert.equal(res.status, 404);
  });

  test("tools/list returns echo tool", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.map((t) => t.name).includes("echo"));
  });

  test("tools/call echoes the input", async () => {
    const res = await client.callTool({ name: "echo", arguments: { msg: "hello world" } });
    const content = res.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.text, "echo: hello world");
  });

  // 2 つの Client が同時に接続すると、それぞれが別の session を確立して別 backend
  // instance で動く。session ごとに request id 空間が完全に分離されるため、片方の
  // 応答が他方に流れる事故は構造的に起きない。並行 callTool で混線しないことを確認。
  test("並行する複数 Client が独立した session として混線しない", async () => {
    const a = await connectClient();
    const b = await connectClient();
    try {
      const [resA, resB] = await Promise.all([
        a.callTool({ name: "echo", arguments: { msg: "A" } }),
        b.callTool({ name: "echo", arguments: { msg: "B" } }),
      ]);
      const textA = (resA.content as Array<{ text?: string }>)[0]?.text;
      const textB = (resB.content as Array<{ text?: string }>)[0]?.text;
      assert.equal(textA, "echo: A");
      assert.equal(textB, "echo: B");
    } finally {
      await a.close();
      await b.close();
    }
  });
});
