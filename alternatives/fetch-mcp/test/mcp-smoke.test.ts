import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/index.ts";

let server: ReturnType<typeof startHttpServer>;
let baseUrl: string;

beforeAll(() => {
  server = startHttpServer({ hostname: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.hostname}:${server.port}/mcp`;
});

afterAll(() => {
  server.stop(true);
});

describe("fetch-mcp MCP server", () => {
  test("tools/list returns the fetch tool with outputSchema", async () => {
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(1);
      expect(tools[0]?.name).toBe("fetch");
      expect(tools[0]?.outputSchema).toBeDefined();
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
      expect(r.isError).toBe(true);
      const content = r.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("filter: blocked");
      expect(content[0]?.text).toContain("https");
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
      expect(r.isError).toBe(true);
      const content = r.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toContain("network");
    } finally {
      await client.close();
    }
  });
});
