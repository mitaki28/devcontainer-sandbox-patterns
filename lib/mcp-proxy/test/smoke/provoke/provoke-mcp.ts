#!/usr/bin/env bun
// proxy が server-initiated message を front (client) に正しく転送することを確認するための mock backend。
// `provoke` tool が呼ばれると、次の 2 つを順に発火する:
//   1. sendToolListChanged() — server-initiated notification (id 無し)
//   2. createMessage()        — server-initiated request (sampling/createMessage)
// proxy が転送できていれば (1) は client の notification handler が、(2) は client の
// request handler が受け取り、client が返した sampling 結果の text を tool result に
// echo して返す。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "provoker",
  version: "0.0.1",
});

server.registerTool(
  "provoke",
  {
    description: "Emits a server-initiated notification + request and echoes the sampling response.",
    inputSchema: {},
  },
  async () => {
    await server.server.sendToolListChanged();

    const result = await server.server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: "ping" } }],
      maxTokens: 1,
    });
    const sampleText =
      result.content.type === "text" ? result.content.text : "<non-text>";

    return {
      content: [{ type: "text", text: `sampling: ${sampleText}` }],
    };
  },
);

await server.connect(new StdioServerTransport());
