#!/usr/bin/env bun
// proxy の動作確認用の最小 MCP server。
// stdio で起動し、`echo` ツールを 1 つだけ提供する。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({
  name: "echo",
  version: "0.0.1",
});

server.registerTool(
  "echo",
  {
    description: "Echoes the given message back.",
    inputSchema: { msg: z.string() },
  },
  ({ msg }) =>
    Promise.resolve({
      content: [{ type: "text", text: `echo: ${msg}` }],
    }),
);

await server.connect(new StdioServerTransport());
