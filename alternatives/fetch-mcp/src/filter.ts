const ALLOWED_SCHEMES = new Set(["https:"]);

const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
]);

export const HTML_BASES = new Set(["text/html", "application/xhtml+xml"]);

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
  parsed?: URL;
}

export function checkUrl(url: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    const scheme = parsed.protocol.replace(/:$/, "");
    return {
      ok: false,
      reason: `URL scheme is "${scheme}"; only "https" is allowed.`,
    };
  }
  return { ok: true, parsed };
}

export interface ContentTypeCheckResult {
  ok: boolean;
  base?: string;
  reason?: string;
}

export function checkContentType(
  raw: string | null | undefined,
): ContentTypeCheckResult {
  if (!raw) {
    return { ok: false, reason: "Content-Type header is missing." };
  }
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(base)) {
    const allow = [...ALLOWED_CONTENT_TYPES].join(", ");
    return {
      ok: false,
      base,
      reason: `Content-Type "${base}" is not in the allowlist (${allow}).`,
    };
  }
  return { ok: true, base };
}
