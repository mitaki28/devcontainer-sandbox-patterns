# recipes/cloud-mcp-with-short-lived-credential/ — Google Cloud MCP を短寿命トークンで運用

`gcloud-mcp` を `mcp-proxy` 経由で使うレシピ。ホスト側で専用 SA に impersonate して 1h 寿命のアクセストークンを発行し、プロキシはそのトークンファイルだけを ro mount する。作業コンテナは gcloud CLI も認証情報も持たない。

設計は docs 側で扱う:

- [docs/06-cloud-mcp.md](../../docs/06-cloud-mcp.md)

## 前提: 専用サービスアカウントの用意

### 1. SA 作成と最小権限の付与

```sh
PROJECT=your-project-id
SA=claude-sandbox

gcloud iam service-accounts create "$SA" \
  --project="$PROJECT" \
  --display-name="Claude Code sandbox"
```

最小権限で始める。例えば Artifact Registry の閲覧だけ:

```sh
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

smoke には `roles/artifactregistry.reader` が必要。

必要に応じて追加:

```sh
# Cloud Logging の閲覧
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/logging.viewer"

# 特定バケットのオブジェクトだけ書ける
gcloud storage buckets add-iam-policy-binding gs://my-sandbox-bucket \
  --member="serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"
```

### 2. impersonate を許可

```sh
USER=you@example.com

gcloud iam service-accounts add-iam-policy-binding \
  "${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --member="user:${USER}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

### 3. ホスト側で ADC を確立

```sh
gcloud auth application-default login
```

### 4. env ファイルを配置

```sh
mkdir -p ~/.config/devsbx
cp recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める
```

## 使い方

### 1. 初回のトークン発行

```sh
./refresh-token.sh
```

`~/.cache/devsbx/gcp-mcp/token` に SA のアクセストークンが書き出される (1h 寿命)。

### 2. smoke で疎通確認

```sh
docker compose run --rm --build smoke
```

4 ケース (サーバ識別 / `tools/list` / トークンファイル到達 / Artifact Registry 一覧取得) を通す。

### 3. devcontainer として起動

VS Code / Cursor で開いて「Reopen in Container」。

```sh
env | grep -i google      # 何も出ないこと
which gcloud              # 見つからないこと
```

### 4. 自動更新 (任意)

1h 寿命なので、長時間使う場合は 50 分間隔で `./refresh-token.sh` を回す。期限切れになると `tools/call` が 401 になるので、手動で叩けば復旧する。
