// awaitOAuthCallback の state 検証 / timeout 挙動を docker 不要で確認する。
// 本物の OAuth provider を立てずに、verifyState を mock した形で挙動だけ検証する。

import net from "node:net";
import { describe, expect, test } from "bun:test";
import { awaitOAuthCallback, CallbackTimeoutError } from "../../src/index.ts";

const CALLBACK_PATH = "/callback";

/** node:net で `listen(0)` した後 close して、空いていた port 番号を返す。 */
function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("could not acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function startCallbackOnFreePort(opts: {
  expectedState: string;
  timeoutMs: number;
}): Promise<{ port: number; promise: Promise<string> }> {
  const port = await findFreePort();
  let resolveListen!: () => void;
  const listening = new Promise<void>((r) => {
    resolveListen = r;
  });
  const promise = awaitOAuthCallback({
    name: "test",
    // pathname だけが比較に使われるため、URL の host / port はダミーで良い。
    callbackUrl: new URL(`http://localhost${CALLBACK_PATH}`),
    listenHost: "127.0.0.1",
    listenPort: port,
    verifyState: (received) => received === opts.expectedState,
    timeoutMs: opts.timeoutMs,
    onListen: () => {
      resolveListen();
    },
  });
  await listening;
  return { port, promise };
}

describe("awaitOAuthCallback", () => {
  test("state 一致の正規 callback で code を resolve する", async () => {
    const expected = "the-state";
    const { port, promise } = await startCallbackOnFreePort({
      expectedState: expected,
      timeoutMs: 5_000,
    });
    const bad1 = await fetch(`http://localhost:${String(port)}${CALLBACK_PATH}?code=injected`);
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=injected&state=wrong`,
    );
    expect(bad2.status).toBe(400);
    const ok = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=legit&state=${expected}`,
    );
    expect(ok.status).toBe(200);
    expect(await promise).toBe("legit");
  }, 10_000);

  test("state 不一致の error injection で Promise は settle しない", async () => {
    const expected = "the-state";
    const { port, promise } = await startCallbackOnFreePort({
      expectedState: expected,
      timeoutMs: 5_000,
    });
    let resolved: string | undefined;
    let rejected: unknown;
    void promise.then(
      (v) => {
        resolved = v;
      },
      (e: unknown) => {
        rejected = e;
      },
    );
    const bad = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?error=access_denied`,
    );
    expect(bad.status).toBe(400);
    const ok = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=legit&state=${expected}`,
    );
    expect(ok.status).toBe(200);
    expect(await promise).toBe("legit");
    expect(resolved).toBe("legit");
    expect(rejected).toBeUndefined();
  }, 10_000);

  test("timeout で CallbackTimeoutError として reject する", async () => {
    const { promise } = await startCallbackOnFreePort({
      expectedState: "unused",
      timeoutMs: 200,
    });
    let caught: unknown;
    await promise.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(CallbackTimeoutError);
    expect((caught as Error).message).toContain("200");
  }, 10_000);

  test("正規 error (state 一致) は reject にする", async () => {
    const expected = "the-state";
    const { port, promise } = await startCallbackOnFreePort({
      expectedState: expected,
      timeoutMs: 5_000,
    });
    // fetch 完了前に reject が走るので、先に rejection を観測する handler を取り付ける。
    let caught: unknown;
    const settled = promise.catch((e: unknown) => {
      caught = e;
    });
    const res = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}` +
        `?error=access_denied&error_description=user+denied&state=${expected}`,
    );
    expect(res.status).toBe(400);
    await settled;
    expect((caught as Error).message).toContain("access_denied");
    expect((caught as Error).message).toContain("user denied");
  }, 10_000);
});
