// isRefreshTokenRequest の判定ロジックの純粋ユニットテスト。
// dedup fetch wrapper は backend への全 HTTP request を通るため、MCP 本体の JSON request を
// refresh_token grant と誤判定しないこと (Content-Type で除外できること) を確認する。

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { isRefreshTokenRequest } from "../../src/index.ts";

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

describe("isRefreshTokenRequest", () => {
  test("URLSearchParams body の refresh_token grant を検出する", () => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x" });
    assert.equal(isRefreshTokenRequest({ body }), true);
  });

  test("URLSearchParams body の authorization_code grant は false", () => {
    const body = new URLSearchParams({ grant_type: "authorization_code", code: "x" });
    assert.equal(isRefreshTokenRequest({ body }), false);
  });

  test("form-urlencoded の string body の refresh_token grant を検出する", () => {
    assert.equal(
      isRefreshTokenRequest({ body: "grant_type=refresh_token&refresh_token=x", headers: FORM }),
      true,
    );
  });

  test("MCP の JSON request body は refresh と誤判定しない (Content-Type が JSON)", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { q: "x&grant_type=refresh_token&y=1" } },
    });
    assert.equal(
      isRefreshTokenRequest({ body, headers: { "Content-Type": "application/json" } }),
      false,
    );
  });

  test("Content-Type 無しの string body は refresh と誤判定しない", () => {
    // form-urlencoded として解釈可能でも、Content-Type が無ければ token request ではない。
    assert.equal(isRefreshTokenRequest({ body: "grant_type=refresh_token" }), false);
  });

  test("Content-Type が charset 付き / 大文字でも form-urlencoded を検出する", () => {
    assert.equal(
      isRefreshTokenRequest({
        body: "grant_type=refresh_token",
        headers: { "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" },
      }),
      true,
    );
  });

  test("Headers インスタンス / 配列形態の headers でも判定できる", () => {
    assert.equal(
      isRefreshTokenRequest({
        body: "grant_type=refresh_token",
        headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      }),
      true,
    );
    assert.equal(
      isRefreshTokenRequest({
        body: "grant_type=refresh_token",
        headers: [["content-type", "application/x-www-form-urlencoded"]],
      }),
      true,
    );
  });

  test("body 無し / 非対象の body 型は false", () => {
    assert.equal(isRefreshTokenRequest(undefined), false);
    assert.equal(isRefreshTokenRequest({}), false);
  });
});
