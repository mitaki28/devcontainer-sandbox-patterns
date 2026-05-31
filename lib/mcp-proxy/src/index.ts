#!/usr/bin/env bun
import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  compileFilter,
  filterToolsListResponse,
  invalidParamsError,
  isFilterActive,
  methodNotFoundError,
  parsePatternList,
  type FilterOptions,
} from "./filter.ts";
import { FileOAuthProvider } from "./oauth.ts";

type BackendTransport = "stdio" | "http";

/**
 * 内部 callback listener が listen する path。redirect_uri 告知側の path とは独立に
 * 固定する (= reverse proxy 前段で path rewrite してから listener に届ける前提)。
 * 慣習に倣って `/callback` を使う。
 */
export const CALLBACK_PATH = "/callback";

interface CliArgs {
  listen: string;
  token: string;
  transport: BackendTransport;
  oauth: boolean;
  headers: Record<string, string>;
  env: Record<string, string>;
  /** stdio backend に proxy の環境から継承して渡す env key (allowlist への追加分)。 */
  passEnv: string[];
  /**
   * 内部 callback listener が bind する host:port。default は `127.0.0.1:3030`
   * (loopback 限定)。reverse proxy を前段に置く等、callback を loopback の外で受ける
   * 必要がある構成のときだけ host を `0.0.0.0` 等に拡げる
   * (env: `PROXY_CALLBACK_LISTEN`)。`--callback-url` の host:port とは独立に扱う —
   * `--callback-url` は provider に告知する redirect_uri、こちらは listen 範囲。
   */
  callbackListen: { hostname: string; port: number };
  /**
   * DCR で provider に登録する redirect_uri。reverse proxy を前段に置く構成では
   * 公開 URL (rewrite 前) を指定する。`--callback-url` 未指定時は
   * `http://localhost:<callback-listen port>/callback` で組み立てる (loopback 直接公開構成)。
   * 内部 listener は常に `CALLBACK_PATH` 固定で受けるため、reverse proxy 側で
   * 公開 path → `/callback` の rewrite が必要 (host/port も同様に provider 告知用と
   * listener bind は別物として扱う)。
   */
  callbackUrl: URL;
  /** callback を待ち続ける上限。これを越えたら CallbackTimeoutError で reject。 */
  callbackTimeoutMs: number;
  /**
   * 直近の activity から idle timeout を超えた session を sweep する閾値 (ms)。
   * 0 で sweep を無効化する。
   * MCP spec 上 server は `MAY` で session を terminate できるため、DELETE が来ない
   * (例: client コンテナが kill された) 場合に backend と session map を解放する目的。
   */
  sessionIdleTimeoutMs: number;
  /**
   * `--oauth-refresh-dedup` 指定時、proxy 全体で 1 つの fetch wrapper を share し、
   * 同時発火した refresh_token grant を 1 本の HTTP request に集約する (experimental)。
   * `--oauth` 指定時のみ意味を持つ。
   */
  oauthRefreshDedup: boolean;
  tokenStore: string;
  scope: string | undefined;
  filter: FilterOptions;
  name: string;
  commandOrUrl: string;
  commandArgs: string[];
}

export class CallbackTimeoutError extends Error {
  constructor(ms: number) {
    super(`OAuth callback timeout after ${String(ms)}ms`);
    // TS で `class extends Error` すると一部 runtime で `instanceof` / `name` が
    // 安定しないため明示的に prototype を張り直し、name は defineProperty で固定する。
    Object.setPrototypeOf(this, CallbackTimeoutError.prototype);
    Object.defineProperty(this, "name", {
      value: "CallbackTimeoutError",
      configurable: true,
    });
  }
}

