#!/bin/sh
# git-gateway entrypoint (production).
#
# 役割は最小化してあり:
#   1. env (UPSTREAM_BASE_URL / ALLOWED_REPOS / GITHUB_PAT) の validation
#   2. 登録 repo ごとの bare repo init + hook 配置 + push 上流 URL を per-repo git config に記録
#   3. 登録 repo ごとに /etc/caddy/per-repo/<N>.caddy を heredoc で生成
#      (Caddyfile の静的部分は Dockerfile で COPY 済み、ここでは触らない)
#   4. fcgiwrap (Unix socket) を bg、caddy を fg で起動
# のみ。
#
# mock-upstream 用のロジックは test/mock-upstream/entrypoint.sh に分離してある。
# このスクリプトは production パスだけを扱う。
set -eu

# 以降で生成するファイル群 (per-repo Caddyfile、bare repo の git config) には
# PAT を base64 化した Authorization 値が含まれる。container 内が単一 user で
# 動いている現状でも default umask 022 → 644 は不要に広いので、defense-in-depth
# として 600 に絞る (container escape を仮定したシナリオに対する被害縮小)。
umask 077

CADDYFILE=/etc/caddy/Caddyfile   # Dockerfile で静的 Caddyfile.gateway を COPY 済み
PER_REPO_TMPL=/etc/caddy/per-repo.caddy.tmpl
PER_REPO_DIR=/etc/caddy/per-repo
SOCKET_PATH=/run/fcgiwrap.sock

# ---- env validation ----------------------------------------------------------

validate_repo_csv() {
    _csv="$1"; _kind="$2"
    [ -z "$_csv" ] && return 0
    _old_ifs=$IFS
    IFS=','
    # shellcheck disable=SC2086
    set -- $_csv
    IFS=$_old_ifs
    for _entry in "$@"; do
        case "$_entry" in
            ''|*' '*) echo "[entrypoint] $_kind: empty or contains space: '$_entry'" >&2; exit 1 ;;
        esac
        # "owner/repo" 形式: '/' がちょうど 1 個 + 両端非空
        case "$_entry" in
            */*/*|/*|*/) echo "[entrypoint] $_kind entry must be 'owner/repo' (got '$_entry')" >&2; exit 1 ;;
            */*)         : ;;
            *)           echo "[entrypoint] $_kind entry must contain '/' (got '$_entry')" >&2; exit 1 ;;
        esac
        case "$_entry" in
            *..*) echo "[entrypoint] $_kind entry must not contain '..': '$_entry'" >&2; exit 1 ;;
        esac
        case "$_entry" in
            *[!A-Za-z0-9._/-]*)
                echo "[entrypoint] $_kind entry contains forbidden char (allowed: A-Za-z0-9._-/): '$_entry'" >&2
                exit 1
                ;;
        esac
    done
}

UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:?UPSTREAM_BASE_URL must be set}"
ALLOWED_REPOS="${ALLOWED_REPOS:-}"
GITHUB_PAT="${GITHUB_PAT:-}"

validate_repo_csv "$ALLOWED_REPOS" ALLOWED_REPOS

case "$UPSTREAM_BASE_URL" in
    */) : ;;
    *)  echo "[entrypoint] UPSTREAM_BASE_URL must end with '/' (got '$UPSTREAM_BASE_URL')" >&2; exit 1 ;;
esac
case "$UPSTREAM_BASE_URL" in
    http://*|https://*) : ;;
    *) echo "[entrypoint] UPSTREAM_BASE_URL must start with http:// or https:// (got '$UPSTREAM_BASE_URL')" >&2; exit 1 ;;
