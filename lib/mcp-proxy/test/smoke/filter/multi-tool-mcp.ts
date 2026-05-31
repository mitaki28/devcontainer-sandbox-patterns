#!/usr/bin/env bun
// allow/deny フィルタの動作確認用に複数 tool を提供する MCP server。
// stdio で起動し、prefix の異なる 4 つの tool を返す（read_/write_/delete_ + ping）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({
  name: "multi-tool",
  version: "0.0.1",
});

const tools: Array<{ name: string; description: string }> = [
  { name: "read_file", description: "Pretend to read a file." },
  { name: "write_file", description: "Pretend to write a file." },
  { name: "delete_file", description: "Pretend to delete a file." },
  { name: "ping", description: "Liveness check; returns 'pong'." },
];

for (const t of tools) {
  server.registerTool(
    t.name,
    {
      description: t.description,
      inputSchema: { msg: z.string().optional() },
    },
    ({ msg }) =>
      Promise.resolve({
        content: [{ type: "text", text: `${t.name}: ${msg ?? ""}` }],
      }),
  );
}

await server.connect(new StdioServerTransport());
