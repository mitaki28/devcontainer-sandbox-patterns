#!/bin/sh
set -eu

# /certs 配下に自己署名 cert を毎回生成。Docker network alias で受ける全 host を
# SAN に並べておくことで、proxy (mitmproxy) の upstream cert 検証
# (--set ssl_verify_upstream_trusted_ca=/certs/mock-target.crt) が
# どの alias 名でアクセスされても通る。
#
# RFC 6761 で予約された .test TLD を使うことで、実 DNS では resolve せず、
# smoke 専用の仮想 host であることを明示する (alternatives/simple-http-proxy/ と同じ慣行)。
#
# .ready マーカーは port 443 listen 完了後に mock-server.ts 側で touch される
# (smoke の wait-for は listen 完了まで待つ必要があるため)。
openssl req -new -newkey rsa:2048 -days 30 -nodes -x509 \
    -keyout /certs/mock-target.key \
    -out /certs/mock-target.crt \
    -subj /CN=mock-target \
    -addext 'subjectAltName=DNS:api.test,DNS:registry.test,DNS:echo.test,DNS:raw.content.test,DNS:denied.test,DNS:git.test' \
    >/dev/null 2>&1

exec node /app/mock-server.ts
