# alternatives/git-mitm-proxy-addon/test/mock-upstream/: smoke 専用の TLS-enabled mock 上流。
#
# recipes/git-gateway/test/mock-upstream/Dockerfile を base に、addon 用の TLS upstream
# として動かすため (1) openssl で self-signed cert を生成する用に openssl を追加 install、
# (2) listen port を 8080 (plain HTTP) から 443 (TLS) に変更。git-gateway 側 mock を TLS 化
# するのは git-gateway の設計を歪めるため、独立した image として持つ。
#
# digest pin は git-gateway 側と統一する (供給源を揃える)。
FROM caddy:2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d

# git-gateway 版 mock と同じ最小セット + openssl (entrypoint で SAN 付き self-signed cert
# を毎回生成するため)。
RUN apk add --no-cache fcgiwrap git git-daemon ca-certificates openssl

# 静的 Caddyfile。git-gateway 側と同じく entrypoint は smoke 用の invariant check
# (PAT 要求 / PAT 禁止) のみを /etc/caddy/mock-checks.caddy に書き出す。
COPY Caddyfile.mock /etc/caddy/Caddyfile
RUN mkdir -p /etc/caddy

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# mitm-github が CONNECT する宛先は `<alias>:443` (https://github.com/...) なので
# git-gateway 版 (8080 plain) と違って 443 で listen する。
EXPOSE 443
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
