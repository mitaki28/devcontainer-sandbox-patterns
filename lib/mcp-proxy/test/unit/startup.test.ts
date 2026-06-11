// proxy 起動時の引数検証 (token 必須化など) を docker 不要で確認する。
// `node --test test/unit/startup.test.ts` で単体実行可能。

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import * as assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runProxy(extraArgs: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(
    "node",
    ["src/index.ts", ...extraArgs],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

describe("mcp-proxy startup", () => {
  test("--token も PROXY_TOKEN も無いと起動拒否される", () => {
    const r = runProxy(["echo", "--", "node", "test/mocks/echo-mcp.ts"], {
      PROXY_TOKEN: "",
    });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("Bearer token is required"));
  });
});
