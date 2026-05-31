// FileOAuthProvider の state ライフサイクルを docker 不要で検証する。
// `bun test test/unit/oauth.test.ts` で単独実行可能。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileOAuthProvider } from "../../src/oauth.ts";

describe("FileOAuthProvider state", () => {
  let storeDir: string;
  let provider: FileOAuthProvider;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mcp-proxy-oauth-"));
    provider = new FileOAuthProvider({
      name: "test",
      storeDir,
      callbackUrl: new URL("http://localhost:3030/callback"),
    });
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  test("state() は十分な entropy を持つ unique な nonce を返す", () => {
    const a = provider.state();
    const b = provider.state();
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url ≒ 43 chars
    expect(a).not.toBe(b);
  });

  test("state() は state.txt に保存される (mode 0o600)", () => {
    const nonce = provider.state();
    const p = join(storeDir, "test", "state.txt");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(nonce);
  });

  test("verifyAndClearState は一致時に true を返し、ファイルを削除する", () => {
    const nonce = provider.state();
    expect(provider.verifyAndClearState(nonce)).toBe(true);
    expect(existsSync(join(storeDir, "test", "state.txt"))).toBe(false);
    // 2 回目は false (既に消えている)
    expect(provider.verifyAndClearState(nonce)).toBe(false);
  });

  test("verifyAndClearState は不一致時に false を返し、ファイルは残る", () => {
    const nonce = provider.state();
    expect(provider.verifyAndClearState("wrong-state")).toBe(false);
    expect(existsSync(join(storeDir, "test", "state.txt"))).toBe(true);
    // 後続の正規 callback は変わらず通る
    expect(provider.verifyAndClearState(nonce)).toBe(true);
  });

  test("verifyAndClearState は state 未生成時に false を返す", () => {
    expect(provider.verifyAndClearState("anything")).toBe(false);
  });

  test("verifyAndClearState は長さ違いを timing-safe に弾く", () => {
    provider.state();
    // 同じ prefix だが短い文字列 → timingSafeEqual の length check で false
    expect(provider.verifyAndClearState("short")).toBe(false);
    expect(existsSync(join(storeDir, "test", "state.txt"))).toBe(true);
  });

  test("invalidateCredentials('verifier') は state も一緒に捨てる", () => {
    provider.state();
    provider.saveCodeVerifier("verifier-xyz");
    provider.invalidateCredentials("verifier");
    expect(existsSync(join(storeDir, "test", "state.txt"))).toBe(false);
    expect(existsSync(join(storeDir, "test", "verifier.txt"))).toBe(false);
  });

  test("invalidateCredentials('all') は state を含む全ファイルを wipe", () => {
    provider.state();
    provider.saveCodeVerifier("verifier-xyz");
    provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    provider.invalidateCredentials("all");
    expect(existsSync(join(storeDir, "test", "state.txt"))).toBe(false);
    expect(existsSync(join(storeDir, "test", "verifier.txt"))).toBe(false);
    expect(existsSync(join(storeDir, "test", "tokens.json"))).toBe(false);
  });
});

describe("FileOAuthProvider file permissions", () => {
  let storeDir: string;
  let provider: FileOAuthProvider;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mcp-proxy-oauth-"));
    provider = new FileOAuthProvider({
      name: "test",
      storeDir,
      callbackUrl: new URL("http://localhost:3030/callback"),
    });
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  test("token store の dir は 0o700、秘匿ファイルは 0o600", () => {
    provider.state();
    provider.saveCodeVerifier("v");
    provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    provider.saveClientInformation({ client_id: "c", redirect_uris: [] });
    expect(statSync(join(storeDir, "test")).mode & 0o777).toBe(0o700);
    for (const f of ["state.txt", "verifier.txt", "tokens.json", "client.json"]) {
      expect(statSync(join(storeDir, "test", f)).mode & 0o777).toBe(0o600);
    }
  });

  test("既存ディレクトリの緩い mode も constructor で 0o700 に矯正される", () => {
    // beforeEach の provider が作った dir を消し、0o755 で作り直してから
    // provider を再生成する。
    const looseDir = join(storeDir, "test");
    rmSync(looseDir, { recursive: true, force: true });
    mkdirSync(looseDir, { recursive: true, mode: 0o755 });
    new FileOAuthProvider({
      name: "test",
      storeDir,
      callbackUrl: new URL("http://localhost:3030/callback"),
    });
    expect(statSync(looseDir).mode & 0o777).toBe(0o700);
  });

  test("既存ファイルの緩い mode も writeSecret で 0o600 に矯正される", () => {
    const p = join(storeDir, "test", "tokens.json");
    writeFileSync(p, "{}", { mode: 0o644 });
    expect(statSync(p).mode & 0o777).toBe(0o644);
    provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("invalidateCredentials('all') 後も dir は 0o700 を維持する", () => {
    // wipe 前に何か書いておく (保存対象があった状態を再現)
    provider.saveTokens({ access_token: "a", token_type: "Bearer" });
    provider.invalidateCredentials("all");
    // wipe 直後の dir が緩い mode (e.g. 0o755) で再生成されると、その後
    // saveTokens で書く tokens.json は 0o600 でも、dir の閲覧権が他ユーザーに
    // 開いてしまう。constructor の不変条件 (dir 0o700) を維持していることを確認。
    expect(statSync(join(storeDir, "test")).mode & 0o777).toBe(0o700);
    // 再書き込みも変わらず 0o600 になる
    provider.saveTokens({ access_token: "b", token_type: "Bearer" });
    expect(statSync(join(storeDir, "test", "tokens.json")).mode & 0o777).toBe(0o600);
  });
});
