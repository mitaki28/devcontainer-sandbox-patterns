// mock-target: smoke 用の偽 upstream。
//
// alternatives/simple-http-proxy の mock-server.ts と同じ思想で、本 mock も
// 1 つの container を Docker network alias で複数の .test TLD 仮想 host
// (api.test / registry.test / echo.test / raw.content.test / denied.test /
// git.test) に紐付ける。cert の SAN にそれら全てが入っており、proxy
// (mitmproxy) は --set ssl_verify_upstream_trusted_ca=/certs/mock-target.crt で
// 本 cert を upstream として trust する前提。各 alias の役割は
// test/policy.smoke.json の _doc_aliases を参照。
//
// 振る舞いは smoke 用に必要な最小限:
//   - GET /                 → 200 "mock-ok GET <host>/"
//   - GET /headers          → 200 + request headers を JSON で echo (HeaderInjector の検証用)
//   - POST /anything/<seg>  → 200 + {method, url, json} を JSON で echo (allow_rules の検証用)
//   - その他                 → 200 "mock-ok ..." (届けば必ず 200。proxy で deny されれば届かない)

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";

const cert = readFileSync("/certs/mock-target.crt");
const key = readFileSync("/certs/mock-target.key");

const PORT = 443;

const server = createServer({ cert, key }, async (req, res) => {
  const host = req.headers.host ?? "mock-target";
  const url = new URL(req.url ?? "/", `https://${host}`);

  if (req.method === "GET" && url.pathname === "/sni") {
    // mitmproxy が upstream TLS handshake で送ってきた SNI を JSON で返す。
    // SNI 詐称検証用。req.socket は TLSSocket で、servername に対向 (= mitmproxy)
    // が送ってきた SNI が入る。
    // chunked encoding を避けるため Content-Length を明示する (smoke 側の生 socket
    // からの body parse が chunked framing を扱わないため)。
    const sni = (req.socket as TLSSocket).servername || null;
    const body = JSON.stringify({ sni, host });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/headers") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        headers[k] = v.join(", ");
      } else if (typeof v === "string") {
        headers[k] = v;
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ headers }));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/anything/")) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let json: unknown = null;
    const ct = req.headers["content-type"] ?? "";
    if (typeof ct === "string" && ct.includes("application/json")) {
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        json = null;
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      method: req.method,
      url: `https://${host}${url.pathname}${url.search}`,
      json,
    }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`mock-ok ${req.method} ${host}${url.pathname}\n`);
});

server.listen(PORT, () => {
  // listen 完了後に .ready を touch して、smoke コンテナの wait-for を解除する。
  writeFileSync("/certs/.ready", "");
  console.log(`mock-target: TLS listening on :${PORT}`);
});
