# floating tag 経由のサプライチェーン攻撃を避けるため digest pin
# (integrated/single-workspace/ingress/Dockerfile と同じ image sha)。
# 更新は host で `docker pull caddy:2-alpine`
#   → `docker image inspect ... --format '{{index .RepoDigests 0}}'` で digest を取って置換。
FROM caddy:2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d

# - fcgiwrap: git-http-backend を CGI として spawn する FastCGI ラッパ。Caddy から
#   Unix socket で叩く。
# - git: pre-receive 内の git push 等の client 機能。
# - git-daemon: Alpine では git-http-backend (server-side) は git-daemon パッケージに
#   同梱されている (Debian と異なり git 本体には入っていない)。
# - ca-certificates: Caddy → https://github.com/ への上流 TLS 検証用。
#   (Caddy reverse_proxy は既定で上流証明書を検証する)
# - gettext: entrypoint が per-repo.caddy.tmpl を envsubst で展開するのに使う。
RUN apk add --no-cache fcgiwrap git git-daemon ca-certificates gettext

# 静的 Caddyfile を /etc/caddy/Caddyfile に置く。entrypoint は per-repo ファイルを
# /etc/caddy/per-repo/*.caddy として書くだけで、この静的ファイルには触らない。
# per-repo の handle 構造はテンプレ per-repo.caddy.tmpl に切り出してあり、
# entrypoint は envsubst で ${REPO} / ${IDX} / ${PAT_HEADER_LINE} を展開する。
COPY Caddyfile.gateway /etc/caddy/Caddyfile
COPY per-repo.caddy.tmpl /etc/caddy/per-repo.caddy.tmpl
RUN mkdir -p /etc/caddy/per-repo

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY hooks/ /srv/hooks/
RUN chmod +x /srv/hooks/pre-receive /srv/hooks/post-receive

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