function printHelp(): void {
  console.error(
    `mcp-proxy - 1 backend MCP を streamable-HTTP として透過 forward

Usage:
  mcp-proxy [options] <name> <commandOrUrl> [args...]

Proxy options (incoming side):
  --listen <addr>               Listen address (default 0.0.0.0:8000, env PROXY_LISTEN)
  --token <token>               Bearer token for incoming clients (env PROXY_TOKEN, REQUIRED)

Backend options (claude mcp add 互換):
  -t, --transport <stdio|http>  Backend transport (default stdio)
  -H, --header <"K: V">         HTTP backend のヘッダ（繰り返し可）
  -e, --env <KEY=VALUE>         stdio backend の環境変数（繰り返し可、値を直接指定）
  --pass-env <KEY>              proxy の環境から stdio backend に継承する env key
                                （繰り返し可）。proxy の env 全体は渡さず、
                                PATH / HOME 等の安全な既定 allowlist + これだけを渡す。

OAuth options (HTTP backend のみ、初回認可と token 永続化):
  --oauth                       起動時に OAuth flow を駆動する（DCR + 認可 + token 保存）
  --callback-listen <host:port> 内部 callback listener の bind 範囲 (default 127.0.0.1:3030、
                                env: PROXY_CALLBACK_LISTEN)。reverse proxy を前段に置く等
                                callback を loopback の外で受ける構成では 0.0.0.0:3030 等を
                                明示的に指定する。--callback-url の host:port とは独立。
                                listener は path /callback 固定で受ける
  --callback-url <URL>          DCR redirect_uri に登録する完全 URL (告知専用、reverse proxy
                                を前段に置く構成では公開 URL を指定する)。listener path は
                                URL に関わらず /callback 固定なので、reverse proxy 側で
                                公開 path → /callback の rewrite が必要。未指定時は
                                http://localhost:<callback-listen port>/callback を組み立てる
                                例: http://localhost:8080/atlassian/callback
                                env: PROXY_CALLBACK_URL
  --callback-timeout <ms>       Callback を待つ上限 (default 300000 = 5 分、env PROXY_CALLBACK_TIMEOUT)
  --token-store <dir>           Persist tokens / client info (default /data)
  --scope <scope>               OAuth scope passed during DCR (optional)
  --oauth-refresh-dedup         [experimental] 同時発火した refresh_token grant を proxy 全体で
                                1 本の HTTP request に集約する。複数 backend が同じ token を
                                共有する構成 (per-session backend) で refresh_token rotation
                                する provider との race を回避する用途
                                (env: PROXY_OAUTH_REFRESH_DEDUP=1)

Tool filter options (allowlist / denylist by tool name):
  --allow-tool <pattern>        許可する tool 名のパターン（繰り返し可、glob "*" 対応）
  --deny-tool  <pattern>        拒否する tool 名のパターン（繰り返し可、deny が allow より優先）
                                env: PROXY_ALLOW_TOOLS / PROXY_DENY_TOOLS（カンマ区切り）

Session lifecycle options:
  --session-idle-timeout <ms>   idle timeout を超えた session を sweep する閾値
                                (default 3600000 = 1 時間、env PROXY_SESSION_IDLE_TIMEOUT)。
                                0 で sweep を無効化。in-flight な request を持つ session は
                                対象外。

Examples:
  mcp-proxy fs -- npx -y @modelcontextprotocol/server-filesystem /workspace
  mcp-proxy -t http -H "Authorization: Bearer $GITHUB_PAT" \\
    github https://api.githubcopilot.com/mcp/
  mcp-proxy -t http --oauth --callback-listen 0.0.0.0:3030 --token-store /data \\
    atlassian https://mcp.atlassian.com/v1/mcp/authv2
`,
  );
}

function parseHeader(s: string): [string, string] {
  const idx = s.indexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid header (expected "Key: Value"): ${s}`);
  }
  return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
}

function parseEnv(s: string): [string, string] {
  const idx = s.indexOf("=");
  if (idx === -1) {
    throw new Error(`Invalid env (expected "KEY=VALUE"): ${s}`);
  }
  return [s.slice(0, idx), s.slice(idx + 1)];
}

function timingSafeStringEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parsePort(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function parseNonNegativeInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function parseCli(): CliArgs {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      listen: { type: "string" },
      token: { type: "string" },
      transport: { type: "string", short: "t" },
      header: { type: "string", short: "H", multiple: true },
      env: { type: "string", short: "e", multiple: true },
      "pass-env": { type: "string", multiple: true },
      oauth: { type: "boolean" },
      "callback-listen": { type: "string" },
      "callback-url": { type: "string" },
      "callback-timeout": { type: "string" },
      "token-store": { type: "string" },
      scope: { type: "string" },
      "allow-tool": { type: "string", multiple: true },
      "deny-tool": { type: "string", multiple: true },
      "session-idle-timeout": { type: "string" },
      "oauth-refresh-dedup": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (positionals.length < 2) {
    printHelp();
    process.exit(1);
  }

  const transportRaw = values.transport ?? "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "http") {
    throw new Error(`Unsupported transport: ${transportRaw} (only stdio/http)`);
  }

  const [name, commandOrUrl, ...commandArgs] = positionals as [string, string, ...string[]];

  const headers: Record<string, string> = {};
  for (const h of values.header ?? []) {
    const [k, v] = parseHeader(h);
    headers[k] = v;
  }

  const env: Record<string, string> = {};
  for (const e of values.env ?? []) {
    const [k, v] = parseEnv(e);
    env[k] = v;
  }

  // default は loopback (127.0.0.1:3030)。reverse proxy を前段に置く等、callback を
  // loopback の外で受ける構成では recipe 側で 0.0.0.0:3030 を明示する。
  // `--callback-url` の host:port とは独立に扱う。`--listen` と同形式にして host 指定漏れを防ぐ。
  const callbackListenRaw =
    values["callback-listen"] ?? Bun.env["PROXY_CALLBACK_LISTEN"] ?? "127.0.0.1:3030";
  const callbackListen = parseListen(callbackListenRaw, "--callback-listen");

  const callbackTimeoutRaw =
    values["callback-timeout"] ?? Bun.env["PROXY_CALLBACK_TIMEOUT"] ?? "300000";
  const callbackTimeoutMs = parsePositiveInt(callbackTimeoutRaw, "--callback-timeout");

  const sessionIdleTimeoutRaw =
    values["session-idle-timeout"] ?? Bun.env["PROXY_SESSION_IDLE_TIMEOUT"] ?? "3600000";
  const sessionIdleTimeoutMs = parseNonNegativeInt(
    sessionIdleTimeoutRaw,
    "--session-idle-timeout",
  );

  const callbackUrlRaw = values["callback-url"] ?? Bun.env["PROXY_CALLBACK_URL"];
  let callbackUrl: URL;
  if (callbackUrlRaw) {
    try {
      callbackUrl = new URL(callbackUrlRaw);
    } catch {
      throw new Error(`Invalid --callback-url (expected absolute URL): ${callbackUrlRaw}`);
    }
    // path/host/port は告知用 (= provider に登録する redirect_uri) として渡すだけで
    // listener bind とは独立。validate しない。listener は `CALLBACK_PATH` 固定で受ける
    // (reverse proxy 前段で公開 path → `/callback` の rewrite 前提)。
  } else {
    // --callback-url 未指定なら loopback 直接公開構成として組み立てる
    callbackUrl = new URL(
      `http://localhost:${String(callbackListen.port)}${CALLBACK_PATH}`,
    );
  }

  const oauth = values.oauth ?? Bun.env["PROXY_OAUTH"] === "1";
  if (oauth && transportRaw !== "http") {
    throw new Error("--oauth requires --transport http");
  }

  const oauthRefreshDedup =
    values["oauth-refresh-dedup"] ?? Bun.env["PROXY_OAUTH_REFRESH_DEDUP"] === "1";
  if (oauthRefreshDedup && !oauth) {
    throw new Error("--oauth-refresh-dedup requires --oauth");
  }

  const filter: FilterOptions = {
    allow: [...(values["allow-tool"] ?? []), ...parsePatternList(Bun.env["PROXY_ALLOW_TOOLS"])],
    deny: [...(values["deny-tool"] ?? []), ...parsePatternList(Bun.env["PROXY_DENY_TOOLS"])],
  };

  const token = values.token ?? Bun.env["PROXY_TOKEN"];
  if (!token) {
    throw new Error(
      "Bearer token is required: pass --token <token> or set PROXY_TOKEN. " +
        "no-auth listen is intentionally disabled (see lib/mcp-proxy/README.md).",
    );
  }

  return {
    listen: values.listen ?? Bun.env["PROXY_LISTEN"] ?? "0.0.0.0:8000",
    token,
    transport: transportRaw,
    oauth,
    headers,
    env,
    passEnv: values["pass-env"] ?? [],
    callbackListen,
    callbackUrl,
    callbackTimeoutMs,
    sessionIdleTimeoutMs,
    oauthRefreshDedup,
    tokenStore: values["token-store"] ?? Bun.env["PROXY_TOKEN_STORE"] ?? "/data",
    scope: values.scope ?? Bun.env["PROXY_OAUTH_SCOPE"],
    filter,
    name,
    commandOrUrl,
    commandArgs,
  };
}

