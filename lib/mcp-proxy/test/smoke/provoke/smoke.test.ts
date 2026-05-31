// proxy が server-initiated message を front (client) に正しく往復させることの E2E smoke。
// provoke-mcp + proxy 経由で `provoke` tool を呼び、
//   - sampling/createMessage を proxy が front に転送し、client の handler が返した
//     固定文字列が tool result まで戻ってくること
//   - notifications/tools/list_changed が proxy 経由で client の notification handler に届くこと
// を確認する。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const url = Bun.env["PROXY_URL"] ?? "http://localhost:8000/mcp";
const token = Bun.env["PROXY_TOKEN"];

const SAMPLING_REPLY = "from-client-handler";

interface ToolListChangedSignal {
  received: boolean;
}

async function connectClient(signal: ToolListChangedSignal): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      });
      const c = new Client(
        { name: "provoke-smoke", version: "0.0.1" },
        { capabilities: { sampling: {} } },
      );
      c.setRequestHandler(CreateMessageRequestSchema, () =>
        Promise.resolve({
          model: "smoke-model",
          role: "assistant",
          content: { type: "text", text: SAMPLING_REPLY },
        }),
      );
      c.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        signal.received = true;
        return Promise.resolve();
      });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("mcp-proxy server-initiated forwarding", () => {
  let client: Client;
  const signal: ToolListChangedSignal = { received: false };

  beforeAll(async () => {
    client = await connectClient(signal);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("server-initiated request (sampling/createMessage) が front の handler で処理される", async () => {
    const res = await client.callTool({ name: "provoke", arguments: {} }, undefined, {
      timeout: 10_000,
    });
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain(SAMPLING_REPLY);
  }, 15_000);

  test("server-initiated notification (tools/list_changed) が front の handler に届く", () => {
    expect(signal.received).toBe(true);
  });
});
