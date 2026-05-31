// idle session sweep の E2E smoke。
// --session-idle-timeout 2000 で起動した proxy に対し、initialize で session を作り、
// 何もせずに sweep interval (5 秒) + idle timeout (2 秒) を超えて待ったあとで、
// 同じ session id 宛の POST が 404 を返すことを確認する。

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = Bun.env["PROXY_URL"] ?? "http://localhost:8000/mcp";
const token = Bun.env["PROXY_TOKEN"];

async function connectClient(): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      });
      const c = new Client({ name: "sweep-smoke", version: "0.0.1" });
      await c.connect(transport);
      return c;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe("mcp-proxy session idle sweep", () => {
  test("idle timeout を超えた session id への POST は 404 を返す", async () => {
    const client = await connectClient();
    // SDK Client は transport.sessionId を直接公開しないため、内部 transport を見る。
    // sweep の挙動を生 fetch で確認するために raw session id が要る。
    const sessionId = (
      client as unknown as { _transport?: { sessionId?: string } }
    )._transport?.sessionId;
    expect(sessionId).toBeDefined();

    // sweep interval (5s) + idle timeout (2s) を超えて待つ
    await Bun.sleep(8000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(404);

    await client.close().catch(() => {
      // sweep 後はもう session が無いので close は失敗してよい
    });
  }, 30_000);
});
