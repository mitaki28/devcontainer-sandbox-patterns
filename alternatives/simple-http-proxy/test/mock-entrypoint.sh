#!/bin/sh
set -eu

# /certs 配下に自己署名 cert を毎回生成。allowed-hosts.smoke.txt と揃えた
# hostname (mock-target.test) を SAN に入れ、fetch 側の cert 検証が通るように
# する。.ready マーカーは port 443 listen 完了後に mock-server.ts 側で touch
# される (smoke の wait-for は listen 完了まで待つ必要があるため)。
openssl req -new -newkey rsa:2048 -days 30 -nodes -x509 \
    -keyout /certs/mock-target.key \
    -out /certs/mock-target.crt \
    -subj /CN=mock-target \
    -addext 'subjectAltName=DNS:mock-target.test' \
    >/dev/null 2>&1

exec bun run /app/mock-server.ts
