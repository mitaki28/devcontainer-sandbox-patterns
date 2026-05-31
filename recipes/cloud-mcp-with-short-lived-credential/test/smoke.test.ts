// recipes/cloud-mcp-with-short-lived-credential/ の smoke test。
// proxy 経由で gcloud-mcp に initialize / tools/list / tools/call が通ることと、
// CLOUDSDK_AUTH_ACCESS_TOKEN_FILE 経由の token 注入が gcloud に届いていることを確認する。
//
// 事前に host 側で `./refresh-token.sh` を 1 回実行して
// ${HOME}/.cache/devsbx/gcp-mcp/token を作っておく必要がある（README 参照）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.env["PROXY_URL"] ?? "http://proxy:8000/mcp";
const token = Bun.env["PROXY_TOKEN"];

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(url),
        token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
      );
      const c = new Client({ name: "recipes-gcp-mcp-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } =>
      typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text",
    )
    .map((c) => c.text)
    .join("");
}

async function callGcloud(client: Client, args: string[]) {
  return client.callTool({
    name: "run_gcloud_command",
    arguments: { args },
  });
}

describe("recipes/cloud-mcp-with-short-lived-credential smoke (host script → proxy → gcloud-mcp)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  test("server identifies as gcloud-mcp", () => {
    const info = client.getServerVersion();
    expect(info?.name).toMatch(/gcloud/i);
  });

  test("tools/list returns non-empty gcloud tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map((t) => t.name).join(",");
    expect(names).toMatch(/gcloud|run_gcloud|gcp/i);
  });

  test("CLOUDSDK_AUTH_ACCESS_TOKEN_FILE is wired through to gcloud config", async () => {
    const result = await callGcloud(client, ["config", "get", "auth/access_token_file"]);
    expect(result.isError).toBeFalsy();
    const text = extractText(result.content);
    // 値が空 / "(unset)" だと token 注入経路が壊れている。
    expect(text).toContain("/tokens/token");
  }, 30_000);

  test("can list artifact registry repositories via gcloud (auth chain works)", async () => {
    // sandbox SA に roles/artifactregistry.reader が付いている前提（README 参照）。
    // refresh-token.sh が出した SA token を proxy が file 経由で読み、
    // GCP に Bearer 認証として届けて受理されることを確認する。
    // 失敗するなら token 失効 / file 不整合 / token 注入経路の問題。
    const result = await callGcloud(client, [
      "artifacts",
      "repositories",
      "list",
      "--format=value(name)",
    ]);
    expect(result.isError).toBeFalsy();
  }, 30_000);
});
