# recipes/ingress-single-workspace/ — devcontainer 内の開発サーバをホストブラウザに公開

作業コンテナ内の開発サーバ (`:3000` 等) をホストブラウザから見るためのリバースプロキシ (Caddy) 構成。

設計は docs 側で扱う:

- [docs/09-ingress.md](../../docs/09-ingress.md)

## 使い方

### 初期設定

```sh
cp .env.example .env
# 並列起動するなら HOST_PORT をプロジェクトごとに変える
```

### smoke test (ホストから実行)

```sh
./test/smoke.sh
```

4 ケース (ルーティング / ポート付き Host のマッチ / 404 フォールスルー) を通す。

### devcontainer として起動

VS Code / Cursor で開いて「Reopen in Container」。

開発サーバは `0.0.0.0` で listen させる:

```sh
python3 -m http.server 3000
# next dev / vite 等は --host 0.0.0.0
```

ホストブラウザから `http://app.localhost:8080/` でアクセスする。

### `Host` のマッピングを追加する

`ingress/Caddyfile` に handle ブロックを追加して `docker compose restart ingress`。

### 並列で複数 devcontainer を起動する

各プロジェクトの `.env` で `HOST_PORT` を別々の値にする。1 つのホストポートに集約したい場合は `recipes/ingress-multi-workspace/` を使う。

## 実装の罠

### `*.localhost` の解決

ホスト側で `app.localhost` が `127.0.0.1` に解決される必要がある。

- **ブラウザ (Chrome / Firefox / Safari)**: RFC 6761 §6.3 でループバックに固定されるため設定不要
- **macOS の CLI (curl, dig 等)**: `*.localhost` を解決しない。`--resolve` か `/etc/hosts` 追記が必要
- **Linux glibc**: `myhostname` / `files` でループバックに向ける設定が一般的

ブラウザで開発サーバを見る用途では問題にならない。
