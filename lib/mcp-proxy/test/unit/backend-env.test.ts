// buildBackendEnv の純粋ユニットテスト。
// stdio backend に proxy の env が丸ごと漏れないことを確認する。

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { buildBackendEnv } from "../../src/index.ts";

describe("buildBackendEnv", () => {
  const source: Record<string, string | undefined> = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/mcpproxy",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "UTF-8",
    // proxy 自身の秘匿情報・無関係な env (backend に漏らしたくない)
    PROXY_TOKEN: "super-secret",
    GITHUB_PAT: "ghp_xxx",
    CLOUDSDK_CORE_PROJECT: "my-project",
    CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/tokens/token",
    AWS_SECRET_ACCESS_KEY: "leak-me-not",
  };

  test("allowlist の env だけ継承し、それ以外 (秘匿情報含む) は渡さない", () => {
    const env = buildBackendEnv(source, [], {});
    assert.equal(env["PATH"], "/usr/bin:/bin");
    assert.equal(env["HOME"], "/home/mcpproxy");
    assert.equal(env["LANG"], "en_US.UTF-8");
    // LC_* は prefix で継承
    assert.equal(env["LC_ALL"], "C");
    assert.equal(env["LC_CTYPE"], "UTF-8");
    // proxy の秘匿情報・無関係な env は漏れない
    assert.equal(env["PROXY_TOKEN"], undefined);
    assert.equal(env["GITHUB_PAT"], undefined);
    assert.equal(env["CLOUDSDK_CORE_PROJECT"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
  });

  test("--pass-env で明示したものだけ追加で継承する", () => {
    const env = buildBackendEnv(
      source,
      ["CLOUDSDK_CORE_PROJECT", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"],
      {},
    );
    assert.equal(env["CLOUDSDK_CORE_PROJECT"], "my-project");
    assert.equal(env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"], "/tokens/token");
    // pass-env に挙げていないものは依然として漏れない
    assert.equal(env["PROXY_TOKEN"], undefined);
    assert.equal(env["GITHUB_PAT"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
  });

  test("--pass-env に存在しない key を挙げても無害 (undefined はスキップ)", () => {
    const env = buildBackendEnv(source, ["DOES_NOT_EXIST"], {});
    assert.equal(env["DOES_NOT_EXIST"], undefined);
  });

  test("--env で指定した値が最優先 (allowlist / pass-env を上書きできる)", () => {
    const env = buildBackendEnv(
      source,
      ["CLOUDSDK_CORE_PROJECT"],
      { CLOUDSDK_CORE_PROJECT: "override", CUSTOM_VAR: "explicit" },
    );
    assert.equal(env["CLOUDSDK_CORE_PROJECT"], "override");
    assert.equal(env["CUSTOM_VAR"], "explicit");
  });

  test("source に無い allowlist key はキーごと省かれる (undefined を入れない)", () => {
    const env = buildBackendEnv({ PATH: "/bin" }, [], {});
    assert.equal(env["PATH"], "/bin");
    assert.equal("HOME" in env, false);
    assert.equal("TERM" in env, false);
  });
});
