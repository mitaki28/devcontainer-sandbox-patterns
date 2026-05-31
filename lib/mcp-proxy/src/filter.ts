// Tool 名ベースの allow/deny フィルタ。
// `tools/list` のレスポンスを post-filter し、`tools/call` を pre-check する。
// 拒否は MCP spec の流儀どおり JSON-RPC error (-32601) で返す。

import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

export interface FilterOptions {
  /** 空配列なら「全許可（deny を除く）」。非空なら「いずれかにマッチした tool だけ通す」。 */
  allow: string[];
  /** マッチした tool は allow より優先で拒否される。 */
  deny: string[];
}

export type ToolPredicate = (name: string) => boolean;

export function compileFilter(opts: FilterOptions): ToolPredicate {
  const allow = opts.allow.map(globToRegex);
  const deny = opts.deny.map(globToRegex);
  return (name) => {
    if (allow.length > 0 && !allow.some((re) => re.test(name))) return false;
    if (deny.some((re) => re.test(name))) return false;
    return true;
  };
}

export function isFilterActive(opts: FilterOptions): boolean {
  return opts.allow.length > 0 || opts.deny.length > 0;
}

/** カンマ区切りの env 値を pattern 配列に。空白・空要素は除去。 */
export function parsePatternList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * glob → RegExp。`*` のみサポート（任意の文字列、`/` も含む）。
 * 他の正規表現メタ文字は escape する。
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * `tools/list` のレスポンスから、predicate が false の tool を除外した新しい message を返す。
 * 入力が tools/list 応答でない / `result.tools` が無い場合は変更せず返す。
 */
export function filterToolsListResponse(
  msg: JSONRPCMessage,
  isAllowed: ToolPredicate,
): JSONRPCMessage {
  if (typeof msg !== "object" || msg === null) return msg;
  if (!("result" in msg)) return msg;
  const result = (msg as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return msg;
  if (!("tools" in result)) return msg;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return msg;
  const filtered = tools.filter((t: unknown) => {
    if (typeof t !== "object" || t === null) return true;
    const name = (t as { name?: unknown }).name;
    return typeof name === "string" ? isAllowed(name) : true;
  });
  const next: unknown = { ...(msg as object), result: { ...result, tools: filtered } };
  return next as JSONRPCMessage;
}

/**
 * フィルタで拒否された `tools/call` 用の JSON-RPC error response。
 * spec 上「tool 不在」は protocol-level error (-32601) なので isError tool result ではなくこちらで返す。
 */
export function methodNotFoundError(id: RequestId, toolName: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Tool '${toolName}' is not exposed by mcp-proxy`,
    },
  };
}

/**
 * filter が active な状態で `tools/call` の `params.name` が string として
 * 解釈できなかった場合の JSON-RPC error response (spec の params 検証エラー = -32602)。
 *
 * 非文字列のまま backend に流すと、寛容な backend が独自に name を coerce する
 * (例: `["delete", "all"]` → `"delete,all"`) ことで deny を擦り抜ける余地が残る。
 * filter active 時は proxy 側で fail-closed する。
 */
export function invalidParamsError(id: RequestId, message: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message,
    },
  };
}
