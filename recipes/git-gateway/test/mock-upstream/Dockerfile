# test/mock-upstream/: smoke 専用の mock 上流 server。
# production の gateway image (../../gateway/Dockerfile) とは独立した image。
# 同じ base + 同じ apk add だが、production の entrypoint / Caddyfile は持ち込まない。
#
# digest pin は production と同じ image sha を使う (供給源を統一)。
FROM caddy:2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d

# production と同じ最小セット。
RUN apk add --no-cache fcgiwrap git git-daemon ca-certificates

# 静的 Caddyfile。entrypoint は smoke 用の invariant check (PAT 要求 / PAT 禁止) のみを
# /etc/caddy/mock-checks.caddy に書き出す。
COPY Caddyfile.mock /etc/caddy/Caddyfile
RUN mkdir -p /etc/caddy

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
