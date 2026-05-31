// proxy/src/filter.ts の純粋ユニットテスト。
// docker / network を使わず `node --test` で直に回せる。

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
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
    assert.equal(isAllowed("anything"), true);
    assert.equal(isAllowed(""), true);
  });

  test("allow のみ → 列挙されたものだけ通る", () => {
    const isAllowed = compileFilter({ allow: ["echo", "ping"], deny: [] });
    assert.equal(isAllowed("echo"), true);
    assert.equal(isAllowed("ping"), true);
    assert.equal(isAllowed("delete_file"), false);
  });

  test("deny のみ → 列挙されたものだけ落ちる", () => {
    const isAllowed = compileFilter({ allow: [], deny: ["delete_file"] });
    assert.equal(isAllowed("delete_file"), false);
    assert.equal(isAllowed("read_file"), true);
    assert.equal(isAllowed("write_file"), true);
  });

  test("両方指定 → deny が allow より優先", () => {
    const isAllowed = compileFilter({
      allow: ["read_*", "write_*"],
      deny: ["write_*"],
    });
    assert.equal(isAllowed("read_file"), true);
    assert.equal(isAllowed("write_file"), false);
    assert.equal(isAllowed("delete_file"), false);
  });

  test("glob `*` が任意の文字列にマッチする", () => {
    const isAllowed = compileFilter({ allow: ["repos_*"], deny: [] });
    assert.equal(isAllowed("repos_get_issue"), true);
    assert.equal(isAllowed("repos_"), true);
    assert.equal(isAllowed("repos"), false);
    assert.equal(isAllowed("issues_get"), false);
  });

  test("glob はアンカー付き（部分一致しない）", () => {
    const isAllowed = compileFilter({ allow: ["read"], deny: [] });
    assert.equal(isAllowed("read"), true);
    assert.equal(isAllowed("read_file"), false);
    assert.equal(isAllowed("preread"), false);
  });

  test("正規表現メタ文字は escape される", () => {
    const isAllowed = compileFilter({ allow: ["a.b"], deny: [] });
    // `.` がリテラルとして扱われる（正規表現の任意 1 文字ではない）
    assert.equal(isAllowed("a.b"), true);
    assert.equal(isAllowed("aXb"), false);
  });

  test("複数 `*` の組み合わせ", () => {
    const isAllowed = compileFilter({ allow: ["*_read_*"], deny: [] });
    assert.equal(isAllowed("repo_read_file"), true);
    assert.equal(isAllowed("foo_read_bar"), true);
    assert.equal(isAllowed("read_file"), false);
  });
});

describe("isFilterActive", () => {
  test("両方空ならば false", () => {
    assert.equal(isFilterActive({ allow: [], deny: [] }), false);
  });
  test("片方でも入っていれば true", () => {
    assert.equal(isFilterActive({ allow: ["x"], deny: [] }), true);
    assert.equal(isFilterActive({ allow: [], deny: ["x"] }), true);
  });
});

describe("parsePatternList", () => {
  test("undefined / 空文字 → 空配列", () => {
    assert.deepEqual(parsePatternList(undefined), []);
    assert.deepEqual(parsePatternList(""), []);
  });
  test("カンマ区切りを trim", () => {
    assert.deepEqual(parsePatternList("a, b ,  c"), ["a", "b", "c"]);
  });
  test("空要素を除去", () => {
    assert.deepEqual(parsePatternList("a,,b,"), ["a", "b"]);
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
    assert.deepEqual(tools.map((t) => t.name), ["read_file"]);
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
    assert.equal(JSON.stringify(msg), before);
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
    assert.equal(
      (filtered as unknown as { result: { nextCursor: string } }).result.nextCursor,
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
    assert.equal(out, msg);
  });

  test("result.tools が無い response はそのまま返す", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { foo: "bar" },
    } as JSONRPCMessage;
    const out = filterToolsListResponse(msg, isAllowed);
    assert.equal(out, msg);
  });
});

describe("methodNotFoundError", () => {
  test("JSON-RPC error -32601 を id 付きで返す", () => {
    const err = methodNotFoundError(42, "delete_file");
    assert.deepEqual(err, {
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
    assert.equal((err as { id: string }).id, "abc");
  });
});

describe("invalidParamsError", () => {
  test("JSON-RPC error -32602 を id 付きで返す", () => {
    const err = invalidParamsError(7, "tools/call params.name must be a string");
    assert.deepEqual(err, {
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
    assert.equal((err as { id: string }).id, "abc");
  });
});
