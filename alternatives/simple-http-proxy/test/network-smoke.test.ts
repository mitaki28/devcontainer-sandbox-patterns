// alternatives/simple-http-proxy/ smoke test
//
// proxy の 2 段防御 (dstdomain at http_access / ssl::server_name at ssl_bump) と
// L3/L4 隔離 (internal: true) を独立に検証する 4 ケース。攻撃機構の詳細は
// README の「漏れる余地 / 限界」および docs 付録「proxy 層と CDN 層の責任分担」
// を参照。

import { describe, expect, it } from "bun:test";
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (!PROXY) {
  throw new Error("HTTPS_PROXY / HTTP_PROXY が設定されていません");
}

function parseProxy(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 3128) };
}

// proxy に CONNECT を投げてトンネルを開け、その上で任意 SNI を指定して
// TLS handshake を試みる低水準ヘルパ。CONNECT 詐称検証に使う。
async function tlsHandshakeViaProxy(
  proxyHost: string,
  proxyPort: number,
  connectTarget: string,
  connectPort: number,
  sni: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    sock.once("error", (err) => settle(() => reject(err)));
    sock.connect(proxyPort, proxyHost, () => {
      sock.write(
        `CONNECT ${connectTarget}:${connectPort} HTTP/1.1\r\n` +
          `Host: ${connectTarget}:${connectPort}\r\n\r\n`,
      );
      sock.once("data", (data) => {
        const head = data.toString();
        if (!head.startsWith("HTTP/1.1 200")) {
          settle(() => reject(new Error(`CONNECT rejected: ${head.slice(0, 200)}`)));
          return;
        }
        // 既存 socket の上で TLS を開始。servername で SNI を独立指定。
        const tls = tlsConnect({
          socket: sock,
          servername: sni,
          // 詐称テストでは cert 検証で落ちる前に ssl_bump terminate に遭う想定。
          // ここでは cert 検証で「成立した / しなかった」を判定するのではなく、
          // TLS handshake が完了したか / 切られたかを見る。
          rejectUnauthorized: false,
        });
        tls.once("secureConnect", () => {
          tls.destroy();
          settle(() => resolve());
        });
        tls.once("error", (err) => settle(() => reject(err)));
      });
    });
  });
}

describe("alternatives/simple-http-proxy smoke (Squid + Docker internal network)", () => {
  it("allowed host (mock-target.test) is reachable through the proxy", async () => {
    const res = await fetch("https://mock-target.test/", {
      proxy: PROXY,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("disallowed host (example.com) is denied by the proxy", async () => {
    let denied = false;
    try {
      const res = await fetch("https://example.com/", {
        proxy: PROXY,
      });
      // ssl_bump terminate / http_access deny の場合、Squid は 4xx を返すか
      // TCP を切る。前者なら status を見る、後者なら fetch 自体が throw する。
      denied = res.status >= 400;
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });

  it("direct TCP egress to external IP fails (internal: true)", async () => {
    // 外部 IP に直接 TCP connect。proxy を経由せず、Docker network の
    // routing table に外部経路が無いため ENETUNREACH 相当で失敗する。
    // hostname ではなく IP を直接指定して、DNS の有無に依存しない検証にする。
    await new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        // タイムアウト = 経路が無くて応答が無い、と解釈
        resolve();
      }, 3000);
      sock.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.destroy();
        reject(
          new Error(
            "外部 IP への直接 TCP 接続が成功した。internal: true が効いていない可能性がある",
          ),
        );
      });
      sock.connect(443, "1.1.1.1");
    });
  });

  it("CONNECT spoofing (CONNECT mock-target.test + SNI evil.invalid) is terminated by ssl_bump", async () => {
    // CONNECT 行 = allowlist 内 (mock-target.test) / SNI = allowlist 外
    // (evil.invalid) で詐称を仕掛け、ssl_bump terminate で切られることを検証。
    // smoke は本番 allowed-hosts.txt を smoke 用 (mock-target.test のみ) に
    // 差し替えており、external-net も internal: true なので、詐称トラフィックは
    // 一切外部に出ない。
    const { host, port } = parseProxy(PROXY);
    let denied = false;
    try {
      await tlsHandshakeViaProxy(
        host,
        port,
        "mock-target.test",
        443,
        "evil.invalid",
      );
      // TLS handshake が完走した = 詐称が成立した = この test は失敗
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });
});
