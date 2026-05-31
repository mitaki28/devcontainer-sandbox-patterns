#!/bin/sh
# mitm.it/cert/pem から CA を取得して OS trust store に反映する。
# 同 docker network 内の mitmproxy 経由で fetch するため plain HTTP で良い
# （bootstrap trust の前提は「internal network = 信頼境界」という設計に乗る）。
#
# 動作前提: workload は `HTTP_PROXY` / `HTTPS_PROXY` で mitmproxy を指す
# (regular proxy mode のみサポート、transparent mode は非対応 — 構造的に防御層が
# 不足するため)。
#
# privilege drop (不変条件):
#   bootstrap は root で動く必要がある (`update-ca-certificates` が `/etc/ssl/certs/`
#   を書き換えるため)。CA install 完了後、setpriv で `WORKLOAD_USER` に uid を drop
#   してから CMD を exec する。
#   `WORKLOAD_USER` は呼び出し側 (Dockerfile / compose env) で **明示必須**
#   (`${WORKLOAD_USER:?}` で fail-fast)。default を持たせると base image ごとに
#   実在する user が異なる (bun / node / 等) ため、漏れに気付かず privilege drop が
#   壊れたまま動く事故を起こしやすい (lib/mitm-proxy は bun, devcontainers 系は node)。

set -eu

PROXY="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
CA_DST=/usr/local/share/ca-certificates/mitmproxy.crt

if [ -z "$PROXY" ]; then
    echo "[bootstrap-ca] HTTP_PROXY / HTTPS_PROXY が未設定。lib/mitm-proxy は regular proxy mode のみサポートする。" >&2
    exit 1
fi
echo "[bootstrap-ca] fetching CA cert via proxy=$PROXY ..."

# mitm.it は magic hostname。proxy 経由で mitmproxy 自身が response を生成する。
# fail-closed: 取得に失敗したら起動しない。
if ! curl -fsS --max-time 10 -x "$PROXY" http://mitm.it/cert/pem -o "$CA_DST"; then
    echo "[bootstrap-ca] CA 取得に失敗。mitmproxy 未起動 / network 不通 の可能性" >&2
    exit 1
fi

# 取得した cert が PEM の体裁を持つか軽く検証（HTML を掴まされていないか）
if ! head -1 "$CA_DST" | grep -q "BEGIN CERTIFICATE"; then
    echo "[bootstrap-ca] 取得した content が PEM ではない:" >&2
    head -3 "$CA_DST" >&2
    exit 1
fi

update-ca-certificates >/dev/null
echo "[bootstrap-ca] CA installed: $CA_DST (combined bundle: $SSL_CERT_FILE)"

# Drop privileges before exec'ing the workload command.
# 呼び出し側で必ず指定する (例: Dockerfile の `ENV WORKLOAD_USER=node`)。
WORKLOAD_USER="${WORKLOAD_USER:?WORKLOAD_USER must be set (e.g. node, bun) — set it in the Dockerfile ENV or compose environment}"
WORKLOAD_UID=$(id -u "$WORKLOAD_USER")
WORKLOAD_GID=$(id -g "$WORKLOAD_USER")
WORKLOAD_HOME=$(getent passwd "$WORKLOAD_USER" | cut -d: -f6)
: "${WORKLOAD_HOME:?cannot resolve home for $WORKLOAD_USER}"
echo "[bootstrap-ca] dropping privileges to $WORKLOAD_USER (uid=$WORKLOAD_UID gid=$WORKLOAD_GID home=$WORKLOAD_HOME)"
# HOME / USER を明示再設定 (root 時の HOME=/root のままだと bun cache 等が書けない)。
# setpriv --init-groups で supplementary groups も初期化。
exec env HOME="$WORKLOAD_HOME" USER="$WORKLOAD_USER" LOGNAME="$WORKLOAD_USER" \
    setpriv --reuid="$WORKLOAD_UID" --regid="$WORKLOAD_GID" --init-groups -- "$@"