function parseListen(value: string, label: string): { hostname: string; port: number } {
  const idx = value.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid ${label} (expected "host:port"): ${value}`);
  }
  const hostname = value.slice(0, idx);
  const port = parsePort(value.slice(idx + 1), `port in ${label}`);
  return { hostname, port };
}

function getMessageId(msg: JSONRPCMessage): RequestId | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  if (!("id" in msg)) return undefined;
  const id = (msg as { id?: RequestId | null }).id;
  return id == null ? undefined : id;
}

function withMessageId(msg: JSONRPCMessage, id: RequestId): JSONRPCMessage {
  return { ...(msg as object), id } as JSONRPCMessage;
}

function isResponse(msg: JSONRPCMessage): boolean {
  return getMessageId(msg) !== undefined && !("method" in msg);
}

interface AwaitOAuthCallbackOptions {
  name: string;
  /**
   * provider に告知した redirect_uri。log 出力にのみ使う (host/port/path は listener
   * 受付値とは独立。listener は `CALLBACK_PATH` 固定で受ける)。
   */
  callbackUrl: URL;
  /**
   * Bun.serve の `hostname` に渡す bind 範囲。default は CLI 側で `127.0.0.1`、
   * reverse proxy 前段の構成等で loopback の外に開く必要があるときだけ `0.0.0.0`
   * 等に拡げる前提。required にして caller (CLI parser / test harness) が
   * 明示する形にしている。
   */
  listenHost: string;
  /** Bun.serve に渡す port。`0` を渡すと OS が動的に割り当てる (test 用)。 */
  listenPort: number;
  /** 受信した state を保存済み nonce と timing-safe で照合する関数。 */
  verifyState: (received: string) => boolean;
  /** これを越えたら CallbackTimeoutError で reject。 */
  timeoutMs: number;
  /** listen 開始直後に実 port を通知する (動的 port を caller が知るための hook、test 用)。 */
  onListen?: (port: number) => void;
}

/**
 * 認可コードを **正規の state と一致する 1 回だけ** 受け取るための一時 HTTP server。
 *
 * - `/callback?code=...&state=...` を受け、state が照合できたら resolve
 * - `?error=...&state=...` で state が照合できたら正規ユーザーの error として reject
 * - state 不在 / 不一致は静かに 400 を返して listener を続行する (Promise は settle しない)。
 *   これにより同 network 内攻撃者が偽 code/error を投げ込んで認可フローを破壊する
 *   経路 (state 検証不在時の DoS) を遮断する。
 * - `timeoutMs` 経過しても正規 callback が来なければ `CallbackTimeoutError` で reject。
 *
 * listener path は `CALLBACK_PATH` 固定。`callbackUrl` は provider に告知する
 * redirect_uri を log に出すためだけに使う (host/port/path は listener 受付値と
 * 一致する必要はなく、reverse proxy 前段の構成では公開 URL → `/callback` への
 * rewrite が reverse proxy 側で行われる前提)。
 */
export function awaitOAuthCallback(
  opts: AwaitOAuthCallbackOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { name, callbackUrl, listenHost, listenPort, verifyState, timeoutMs } = opts;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bun.serve は同期で server を返すが、fetch handler / timer の closure から
    // 参照するため non-null assertion 用に変数を let で先に宣言する。
    let server!: ReturnType<typeof Bun.serve>;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // response が届くだけの遅延を取って stop する（force すると socket が即 close される）。
      setTimeout(() => void server.stop(), 200);
      action();
    };

    const expectedPath = CALLBACK_PATH;

    server = Bun.serve({
      hostname: listenHost,
      port: listenPort,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== expectedPath) {
          return new Response("Not Found", { status: 404 });
        }
        const state = u.searchParams.get("state");
        if (state === null || !verifyState(state)) {
          // state 不一致 / 不在: 静かに 400 を返して listener は継続する。
          // 攻撃者の偽 code/error/state injection で Promise を settle させない。
          console.error(`[${name}] callback state mismatch; ignoring request`);
          return new Response("State mismatch", { status: 400 });
        }
        const error = u.searchParams.get("error");
        if (error) {
          const desc = u.searchParams.get("error_description");
          finish(() => reject(new Error(`OAuth error: ${error}${desc ? ` (${desc})` : ""}`)));
          return new Response(htmlPage("OAuth error", error + (desc ? ` (${desc})` : "")), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" },
          });
        }
        const code = u.searchParams.get("code");
        if (!code) {
          return new Response("Missing code", { status: 400 });
        }
        finish(() => resolve(code));
        return new Response(
          htmlPage(
            "Authorization complete",
            "mcp-proxy received the authorization code. You can close this tab.",
          ),
          { headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" } },
        );
      },
    });

    // unix socket モードは使わないので server.port は常に number。型上は number | undefined。
    const actualPort = server.port ?? listenPort;
    opts.onListen?.(actualPort);

    timer = setTimeout(() => {
      finish(() => reject(new CallbackTimeoutError(timeoutMs)));
    }, timeoutMs);

    console.error(
      `[${name}] callback listening on ${listenHost}:${String(actualPort)}${expectedPath}` +
        ` (redirect_uri = ${callbackUrl.toString()}, timeout = ${String(timeoutMs)}ms)`,
    );
  });
}

function htmlPage(title: string, body: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem;margin-bottom:0.5rem}p{color:#555}</style>
</head><body><h1>${escape(title)}</h1><p>${escape(body)}</p></body></html>`;
}

