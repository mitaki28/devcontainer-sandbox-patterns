import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/index.ts";

let server: ReturnType<typeof startHttpServer>;
let baseUrl: string;

before(async () => {
  server = startHttpServer({ hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", () => {
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
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

describe("fetch-mcp MCP server", () => {
  test("tools/list returns the fetch tool with outputSchema", async () => {
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.name, "fetch");
      assert.notEqual(tools[0]?.outputSchema, undefined);
    } finally {
      await client.close();
    }
  });

  test("tools/call (https filter blocked) returns isError with reason", async () => {
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    try {
      // checkUrl は https only のため http はブロック対象
      const r = await client.callTool({
        name: "fetch",
        arguments: { url: "http://example.com/" },
      });
      assert.equal(r.isError, true);
      const content = r.content as Array<{ type: string; text?: string }>;
      assert.equal(content[0]?.type, "text");
      assert.ok(content[0]?.text?.includes("filter: blocked"));
      assert.ok(content[0]?.text?.includes("https"));
    } finally {
      await client.close();
    }
  });

  test("tools/call (network error) returns isError with network failure", async () => {
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    try {
      // 注: checkUrl が https only なので、http の network error 経路は test できない。
      // 代わりに 存在しない https ホスト名で network error を起こす。
      const r = await client.callTool({
        name: "fetch",
        arguments: { url: "https://nonexistent.invalid.example/" },
      });
      assert.equal(r.isError, true);
      const content = r.content as Array<{ type: string; text?: string }>;
      assert.ok(content[0]?.text?.includes("network"));
    } finally {
      await client.close();
    }
  });
});
