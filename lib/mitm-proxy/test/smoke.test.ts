// lib/mitm-proxy/ smoke test。
//
// test/compose.yaml の閉鎖環境 (internal-net / external-net とも internal: true)
// 内で実行する前提。実 host への egress は一切起きない。alias / cert / policy の
// 詳細は test/policy.smoke.json の `_doc_aliases` を参照。
//
// 検証する性質:
// 1. CA bootstrap が成功している (trust store に mitmproxy CA が入っている)
// 2. workload が非 root (uid=1000) で動いている
// 3. proxy 経由 + 各種ツール (Node fetch / curl) で HTTPS が成立する
// 4. readonly_hosts 外の host (denied.test) は 403 で deny される
// 5. readonly_hosts に居ても GET 系以外の method (POST / PUT) は deny される
// 6. readonly_hosts の glob (`*.content.test`) で subdomain (raw.content.test) が allow される
// 7. allow_rules で readonly host への個別 POST (echo.test/anything/foo) が通る
// 8. HeaderInjector が policy.json の rule に従ってヘッダを足す
// 9. HostGuard が Host ヘッダ詐称 (実宛先 ≠ Host) を 403 で deny する
// 10. workspace は internal-net に閉じ込められ、proxy を介さず外に出る経路が存在しない
// 11. CONNECT 行と TLS SNI / Host header を食い違わせた詐称が最終的に拒否される
//     (mitmproxy は ssl_bump 系と異なり TLS handshake では切らず、HTTP request 段階で
//     addon が deny する。攻撃トラフィックを実際に流して最終 status を観察する)
//
// note: github.com の git smart-HTTP に対する path-based ACL + PAT 注入は
// recipes/git-gateway/ 側で扱う (lib/mitm-proxy/ は read-only 許可を主とする最小構成)。
// git transport 系の test は git-gateway 側 smoke (recipes/git-gateway/test/smoke.sh) でカバー。

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (!PROXY) {
  throw new Error("HTTPS_PROXY/HTTP_PROXY が設定されていません");
}

function parseProxy(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 8080) };
}

// proxy に CONNECT を投げてトンネルを開け、その上で任意 SNI を指定して
// TLS handshake → HTTP GET 1 本を送り、status code を取得する低水準ヘルパ。
// CONNECT 行 / SNI / Host header を独立に詐称できるので、mitm-proxy の防御層
// (CONNECT 由来の flow.request.host を信頼する CommonPolicy + Host header との
// 整合を見る HostGuard) を実際の攻撃トラフィックで確認するのに使う。
//
// 失敗ケース (TLS handshake が切られた / connection が切られた等) は status = -1 で返す。
async function tlsRequestViaProxy(
  proxyHost: string,
  proxyPort: number,
  connectTarget: string,
  connectPort: number,
  sni: string,
  hostHeader: string,
  pathStr: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let settled = false;
    const settle = (v: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    sock.once("error", () => settle({ status: -1, body: "" }));
    sock.connect(proxyPort, proxyHost, () => {
      sock.write(
        `CONNECT ${connectTarget}:${connectPort} HTTP/1.1\r\n` +
          `Host: ${connectTarget}:${connectPort}\r\n\r\n`,
      );
      sock.once("data", (data) => {
        const head = data.toString();
        if (!head.startsWith("HTTP/1.1 200")) {
          // mitmproxy は CONNECT に常に 200 を返すので、ここに来るのは異常系。
          // status は CONNECT response 由来の数字を採用する。
          const m = /^HTTP\/1\.\d (\d{3})/.exec(head);
          settle({ status: m ? Number(m[1]) : -1, body: head });
          return;
        }
        const tls = tlsConnect({
          socket: sock,
          servername: sni,
          // 詐称検証では cert 検証は本筋ではなく、最終的に mitm-proxy の addon が
          // deny するかを見る。client 側の verify は緩めて先に進む。
          rejectUnauthorized: false,
        });
        tls.once("error", () => settle({ status: -1, body: "" }));
        tls.once("secureConnect", () => {
          tls.write(
            `GET ${pathStr} HTTP/1.1\r\n` +
              `Host: ${hostHeader}\r\n` +
              `Connection: close\r\n\r\n`,
          );
          const chunks: Buffer[] = [];
          tls.on("data", (chunk) => chunks.push(chunk));
          tls.once("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const m = /^HTTP\/1\.\d (\d{3})/.exec(raw);
            const headerEnd = raw.indexOf("\r\n\r\n");
            const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : raw;
            settle({ status: m ? Number(m[1]) : -1, body });
          });
        });
      });
    });
  });
}

