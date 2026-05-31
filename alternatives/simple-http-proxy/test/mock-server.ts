// mock-target: Bun.serve で 443 で TLS listen する smoke 用の偽 upstream。
// allowed-hosts.smoke.txt の hostname (mock-target.test) を Docker network
// alias で受け、proxy 経由のリクエストに 200 を返す。

import { writeFileSync } from "node:fs";

const cert = await Bun.file("/certs/mock-target.crt").text();
const key = await Bun.file("/certs/mock-target.key").text();

const server = Bun.serve({
  port: 443,
  tls: { cert, key },
  fetch(req) {
    const url = new URL(req.url);
    return new Response(`mock-ok ${req.method} ${url.hostname}${url.pathname}\n`, {
      status: 200,
    });
  },
});

// listen 完了後に .ready を touch し、smoke コンテナの wait-for を解除する。
writeFileSync("/certs/.ready", "");
console.log(`mock-target: TLS listening on :${server.port}`);
