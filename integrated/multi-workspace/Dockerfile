# syntax=docker/dockerfile:1.7
#
# multi-workspace 統合 image (mcp-proxy + mitm-proxy 2 基本パーツ + git-gateway)。
# - Claude Code と pnpm を build-time にグローバルインストール
# - 起動時に lib/mitm-proxy/bootstrap-ca.sh で mitm.it 経由で CA を取得し OS trust store に統合
# - 各言語ランタイム向けの CA env を配布
#
# 依存解決 (pnpm install) は **runtime に走らせる方針**。
# mitmproxy が registry.npmjs.org への GET を read-only 許可で透過的に通す
# (POST/PUT は 403 で deny) ため runtime install で問題ない。build-time install の
# 代替は alternatives/dependencies-build-time/ で扱う。
# 起動後に devcontainer の postCreateCommand (`pnpm install`) で初期化される。
#
# build context は **リポジトリ root** を期待する (compose.yaml で context: ../..)。
# lib/mitm-proxy/bootstrap-ca.sh を Dockerfile から COPY するため。
# 既存パターン: recipes/cloud-mcp-with-short-lived-credential/compose.yaml も同じ「context: repo root」方式。

# floating tag の差し替えを起点とする shared-infra 侵害を避けるため digest pin。
# 更新は host で `docker pull mcr.microsoft.com/devcontainers/javascript-node:22-trixie` →
# `docker image inspect ... --format '{{index .RepoDigests 0}}'` で digest を取り、本行を置換する。
FROM mcr.microsoft.com/devcontainers/javascript-node:22-trixie@sha256:e3e9ad58dd68386c000354e8f65fa1e66adb452bbb138b7c871c760155eac06d

# javascript-node:22-trixie は buildpack-deps:trixie 系列を base に持つため
# curl / ca-certificates / git / update-ca-certificates / openssh-client は同梱済み。
# 余計な apt-get install を増やさない方針。

# Claude Code と pnpm をグローバルインストール (build-time、runtime 不要)。
# pnpm は corepack 経由ではなく直接 install (corepack の Node 同梱状況の不安定さを回避)。
# version は ./package.json の packageManager と揃える。
ARG PNPM_VERSION=10.33.2
RUN npm install -g @anthropic-ai/claude-code pnpm@${PNPM_VERSION}

# OS trust store を読まない言語ランタイム向けの env (lib/mitm-proxy/Dockerfile.workspace と同一)。
# update-ca-certificates 適用後の結合 bundle を指す。
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/mitmproxy.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

# bootstrap-ca.sh が CA install 完了後に setpriv で drop する非 root user。
# javascript-node base は node user (uid 1000) を持つ。bootstrap-ca.sh は default を持たず
# 未指定で起動拒否する設計のため、recipe 側で必ず明示する (lib/mitm-proxy/bootstrap-ca.sh 参照)。
ENV WORKLOAD_USER=node

# 起動時 CA bootstrap (lib/mitm-proxy/ から流用)。
# ENTRYPOINT で動かして、CA 取得失敗時は fail-closed で workspace を起動させない。
COPY lib/mitm-proxy/bootstrap-ca.sh /usr/local/bin/bootstrap-ca.sh
RUN chmod +x /usr/local/bin/bootstrap-ca.sh

# github.com への git transport (fetch / push / clone) を shared-infra の git-gateway 経由に強制。
# system-wide gitconfig で url.insteadOf を仕込む (workspace ユーザの gitconfig 上書きでは
# 解除できないように /etc/gitconfig に置く + internal network により github.com への
# 直 egress も塞がれる多段防御)。詳細は recipes/git-gateway/README.md。
COPY integrated/multi-workspace/workspace-gitconfig /etc/gitconfig

WORKDIR /workspace

# devcontainer の remoteUser=node (uid=1000) で attach されるため、named volume 系の
# mount point を image に node 所有で先回り作成しておく。
# named volume が空のとき、Docker は image 内の同 path の owner / permission を引き継いで初期化する。
# 対象:
#   - /pnpm-store          : pnpm の content-addressable store (compose.yaml の workspace_pnpm_store)
#   - /workspace/node_modules : 依存解決結果 (compose.yaml の workspace_node_modules)
#   - /home/node/.claude   : Claude Code の config / 認証情報 (host bind mount だが念のため)
RUN mkdir -p /pnpm-store /workspace/node_modules /home/node/.claude && \
    chown -R node:node /pnpm-store /workspace/node_modules /home/node/.claude

ENTRYPOINT ["/usr/local/bin/bootstrap-ca.sh"]
CMD ["sleep", "infinity"]