/**
 * stdio backend に渡す env を組み立てる。proxy の環境を丸ごと継承すると、
 * proxy 自身の秘匿情報 (PROXY_TOKEN、recipe が `environment:` で渡した値など) が
 * backend MCP の子プロセスに筒抜けになる。backend MCP が supply chain で
 * 汚染された場合の漏洩経路になるため、以下の 3 段だけを渡す:
 *
 *   1. `DEFAULT_BACKEND_ENV_ALLOWLIST` + `LC_*` — 実行に必要な環境系のみ
 *   2. `--pass-env KEY` — proxy の env から明示的に許可されたものだけ継承
 *   3. `--env KEY=VALUE` — 値を直接指定したもの (最優先)
 */
export const DEFAULT_BACKEND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "TMPDIR",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

export function buildBackendEnv(
  source: Record<string, string | undefined>,
  passEnv: readonly string[],
  explicitEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_BACKEND_ENV_ALLOWLIST) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  // locale 系は prefix で一括継承 (LC_ALL / LC_CTYPE / ...)。
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith("LC_") && v !== undefined) env[k] = v;
  }
  for (const key of passEnv) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  Object.assign(env, explicitEnv);
  return env;
}

/**
 * fetch 中の `body` が OAuth 2.1 spec の refresh_token grant か判定する。
 * SDK の `executeTokenRequest` は `URLSearchParams` をそのまま body に渡してくる
 * (`auth.js: body: tokenRequestParams`)。SDK 側が string serialize に切り替わった
 * 場合の保険として string body も受け付ける。OAuth 2.1 で token endpoint への
 * request は `application/x-www-form-urlencoded` 固定なので、それ以外の body 型を
 * 見たら refresh ではないと判定して素通す。
 */
