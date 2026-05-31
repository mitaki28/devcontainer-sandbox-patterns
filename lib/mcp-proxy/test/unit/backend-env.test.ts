// buildBackendEnv の純粋ユニットテスト。
// stdio backend に proxy の env が丸ごと漏れないことを確認する。

import { describe, expect, test } from "bun:test";
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
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/home/mcpproxy");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    // LC_* は prefix で継承
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LC_CTYPE"]).toBe("UTF-8");
    // proxy の秘匿情報・無関係な env は漏れない
    expect(env["PROXY_TOKEN"]).toBeUndefined();
    expect(env["GITHUB_PAT"]).toBeUndefined();
    expect(env["CLOUDSDK_CORE_PROJECT"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("--pass-env で明示したものだけ追加で継承する", () => {
    const env = buildBackendEnv(
      source,
      ["CLOUDSDK_CORE_PROJECT", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"],
      {},
    );
    expect(env["CLOUDSDK_CORE_PROJECT"]).toBe("my-project");
    expect(env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"]).toBe("/tokens/token");
    // pass-env に挙げていないものは依然として漏れない
    expect(env["PROXY_TOKEN"]).toBeUndefined();
    expect(env["GITHUB_PAT"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("--pass-env に存在しない key を挙げても無害 (undefined はスキップ)", () => {
    const env = buildBackendEnv(source, ["DOES_NOT_EXIST"], {});
    expect(env["DOES_NOT_EXIST"]).toBeUndefined();
  });

  test("--env で指定した値が最優先 (allowlist / pass-env を上書きできる)", () => {
    const env = buildBackendEnv(
      source,
      ["CLOUDSDK_CORE_PROJECT"],
      { CLOUDSDK_CORE_PROJECT: "override", CUSTOM_VAR: "explicit" },
    );
    expect(env["CLOUDSDK_CORE_PROJECT"]).toBe("override");
    expect(env["CUSTOM_VAR"]).toBe("explicit");
  });

  test("source に無い allowlist key はキーごと省かれる (undefined を入れない)", () => {
    const env = buildBackendEnv({ PATH: "/bin" }, [], {});
    expect(env["PATH"]).toBe("/bin");
    expect("HOME" in env).toBe(false);
    expect("TERM" in env).toBe(false);
  });
});
