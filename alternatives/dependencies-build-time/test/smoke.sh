#!/bin/sh
set -eu

echo "=== dependencies-build-time smoke test ==="
echo

# [1/3] node_modules が image に焼かれているか
echo "[1/3] node_modules is baked into the workspace image"
if [ -d /workspace/node_modules/typescript ]; then
    echo "    PASS"
else
    echo "    FAIL: /workspace/node_modules/typescript is missing"
    exit 1
fi
echo

# [2/3] workspace から registry への直 egress が塞がれているか
echo "[2/3] workspace cannot reach registry.npmjs.org directly (internal: true)"
if curl --fail --silent --show-error --max-time 5 -o /dev/null https://registry.npmjs.org/ 2>/dev/null; then
    echo "    FAIL: unexpected egress to registry.npmjs.org"
    exit 1
else
    echo "    PASS (direct egress is blocked)"
fi
echo

# [3/3] image に焼かれた依存が require できるか
echo "[3/3] installed package is loadable"
if node -e "console.log('typescript version:', require('typescript').version)"; then
    echo "    PASS"
else
    echo "    FAIL: cannot load typescript"
    exit 1
fi
echo

echo "All smoke tests passed."
