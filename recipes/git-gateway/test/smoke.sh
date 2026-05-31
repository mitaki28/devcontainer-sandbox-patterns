#!/usr/bin/env bash
# git-gateway smoke (10 cases).
#
# - workspace の gitconfig は https://github.com/ → http://git-gateway:8080/ 書換
# - 登録 repo: smoke-org/repo (gateway の ALLOWED_REPOS、上流 mock-upstream)
# - 未登録 repo: other-org/public (gateway の ALLOWED_REPOS に含まれない)
# - 直接 URL は smoke 内のセットアップ / 検証用 (insteadOf を bypass)
#
# mock-upstream は /smoke-org/repo.git/* に Authorization: Basic <expected> を要求し、
# /other-org/public.git/* に Authorization が乗っていたら 401 を返す。
# したがって case 1〜8 が通ること自体が「gateway の PAT 注入 / strip が
# 正しく動いている」ことの end-to-end な証拠になる。case 9 ではさらに、
# workspace 側で偽の Authorization を送っても gateway が strip + 再注入で
# 正しい PAT に置き換える不変条件を curl で明示的に assert する。
set -euo pipefail

SMOKE_PAT="${SMOKE_PAT:-ghp_smoke_test_pat}"

UPSTREAM_BASE_NOAUTH=http://mock-upstream:8080
UPSTREAM_BASE_AUTH="http://x-access-token:${SMOKE_PAT}@mock-upstream:8080"
GATEWAY_BASE=http://git-gateway:8080

# 登録 repo (直接の mock 操作には PAT を URL に embed する)
REPO_REG=smoke-org/repo
GH_REG="https://github.com/${REPO_REG}.git"
UPSTREAM_REG="${UPSTREAM_BASE_AUTH}/${REPO_REG}.git"
GATEWAY_REG="${GATEWAY_BASE}/${REPO_REG}.git"

# 未登録 repo (mock は anonymous を要求 = 余計な Authorization は付けない)
REPO_UNREG=other-org/public
GH_UNREG="https://github.com/${REPO_UNREG}.git"
UPSTREAM_UNREG="${UPSTREAM_BASE_NOAUTH}/${REPO_UNREG}.git"
GATEWAY_UNREG="${GATEWAY_BASE}/${REPO_UNREG}.git"

WORK=/tmp/work
EXT=/tmp/ext
SEED=/tmp/seed

export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@test
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@test
git config --global init.defaultBranch main

step() { echo ""; echo "=== $1 ==="; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; exit 1; }

ls_remote_sha() {
    git ls-remote "$1" "$2" 2>/dev/null | awk '{print $1}'
}

# gateway の per-repo fetch handler は上流に reverse-proxy するため、
# `git ls-remote http://git-gateway:...` は **上流 state** を返す。
# gateway 内部 bare repo (push 系の advertise) の state を取るには
# receive-pack advertise (smart HTTP) を curl で叩いて pkt-line から
# 該当 ref の SHA を抜く。これは pre-receive の rollback 検証に必要。
gateway_internal_sha() {
    _repo="$1"; _ref="$2"
    curl -s "http://git-gateway:8080/${_repo}.git/info/refs?service=git-receive-pack" \
        | grep -ao "[0-9a-f]\{40\} ${_ref}" \
        | head -1 \
        | awk '{print $1}'
}

# ---- wait for gateway and mock-upstream to become reachable ----
echo "waiting for mock-upstream and git-gateway to come up..."
for i in $(seq 1 60); do
    ok_mock=0; ok_gw=0
    curl -sf -o /dev/null --max-time 2 "${UPSTREAM_BASE_NOAUTH}/_health" 2>/dev/null && ok_mock=1
    curl -sf -o /dev/null --max-time 2 "${GATEWAY_BASE}/_health" 2>/dev/null && ok_gw=1
    if [ "$ok_mock" = 1 ] && [ "$ok_gw" = 1 ]; then
        echo "  both reachable after ${i}s"
        break
    fi
    if [ "$i" = 60 ]; then
        echo "DNS check:"; getent hosts mock-upstream git-gateway || true
        echo "resolv.conf:"; head -5 /etc/resolv.conf || true
        fail "mock-upstream / git-gateway not reachable after 60s (mock=$ok_mock gw=$ok_gw)"
    fi
    sleep 1
