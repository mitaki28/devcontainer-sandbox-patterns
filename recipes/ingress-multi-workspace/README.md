# recipes/ingress-multi-workspace/ — 共有リバースプロキシの単体検証

並列の作業コンテナを `<task>.devsbx.localhost:8080` で振り分けるリバースプロキシ (Caddy) の単体検証用レシピ。`integrated/multi-workspace/` から切り出したもので、独立利用は想定していない。

設計は docs 側で扱う:

- [docs/09-ingress.md](../../docs/09-ingress.md)

## 使い方

### smoke test (ホストから実行)

```sh
./test/smoke.sh
```

8 ケース (ルーティング / ポート振り分け / 404 フォールスルー / 停止時 502 / 再起動時の自動復帰 等) を通す。

### 手動起動

```sh
# 1. ingress を起動
docker compose -f ingress/compose.yaml -p shared-ingress-test up -d --build

# 2. workspace を並列起動
docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml \
  -p task-a up -d
docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml \
  -p task-b up -d

# 3. 確認
curl -H 'Host: task-a.devsbx.localhost' http://127.0.0.1:8080/index.html

# 4. クリーンアップ
docker compose -f workspace/compose.yaml -p task-a down
docker compose -f workspace/compose.yaml -p task-b down
docker compose -f ingress/compose.yaml -p shared-ingress-test down
```

## 実装の罠

### Caddy v2 に `host_regexp` マッチャは無い

`host_regexp` は存在しない (module not registered で起動失敗する)。`Host` ヘッダから正規表現キャプチャを取るには `header_regexp` を使う:

```caddy
@task header_regexp host Host ^(?P<name>[a-z0-9-]+)\.devsbx\.localhost(?::\d+)?$
handle @task {
    reverse_proxy {re.host.name}-workspace:3000
}
```

### `header_regexp` はポートを除去しない

`host` マッチャと違い、`header_regexp` は `Host` ヘッダをそのまま取る。ブラウザは `Host: task-a.devsbx.localhost:8080` とポート込みで送るので、正規表現末尾に `(?::\d+)?` が要る。これが無いとブラウザからだけ 404 になる。

### 作業コンテナのネットワークエイリアス

per-task compose で `${COMPOSE_PROJECT_NAME}-workspace` をネットワークエイリアスに設定すると、Docker DNS 経由でリバースプロキシから到達できる。作業コンテナの起動 / 停止は DNS の追加 / 削除で完結するため、リバースプロキシのリロードは不要。