describe("lib/mitm-proxy smoke (CA bootstrap + ACL + header inject + 攻撃模倣)", () => {
  test("workload は非 root (node, uid=1000) で動いている", () => {
    // bootstrap-ca.sh が CA install 後 setpriv で node に drop している前提。
    // regular mode でも defense-in-depth として非root を維持する (万一 netns
    // 共有構成に派生した場合に uid-owner 除外を悪用される事故を防ぐ)。
    const r = spawnSync("id", ["-u"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "1000");
  });

  test("CA cert ファイルが trust store にある", () => {
    assert.equal(existsSync("/usr/local/share/ca-certificates/mitmproxy.crt"), true);
    const indiv = readFileSync("/usr/local/share/ca-certificates/mitmproxy.crt", "utf8");
    assert.ok(indiv.includes("BEGIN CERTIFICATE"));
    assert.ok(indiv.includes("END CERTIFICATE"));
  });

  test("結合 bundle (/etc/ssl/certs/ca-certificates.crt) に mitmproxy CA が統合されている", () => {
    const indiv = readFileSync("/usr/local/share/ca-certificates/mitmproxy.crt", "utf8");
    const bundle = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8");
    const body = indiv
      .split("\n")
      .filter((l) => l && !l.includes("CERTIFICATE"))
      .join("\n");
    const head = body.slice(0, 60);
    assert.ok(head.length > 0);
    assert.ok(bundle.includes(head));
  });

  test("Node fetch: api.test (readonly exact, GET) → 200", async () => {
    const res = await fetch("https://api.test/");
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("mock-ok GET"));
  });

  test("curl: registry.test (readonly exact, GET) → 200", () => {
    const r = spawnSync(
      "curl",
      ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "https://registry.test/"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "200");
  });

  test("readonly_hosts 外 (denied.test) は 403 で deny", async () => {
    const res = await fetch("https://denied.test/");
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes("not in allowlist"));
  });

  test("readonly_hosts の glob (`*.content.test`) で raw.content.test が allow される", async () => {
    // policy.smoke.json に exact で raw.content.test は無いが、
    // glob `*.content.test` 経由で allow されることを確認。
    const res = await fetch("https://raw.content.test/some/path");
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("mock-ok GET"));
  });

  test("readonly_hosts: echo.test への POST (allow_rules 不一致 path) は 403 で deny", async () => {
    const res = await fetch("https://echo.test/post", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes("readonly"));
  });

  test("readonly_hosts: PUT も同様に deny", async () => {
    const res = await fetch("https://echo.test/put", {
      method: "PUT",
      body: "",
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes("readonly"));
  });

  test("api.test: 非 GET は 403 で deny (readonly_hosts として強制)", async () => {
    const res = await fetch("https://api.test/some/endpoint", {
      method: "POST",
      body: JSON.stringify({ probe: "non-GET on readonly host" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes("readonly"));
  });

  test("git.test への mitm 経由 fetch は readonly_hosts に含まれず 403 (git-gateway 経由が前提)", async () => {
    // github.com の git smart-HTTP は recipes/git-gateway/ で扱う方針。
    // lib/mitm-proxy/ は read-only 許可を主とする最小構成に絞り、本来 github.com に当たる host
    // (smoke では git.test に置き換え) は readonly_hosts に入れず default deny される。
    // 統合構成 (integrated/single-workspace/ / integrated/multi-workspace/) では workspace の
    // gitconfig insteadOf で gateway に書き換わるため、この経路は通らない。
    const res = await fetch(
      "https://git.test/octocat/Hello-World.git/info/refs?service=git-upload-pack",
    );
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes("not in allowlist"));
  });

  test("allow_rules: readonly host (echo.test) でも /anything/foo への POST は個別に許可されて通る", async () => {
    // policy.smoke.json の allow_rules に以下が入っている前提:
    //   {host: "echo.test", path: "/anything/foo", method: "POST"}
    // 同じ host への /post への POST は readonly_hosts で 403 になるが (上のテスト)、
    // allow_rules マッチの /anything/foo は通って mock の echo back を返す。
    const res = await fetch("https://echo.test/anything/foo", {
      method: "POST",
      body: JSON.stringify({ probe: "allow_rules-individual" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { method: string; url: string; json?: unknown };
    assert.equal(data.method, "POST");
    assert.ok(data.url.includes("/anything/foo"));
  });

  test("HostGuard: 偽 Host ヘッダ (実宛先 denied.test, Host: api.test) は 403", () => {
    // `flow.request.pretty_host` (Host ヘッダ優先の spoof 可能値) で ACL すると、
    // `GET http://denied.test/ Host: api.test` で denied.test (非 allowlist) に
    // egress + 注入 secret 漏洩が成立する。HostGuard が Host と実宛先の不整合を
    // 403 で deny する境界を担う。
    //
    // Node fetch は Host を URL から自動正規化してくれて override が効きにくいので
    // curl の -H 'Host: ...' で raw に詐称する。-x proxy で absolute-form になる。
    const r = spawnSync(
      "curl",
      [
        "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-x", PROXY,
        "-H", "Host: api.test",
        "http://denied.test/",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.stdout.trim(), "403");
  });

  test("HeaderInjector: policy.json の rule で echo.test/headers にヘッダ注入される", async () => {
    // policy.smoke.json に以下の rule が入っている前提:
    //   match: {host: "echo.test", path: "/headers"}
    //   headers: {X-Mitm-Proxy-Test: "smoke-injected"}
    // mock の /headers は受け取った request headers を JSON で echo back するので、
    // proxy 経由でアクセスして response body の中に注入された header が見えれば OK。
    const res = await fetch("https://echo.test/headers");
    assert.equal(res.status, 200);
    const data = (await res.json()) as { headers: Record<string, string> };
    // mock のヘッダ名の casing には依存せず case-insensitive に探す
    const entry = Object.entries(data.headers).find(
      ([k]) => k.toLowerCase() === "x-mitm-proxy-test",
    );
    assert.ok(entry !== undefined);
    assert.equal(entry![1], "smoke-injected");
  });

  test("直接 TCP egress (1.1.1.1:443) は internal-net で経路が無く失敗する", async () => {
    // workspace は internal: true の internal-net しか持たないため、proxy を介さず
    // 外部 IP に直接出る経路は L3 段階で存在しない。hostname ではなく IP を直接指定して
    // DNS の有無に依存しない検証にする (alternatives/simple-http-proxy の同名テストと同方針)。
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

  test("CONNECT 詐称: CONNECT api.test + SNI/Host denied.test → 最終的に deny される", async () => {
    // 攻撃シナリオ: CONNECT 行は allowlist 内 (api.test) として通過し、TLS 内側で
    // 実際の宛先 (denied.test) に egress 成立を狙う。mitmproxy は ssl_bump と異なり
    // TLS handshake では切らず、addon は HTTP request 段階で動く。
    //
    // 期待される防御層:
    //   - mitmproxy が flow.request.host を SNI / Host header 由来で更新する場合
    //     → CommonPolicy が denied.test を default deny で 403
    //   - mitmproxy が CONNECT 行 (api.test) を保持する場合
    //     → HostGuard が Host header (denied.test) との不整合を 403
    //
    // どちらの実装でも最終 status は 4xx 以上で「攻撃は阻止された」を意味する。
    // 閉鎖ネットなので仮に防御が抜けても外部には到達しない。
    const { host, port } = parseProxy(PROXY);
    const r = await tlsRequestViaProxy(
      host, port, "api.test", 443, "denied.test", "denied.test", "/",
    );
    assert.ok(r.status >= 400);
  });
});