esac
_after_scheme="${UPSTREAM_BASE_URL#*://}"
case "${_after_scheme%/}" in
    */*) echo "[entrypoint] UPSTREAM_BASE_URL must be scheme://host[:port]/ (no extra path), got '$UPSTREAM_BASE_URL'" >&2; exit 1 ;;
esac
# host[:port] 部の文字種を制限し、userinfo (`user:pass@host`)、query (`host?q=v`)、
# fragment (`host#x`) のような「path component を含まないが PAT 転送先を歪ませる」
# 入力が validate を素通りするのを防ぐ。Caddy 自身もホスト名の妥当性は弾くが、
# entrypoint で先に弾く方が PAT を上流に渡す前段の安全側に倒せる。
_host_port="${_after_scheme%/}"
case "$_host_port" in
    '')
        echo "[entrypoint] UPSTREAM_BASE_URL host is empty (got '$UPSTREAM_BASE_URL')" >&2
        exit 1
        ;;
    *[!A-Za-z0-9.:-]*)
        echo "[entrypoint] UPSTREAM_BASE_URL host[:port] must be [A-Za-z0-9.:-]+ (got '$_host_port')" >&2
        exit 1
        ;;
esac

# Caddy の {$UPSTREAM_HOST_PART} がここから展開される (Caddyfile.gateway 参照)
UPSTREAM_HOST_PART="${UPSTREAM_BASE_URL%/}"
export UPSTREAM_HOST_PART

GITHUB_PAT_B64=""
if [ -n "$GITHUB_PAT" ]; then
    GITHUB_PAT_B64=$(printf 'x-access-token:%s' "$GITHUB_PAT" | base64 | tr -d '\n')
fi

# ---- per-repo Caddyfile 生成 -------------------------------------------------

init_bare_repo() {
    _repo_path="$1"
    if [ ! -d "$_repo_path" ]; then
        mkdir -p "$(dirname "$_repo_path")"
        git init -q --bare -b main "$_repo_path"
    fi
    git -C "$_repo_path" config http.receivepack true
    git -C "$_repo_path" config http.uploadpack true
}

# per-repo Caddyfile 1 ファイルを標準出力に出す。
# 引数: owner/repo, インデックス, PAT_B64 (空可)
#
# テンプレ per-repo.caddy.tmpl を envsubst で展開する。展開対象は引数で
# ${REPO} / ${IDX} / ${PAT_HEADER_LINE} に限定する。PAT_HEADER_LINE は
# fetch handler 内の 1 行で、PAT 有なら `    request_header Authorization
# "Basic <PAT_B64>"`、PAT 無なら空文字列 (空行は Caddyfile で ignore され、
# fetch handler は strip のみで PAT 注入無しの状態になる)。
emit_per_repo_caddy() {
    _r="$1"; _i="$2"; _pat_b64="$3"
    if [ -n "$_pat_b64" ]; then
        _pat_line="    request_header Authorization \"Basic $_pat_b64\""
    else
        _pat_line=""
    fi
    REPO="$_r" IDX="$_i" PAT_HEADER_LINE="$_pat_line" \
        envsubst '${REPO} ${IDX} ${PAT_HEADER_LINE}' < "$PER_REPO_TMPL"
}

mkdir -p /srv/git "$PER_REPO_DIR"
rm -f "$PER_REPO_DIR"/*.caddy

if [ -n "$ALLOWED_REPOS" ]; then
    _i=0
    _old_ifs=$IFS; IFS=','
    # shellcheck disable=SC2086
    set -- $ALLOWED_REPOS
    IFS=$_old_ifs
    for _r in "$@"; do
        _i=$((_i + 1))
        _path="/srv/git/$_r.git"
        init_bare_repo "$_path"
        cp /srv/hooks/pre-receive "$_path/hooks/pre-receive"
        cp /srv/hooks/post-receive "$_path/hooks/post-receive"
        chmod +x "$_path/hooks/pre-receive" "$_path/hooks/post-receive"
        git -C "$_path" config push-gateway.upstream-url "${UPSTREAM_BASE_URL}${_r}.git"
        # pre-receive の git push が上流に Authorization を upfront で送るために
        # bare repo の git config に extraHeader を設定する。
        if [ -n "$GITHUB_PAT_B64" ]; then
            git -C "$_path" config http.extraHeader "Authorization: Basic $GITHUB_PAT_B64"
        else
            git -C "$_path" config --unset http.extraHeader 2>/dev/null || true
        fi
        emit_per_repo_caddy "$_r" "$_i" "$GITHUB_PAT_B64" > "$PER_REPO_DIR/${_i}.caddy"
    done
fi

# ---- dump (redacted) + validate + start --------------------------------------

# base64 化した PAT は最低 20 文字以上 (ghp_xxx の 40+ 文字 → base64 50+ 文字)。
# 短い `Basic realm=...` のような WWW-Authenticate 値を巻き込まないよう 20+ で絞る。
redact() { sed 's|Basic [A-Za-z0-9+/=]\{20,\}|Basic <redacted>|g' "$@"; }

{
    echo "[entrypoint] $CADDYFILE:"
    redact "$CADDYFILE"
    for _f in "$PER_REPO_DIR"/*.caddy; do
        [ -f "$_f" ] || continue
        echo "[entrypoint] $_f:"
        redact "$_f"
    done
    echo "[entrypoint] UPSTREAM_HOST_PART=${UPSTREAM_HOST_PART}"
} >&2

# fcgiwrap (bg) → socket 出現待ち → caddy validate → caddy run (fg)
rm -f "$SOCKET_PATH"
fcgiwrap -s "unix:$SOCKET_PATH" -f &
_i=0
while [ ! -S "$SOCKET_PATH" ]; do
    if [ "$_i" -ge 50 ]; then
        echo "[entrypoint] fcgiwrap socket did not appear within 5s" >&2
        exit 1
    fi
    _i=$((_i + 1))
    sleep 0.1
done

caddy validate --config "$CADDYFILE" --adapter caddyfile
exec caddy run --config "$CADDYFILE" --adapter caddyfile
