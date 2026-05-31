// proxy/src/filter.ts の純粋ユニットテスト。
// docker / network を使わず bun test 直で回せる。

import { describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  compileFilter,
  filterToolsListResponse,
  invalidParamsError,
  isFilterActive,
  methodNotFoundError,
  parsePatternList,
} from "../../src/filter.ts";

describe("compileFilter", () => {
  test("empty allow + empty deny → 全許可", () => {
    const isAllowed = compileFilter({ allow: [], deny: [] });
    expect(isAllowed("anything")).toBe(true);
    expect(isAllowed("")).toBe(true);
  });

  test("allow のみ → 列挙されたものだけ通る", () => {
    const isAllowed = compileFilter({ allow: ["echo", "ping"], deny: [] });
    expect(isAllowed("echo")).toBe(true);
    expect(isAllowed("ping")).toBe(true);
    expect(isAllowed("delete_file")).toBe(false);
  });

  test("deny のみ → 列挙されたものだけ落ちる", () => {
    const isAllowed = compileFilter({ allow: [], deny: ["delete_file"] });
    expect(isAllowed("delete_file")).toBe(false);
    expect(isAllowed("read_file")).toBe(true);
    expect(isAllowed("write_file")).toBe(true);
  });

  test("両方指定 → deny が allow より優先", () => {
    const isAllowed = compileFilter({
      allow: ["read_*", "write_*"],
      deny: ["write_*"],
    });
    expect(isAllowed("read_file")).toBe(true);
    expect(isAllowed("write_file")).toBe(false);
    expect(isAllowed("delete_file")).toBe(false);
  });

  test("glob `*` が任意の文字列にマッチする", () => {
    const isAllowed = compileFilter({ allow: ["repos_*"], deny: [] });
    expect(isAllowed("repos_get_issue")).toBe(true);
    expect(isAllowed("repos_")).toBe(true);
    expect(isAllowed("repos")).toBe(false);
    expect(isAllowed("issues_get")).toBe(false);
  });

  test("glob はアンカー付き（部分一致しない）", () => {
    const isAllowed = compileFilter({ allow: ["read"], deny: [] });
    expect(isAllowed("read")).toBe(true);
    expect(isAllowed("read_file")).toBe(false);
    expect(isAllowed("preread")).toBe(false);
  });

  test("正規表現メタ文字は escape される", () => {
    const isAllowed = compileFilter({ allow: ["a.b"], deny: [] });
    // `.` がリテラルとして扱われる（正規表現の任意 1 文字ではない）
    expect(isAllowed("a.b")).toBe(true);
    expect(isAllowed("aXb")).toBe(false);
  });

  test("複数 `*` の組み合わせ", () => {
    const isAllowed = compileFilter({ allow: ["*_read_*"], deny: [] });
    expect(isAllowed("repo_read_file")).toBe(true);
    expect(isAllowed("foo_read_bar")).toBe(true);
    expect(isAllowed("read_file")).toBe(false);
  });
});

describe("isFilterActive", () => {
  test("両方空ならば false", () => {
    expect(isFilterActive({ allow: [], deny: [] })).toBe(false);
  });
  test("片方でも入っていれば true", () => {
    expect(isFilterActive({ allow: ["x"], deny: [] })).toBe(true);
    expect(isFilterActive({ allow: [], deny: ["x"] })).toBe(true);
  });
});

describe("parsePatternList", () => {
  test("undefined / 空文字 → 空配列", () => {
    expect(parsePatternList(undefined)).toEqual([]);
    expect(parsePatternList("")).toEqual([]);
  });
  test("カンマ区切りを trim", () => {
    expect(parsePatternList("a, b ,  c")).toEqual(["a", "b", "c"]);
  });
  test("空要素を除去", () => {
    expect(parsePatternList("a,,b,")).toEqual(["a", "b"]);
  });
});

describe("filterToolsListResponse", () => {
  const isAllowed = compileFilter({ allow: ["read_*"], deny: [] });

  test("tools 配列が predicate で絞られる", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "read_file", description: "" },
          { name: "write_file", description: "" },
          { name: "delete_file", description: "" },
        ],
      },
    } as JSONRPCMessage;

    const filtered = filterToolsListResponse(msg, isAllowed);
    const tools = (filtered as unknown as { result: { tools: Array<{ name: string }> } }).result
      .tools;
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  test("入力 message を mutate しない", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        tools: [{ name: "write_file", description: "" }],
      },
    };
    const before = JSON.stringify(msg);
    filterToolsListResponse(msg as JSONRPCMessage, isAllowed);
    expect(JSON.stringify(msg)).toBe(before);
  });

  test("nextCursor 等の他フィールドを保つ", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        nextCursor: "page-2",
        tools: [{ name: "read_file", description: "" }],
      },
    } as JSONRPCMessage;

    const filtered = filterToolsListResponse(msg, isAllowed);
    expect((filtered as unknown as { result: { nextCursor: string } }).result.nextCursor).toBe(
      "page-2",
    );
  });

  test("error response はそのまま返す", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "internal" },
    } as JSONRPCMessage;
    const out = filterToolsListResponse(msg, isAllowed);
    expect(out).toBe(msg);
  });

  test("result.tools が無い response はそのまま返す", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { foo: "bar" },
    } as JSONRPCMessage;
    const out = filterToolsListResponse(msg, isAllowed);
    expect(out).toBe(msg);
  });
});

describe("methodNotFoundError", () => {
  test("JSON-RPC error -32601 を id 付きで返す", () => {
    const err = methodNotFoundError(42, "delete_file");
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 42,
      error: {
        code: -32601,
        message: "Tool 'delete_file' is not exposed by mcp-proxy",
      },
    });
  });

  test("string id にも対応する", () => {
    const err = methodNotFoundError("abc", "x");
    expect((err as { id: string }).id).toBe("abc");
  });
});

describe("invalidParamsError", () => {
  test("JSON-RPC error -32602 を id 付きで返す", () => {
    const err = invalidParamsError(7, "tools/call params.name must be a string");
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32602,
        message: "tools/call params.name must be a string",
      },
    });
  });

  test("string id にも対応する", () => {
    const err = invalidParamsError("abc", "x");
    expect((err as { id: string }).id).toBe("abc");
  });
});
