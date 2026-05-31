// OAuthClientProvider のファイル永続化実装。
// 1 つの mcp-proxy インスタンスに対する token / client 情報 / PKCE verifier を
// `<storeDir>/<name>/` 配下に JSON で保存する。proxy 起動時に 1 つだけ作って、
// 全 session の backend transport で authProvider として共有する前提。
// redirectToAuthorization は標準エラーに認可 URL を出すだけ
// （コンテナ内では xdg-open 等が使えないため、ユーザー側で開く）。

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface FileOAuthProviderOptions {
  /** server 名（mcp-proxy の <name> 引数）。保存ディレクトリ名としても使う。 */
  name: string;
  /** token / client / verifier の保存先ベースディレクトリ。 */
  storeDir: string;
  /**
   * DCR で provider に登録する redirect_uri そのもの。
   * 内部 callback listener はこの URL の pathname で listen し、reverse proxy 経由で
   * path 集約される構成と、loopback 直接公開構成の両方をこの 1 値で表現する。
   */
  callbackUrl: URL;
  /** OAuth scope（DCR 時に渡す）。 */
  scope?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly dir: string;

  constructor(opts: FileOAuthProviderOptions) {
    this.dir = join(opts.storeDir, opts.name);
    // token / verifier / state は秘匿情報。保存ディレクトリは 0o700 で固定する。
    // mkdirSync の mode は umask の影響を受け、かつ既存ディレクトリには効かないため
    // chmodSync を併用して確実に矯正する。
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.redirectUrl = opts.callbackUrl;
    this.clientMetadata = {
      client_name: `mcp-proxy:${opts.name}`,
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(opts.scope ? { scope: opts.scope } : {}),
    };
  }

  private readJson<T>(name: string): T | undefined {
    const p = join(this.dir, name);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * 秘匿ファイルを 0o600 で書く。writeFileSync の `mode` は新規作成時にしか
   * 効かないため、既存ファイルだった場合に備えて chmodSync でも矯正する。
   */
  private writeSecret(name: string, content: string): void {
    const p = join(this.dir, name);
    writeFileSync(p, content, { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  private writeJson(name: string, value: unknown): void {
    this.writeSecret(name, JSON.stringify(value, null, 2));
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>("tokens.json");
  }

  saveTokens(tokens: OAuthTokens): void {
    this.writeJson("tokens.json", tokens);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.readJson<OAuthClientInformationMixed>("client.json");
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.writeJson("client.json", info);
  }

  codeVerifier(): string {
    const p = join(this.dir, "verifier.txt");
    if (!existsSync(p)) {
      throw new Error("code verifier has not been saved yet");
    }
    return readFileSync(p, "utf8");
  }

  saveCodeVerifier(verifier: string): void {
    this.writeSecret("verifier.txt", verifier);
  }

  /**
   * 認可リクエスト発行時に SDK の `auth()` から呼ばれる。新規 nonce を生成し
   * `state.txt` に保存して返す。SDK は返り値を認可 URL の `state` パラメータに
   * 乗せる。callback 受信時に `verifyAndClearState()` で照合する。
   *
   * OAuth 2.1 §4.1.1.5 / §10.12 で CSRF 対策として state は事実上必須。本 proxy では
   * 加えて「callback 経路に偽 code/error を投げ込んで認可フローを破壊する」DoS の
   * 遮断にも使う (state 不一致は callback listener で静かに 400 を返して reject しない)。
   */
  state(): string {
    const nonce = randomBytes(32).toString("base64url");
    this.writeSecret("state.txt", nonce);
    return nonce;
  }

  /**
   * callback で受け取った state を保存済み nonce と timing-safe で比較する。
   * 一致したら state.txt を削除して true、不一致 / 未保存 / 長さ違いは false を返す。
   * 不一致時はファイルを残し、後続の正規 callback がまだ届く余地を保つ。
   */
  verifyAndClearState(received: string): boolean {
    const p = join(this.dir, "state.txt");
    if (!existsSync(p)) return false;
    const saved = readFileSync(p, "utf8");
    const a = Buffer.from(saved, "utf8");
    const b = Buffer.from(received, "utf8");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
    rmSync(p, { force: true });
    return true;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    console.error(
      `\n[mcp-proxy] OAuth authorization required.\n` +
        `Open the following URL in your browser:\n\n` +
        `  ${authorizationUrl.toString()}\n\n` +
        `Waiting for callback at ${this.redirectUrl.toString()} ...\n`,
    );
  }

  /**
   * SDK から呼ばれる credential 破棄。token が失効したり、リフレッシュが
   * `invalid_grant` などで失敗した場合に呼ばれる。proxy 側はファイルを
   * 削除して、次回の auth() で新規 DCR + 認可をやり直せる状態にする。
   */
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const remove = (file: string): void => {
      rmSync(join(this.dir, file), { force: true });
    };
    if (scope === "all") {
      rmSync(this.dir, { recursive: true, force: true });
      // constructor と同じく「token store dir は常に 0o700」の不変条件を維持する。
      // mkdirSync の mode は umask の影響を受けるので chmodSync で確実に矯正する。
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      return;
    }
    if (scope === "tokens") remove("tokens.json");
    if (scope === "client") remove("client.json");
    if (scope === "verifier") {
      remove("verifier.txt");
      // verifier と state は同じ認可フローの一対なので一緒に捨てる。
      remove("state.txt");
    }
    // 'discovery' はファイル化していないので no-op
  }
}
