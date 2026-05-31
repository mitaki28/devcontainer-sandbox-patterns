# syntax=docker/dockerfile:1.7

FROM node:lts@sha256:e9891237dfbb1de60ce19e9ff9fac5d73ad9c37da303ad72ff2a425ad1057e71

# pnpm を Dockerfile で直接 install。
# corepack の Node 同梱は Node 25+ で外れる議論があり不安定なのと、
# 初回利用時の download 確認 prompt を避けるため、corepack に依存させない。
# version は package.json の packageManager と揃えること。
ARG PNPM_VERSION=10.33.2
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /workspace

# 依存定義のみ先に COPY して layer cache を効かせる。
# build context は alternatives/dependencies-build-time/ の直下。
COPY package.json pnpm-lock.yaml ./

# build-time に依存解決して node_modules を image に焼き込む。
# --frozen-lockfile で lockfile と package.json の整合を強制する。
RUN pnpm install --frozen-lockfile

# 実行時の bind mount は compose.yaml 側で `.:/workspace` を当てる。
# /workspace/node_modules は named volume で保護することで、bind mount 経由の
# host 側空ディレクトリで上書きされないようにする (compose.yaml 参照)。

CMD ["sleep", "infinity"]
