# fetch-mcp を node ランタイム上で動かす単一 image。
# compose.yaml の build context として参照される。

# base image は floating tag による差し替えを避けるため digest pin。
# 更新は host で `docker pull node:22-slim` →
# `docker image inspect node:22-slim --format '{{index .RepoDigests 0}}'` で digest を取り置換する。
FROM node:22-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732

WORKDIR /app

# corepack で package.json の `packageManager` に固定された pnpm バージョンを起動する。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8000
ENTRYPOINT ["node", "src/index.ts"]
