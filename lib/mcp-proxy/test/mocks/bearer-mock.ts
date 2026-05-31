#!/usr/bin/env bun
// Bearer 認証付き HTTP MCP backend のモック。
// proxy が API key 認証 backend (GitHub MCP 等) を扱う動作確認用。
// SDK の requireBearerAuth + StreamableHTTPServerTransport を使う最小実装。
//
// mock 自身は stateless モード (transport / McpServer を per-request 使い捨て) で動く。
// SDK の examples/server/simpleStatelessStreamableHttp と同じ理由で、最小実装として
// session 管理は持たない。mock 内部の事情であり、前段の mcp-proxy 本体の挙動とは独立。

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v4";

const TOKEN = Bun.env["BEARER_TOKEN"] ?? "secret-bearer-token";
const PORT = Number(Bun.env["PORT"] ?? "3000");

const verifier: OAuthTokenVerifier = {
  verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token !== TOKEN) {
      return Promise.reject(new Error("Invalid token"));
    }
    return Promise.resolve({
      token,
      clientId: "mock-client",
      scopes: [],
      // requireBearerAuth は expiresAt 必須。
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  },
};

function createServer(): McpServer {
  const server = new McpServer({ name: "bearer-mock", version: "0.0.1" });
  server.registerTool(
    "echo",
    { description: "Echoes the given message back.", inputSchema: { msg: z.string() } },
    ({ msg }) =>
      Promise.resolve({
        content: [{ type: "text", text: `echo: ${msg}` }],
      }),
  );
  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", requireBearerAuth({ verifier }), async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[bearer-mock] error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res
    .writeHead(405)
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.delete("/mcp", (_req, res) => {
  res
    .writeHead(405)
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`bearer-mock listening on 0.0.0.0:${String(PORT)}/mcp (token=${TOKEN})`);
});
