// mock-target: 443 で TLS listen する smoke 用の偽 upstream。
// allowed-hosts.smoke.txt の hostname (mock-target.test) を Docker network
// alias で受け、proxy 経由のリクエストに 200 を返す。

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

const cert = readFileSync("/certs/mock-target.crt");
const key = readFileSync("/certs/mock-target.key");

const PORT = 443;

const server = createServer({ cert, key }, (req, res) => {
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "mock-target.test"}`);
  res
    .writeHead(200, { "content-type": "text/plain" })
    .end(`mock-ok ${req.method ?? "?"} ${url.hostname}${url.pathname}\n`);
});

server.listen(PORT, () => {
  // listen 完了後に .ready を touch し、smoke コンテナの wait-for を解除する。
  writeFileSync("/certs/.ready", "");
  console.log(`mock-target: TLS listening on :${PORT}`);
});