function isRefreshTokenRequest(init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token";
  }
  if (typeof body === "string") {
    try {
      return new URLSearchParams(body).get("grant_type") === "refresh_token";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * OAuth refresh_token grant の同時発火を 1 本の HTTP request に集約する fetch wrapper。
 *
 * per-session backend では複数 backend transport が同じ token store / refresh_token を
 * 共有するため、同時に access_token が期限切れになると各 transport が独立に token endpoint
 * を叩く。refresh_token rotation する provider (Atlassian, Google など) では 1 回目だけ
 * 成功して 2 回目以降が `invalid_grant` で失敗し、SDK が credential を invalidate して
 * 全 session が無効化される。
 *
 * SDK 本体には in-process dedup が無い (typescript-sdk #1760 で認識済み、PR #1813 が
 * レビュー停止中)。proxy 側で `StreamableHTTPClientTransport({ fetch })` の hook 経由で
 * grant_type=refresh_token の POST を 1 本に集約することで race を防ぐ。
 *
 * 各 caller は同じ Response を共有するが、`Response.clone()` で body stream を duplicate
 * して独立に read できるようにする。
 */
function createOAuthRefreshDedupFetch(): FetchLike {
  // Bun の global Response (BunHeadersOverride 拡張) と SDK の FetchLike が要求する
  // undici-types Response は同じ Web Standard Response の別宣言で TS 上は不整合だが、
  // runtime では完全互換 (clone() / json() 等は素通しで動く)。inflight は Promise<unknown> で
  // 抱え、関数全体を最後に as unknown as FetchLike でブリッジして型衝突を吸収する。
  let inflight: Promise<unknown> | undefined;
  const handler = async (input: string | URL, init?: RequestInit) => {
    if (!isRefreshTokenRequest(init)) {
      return fetch(input, init);
    }
    if (!inflight) {
      inflight = fetch(input, init).finally(() => {
        inflight = undefined;
      });
    }
    const res = (await inflight) as Response;
    return res.clone();
  };
  return handler as unknown as FetchLike;
}

async function startBackend(
  args: CliArgs,
  sharedFetch?: FetchLike,
  sharedOAuthProvider?: FileOAuthProvider,
): Promise<Transport> {
  if (args.transport === "stdio") {
    const t = new StdioClientTransport({
      command: args.commandOrUrl,
      args: args.commandArgs,
      env: buildBackendEnv(process.env, args.passEnv, args.env),
    });
    await t.start();
    return t;
  }

  // HTTP backend
  const url = new URL(args.commandOrUrl);

  if (!args.oauth) {
    // PAT / API key を --header で渡す通常の HTTP backend
    const t = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: args.headers },
    });
    await t.start();
    return t;
  }

  // OAuth backend は proxy 寿命で 1 つの FileOAuthProvider を共有する。
  // 初期 auth flow (runOAuthFlow) は proxy 起動時に main() で済ませた前提で、ここでは
  // 共有 provider を transport に渡すだけ。session ごとに provider を作らないことで、
  // state.txt / verifier.txt の同時上書きや、cached token に対する重複 refresh を構造的に避ける。
  if (!sharedOAuthProvider) {
    throw new Error(
      "internal: OAuth backend requires sharedOAuthProvider initialized at proxy startup",
    );
  }
  const t = new StreamableHTTPClientTransport(url, {
    authProvider: sharedOAuthProvider,
    requestInit: { headers: args.headers },
    ...(sharedFetch ? { fetch: sharedFetch } : {}),
  });
  await t.start();
  return t;
}

/**
 * `auth()` の呼び出しを 1 回まで retry 付きで実行する。
 * 永続化された refresh_token 等が server 側で無効化された場合（例:
 * ユーザーが連携を削除した場合）、最初の auth() は token endpoint で
 * `invalid_grant` 系のエラーを返して throw する。その時は永続化された
 * 認証情報を破棄して、新規 DCR + 認可フローでやり直す。
 *
 * callback timeout や network 由来のエラーは credential 起因ではないため、
 * `invalidateCredentials("all")` は呼ばずにそのまま escalate する
 * (攻撃者が callback を吊らせて proxy の保存資格情報を wipe させる経路を遮断)。
 */
