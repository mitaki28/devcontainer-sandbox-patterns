// awaitOAuthCallback の state 検証 / timeout 挙動を docker 不要で確認する。
// 本物の OAuth provider を立てずに、verifyState を mock した形で挙動だけ検証する。

import net from "node:net";
import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
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

/**
 * fetch では送れない生の HTTP リクエスト (不正な Host ヘッダ等) を 1 本投げて、
 * ステータス行を返す。接続が閉じられたら resolve する。
 */
function sendRawRequest(port: number, rawRequest: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(rawRequest);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("error", reject);
    sock.on("close", () => {
      resolve(buf.split("\r\n")[0] ?? "");
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
  test("state 一致の正規 callback で code を resolve する", { timeout: 10_000 }, async () => {
    const expected = "the-state";
    const { port, promise } = await startCallbackOnFreePort({
      expectedState: expected,
      timeoutMs: 5_000,
    });
    const bad1 = await fetch(`http://localhost:${String(port)}${CALLBACK_PATH}?code=injected`);
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=injected&state=wrong`,
    );
    assert.equal(bad2.status, 400);
    const ok = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=legit&state=${expected}`,
    );
    assert.equal(ok.status, 200);
    assert.equal(await promise, "legit");
  });

  test("state 不一致の error injection で Promise は settle しない", { timeout: 10_000 }, async () => {
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
    assert.equal(bad.status, 400);
    const ok = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=legit&state=${expected}`,
    );
    assert.equal(ok.status, 200);
    assert.equal(await promise, "legit");
    assert.equal(resolved, "legit");
    assert.equal(rejected, undefined);
  });

  test("不正な Host ヘッダでも listener はクラッシュせず継続する", { timeout: 10_000 }, async () => {
    const expected = "the-state";
    const { port, promise } = await startCallbackOnFreePort({
      expectedState: expected,
      timeoutMs: 5_000,
    });
    // base に Host ヘッダを使っていると `new URL` が throw して同期ハンドラ内の
    // 例外でプロセスごと落ちる。スペース入りの不正 Host を投げて、listener が
    // 生き残ること (= 後続の正規 callback が成功すること) を確認する。
    const statusLine = await sendRawRequest(
      port,
      `GET ${CALLBACK_PATH}?code=injected HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n`,
    );
    assert.match(statusLine, /^HTTP\/1\.1 400/);
    // listener が生きていれば正規 callback は通る。
    const ok = await fetch(
      `http://localhost:${String(port)}${CALLBACK_PATH}?code=legit&state=${expected}`,
    );
    assert.equal(ok.status, 200);
    assert.equal(await promise, "legit");
  });

  test("timeout で CallbackTimeoutError として reject する", { timeout: 10_000 }, async () => {
    const { promise } = await startCallbackOnFreePort({
      expectedState: "unused",
      timeoutMs: 200,
    });
    let caught: unknown;
    await promise.catch((e: unknown) => {
      caught = e;
    });
    assert.ok(caught instanceof CallbackTimeoutError);
    assert.ok((caught as Error).message.includes("200"));
  });

  test("正規 error (state 一致) は reject にする", { timeout: 10_000 }, async () => {
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
    assert.equal(res.status, 400);
    await settled;
    assert.ok((caught as Error).message.includes("access_denied"));
    assert.ok((caught as Error).message.includes("user denied"));
  });
});
