import { checkContentType, HTML_BASES } from "./filter.ts";
import { htmlToMarkdown } from "./sanitize.ts";

const HTTP_TIMEOUT_MS = 30_000;

export interface FetchSuccess {
  status: number;
  location: string | null;
  content_type: string | null;
  original_size: number | null;
  truncated: boolean;
  body: string;
}

export interface FetchFailure {
  kind: "filter" | "network";
  reason: string;
}

export type FetchOutcome = FetchSuccess | FetchFailure;

/**
 * URL を fetch し、必要なら HTML を Markdown に変換して返す。
 * URL の scheme チェック（https only）は呼び出し側で行う前提。
 * redirect は追従しない（3xx をそのまま返す）。
 */
export async function fetchAndProcess(
  url: string,
  maxBytes: number,
): Promise<FetchOutcome> {
  let resp: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    resp = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err: unknown) {
    return {
      kind: "network",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const status = resp.status;
  const contentTypeRaw = resp.headers.get("content-type");
  const location = resp.headers.get("location");

  // 3xx redirect: 追従しない、本文も読まない
  if (status >= 300 && status < 400) {
    await resp.body?.cancel().catch(() => {});
    return {
      status,
      location,
      content_type: contentTypeRaw,
      original_size: null,
      truncated: false,
      body: "",
    };
  }

  // 4xx / 5xx: 本文は読まない（noise 削減）
  if (status >= 400) {
    await resp.body?.cancel().catch(() => {});
    return {
      status,
      location: null,
      content_type: contentTypeRaw,
      original_size: null,
      truncated: false,
      body: "",
    };
  }

  // 2xx: Content-Type チェック
  const ctCheck = checkContentType(contentTypeRaw);
  if (!ctCheck.ok) {
    await resp.body?.cancel().catch(() => {});
    return { kind: "filter", reason: ctCheck.reason ?? "Content-Type rejected" };
  }

  // 本文を max_bytes まで読む
  const reader = resp.body?.getReader();
  if (!reader) {
    return {
      status,
      location: null,
      content_type: contentTypeRaw,
      original_size: 0,
      truncated: false,
      body: "",
    };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > maxBytes) {
      const remain = maxBytes - received;
      if (remain > 0) {
        chunks.push(value.slice(0, remain));
        received = maxBytes;
      }
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }

  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);

  let body = text;
  if (ctCheck.base !== undefined && HTML_BASES.has(ctCheck.base)) {
    body = htmlToMarkdown(text);
  }

  return {
    status,
    location: null,
    content_type: contentTypeRaw,
    original_size: received,
    truncated,
    body,
  };
}
