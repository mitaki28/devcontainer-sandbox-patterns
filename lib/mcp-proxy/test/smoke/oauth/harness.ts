// proxy の OAuth フロー全体を oauth-mock 相手に自動 smoke 化する。
//
// flow:
//   1. mcp-proxy を child process として起動（--oauth）
//   2. proxy の標準エラーから認可 URL を抽出
//   3. URL を fetch（mock の auto-consent で 302 → proxy callback URL）
//   4. fetch の redirect follow で proxy の callback HTTP server に GET 到達
//   5. proxy が token endpoint で交換 → listen 開始
//   6. proxy 経由で MCP client の listTools / callTool を実行

import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BACKEND = process.env["OAUTH_BACKEND"] ?? "http://oauth-mock:3000/mcp";
const PROXY_LISTEN = "127.0.0.1:8000";
const CALLBACK_LISTEN = "127.0.0.1:3030";
// OAUTH_REFRESH_DEDUP=1 で proxy 起動時に --oauth-refresh-dedup を付け、
// dedup 有効でも OAuth flow / tools/list / tools/call が壊れないことを確認する。
const OAUTH_REFRESH_DEDUP = process.env["OAUTH_REFRESH_DEDUP"] === "1";
const TOKEN_STORE = `/tmp/oauth-tokens-${String(Date.now())}`;

function fail(proc: ChildProcess, message: string): never {
  console.error(`[harness] FAIL: ${message}`);
  proc.kill();
  process.exit(1);
}

// oauth-mock の Express が listen を始めるまで待つ。
// docker compose の depends_on は container start までしか待たない。
async function waitMock(url: string, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock did not become ready: ${url}`);
}

const mockBase = new URL(BACKEND);
console.error(`[harness] waiting for mock at ${mockBase.origin}/.well-known/oauth-authorization-server`);
await waitMock(`${mockBase.origin}/.well-known/oauth-authorization-server`, 15_000);
console.error("[harness] mock is ready");

console.error("[harness] starting proxy subprocess");
const proxyArgs = [
  "src/index.ts",
  "--listen",
  PROXY_LISTEN,
  "-t",
  "http",
  "--oauth",
  "--callback-listen",
  CALLBACK_LISTEN,
  "--token-store",
  TOKEN_STORE,
];
if (OAUTH_REFRESH_DEDUP) {
  proxyArgs.push("--oauth-refresh-dedup");
}
proxyArgs.push("oauth-test", BACKEND);
const proxy = spawn("node", proxyArgs, { stdio: ["ignore", "pipe", "pipe"] });

let authorizationUrl: string | undefined;
let listening = false;

proxy.stderr?.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  process.stderr.write(`[proxy] ${text}`);
  const urlMatch = /\n\s*(https?:\/\/\S+\/authorize\?\S+)/m.exec(text);
  if (urlMatch && !authorizationUrl) authorizationUrl = urlMatch[1];
  if (/mcp-proxy \[.*\] listening on/.test(text)) listening = true;
});

proxy.on("exit", (code) => {
  console.error(`[harness] proxy exited with code ${String(code)}`);
});

const waitFor = async (predicate: () => boolean, label: string, ms: number): Promise<void> => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!predicate()) fail(proxy, `timeout waiting for ${label}`);
};

await waitFor(() => authorizationUrl !== undefined, "authorization URL", 15_000);
console.error(`[harness] got authorization URL: ${authorizationUrl ?? "?"}`);

const authResp = await fetch(authorizationUrl ?? "", { redirect: "follow" });
console.error(`[harness] authorization fetch finished, status=${String(authResp.status)}`);
if (authResp.status >= 400) {
  console.error(await authResp.text());
  fail(proxy, `authorization fetch returned ${String(authResp.status)}`);
}

await waitFor(() => listening, "proxy listen", 15_000);

console.error("[harness] connecting MCP client through proxy");
const client = new Client({ name: "oauth-smoke", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(
  new URL(`http://${PROXY_LISTEN}/mcp`),
);
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.error(`[harness] tools: ${names.join(", ")}`);
if (!names.includes("echo")) fail(proxy, `expected 'echo' tool, got ${names.join(", ")}`);

const result = await client.callTool({ name: "echo", arguments: { msg: "hello via oauth" } });
const content = result.content as Array<{ type: string; text?: string }>;
console.error(`[harness] echo result: ${JSON.stringify(content)}`);
if (content[0]?.text !== "echo: hello via oauth") {
  fail(proxy, `unexpected echo result: ${JSON.stringify(content)}`);
}

await client.close();
proxy.kill();
console.error("[harness] OAuth smoke OK");
process.exit(0);
