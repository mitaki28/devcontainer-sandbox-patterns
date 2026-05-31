# syntax=docker/dockerfile:1.7

FROM node:lts@sha256:e9891237dfbb1de60ce19e9ff9fac5d73ad9c37da303ad72ff2a425ad1057e71

# pnpm を Dockerfile で直接 install。
# corepack の Node 同梱は Node 25+ で外れる議論があり不安定なのと、
# 初回利用時の download 確認 prompt を避けるため、corepack に依存させない。
# version は workspace/package.json の packageManager と揃えること。
# 本 image には source code / node_modules を焼かない。起動時に compose.yaml 側で
# package.json と pnpm-lock.yaml をフルマウントし、`pnpm add` / `pnpm update` の
# 実行体として使う想定。
ARG PNPM_VERSION=10.33.2
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /work

CMD ["pnpm", "--help"]
