import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { checkUrl } from "./filter.ts";
import { fetchAndProcess, type FetchSuccess } from "./fetcher.ts";

const DEFAULT_MAX_BYTES = 1024 * 1024;

const HTTP_REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function formatTextResponse(r: FetchSuccess): string {
  const lines: string[] = [];
  const reason = HTTP_REASONS[r.status] ?? "";
  lines.push(`HTTP ${r.status}${reason ? " " + reason : ""}`);
  if (r.location !== null) lines.push(`Location: ${r.location}`);
  if (r.content_type !== null) lines.push(`Content-Type: ${r.content_type}`);
  if (r.original_size !== null) lines.push(`Original-Size: ${r.original_size} bytes`);
  lines.push(`Truncated: ${r.truncated ? "yes" : "no"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  if (r.status >= 300 && r.status < 400) {
    lines.push(
      "This URL returned a redirect. fetch-mcp does not follow redirects automatically.",
    );
    lines.push("Call fetch again with the new URL if appropriate.");
  } else if (r.status >= 400) {
    lines.push("(body omitted: error response)");
  } else {
    lines.push(r.body);
  }
  return lines.join("\n");
}

const InputSchema = {
  url: z.string().describe("URL starting with https://"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max bytes to read (default ${DEFAULT_MAX_BYTES})`),
};

const OutputSchema = {
  status: z.number().int(),
  location: z.string().nullable(),
  content_type: z.string().nullable(),
  original_size: z.number().int().nullable(),
  truncated: z.boolean(),
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fetch-mcp",
    version: "0.0.1",
  });

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch a URL and return its content as Markdown. Does not follow redirects (3xx returns status + Location for the LLM to decide).",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    async ({ url, max_bytes }) => {
      const maxBytes = max_bytes ?? DEFAULT_MAX_BYTES;
      const urlCheck = checkUrl(url);
      if (!urlCheck.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `fetch-mcp filter: blocked\nReason: ${urlCheck.reason ?? "URL rejected"}`,
            },
          ],
        };
      }
      const outcome = await fetchAndProcess(url, maxBytes);

      if ("kind" in outcome) {
        const prefix =
          outcome.kind === "filter"
            ? "fetch-mcp filter: blocked"
            : "fetch-mcp error: network failure";
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${prefix}\nReason: ${outcome.reason}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatTextResponse(outcome),
          },
        ],
        structuredContent: {
          status: outcome.status,
          location: outcome.location,
          content_type: outcome.content_type,
          original_size: outcome.original_size,
          truncated: outcome.truncated,
        },
      };
    },
  );

  return server;
}

export interface ListenAddr {
  hostname: string;
  port: number;
}

export function parseListenAddr(addr: string): ListenAddr {
  const lastColon = addr.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`Invalid listen address (expected host:port): ${addr}`);
  }
  const hostname = addr.slice(0, lastColon);
  const port = parseInt(addr.slice(lastColon + 1), 10);
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`Invalid port in listen address: ${addr}`);
  }
  return { hostname, port };
}

export function startHttpServer(addr: ListenAddr): ReturnType<typeof createHttpServer> {
  // SDK の stateless StreamableHTTP パターンに従い、per-request に
  // McpServer + transport を new する。McpServer.connect は同じ
  // インスタンスでは 2 回呼べないため、server も使い捨てにする。
  // tool 定義は registerTool 経由で毎 request 再構築されるが、軽量。
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not Found");
      return;
    }
    const mcpServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });
  // SSE の long-lived stream を request / headers timeout で打ち切らないよう無効化する。
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.listen(addr.port, addr.hostname);
  return server;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const addr = parseListenAddr(process.env["FETCH_MCP_LISTEN"] ?? "0.0.0.0:8000");
  startHttpServer(addr);
  console.error(`fetch-mcp listening on ${addr.hostname}:${addr.port}/mcp`);
}
