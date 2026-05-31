# 更新は host で `docker pull caddy:2-alpine` → `docker image inspect ... --format
# '{{index .RepoDigests 0}}'` で digest を取り、本行を置換する。
FROM caddy:2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d

COPY Caddyfile /etc/caddy/Caddyfile