done

# ---- seed: mock-upstream の登録 repo に main を植える ----
step "setup: seed mock-upstream smoke-org/repo with main"
rm -rf "$SEED"
git init -q -b main "$SEED"
( cd "$SEED" \
  && echo seed > README.md \
  && git add . \
  && git commit -m seed -q \
  && git push -q "$UPSTREAM_REG" main ) || fail "seed push to mock-upstream failed"
pass "mock-upstream smoke-org/repo main seeded"

# 未登録 repo (other-org/public) にも anonymous 検証用に main を植える
step "setup: seed mock-upstream other-org/public with main"
rm -rf "$SEED"
git init -q -b main "$SEED"
( cd "$SEED" \
  && echo public-seed > README.md \
  && git add . \
  && git commit -m public-seed -q \
  && git push -q "$UPSTREAM_UNREG" main ) || fail "seed push to mock-upstream (other-org/public) failed"
pass "mock-upstream other-org/public main seeded"

# ---- case 1: basic push (登録 repo を gateway 経由で) ----
step "case 1: basic push (workspace → git-gateway → mock-upstream)"
rm -rf "$WORK"
git clone -q "$GH_REG" "$WORK" || fail "clone failed"
(
    cd "$WORK"
    git checkout -q -b feature/c1
    echo c1 > c1.txt
    git add . && git commit -q -m c1
    git push -q origin feature/c1 || fail "push failed"
    sha_local=$(git rev-parse feature/c1)
    sha_remote=$(ls_remote_sha "$UPSTREAM_REG" refs/heads/feature/c1)
    [ "$sha_local" = "$sha_remote" ] || fail "mock-upstream ref mismatch: $sha_local vs $sha_remote"
)
pass "feature/c1 propagated to mock-upstream"

# ---- case 2: deny main ----
step "case 2: ref denylist (push to main rejected by pre-receive)"
(
    cd "$WORK"
    git checkout -q main
    echo should-fail > x.txt
    git add . && git commit -q -m should-fail-on-main
    if git push -q origin main 2>/tmp/c2.err; then
        fail "main push should be denied but succeeded"
    fi
    grep -q "DENIED_REF_PATTERNS" /tmp/c2.err || { cat /tmp/c2.err; fail "expected DENIED message"; }
    git reset --hard -q HEAD~1
)
pass "main push denied by pre-receive"

# ---- case 3: external linear push, then workspace push (auto resolve) ----
step "case 3: external linear push to mock-upstream, workspace fetch+rebase+push"
(
    cd "$WORK"
    git checkout -q main
    git checkout -q -b feature/c3
    echo c3-base > c3.txt
    git add . && git commit -q -m c3-base
    git push -q origin feature/c3 || fail "seed push for c3 failed"
)
rm -rf "$EXT"
git clone -q "$UPSTREAM_REG" "$EXT" || fail "external clone failed"
(
    cd "$EXT"
    git checkout -q feature/c3
    echo external-linear > c3-ext.txt
    git add . && git commit -q -m external-linear
    git push -q origin feature/c3 || fail "external linear push failed"
)
(
    cd "$WORK"
    git fetch -q origin feature/c3
    git checkout -q feature/c3
    git rebase -q origin/feature/c3 || fail "rebase failed (should be ff)"
    echo workspace-c3 > c3-ws.txt
    git add . && git commit -q -m workspace-c3
    git push -q origin feature/c3 || fail "workspace push after fetch+rebase failed"
    sha_local=$(git rev-parse feature/c3)
    sha_remote=$(ls_remote_sha "$UPSTREAM_REG" refs/heads/feature/c3)
    [ "$sha_local" = "$sha_remote" ] || fail "mock-upstream c3 mismatch after auto-resolve"
)
pass "external linear push auto-resolved on workspace retry"

