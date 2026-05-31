// OAuth 2.1 + DCR 認証サーバ + Bearer 保護された MCP backend のモック。
// SDK の mcpAuthRouter / requireBearerAuth と OAuthServerProvider interface を
// in-memory で実装している（参考: examples/server/demoInMemoryOAuthProvider）。
//
// authorize() は **auto-consent** で即座に redirect するため、認可ページの UI を
// 持たない。手動でブラウザを開く場合も「認可ボタンを押す」操作は不要、
// URL を開いた瞬間に callback に redirect される。

import { randomUUID } from "node:crypto";
import express, { type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod/v4";

const PORT = Number(process.env["PORT"] ?? "3000");
const ISSUER = process.env["ISSUER_URL"] ?? `http://localhost:${String(PORT)}`;

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }
  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

interface CodeData {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface TokenData {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

class InMemoryProvider implements OAuthServerProvider {
  clientsStore = new InMemoryClientsStore();
  private codes = new Map<string, CodeData>();
  private accessTokens = new Map<string, TokenData>();
  private refreshTokens = new Map<string, TokenData>();

  authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    const code = randomUUID();
    this.codes.set(code, { client, params });
    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state !== undefined) url.searchParams.set("state", params.state);
    res.redirect(url.toString());
    return Promise.resolve();
  }

  challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    const data = this.codes.get(code);
    if (!data) throw new Error("Invalid authorization code");
    return Promise.resolve(data.params.codeChallenge);
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<OAuthTokens> {
    const data = this.codes.get(code);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) {
      throw new Error("Code was not issued to this client");
    }
    this.codes.delete(code);
    return Promise.resolve(this.issueTokens(client, data.params.scopes ?? []));
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data) throw new Error("Invalid refresh token");
    if (data.clientId !== client.client_id) {
      throw new Error("Refresh token not for this client");
    }
    this.refreshTokens.delete(refreshToken);
    return Promise.resolve(this.issueTokens(client, scopes ?? data.scopes));
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.accessTokens.get(token);
    if (!data || data.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("Invalid or expired token");
    }
    return Promise.resolve({
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
    });
  }

  private issueTokens(
    client: OAuthClientInformationFull,
    scopes: string[],
  ): OAuthTokens {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const data: TokenData = { clientId: client.client_id, scopes, expiresAt };
    this.accessTokens.set(accessToken, data);
    this.refreshTokens.set(refreshToken, data);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

const provider = new InMemoryProvider();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "oauth-mock", version: "0.0.1" });
  server.registerTool(
    "echo",
    { description: "Echoes the given message back.", inputSchema: { msg: z.string() } },
    ({ msg }) =>
      Promise.resolve({ content: [{ type: "text", text: `echo: ${msg}` }] }),
  );
  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth 2.1 endpoints (/.well-known/*, /authorize, /token, /register, /revoke)
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(ISSUER),
    scopesSupported: [],
  }),
);

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

app.post("/mcp", requireBearerAuth({ verifier: provider }), async (req, res) => {
  try {
    const server = createMcpServer();
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
    console.error("[oauth-mock] mcp error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`oauth-mock listening on 0.0.0.0:${String(PORT)} (issuer=${ISSUER})`);
});
