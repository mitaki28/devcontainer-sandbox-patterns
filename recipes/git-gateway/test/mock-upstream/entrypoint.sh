#!/bin/sh
# test/mock-upstream/entrypoint.sh — smoke 用の mock 上流 server。
#
# 役割:
#   1. MOCK_REPOS の bare repo を anonymous receive-pack 可能な状態で init
#   2. EXPECT_PAT_FOR_REPOS / EXPECT_PAT を元に「指定 repo path に正しい
#      Authorization が無ければ 401」の Caddy matcher を生成 (PAT 注入の検証用)
#   3. FORBID_PAT_FOR_REPOS を元に「指定 repo path に Authorization が乗っていたら 401」の
#      matcher を生成 (anonymous 経路に PAT が漏れていないことの検証用)
#   4. fcgiwrap (bg) + caddy (fg) 起動
#
# 本番では使わない。production の entrypoint は gateway/entrypoint.sh。
set -eu

# mock-checks.caddy にも EXPECT_PAT 由来の Authorization 値が embed されるので
# production と同じく umask を絞る (詳細は gateway/entrypoint.sh のコメント参照)。
umask 077

CADDYFILE=/etc/caddy/Caddyfile
MOCK_CHECKS=/etc/caddy/mock-checks.caddy
SOCKET_PATH=/run/fcgiwrap.sock

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
            ''|*' '*) echo "[mock] $_kind: empty or contains space: '$_entry'" >&2; exit 1 ;;
        esac
        case "$_entry" in
            */*/*|/*|*/) echo "[mock] $_kind entry must be 'owner/repo' (got '$_entry')" >&2; exit 1 ;;
            */*)         : ;;
            *)           echo "[mock] $_kind entry must contain '/' (got '$_entry')" >&2; exit 1 ;;
        esac
        case "$_entry" in
            *..*) echo "[mock] $_kind entry must not contain '..': '$_entry'" >&2; exit 1 ;;
        esac
        case "$_entry" in
            *[!A-Za-z0-9._/-]*)
                echo "[mock] $_kind entry contains forbidden char: '$_entry'" >&2
                exit 1
                ;;
        esac
    done
}

init_bare_repo() {
    _repo_path="$1"
    if [ ! -d "$_repo_path" ]; then
        mkdir -p "$(dirname "$_repo_path")"
        git init -q --bare -b main "$_repo_path"
    fi
    git -C "$_repo_path" config http.receivepack true
    git -C "$_repo_path" config http.uploadpack true
}

MOCK_REPOS="${MOCK_REPOS:-}"
EXPECT_PAT_FOR_REPOS="${EXPECT_PAT_FOR_REPOS:-}"
FORBID_PAT_FOR_REPOS="${FORBID_PAT_FOR_REPOS:-}"
EXPECT_PAT="${EXPECT_PAT:-}"

validate_repo_csv "$MOCK_REPOS" MOCK_REPOS
validate_repo_csv "$EXPECT_PAT_FOR_REPOS" EXPECT_PAT_FOR_REPOS
validate_repo_csv "$FORBID_PAT_FOR_REPOS" FORBID_PAT_FOR_REPOS

EXPECT_AUTH_B64=""
if [ -n "$EXPECT_PAT" ]; then
    EXPECT_AUTH_B64=$(printf 'x-access-token:%s' "$EXPECT_PAT" | base64 | tr -d '\n')
fi

# bare repo init
mkdir -p /srv/git
if [ -n "$MOCK_REPOS" ]; then
    _old_ifs=$IFS; IFS=','
    # shellcheck disable=SC2086
    set -- $MOCK_REPOS
    IFS=$_old_ifs
    for _r in "$@"; do
        init_bare_repo "/srv/git/$_r.git"
    done
fi

# mock-checks.caddy 生成。Caddyfile.mock がこれを import する。
# 何も検証しない構成 (EXPECT_PAT も FORBID_PAT_FOR_REPOS も空) では空ファイルを置く
# (import を成功させるため、内容は無)。
: > "$MOCK_CHECKS"

if [ -n "$EXPECT_AUTH_B64" ] && [ -n "$EXPECT_PAT_FOR_REPOS" ]; then
    _i=0
    _old_ifs=$IFS; IFS=','
    # shellcheck disable=SC2086
    set -- $EXPECT_PAT_FOR_REPOS
    IFS=$_old_ifs
    for _r in "$@"; do
        _i=$((_i + 1))
        cat <<EOF >> "$MOCK_CHECKS"
# require Authorization for $_r
@mock_auth_required_$_i {
    path /$_r.git/*
    not header Authorization "Basic $EXPECT_AUTH_B64"
}
handle @mock_auth_required_$_i {
    header WWW-Authenticate "Basic realm=\"mock-upstream\""
    respond "mock: authorization required for $_r" 401
}

EOF
    done
fi

if [ -n "$FORBID_PAT_FOR_REPOS" ]; then
    _j=0
    _old_ifs=$IFS; IFS=','
    # shellcheck disable=SC2086
    set -- $FORBID_PAT_FOR_REPOS
    IFS=$_old_ifs
    for _r in "$@"; do
        _j=$((_j + 1))
        cat <<EOF >> "$MOCK_CHECKS"
# forbid Authorization on $_r (anonymous path invariant)
@mock_unexpected_auth_$_j {
    path /$_r.git/*
    header Authorization *
}
handle @mock_unexpected_auth_$_j {
    respond "mock: unexpected Authorization for $_r" 401
}

EOF
    done
fi

# dump (PAT は redact)
redact() { sed 's|Basic [A-Za-z0-9+/=]\{20,\}|Basic <redacted>|g' "$@"; }
{
    echo "[mock] $CADDYFILE:"
    redact "$CADDYFILE"
    echo "[mock] $MOCK_CHECKS:"
    redact "$MOCK_CHECKS"
} >&2

# fcgiwrap (bg) → socket 待ち → caddy validate → caddy run (fg)
rm -f "$SOCKET_PATH"
fcgiwrap -s "unix:$SOCKET_PATH" -f &
_i=0
while [ ! -S "$SOCKET_PATH" ]; do
    if [ "$_i" -ge 50 ]; then
        echo "[mock] fcgiwrap socket did not appear within 5s" >&2
        exit 1
    fi
    _i=$((_i + 1))
    sleep 0.1
done

caddy validate --config "$CADDYFILE" --adapter caddyfile
exec caddy run --config "$CADDYFILE" --adapter caddyfile
