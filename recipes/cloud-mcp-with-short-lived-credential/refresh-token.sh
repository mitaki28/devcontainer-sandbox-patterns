#!/bin/sh
# host 側で明示的に実行する SA access token リフレッシュ。
#
# このスクリプトは:
#   - 個人アカウントの ADC（refresh token）を **ホストのみで** 使う
#   - sandbox SA に impersonate して 1 時間寿命の access token を発行
#   - ${HOME}/.cache/devsbx/gcp-mcp/token に書き出す
#
# proxy container は token ファイルだけを ro mount するため、refresh token は
# container 側に届かない（基本方針）。
#
# 設定の読み込み:
#   ${HOME}/.config/devsbx/gcp-mcp.env から
#   IMPERSONATE_SERVICE_ACCOUNT を読む（compose.yaml と共通）。
#
# 自動化（任意）:
#   寿命 1h なので 50 分間隔で叩く想定。
#   - macOS: launchd plist で StartInterval=3000
#   - Linux: systemd .timer で OnUnitActiveSec=50min
#   - 簡易: crontab に  */50 * * * *  /path/to/refresh-token.sh
#   いずれの場合も既存セッションの user 環境変数（PATH 含む）が要る点に注意。
set -eu

ENV_FILE="${HOME}/.config/devsbx/gcp-mcp.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${IMPERSONATE_SERVICE_ACCOUNT:?required (set in $ENV_FILE)}"

TOKEN_DIR="${HOME}/.cache/devsbx/gcp-mcp"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"

# tmp に書いて atomic に rename。proxy 側 reader と race しないため。
gcloud auth print-access-token \
  --impersonate-service-account="$IMPERSONATE_SERVICE_ACCOUNT" \
  > "$TOKEN_DIR/token.tmp"
chmod 600 "$TOKEN_DIR/token.tmp"
mv "$TOKEN_DIR/token.tmp" "$TOKEN_DIR/token"

printf '[%s] refreshed %s\n' "$(date -u +%FT%TZ)" "$TOKEN_DIR/token"