# ---- case 4: external history rewrite → workspace local non-ff reject ----
step "case 4: external history rewrite (orphan), workspace push rejected locally"
(
    cd "$WORK"
    git checkout -q main
    git checkout -q -b feature/c4
    echo c4-base > c4.txt
    git add . && git commit -q -m c4-base
    git push -q origin feature/c4 || fail "seed push for c4 failed"
)
rm -rf "$EXT"
git clone -q "$UPSTREAM_REG" "$EXT" || fail "external clone failed"
(
    cd "$EXT"
    git checkout -q --orphan feature/c4
    git rm -rfq . 2>/dev/null || true
    echo orphan > orphan.txt
    git add . && git commit -q -m orphan-c4
    git push -q "$UPSTREAM_REG" "+feature/c4" || fail "external force-push failed"
)
(
    cd "$WORK"
    git fetch -q origin
    git checkout -q feature/c4
    git reset -q --hard origin/feature/c4
    echo ws-on-orphan > ws-c4.txt
    git add . && git commit -q -m ws-on-orphan
    if git push -q origin feature/c4 2>/tmp/c4.err; then
        fail "case 4 push should be rejected by workspace local non-ff check"
    fi
    grep -qE "non-fast-forward|rejected|stale info" /tmp/c4.err \
        || { cat /tmp/c4.err; fail "expected non-ff error"; }
)
pass "workspace local non-ff reject as expected"

# ---- case 5: stale workspace push (gateway accepts, upstream rejects, rollback) ----
step "case 5: stale workspace push (gateway accepts → mock-upstream rejects → full rollback)"
(
    cd "$WORK"
    git checkout -q main
    git checkout -q -b feature/c5
    echo c5-base > c5.txt
    git add . && git commit -q -m c5-base
    git push -q origin feature/c5 || fail "seed push for c5 failed"
    sha_c5_base=$(git rev-parse feature/c5)
    echo "$sha_c5_base" > /tmp/c5_base.sha
)
sha_c5_base=$(cat /tmp/c5_base.sha)

rm -rf "$EXT"
git clone -q "$UPSTREAM_REG" "$EXT" || fail "external clone failed"
(
    cd "$EXT"
    git checkout -q feature/c5
    echo external-c5 > ext-c5.txt
    git add . && git commit -q -m external-c5
    git push -q "$UPSTREAM_REG" feature/c5 || fail "external linear push for c5 failed"
    git rev-parse feature/c5 > /tmp/c5_external.sha
)
sha_c5_external=$(cat /tmp/c5_external.sha)

(
    cd "$WORK"
    git checkout -q feature/c5
    git update-ref refs/remotes/origin/feature/c5 "$sha_c5_base"
    echo ws-stale-c5 > ws-c5.txt
    git add . && git commit -q -m ws-stale-c5
    if git push -q origin feature/c5 2>/tmp/c5.err; then
        fail "case 5 push should be rejected via pre-receive (mock-upstream non-ff)"
    fi
    grep -qE "forward to|failed|remote rejected" /tmp/c5.err \
        || { cat /tmp/c5.err; fail "expected mock-upstream rejection in stderr"; }
)
# mock-upstream の state は workspace の fetch URL (= gateway, proxy 経由) では見られない
# (gateway は fetch を上流に reverse-proxy する設計のため、ls-remote gateway = ls-remote
# mock-upstream)。そのため mock-upstream への直接 ls-remote と、gateway 内部 bare repo
# 専用の SHA 取得 (receive-pack advertise) を別に使う。
sha_mock=$(ls_remote_sha "$UPSTREAM_REG" refs/heads/feature/c5)
sha_gw_internal=$(gateway_internal_sha "$REPO_REG" refs/heads/feature/c5)
[ "$sha_mock" = "$sha_c5_external" ] || fail "mock-upstream should remain at external state: got $sha_mock, want $sha_c5_external"
[ "$sha_gw_internal" = "$sha_c5_base" ] || fail "gateway internal should rollback to base: got $sha_gw_internal, want $sha_c5_base"
pass "gateway rolled back to base; mock-upstream unchanged at external state"

