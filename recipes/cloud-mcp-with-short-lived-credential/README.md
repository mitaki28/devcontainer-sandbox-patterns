# recipes/cloud-mcp-with-short-lived-credential/ — Google Cloud MCP を短寿命のトークンで隔離

公式 [`gcloud-mcp`](https://github.com/googleapis/gcloud-mcp) を [`mcp-proxy`](../../lib/mcp-proxy/) 経由で streamable-HTTP として公開するレシピ。ホスト側で個人 ADC を **sandbox SA に impersonate** して 1 時間寿命のアクセストークンをファイル化し、プロキシはそのファイルだけを ro mount する。devcontainer は gcloud CLI も認証情報も持たず、HTTP MCP として接続するだけ。

設計上の動機・原則 (sandbox SA + impersonation / 認証情報の寿命に上限を設ける / 単純な ADC 直マウントを採用しない理由) は docs 側で扱う:

- [docs/06-cloud-mcp.md](../../docs/06-cloud-mcp.md) — クラウドの認証情報固有のリスクと本レシピの設計

本 README はレシピの利用手順とサプライチェーン緩和に集中する。

## 共通の前提: sandbox SA の用意

impersonate 先となる **sandbox SA** を事前に GCP 側で作っておく必要がある。

### 1. SA 作成と最小権限の付与

```sh
PROJECT=your-project-id
SA=claude-sandbox

gcloud iam service-accounts create "$SA" \
  --project="$PROJECT" \
  --display-name="Claude Code sandbox"
```

**最初は触れる API を 1 個に絞った最小起点で始める** ことを推奨する。例えば Artifact Registry の閲覧だけ許可:

```sh
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

> **smoke の前提**: 本レシピの smoke は実 GCP API 呼び出しに `gcloud artifacts repositories list` を使うため、sandbox SA に少なくとも `roles/artifactregistry.reader` が付いている必要がある。理想は「認証だけで叩ける API」(`cloudresourcemanager.testIamPermissions` のような no-permission-required API) を使うことだが、gcloud CLI には対応サブコマンドが無く、実用上の妥協として `artifactregistry.reader` を smoke 前提に置いている。

実際に AI エージェントに作業を任せる中で「これも触りたい」が出てきたら、その都度 **特定サービスの reader / 特定リソースの書き込み** を最小単位で追加する:

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

> **絶対に付けないロール**: `roles/owner`, `roles/editor`, `roles/viewer`, `roles/iam.*`, `roles/billing.*`, `roles/run.admin`, `roles/cloudfunctions.admin`, `roles/storage.admin`, `roles/cloudbuild.builds.editor` などの全権・デプロイ・高権限系。`roles/viewer` は一見安全だが「全 read」を一括で付けるため、最小化の議論が飛ばされる原因になる。サービス単位の reader を積み上げる方が後から削りやすい。

### 2. impersonate を許可

開発者個人アカウントから sandbox SA への impersonation を許可する。

```sh
USER=you@example.com

gcloud iam service-accounts add-iam-policy-binding \
  "${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --member="user:${USER}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

> **注意**: 個人アカウント側に他の高権限 SA への `tokenCreator` を付けないこと。付けると AI エージェントから (gcloud CLI 経由ではなく) 直接 `iamcredentials.generateAccessToken` を呼ばれて横展開される余地が生まれる。

### 3. ホスト側で個人アカウントの ADC を確立

```sh
gcloud auth application-default login
```

これで `~/.config/gcloud/application_default_credentials.json` にリフレッシュトークンが保存される。**この ADC はホストから外に出ない** (コンテナにはバインドマウントしない)。

### 4. 共通の env ファイルを配置

```sh
mkdir -p ~/.config/devsbx
cp recipes/cloud-mcp-with-short-lived-credential/.env.example ~/.config/devsbx/gcp-mcp.env
chmod 600 ~/.config/devsbx/gcp-mcp.env
# 編集して GOOGLE_CLOUD_PROJECT / CLOUDSDK_CORE_PROJECT / IMPERSONATE_SERVICE_ACCOUNT を埋める
```

## 構成

```
recipes/cloud-mcp-with-short-lived-credential/
├── compose.yaml              # proxy + smoke + workspace (refresher は持たない)
├── refresh-token.sh          # ホスト側で実行する SA トークンのリフレッシュ
├── Dockerfile.gcloud-mcp     # gcp-mcp プロキシイメージ (gcr.io 経由の google-cloud-cli:slim + Node + mcp-proxy ソース + gcloud-mcp)
├── package.json              # gcloud-mcp のバージョンピン
├── pnpm-lock.yaml            # 推移依存のピン
├── pnpm-workspace.yaml       # minimumReleaseAge / blockExoticSubdeps (pnpm install のサプライチェーン対策)
├── .env.example
├── .mcp.json
├── .devcontainer/devcontainer.json
└── test/smoke.test.ts

# ホスト側に置くもの:
${HOME}/.config/gcloud/                                           # 個人アカウントの ADC
${HOME}/.config/devsbx/gcp-mcp.env            # project / impersonate 先
${HOME}/.cache/devsbx/gcp-mcp/token           # SA の短寿命なアクセストークン
```

## 使い方

### 1. 共通の前提を済ませる

上記の「共通の前提: sandbox SA の用意」に従って sandbox SA を作成し、impersonation を許可し、`gcp-mcp.env` が配置されていること。

加えて、プロキシへの接続認証用の Bearer (`PROXY_TOKEN`) を発行する:

```sh
mkdir -p ~/.config/devsbx
printf 'PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/devsbx/mcp-proxy.env
chmod 600 ~/.config/devsbx/mcp-proxy.env
```

`PROXY_TOKEN` は全 mcp-* プロキシと作業コンテナで共有する 1 値 (`lib/mcp-proxy/README.md` 参照)。

### 2. 初回のトークン発行

```sh
./refresh-token.sh
```

`${HOME}/.cache/devsbx/gcp-mcp/token` に SA のアクセストークンが書き出される (既定 1 時間寿命)。compose.yaml のバインドマウントは `create_host_path: false` なので、未実行で `docker compose up` すると即座に検知して止まる。

### 3. smoke で疎通確認

```sh
docker compose run --rm --build smoke
```

期待結果 (4 観点):

- サーバが `gcloud-mcp` として識別される
- `tools/list` が非空の gcloud ツール群を返す
- `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` がバックエンドの `gcloud config` まで届いている
- `gcloud` 経由で Artifact Registry のリポジトリ一覧が取れる (認証チェーン全体が機能)

最後の 2 本で、`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` がコンテナの環境変数 → `--pass-env` → バックエンド (gcloud-mcp) → gcloud config まで届いていることと、`refresh-token.sh` が出した SA の短寿命トークンを使って実 API が叩けることを確認する。`./refresh-token.sh` が成功していれば SA トークンが有効、smoke の artifactregistry list は読み取り専用なので副作用・課金影響は実用上ほぼ無い。

> `mcp-proxy` は stdio バックエンドにプロキシの環境変数を丸ごとは渡さない。GCP 系の必要な環境変数 (`GOOGLE_CLOUD_PROJECT` / `CLOUDSDK_CORE_PROJECT` / `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`) のみ `--pass-env` で明示的に通している。`PROXY_TOKEN` や `IMPERSONATE_SERVICE_ACCOUNT` はバックエンド (gcloud-mcp) に渡らないため、バックエンドがサプライチェーンで汚染されてもプロキシ内の他の秘匿情報は抜き取られない。詳細は [`../../lib/mcp-proxy/README.md`](../../lib/mcp-proxy/README.md) の「stdio バックエンドへの env 受け渡し」節参照。

### 4. devcontainer として起動

VS Code / Cursor で `recipes/cloud-mcp-with-short-lived-credential/` を開き「Reopen in Container」。`.devcontainer/devcontainer.json` が `compose.yaml` の `workspace` サービスを起動し、`proxy` も連動起動する。

devcontainer 内ターミナルでの最低確認:

```sh
env | grep -i google      # 何も出ないこと
env | grep -i gcloud      # 何も出ないこと
which gcloud              # 見つからないこと
env | grep PROXY_TOKEN    # PROXY_TOKEN=... が 1 行出ること (プロキシ接続に必要)

curl -s -X POST \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  http://proxy:8000/mcp
```

`event: message` の中に gcloud 系の `serverInfo` が返れば成功。

### 5. 自動更新 (任意)

寿命 1h なので、長時間使う場合は 50 分間隔程度で `refresh-token.sh` を回す。具体的なスケジューラは強制せず、利用者の OS / 好みで選ぶ:

- **macOS (launchd)**: `~/Library/LaunchAgents/dev.local.gcp-mcp-refresh.plist` を作って `StartInterval=3000` にする。`launchctl load -w` で常駐化
- **Linux (systemd timer)**: `~/.config/systemd/user/gcp-mcp-refresh.{service,timer}` を作り `OnUnitActiveSec=50min` で常駐化 (`systemctl --user enable --now ...`)
- **簡易 (crontab)**: `*/50 * * * * /path/to/refresh-token.sh >> ~/.cache/...gcp-mcp-refresh.log 2>&1`。cron の PATH に gcloud が含まれていない場合があるので、絶対パスで叩くのが安全

トークンの期限が切れると `tools/call` 経由の GCP API 呼び出しが 401 になるため、即座に検知できる。気づいた時点で `./refresh-token.sh` を手動で叩けば即復旧する。

## サプライチェーン緩和

`gcloud-mcp` は impersonation 経路で発行された短寿命なトークンを持つコンテナ内で動くため、悪意のあるバージョンを pull した場合の被害 (トークン流出 ≦ 50min 寿命) に備えて Dockerfile レベルで以下を強制:

- **バージョンピン**: [`package.json`](./package.json) で `@google-cloud/gcloud-mcp` を厳密にピン
- **lockfile ピン**: [`pnpm-lock.yaml`](./pnpm-lock.yaml) で推移依存も完全にピン。ビルドは `pnpm install --frozen-lockfile` で行い、AI エージェントがバージョンを勝手にずらせない
- **minimumReleaseAge=10080**: 公開から 7 日経っていないバージョンは install できない (バージョン更新作業時の補助防御。[`./pnpm-workspace.yaml`](./pnpm-workspace.yaml) で推移依存含めて適用)
- **blockExoticSubdeps=true**: 推移依存が git: / file: 経由でレジストリ外から引っ張るのを禁止
- **ビルド時インストール**: 実行時は `pnpm exec gcloud-mcp` でローカルの node_modules から直起動。レジストリへの実行時ネット出し不要。`pnpm dlx` を実行時に使うと dlx 専用キャッシュの状態次第でネットワーク取得が走る場合があり、採用しない

バージョン更新時は (1) npm 上の公開日が 7 日以上前であることを確認、(2) `package.json` のバージョンを更新、(3) コンテナ内で `pnpm install` を実行して `pnpm-lock.yaml` を再生成、(4) 差分をコミット、の順で行う。手元に pnpm が無くても以下で生成できる:

```sh
docker run --rm -v "$PWD/recipes/cloud-mcp-with-short-lived-credential:/work" -w /work \
  --entrypoint pnpm gcp-mcp-proxy:dev install --lockfile-only
```

## 残存リスク (漏れる余地)

1. **トークンの寿命中にプロキシが侵害されると、寿命残分の SA 操作が漏れる**: 影響範囲は sandbox SA の IAM スコープに閉じる。50 分のリフレッシュ周期だと最悪寿命 1h 弱 (アクセストークンは 1h、リフレッシュは 50 分後)
2. **`refresh-token.sh` を回し忘れると寿命切れで API 呼び出しが 401**: 即座に検知できる (黙って古いトークンを使い続けることはない)。自動化 (cron / timer) を使うか、devcontainer 起動フックで都度実行する運用が現実的
3. **ホスト側の `~/.cache/devsbx/gcp-mcp/token` が他プロセスから読める可能性**: `chmod 700 dir / 600 file` をスクリプト内で適用しているが、ホストが侵害されれば突破される。本レシピは「ホストは信頼できる、コンテナはしない」を信頼の前提として置く
4. **`refresh-token.sh` はホスト側 gcloud CLI に依存**: gcloud SDK が無い環境向けの派生は本レシピでは扱わない (シンプル優先)
5. **gcloud-mcp の API surface に乗っていない GCP API は触れない**: これが本レシピの「読み取り中心」の根拠でもある (surface が狭い = 安全)。副作用: `terraform apply` のような IaC 操作はこのレシピでは不可
6. **gcloud-mcp 側のバグで「読み取りのつもりが書き込んだ」可能性**: sandbox SA に書き込み権限を付けない限り IAM 段で止まる (多層防御)
7. **gcloud-mcp の上流のツール名が増減すればプロキシ側の deny フィルタが黙って効かなくなる**: smoke で `tools/list` の現状と整合を監視
8. **クラウド側の課金は IAM の許可範囲なら止まらない**: 重課金 API (BigQuery 大量 query 等) は budget alert / quota 制御を併用する。本リポジトリでは budget / quota 設定までは扱わない

## 関連

- [`../../lib/mcp-proxy/`](../../lib/mcp-proxy/) — このレシピが使う mcp-proxy 本体 (Bearer 認証 / `--pass-env` 機構 / OAuth フロー等の実装詳細)
- [`../../lib/mcp-proxy/examples/api-key/`](../../lib/mcp-proxy/examples/api-key/) — 同じ「MCP バックエンドをプロキシ経由で作業コンテナから隔離」の API キー版 (GitHub MCP)
- [gcloud-mcp (googleapis/gcloud-mcp)](https://github.com/googleapis/gcloud-mcp) — 本レシピが薄くラップしている MCP サーバ
