#!/usr/bin/env bash
# このスクリプトは **ホストから** 実行する。
# 検証対象は:
#   1. ingress + 2 workspace の並列起動で wildcard subdomain routing が動くこと
#      (@task wildcard + 名前付き port @app/@api の両方)
#   2. unknown host が 404 で fall through すること
#   3. workspace 停止 → upstream unreachable / 起動 → 復活 の動的追従
#
# 動的更新機構を全廃し routing 管理を Docker DNS に移譲する設計
# (integrated/multi-workspace/README.md 参照) の核心を最小構成で実証する単体検証 recipe。
set -euo pipefail

cd "$(dirname "$0")/.."

INGRESS_PROJECT="shared-ingress-test"
TASK_A="task-a"
TASK_B="task-b"
HOST_PORT=8080

INGRESS_COMPOSE=(docker compose -f ingress/compose.yaml -p "${INGRESS_PROJECT}")
WS_A_COMPOSE=(docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml -p "${TASK_A}")
WS_B_COMPOSE=(docker compose -f workspace/compose.yaml -f workspace/compose.smoke.yaml -p "${TASK_B}")

cleanup() {
	"${WS_A_COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
	"${WS_B_COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
	"${INGRESS_COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== ingress-multi-workspace smoke test ==="
echo "ingress project: ${INGRESS_PROJECT}"
echo "workspaces: ${TASK_A}, ${TASK_B}"
echo "host port: ${HOST_PORT}"
echo

# ----- setup -----

echo "[setup] starting ingress (creates external shared network)"
"${INGRESS_COMPOSE[@]}" up -d --build >/dev/null

echo "[setup] starting workspace A and B in parallel"
"${WS_A_COMPOSE[@]}" up -d >/dev/null
"${WS_B_COMPOSE[@]}" up -d >/dev/null

echo "[setup] waiting for ingress + both workspaces to come up"
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
	if curl -sf -m 2 -H "Host: ${TASK_A}.devsbx.localhost" \
			-o /dev/null "http://127.0.0.1:${HOST_PORT}/" \
		&& curl -sf -m 2 -H "Host: ${TASK_B}.devsbx.localhost" \
			-o /dev/null "http://127.0.0.1:${HOST_PORT}/"; then
		ready=1
		break
	fi
	sleep 1
done
if [ "$ready" != 1 ]; then
	echo "    FAIL: ingress / workspaces did not become ready in time"
	"${INGRESS_COMPOSE[@]}" logs ingress | tail -20
	exit 1
fi
echo

# ----- tests -----

# Caddy header_regexp matcher が wildcard subdomain を解釈できることの基本検証。
# subdomain から取り出した name で Docker DNS が <name>-workspace を resolve し、
# upstream :3000 まで届くか。
echo "[1/8] task-a.devsbx.localhost routes to workspace A (port 3000)"
body=$(curl -s -m 5 -H "Host: ${TASK_A}.devsbx.localhost" \
	"http://127.0.0.1:${HOST_PORT}/index.html")
if echo "$body" | grep -q "workspace: ${TASK_A} port: 3000"; then
	echo "    PASS"
else
	echo "    FAIL: expected 'workspace: ${TASK_A} port: 3000', got: $body"
	exit 1
fi

echo "[2/8] task-b.devsbx.localhost routes to workspace B (port 3000)"
body=$(curl -s -m 5 -H "Host: ${TASK_B}.devsbx.localhost" \
	"http://127.0.0.1:${HOST_PORT}/index.html")
if echo "$body" | grep -q "workspace: ${TASK_B} port: 3000"; then
	echo "    PASS"
else
	echo "    FAIL: expected 'workspace: ${TASK_B} port: 3000', got: $body"
	exit 1
fi

# ブラウザは http://<name>.devsbx.localhost:8080/ にアクセスすると Host header に
# port を含めて送る。header_regexp の末尾 (?::\d+)? で port suffix を受ける挙動を確認。
echo "[3/8] browser-style 'Host: <name>.devsbx.localhost:8080' is matched"
body=$(curl -s -m 5 -H "Host: ${TASK_A}.devsbx.localhost:${HOST_PORT}" \
	"http://127.0.0.1:${HOST_PORT}/index.html")
if echo "$body" | grep -q "workspace: ${TASK_A} port: 3000"; then
	echo "    PASS"
else
	echo "    FAIL: expected 'workspace: ${TASK_A} port: 3000', got: $body"
	exit 1
fi

# 名前付き port handler: app.<task> は :3000 に振り分けられる (= @task と同じ upstream)。
echo "[4/8] app.task-a.devsbx.localhost routes to workspace A :3000"
body=$(curl -s -m 5 -H "Host: app.${TASK_A}.devsbx.localhost" \
	"http://127.0.0.1:${HOST_PORT}/index.html")
if echo "$body" | grep -q "workspace: ${TASK_A} port: 3000"; then
	echo "    PASS"
else
	echo "    FAIL: expected 'workspace: ${TASK_A} port: 3000', got: $body"
	exit 1
fi

# 名前付き port handler: api.<task> は :4000 に振り分けられる (= @app と別 upstream)。
echo "[5/8] api.task-a.devsbx.localhost routes to workspace A :4000"
body=$(curl -s -m 5 -H "Host: api.${TASK_A}.devsbx.localhost" \
	"http://127.0.0.1:${HOST_PORT}/index.html")
if echo "$body" | grep -q "workspace: ${TASK_A} port: 4000"; then
	echo "    PASS"
else
	echo "    FAIL: expected 'workspace: ${TASK_A} port: 4000', got: $body"
	exit 1
fi

# 未マッチ host は 404 で fall through する (誤って全 host を流さない)。
echo "[6/8] unknown host falls through to 404"
status=$(curl -s -m 5 -H "Host: not-a-task.example.com" \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
if [ "$status" = "404" ]; then
	echo "    PASS"
else
	echo "    FAIL: expected 404, got $status"
	exit 1
fi

# 設計の核心: 動的 routing 機構なしで workspace 停止/起動に追従できるか。
echo "[7/8] stopping workspace A → upstream unreachable (502 or connection refused class)"
"${WS_A_COMPOSE[@]}" down >/dev/null 2>&1
sleep 1
status=$(curl -s -m 5 -H "Host: ${TASK_A}.devsbx.localhost" \
	-o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/")
# Caddy は upstream 不在を 502 で返す (DNS 解決失敗 or connection refused 共に)
if [ "$status" = "502" ]; then
	echo "    PASS (got $status)"
else
	echo "    FAIL: expected 502 after workspace down, got $status"
	exit 1
fi

echo "[8/8] restarting workspace A → routing resumes without ingress reload"
"${WS_A_COMPOSE[@]}" up -d >/dev/null
# DNS 再 resolve + http.server boot を待つ
recovered=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if curl -sf -m 2 -H "Host: ${TASK_A}.devsbx.localhost" \
			"http://127.0.0.1:${HOST_PORT}/index.html" \
			| grep -q "workspace: ${TASK_A} port: 3000"; then
		recovered=1
		break
	fi
	sleep 1
done
if [ "$recovered" = 1 ]; then
	echo "    PASS (workspace A reachable again, no ingress reload)"
else
	echo "    FAIL: workspace A did not become reachable after restart"
	exit 1
fi

echo
echo "All smoke tests passed."