# ---- case 6: 未登録 repo の anonymous fetch (ls-remote / clone) ----
step "case 6: anonymous fetch for unregistered repo (passthrough)"
out=$(git ls-remote "$GH_UNREG" 2>/tmp/c6.err) || { cat /tmp/c6.err; fail "ls-remote on unregistered repo failed"; }
echo "$out" | grep -q "refs/heads/main" || { echo "$out"; fail "expected main ref in ls-remote output"; }
rm -rf /tmp/probe
git clone -q "$GH_UNREG" /tmp/probe 2>/tmp/c6b.err || { cat /tmp/c6b.err; fail "clone of unregistered repo failed"; }
[ -f /tmp/probe/README.md ] || fail "cloned repo missing README.md"
pass "unregistered repo anonymous fetch works"

# ---- case 7: 未登録 repo への push は 403 ----
step "case 7: push to unregistered repo is denied (403)"
(
    cd /tmp/probe
    echo should-fail > x.txt
    git add . && git commit -q -m should-fail
    if git push -q origin main 2>/tmp/c7.err; then
        fail "push to unregistered repo should be denied"
    fi
    grep -qiE "403|forbidden|denied|unable to access" /tmp/c7.err \
        || { cat /tmp/c7.err; fail "expected 403/forbidden in stderr"; }
    # 上流側で main が動いていないことを verify (push が通り抜けてないか)
    sha_upstream_main=$(ls_remote_sha "$UPSTREAM_UNREG" refs/heads/main)
    sha_local=$(git rev-parse HEAD)
    [ "$sha_upstream_main" != "$sha_local" ] || fail "upstream main matches local — push leaked through!"
)
pass "unregistered repo push denied"

# ---- case 8: ACL invariant (advertise endpoint の挙動で間接 verify) ----
step "case 8: advertise endpoints follow ACL invariant"
# mock-upstream は登録 repo path に PAT を要求し、未登録 repo path には PAT が
# 来たら 401 を返す。したがって以下の HTTP code チェックは routing だけでなく
# PAT 注入 / strip も同時に検証している:
#   - 登録 repo の info/refs?service=git-upload-pack → 200
#       (gateway が PAT を注入 → mock 受理)
#       PAT 注入が壊れていたら 401 が返り case 8 が fail する
#   - 未登録 repo の info/refs?service=git-upload-pack → 200
#       (gateway が Authorization strip → mock 受理)
#       strip が壊れていたら 401 が返り case 8 が fail する
#   - 未登録 repo の info/refs?service=git-receive-pack → 403 (push 系は denied)
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
code_reg_fetch=$(http_code "$GATEWAY_REG/info/refs?service=git-upload-pack")
code_unreg_fetch=$(http_code "$GATEWAY_UNREG/info/refs?service=git-upload-pack")
code_unreg_push=$(http_code "$GATEWAY_UNREG/info/refs?service=git-receive-pack")
[ "$code_reg_fetch" = "200" ]      || fail "registered fetch advertise expected 200, got $code_reg_fetch (PAT 注入失敗?)"
[ "$code_unreg_fetch" = "200" ]    || fail "unregistered fetch advertise expected 200, got $code_unreg_fetch (Authorization strip 失敗?)"
[ "$code_unreg_push" = "403" ]     || fail "unregistered push advertise expected 403, got $code_unreg_push"
pass "advertise endpoints behave as ACL invariant predicts"

