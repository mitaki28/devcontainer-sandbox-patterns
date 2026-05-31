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

import { writeFileSync } from "node:fs";

const cert = await Bun.file("/certs/mock-target.crt").text();
const key = await Bun.file("/certs/mock-target.key").text();

const server = Bun.serve({
  port: 443,
  tls: { cert, key },
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.hostname;

    if (req.method === "GET" && url.pathname === "/headers") {
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) {
        headers[k] = v;
      }
      return Response.json({ headers });
    }

    if (req.method === "POST" && url.pathname.startsWith("/anything/")) {
      let json: unknown = null;
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        try {
          json = await req.json();
        } catch {
          json = null;
        }
      }
      return Response.json({
        method: req.method,
        url: `https://${host}${url.pathname}${url.search}`,
        json,
      });
    }

    return new Response(`mock-ok ${req.method} ${host}${url.pathname}\n`, {
      status: 200,
    });
  },
});

// listen 完了後に .ready を touch して、smoke コンテナの wait-for を解除する。
writeFileSync("/certs/.ready", "");
console.log(`mock-target: TLS listening on :${server.port}`);
