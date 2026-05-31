// proxy 起動時の引数検証 (token 必須化など) を docker 不要で確認する。
// `bun test test/unit/startup.test.ts` で単体実行可能。

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "..", "..");

function runProxy(extraArgs: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(
    "bun",
    ["run", "src/index.ts", ...extraArgs],
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
    const r = runProxy(["echo", "--", "bun", "run", "test/mocks/echo-mcp.ts"], {
      PROXY_TOKEN: "",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Bearer token is required");
  });
});