# ---- case 9: PAT 注入 / strip 不変条件の明示的 assert ----
step "case 9: PAT injection / strip invariants (explicit)"
# 9a: 登録 repo に curl (Authorization 未設定) → gateway が PAT 注入 → mock 200
code_9a=$(http_code "$GATEWAY_REG/info/refs?service=git-upload-pack")
[ "$code_9a" = "200" ] || fail "9a: registered fetch w/o client auth expected 200, got $code_9a"

# 9b: 登録 repo に **間違った Authorization で** curl
#     → gateway が unset + 正しい PAT を再注入 → mock 受理 → 200
#     (もし unset/再注入の順序が逆だと workspace の偽 Authorization が上流に届き 401)
code_9b=$(http_code -H "Authorization: Basic d3JvbmctcGF0" "$GATEWAY_REG/info/refs?service=git-upload-pack")
[ "$code_9b" = "200" ] || fail "9b: registered fetch w/ bogus client auth should still be 200 (gateway overrides), got $code_9b"

# 9c: 未登録 repo に curl (Authorization 未設定) → gateway が strip → mock anonymous 受理 → 200
code_9c=$(http_code "$GATEWAY_UNREG/info/refs?service=git-upload-pack")
[ "$code_9c" = "200" ] || fail "9c: unregistered fetch w/o auth expected 200, got $code_9c"

# 9d: 未登録 repo に **Authorization 付きで** curl
#     → gateway が strip → mock は Authorization 不在を確認 → 200
#     (もし strip が壊れていれば mock の FORBID_PAT_FOR_REPOS が 401 を返す)
code_9d=$(http_code -H "Authorization: Basic d3JvbmctcGF0" "$GATEWAY_UNREG/info/refs?service=git-upload-pack")
[ "$code_9d" = "200" ] || fail "9d: unregistered fetch w/ client auth should still be 200 (gateway strips), got $code_9d"

pass "PAT injection (9a/9b) and PAT strip (9c/9d) invariants hold"

# ---- case 10: gateway は git smart HTTP のみ通す ----
step "case 10: only git smart HTTP paths reach the upstream"
# gateway が通すのは smart HTTP の 4 endpoint (push/fetch × advertise/pack) のみ。
# それ以外の (HTTP メソッド, パス) は 404 で完結し、上流に到達しない。

# 10a: web UI 風 path (smart HTTP のいずれの matcher にも該当しない GET)
code_10a=$(http_code "$GATEWAY_BASE/explore")
[ "$code_10a" = "404" ] || fail "10a: non-smart-HTTP GET expected 404, got $code_10a"

# 10b: smart HTTP に該当しない POST
code_10b=$(http_code -X POST --data "k=v" "$GATEWAY_BASE/anything")
[ "$code_10b" = "404" ] || fail "10b: non-smart-HTTP POST expected 404, got $code_10b"

# 10c: 登録 repo の owner 配下でも `.git/` を含まない path
code_10c=$(http_code "$GATEWAY_BASE/$REPO_REG/issues")
[ "$code_10c" = "404" ] || fail "10c: registered owner non-.git path expected 404, got $code_10c"

# 10d: 未登録 repo の `.git/` 配下でも smart HTTP の matcher に該当しない path
code_10d=$(http_code "$GATEWAY_UNREG/raw/main/README.md")
[ "$code_10d" = "404" ] || fail "10d: unregistered repo non-smart-HTTP path expected 404, got $code_10d"

# 10e: info/refs は service クエリ込みで初めて smart HTTP として成立する
code_10e=$(http_code "$GATEWAY_UNREG/info/refs")
[ "$code_10e" = "404" ] || fail "10e: info/refs without service query expected 404, got $code_10e"

# 10f: smart HTTP の正常 path は引き続き 200 (regression sentinel)
code_10f=$(http_code "$GATEWAY_UNREG/info/refs?service=git-upload-pack")
[ "$code_10f" = "200" ] || fail "10f: unregistered fetch advertise expected 200, got $code_10f"

pass "smart HTTP のみが上流に到達し、それ以外は 404"

echo ""
echo "All smoke tests passed (10/10)."
