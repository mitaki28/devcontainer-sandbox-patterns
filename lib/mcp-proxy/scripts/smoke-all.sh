#!/usr/bin/env bash
# 全 smoke 系 docker compose service を逆次実行し、まとめた pass/fail サマリを最後に出す。
# 失敗したものがあれば exit 1。
#
# 使い方: lib/mcp-proxy/ で `bash scripts/smoke-all.sh`
#
# 各 smoke の compose 定義は test/smoke/<name>/compose.yaml に分離。root の compose.yaml が
# それらを include で集約しているため、サービス名で `docker compose run --rm --build <name>` を
# 呼ぶだけで該当 smoke が走る。

set -euo pipefail

SMOKES=(
  smoke
  binary-smoke
  filter-smoke
  sweep-smoke
  provoke-smoke
  bearer-smoke
  oauth-smoke
  oauth-smoke-dedup
)

declare -a passed=()
declare -a failed=()

for s in "${SMOKES[@]}"; do
  echo
  echo "================================================================"
  echo "[smoke-all] running: ${s}"
  echo "================================================================"
  if docker compose run --rm --build "${s}"; then
    passed+=("${s}")
  else
    failed+=("${s}")
  fi
done

echo
echo "================================================================"
echo "[smoke-all] summary"
echo "================================================================"
echo "PASS (${#passed[@]}):"
if (( ${#passed[@]} > 0 )); then
  for s in "${passed[@]}"; do echo "  - ${s}"; done
fi
if (( ${#failed[@]} > 0 )); then
  echo "FAIL (${#failed[@]}):"
  for s in "${failed[@]}"; do echo "  - ${s}"; done
  exit 1
fi