async function runOAuthFlow(
  provider: FileOAuthProvider,
  url: URL,
  args: CliArgs,
): Promise<void> {
  const tryAuth = async (): Promise<"AUTHORIZED" | "REDIRECT"> => {
    let result = await auth(provider, { serverUrl: url, scope: args.scope });
    if (result === "REDIRECT") {
      const code = await awaitOAuthCallback({
        name: args.name,
        callbackUrl: args.callbackUrl,
        listenHost: args.callbackListen.hostname,
        listenPort: args.callbackListen.port,
        verifyState: (received) => provider.verifyAndClearState(received),
        timeoutMs: args.callbackTimeoutMs,
      });
      result = await auth(provider, {
        serverUrl: url,
        authorizationCode: code,
        scope: args.scope,
      });
    }
    return result;
  };

  let result: "AUTHORIZED" | "REDIRECT";
  try {
    result = await tryAuth();
  } catch (e) {
    if (!isCredentialError(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[${args.name}] OAuth attempt failed (${message}); ` +
        `invalidating saved credentials and retrying with a fresh authorization`,
    );
    provider.invalidateCredentials("all");
    result = await tryAuth();
  }
  if (result !== "AUTHORIZED") {
    throw new Error(`OAuth authorization failed: ${result}`);
  }
  // 認可が完了した時点で PKCE verifier と state nonce は用済み。残しておくと
  // ディスク上の攻撃面になるだけなので破棄する (refresh で AUTHORIZED に
  // なった場合も前回フローの残骸を掃除する意味で無条件に呼ぶ)。
  provider.invalidateCredentials("verifier");
}

/**
 * 例外が「保存された credential を捨てて再認可すれば直る」種類かを判定する。
 * refresh_token / client_id の失効 (invalid_grant / invalid_client / invalid_token) は
 * credential 起因なので invalidate + retry。callback timeout / network error は
 * credential と無関係なので escalate して proxy を停止させる方が安全。
 */
function isCredentialError(e: unknown): boolean {
  if (e instanceof CallbackTimeoutError) return false;
  if (!(e instanceof Error)) return false;
  return /invalid_grant|invalid_client|invalid_token/.test(e.message);
}

/**
 * 1 つの client session に紐づく状態。backend transport も session 単位で起動・解放するため、
 * front / backend / id rewrite 用の補助 Map と sweep 判定用の counter をここに集約する。
 */
interface SessionState {
  /** SDK が発行した session id。closeSession 等で逆引きできるよう state にも保持する。 */
  id: string;
  front: WebStandardStreamableHTTPServerTransport;
  backend: Transport;
  /**
   * client が出した request の id → method 名。tools/list 応答にだけ filter を
   * 適用するため、応答時に method を引けるよう覚えておく。
   */
  clientRequestMethods: Map<RequestId, string>;
  /**
   * server-initiated request の bidirectional id rewrite 用。backend が出した
   * request id を proxy が独自 id に張り替えて front に流し、client が返してきた
   * response の id を逆引きして元 id で backend に戻す。
   * id は「client の id 空間 (0 始まり連番) と被らない明確な prefix 付き string」に
   * 固定し、client が string id を返してきても衝突しないようにする。
   */
  serverRequestIds: Map<RequestId, RequestId>;
  nextServerRequestSeq: number;
  /** front/backend いずれかからの message が流れた最後の時刻 (ms)。idle sweep の閾値判定に使う。 */
  lastActivityAt: number;
  /**
   * 進行中の client request の数。client が POST した request を backend に流すと ++、
   * backend からその response を front に流すと --。0 でないあいだは sweep の対象外
   * (long-running tool 実行を巻き込むのを避ける)。
   */
  inFlightCount: number;
  /**
   * close 処理が走っているか。closeSession が複数経路 (DELETE / sweep / backend.onclose) から
   * 同時に呼ばれても二重実行しないためのガード。
   */
  closing: boolean;
}

async function main(): Promise<void> {
  const args = parseCli();
  const { hostname, port } = parseListen(args.listen, "--listen");
  const { name } = args;

  const filterActive = isFilterActive(args.filter);
  const isAllowed = compileFilter(args.filter);
  if (filterActive) {
    console.error(
      `[${name}] tool filter active (allow=[${args.filter.allow.join(",")}] deny=[${args.filter.deny.join(",")}])`,
    );
  }

  // OAuth refresh の同時発火を 1 本の HTTP request に集約する fetch wrapper。
  // proxy 全体で 1 つ作って各 session の backend で共有することで、複数 backend transport が
  // 同時に access_token 期限切れを検知しても token endpoint へ飛ぶ POST は 1 回に集約される。
  const sharedOAuthFetch = args.oauthRefreshDedup ? createOAuthRefreshDedupFetch() : undefined;
  if (sharedOAuthFetch) {
    console.error(`[${name}] OAuth refresh dedup is enabled (experimental)`);
  }

  // OAuth backend は proxy 寿命で 1 つの FileOAuthProvider を共有する。proxy 起動時に
  // ここで runOAuthFlow を 1 回だけ駆動して AUTHORIZED まで進めておく。
  //   - 最初の session 起動時に初めて認可 URL が出る UX を避けられる
  //   - 複数 session が同時に立ち上がっても認可 flow が並走しない
  //   - state.txt / verifier.txt 等の short-lived state を 1 経路で書く構造
  // 各 session の startBackend には同じ provider を渡し、StreamableHTTPClientTransport の
  // authProvider として再利用する。
  let sharedOAuthProvider: FileOAuthProvider | undefined;
  if (args.transport === "http" && args.oauth) {
    sharedOAuthProvider = new FileOAuthProvider({
      name: args.name,
      storeDir: args.tokenStore,
      callbackUrl: args.callbackUrl,
      scope: args.scope,
    });
    await runOAuthFlow(sharedOAuthProvider, new URL(args.commandOrUrl), args);
  }

  const sessions = new Map<string, SessionState>();

  /**
   * session を閉じる共通経路。closing フラグで二重実行をガードし、map からの削除 →
   * backend.close → (必要なら) front.close の順で進める。
   *
   * closeFront を分けているのは DELETE 経路の都合: SDK の `handleDeleteRequest` は
   * `onsessionclosed` callback を呼んだ直後に自分で `transport.close()` するため、
   * その文脈でこちらが front.close を呼ぶと二重 close になる。DELETE の場合は false、
   * sweep / backend クラッシュの場合は true で呼ぶ。
   */
  async function closeSession(id: string, reason: string, closeFront: boolean): Promise<void> {
    const state = sessions.get(id);
    if (!state || state.closing) return;
    state.closing = true;
    sessions.delete(id);
    console.error(`[${name}] session closed id=${id} reason=${reason}`);
    try {
      await state.backend.close();
    } catch (e) {
      console.error(`[${name}] backend close failed for ${id}:`, e);
    }
    if (closeFront) {
      try {
        await state.front.close();
      } catch (e) {
        console.error(`[${name}] front close failed for ${id}:`, e);
      }
    }
  }

  /**
   * backend と front を双方向に紐付ける。session の有効期間中ずっと使う。
   *
   * - backend → front:
   *   - client request の response: `relatedRequestId` 付きで送り、SDK が正しい
   *     SSE stream に乗せてくれる。tools/list は filter を適用
   *   - server-initiated request: proxy 内で id を独自 string id に張り替えて front に流す
   *   - server-initiated notification: そのまま front に流す (standalone SSE)
   *
   * - front → backend:
   *   - 普通の client request: そのまま転送 (filter で deny されている tool 呼び出しは
   *     proxy 自身が -32601 で即返答し、backend には流さない)
   *   - server-initiated request への response: 張り替えた id から backend の元 id を
   *     逆引きして戻す
   */
  function wireBackendToFront(state: SessionState): void {
    const { backend, front } = state;

    backend.onmessage = (msg) => {
      state.lastActivityAt = Date.now();
      const id = getMessageId(msg);

      if (id !== undefined && isResponse(msg)) {
        const method = state.clientRequestMethods.get(id);
        state.clientRequestMethods.delete(id);
        if (state.inFlightCount > 0) state.inFlightCount--;
        const outgoing =
          filterActive && method === "tools/list"
            ? filterToolsListResponse(msg, isAllowed)
            : msg;
        void front.send(outgoing, { relatedRequestId: id }).catch((e: unknown) => {
          console.error(`[${name}] front send failed (id=${String(id)}):`, e);
        });
        return;
      }

      if (id !== undefined) {
        const proxyId = `__proxy_si_${String(state.nextServerRequestSeq++)}__`;
        state.serverRequestIds.set(proxyId, id);
        const outgoing = withMessageId(msg, proxyId);
        void front.send(outgoing).catch((e: unknown) => {
          console.error(`[${name}] front send (server-initiated request) failed:`, e);
        });
        return;
      }

      void front.send(msg).catch((e: unknown) => {
        console.error(`[${name}] front send (notification) failed:`, e);
      });
    };

    backend.onerror = (e) => {
      console.error(`[${name}] backend error:`, e);
    };
    backend.onclose = () => {
      void closeSession(state.id, "backend closed", true);
    };

    front.onmessage = (msg) => {
      state.lastActivityAt = Date.now();
      const id = getMessageId(msg);
      const method =
        typeof msg === "object" && msg !== null && "method" in msg
          ? (msg as { method?: unknown }).method
          : undefined;
      const methodStr = typeof method === "string" ? method : undefined;

      // tools/call の pre-check: フィルタで拒否される tool は backend に転送せず、
      // proxy 自身が JSON-RPC error で応答する。
      // - name が string でない (欠落 / array / object 等) → -32602 で fail-closed。
      //   backend に流すと独自 coerce で deny を擦り抜ける余地が残るため、filter
      //   active 時は proxy 側で拒否する。
      // - name が deny にマッチ → -32601 で拒否。
      if (filterActive && id !== undefined && methodStr === "tools/call") {
        const params = (msg as { params?: unknown }).params;
        const toolName =
          typeof params === "object" && params !== null
            ? (params as { name?: unknown }).name
            : undefined;
        if (typeof toolName !== "string") {
          console.error(
            `[${name}] rejected tools/call without string name (id=${String(id)})`,
          );
          void front
            .send(
              invalidParamsError(id, "tools/call params.name must be a string"),
              { relatedRequestId: id },
            )
            .catch((e: unknown) => {
              console.error(`[${name}] front send failed (invalid id=${String(id)}):`, e);
            });
          return;
        }
        if (!isAllowed(toolName)) {
          console.error(`[${name}] denied tools/call: ${toolName} (id=${String(id)})`);
          void front
            .send(methodNotFoundError(id, toolName), { relatedRequestId: id })
            .catch((e: unknown) => {
              console.error(`[${name}] front send failed (denied id=${String(id)}):`, e);
            });
          return;
        }
      }

      if (id !== undefined && isResponse(msg)) {
        // server-initiated request への response。proxy 内 id から backend の元 id に戻す。
        const backendId = state.serverRequestIds.get(id);
        if (backendId !== undefined) {
          state.serverRequestIds.delete(id);
          const outgoing = withMessageId(msg, backendId);
          void backend.send(outgoing).catch((e: unknown) => {
            console.error(`[${name}] backend send (server-response) failed:`, e);
          });
          return;
        }
        console.error(`[${name}] dropping unexpected response from client id=${String(id)}`);
        return;
      }

      // client request (id 付き response でない) または notification。
      // request なら filter 用に method を覚え、inFlight カウンタを上げてから backend に転送する。
      if (id !== undefined && methodStr !== undefined) {
        state.clientRequestMethods.set(id, methodStr);
        state.inFlightCount++;
      }
      void backend.send(msg).catch((e: unknown) => {
        console.error(`[${name}] backend send failed:`, e);
        if (id !== undefined) {
          state.clientRequestMethods.delete(id);
          if (state.inFlightCount > 0) state.inFlightCount--;
        }
      });
    };

    front.onerror = (e) => {
      console.error(`[${name}] front error:`, e);
    };
  }

  const expectedAuth = `Bearer ${args.token}`;

  Bun.serve({
    hostname,
    port,
    async fetch(req) {
      if (!timingSafeStringEqual(req.headers.get("authorization"), expectedAuth)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      const sessionId = req.headers.get("mcp-session-id");
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        // HTTP request が届いた時点で activity を更新する。GET (standalone SSE を開く) は
        // onmessage を経由しないため、ここでもタッチしておかないと standalone SSE 接続中の
        // session が idle 判定されてしまう。
        existing.lastActivityAt = Date.now();
        return existing.front.handleRequest(req);
      }

      // session id 付きなのに proxy 側に session が無い (sweep 済 / proxy 再起動後 等) ケースは
      // spec の `MUST return 404 Not Found` に従う。新規 transport を作って handleRequest に渡すと
      // 「Server not initialized」400 になってしまい、client が再 initialize に進めないため。
      if (sessionId) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Session not found" },
          },
          { status: 404 },
        );
      }

      // 新規 session: initialize POST の想定。SDK が sessionId を発行して
      // onsessioninitialized を呼ぶので、そこで backend を起動して紐付ける。
      const front = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: async (id) => {
          try {
            const backend = await startBackend(args, sharedOAuthFetch, sharedOAuthProvider);
            const state: SessionState = {
              id,
              front,
              backend,
              clientRequestMethods: new Map(),
              serverRequestIds: new Map(),
              nextServerRequestSeq: 0,
              lastActivityAt: Date.now(),
              inFlightCount: 0,
              closing: false,
            };
            wireBackendToFront(state);
            sessions.set(id, state);
            console.error(`[${name}] session opened id=${id}`);
          } catch (e) {
            console.error(`[${name}] failed to start backend for session ${id}:`, e);
            void front.close();
          }
        },
        // DELETE 受信時に SDK 自身が transport.close() を呼ぶため、ここでは closeFront=false で
        // 二重 close を避ける。
        onsessionclosed: async (id) => {
          await closeSession(id, "client DELETE", false);
        },
      });

      await front.start();
      return front.handleRequest(req);
    },
  });

  // idle sweep: 5 秒ごとに「lastActivity から idleTimeoutMs を超え、かつ inFlight な request を
  // 持たない」session を閉じる。closing フラグでガードしているので、新規 request との race で
  // 同じ session を二回閉じる事故は起きない。idleTimeoutMs=0 で無効化。
  const sweepIntervalMs = 5_000;
  const sweepTimer =
    args.sessionIdleTimeoutMs > 0
      ? setInterval(() => {
          const cutoff = Date.now() - args.sessionIdleTimeoutMs;
          for (const [id, state] of sessions) {
            if (state.closing) continue;
            if (state.inFlightCount > 0) continue;
            if (state.lastActivityAt > cutoff) continue;
            void closeSession(id, "idle timeout", true);
          }
        }, sweepIntervalMs)
      : undefined;

  console.error(
    `mcp-proxy [${name}] listening on ${hostname}:${port}/mcp (backend=${args.transport})`,
  );

  // SIGINT/SIGTERM 受信時は全 session の backend.close を最大 SHUTDOWN_TIMEOUT_MS まで
  // 待ってから exit する。Promise.race で timeout 経過時は fallback exit。
  // stdio backend は close で子プロセスに SIGTERM を送るので、await することで orphan の
  // 残留を抑える (docker 側の SIGKILL 猶予に依存しない)。
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${name}] received ${sig}, shutting down (${sessions.size} session(s))`);
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    const closes = [...sessions.values()].map((state) =>
      state.backend.close().catch((e: unknown) => {
        console.error(`[${name}] backend close failed for ${state.id}:`, e);
      }),
    );
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, SHUTDOWN_TIMEOUT_MS),
    );
    const result = await Promise.race([Promise.allSettled(closes).then(() => "done"), timeout]);
    if (result === "timeout") {
      console.error(`[${name}] shutdown timed out after ${String(SHUTDOWN_TIMEOUT_MS)}ms`);
    }
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }
}

// CLI として直接起動された時のみ main() を走らせる。
// test から `import { awaitOAuthCallback } from "../src/index.ts"` のように
// import された場合は副作用 (CLI 引数解析・listen 開始) を発火させない。
if (import.meta.main) {
  void main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
