#!/usr/bin/env bash
# このスクリプトは **ホストから** 実行する。compose 内部 (smoke service) ではない。
# 検証対象が「ホスト → ingress (publish された host port) → workspace listener」
# というフルパスのため。
set -euo pipefail

cd "$(dirname "$0")/.."

HOST_PORT="${HOST_PORT:-8080}"
COMPOSE=(docker compose -f compose.yaml -f compose.smoke.yaml)

cleanup() {
	"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== ingress-single-workspace smoke test ==="
echo "HOST_PORT=${HOST_PORT}"
echo

echo "[setup] starting compose stack with smoke override"
"${COMPOSE[@]}" up -d --build >/dev/null

echo "[setup] waiting for ingress + listeners to come up"
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if curl -sf -m 2 -H 'Host: app.localhost' \
			-o /dev/null "http://127.0.0.1:${HOST_PORT}/"; then
		ready=1
		break
	fi
	sleep 1
done
if [ "$ready" != 1 ]; then
	echo "    FAIL: ingress did not become ready in time"
	exit 1
fi
echo

echo "[1/4] ingress publishes host port and routes app.localhost -> workspace:3000"
status=$(curl -s -m 5 -H 'Host: app.localhost' \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
if [ "$status" = "200" ]; then
	echo "    PASS"
else
	echo "    FAIL: expected 200, got $status"
	exit 1
fi

echo "[2/4] ingress routes api.localhost -> workspace:4000"
status=$(curl -s -m 5 -H 'Host: api.localhost' \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
if [ "$status" = "200" ]; then
	echo "    PASS"
else
	echo "    FAIL: expected 200, got $status"
	exit 1
fi

echo "[3/4] browser-style 'Host: <name>:<port>' is matched by Caddy host matcher"
# ブラウザは http://app.localhost:8080/ にアクセスすると Host header に port を
# 含めて送る。Caddy の host matcher が port を strip して一致させる挙動を確認。
status=$(curl -s -m 5 -H "Host: app.localhost:${HOST_PORT}" \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
if [ "$status" = "200" ]; then
	echo "    PASS"
else
	echo "    FAIL: expected 200 (Caddy host matcher should strip port), got $status"
	exit 1
fi

echo "[4/4] unknown host falls through to default 404 (no implicit catch-all)"
status=$(curl -s -m 5 -H 'Host: unknown.localhost' \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
if [ "$status" = "404" ]; then
	echo "    PASS"
else
	echo "    FAIL: expected 404, got $status"
	exit 1
fi

echo
echo "All smoke tests passed."
