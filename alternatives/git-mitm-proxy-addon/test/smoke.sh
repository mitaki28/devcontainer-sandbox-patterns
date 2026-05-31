#!/usr/bin/env bash
# alternatives/git-mitm-proxy-addon/ smoke (7 cases)。
#
# test/compose.yaml の閉鎖環境で実行する前提:
#   - internal-net / external-net とも internal: true で実 internet 不可達
#   - docker network alias で github.com を mock-upstream に hijack (本 smoke の URL は
#     `https://github.com/...` のまま; マクロの GIT_HOSTS = ("github.com",) を一切変えない)
#   - mock は `/<repo>.git/*` 全 path で EXPECT_PAT を要求する。マクロの header_inject が path
#     漏れなく PAT を注入できていないと 401 で smoke が落ちる = 注入が構造的に検証される
#   - smoke 用 PAT (ghp_smoke_test_pat) は compose の 3 service 間で literal 共有
#
# 検証する性質:
# 1. fetch advert GET (octocat/Hello-World, service=git-upload-pack) → 200 (全 repo allow + PAT)
# 2. push advert GET (octocat/Hello-World, service=git-receive-pack) → 403 (ALLOWED_PUSH_REPOS の
#    repo のみ allow、許可外は default deny。引き算なしで repo 単位の push 抑止が成立)
# 3. push transfer POST (octocat/Hello-World) → 403 (allow_rules 非該当 → default deny)
# 4. github.com GET / (non-git path) → 403 (マクロは git transport のみ allow、web は scope 外。
#    readonly_hosts にも github.com を入れていないので default deny)
# 5. github.com POST /random (non-git path) → 403 (default deny)
# 6. push 成功 (smoke-org/repo の feature/c1) → マクロの allow_rules で push 本体 POST を許可 +
#    header_inject で PAT 注入し mock に反映。同 ref を proxy 経由 ls-remote して SHA round-trip
#    = fetch PAT 注入も同時に検証。`git clone` で empty bare に対し `/HEAD` も追加 fetch される
#    が、header_inject の `.git/**` で `/HEAD` にも PAT が乗るため mock 全件 PAT 必須でも通る
# 7. workspace から偽 Authorization で smoke-org/repo fetch → header_inject が上書き → mock 200
#    (git-gateway smoke case 9b と同形の不変条件 assert)
#
# 実 GitHub には一切到達しない。api.github.com 等のマクロ範囲外 readonly_hosts の挙動と
# CA bootstrap / 起動性 / マクロ load 機構 (POLICY_MACROS) 自体は lib/mitm-proxy/ 本家
# smoke でカバーするため割愛。
set -euo pipefail

PROXY="${HTTPS_PROXY:?HTTPS_PROXY must be set}"
SMOKE_PAT="${SMOKE_PAT:?SMOKE_PAT must be set (compose の literal と一致させる)}"

step() { echo ""; echo "=== $1 ==="; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; exit 1; }

# bootstrap-ca.sh ENTRYPOINT で mitm-github CA は trust store に入っている前提なので
# 通常時は -k 不要。ただし case 8 のように curl で raw に Authorization を細工する箇所が
# あるため、共通 base には付けず必要な所で個別指定する。proxy は -x で明示。
CURL_BASE=(curl -fsS --max-time 15 -o /dev/null -w '%{http_code}' -x "$PROXY")
# -f を外し、4xx も値として受ける版 (deny / 401 期待時)。
CURL_RAW=(curl  -sS --max-time 15 -o /dev/null -w '%{http_code}' -x "$PROXY")

# ---- wait for mitm-github ----
echo "waiting for mitm-github to come up..."
for i in $(seq 1 60); do
    # github.com root (non-git) を proxy 越しに probe。proxy が応答できれば
    # 何らかの code が返る (200/4xx いずれでも到達は証明される)。
    if curl -sS --max-time 2 -o /dev/null -x "$PROXY" "https://github.com/" >/dev/null 2>&1; then
        echo "  reachable after ${i}s"
        break
    fi
    if [ "$i" = 60 ]; then
        fail "mitm-github not reachable after 60s"
    fi
    sleep 1
done

# ---- 1: github.com fetch advert (octocat/Hello-World) → 200 ----
step "case 1: fetch advert (info/refs?service=git-upload-pack) — マクロが fetch に PAT 注入"
# mock の EXPECT_PAT_FOR_REPOS=octocat/Hello-World により、PAT 注入が無いと 401。
# 200 が返ること = マクロの header_inject による fetch 経路 PAT 注入が機能している。
code=$("${CURL_RAW[@]}" "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack")
[ "$code" = "200" ] || fail "fetch advert returned $code, want 200 (PAT 注入失敗?)"
pass "fetch advert → 200 (PAT 注入を検証)"

# ---- 2: ALLOWED_PUSH_REPOS 外の push advert は default deny ----
step "case 2: octocat/Hello-World への push advert (GET ?service=git-receive-pack) → 403"
# マクロは push advert (GET service=git-receive-pack) を ALLOWED_PUSH_REPOS の repo のみ allow する。
# octocat は許可外なので allow に載らず default deny。引き算なしで repo 単位の push 抑止が成立する。
code=$("${CURL_RAW[@]}" "https://github.com/octocat/Hello-World.git/info/refs?service=git-receive-pack")
[ "$code" = "403" ] || fail "push advert returned $code, want 403"
pass "push advert denied by default deny (HTTP $code, ALLOWED_PUSH_REPOS 外)"

# ---- 3: ALLOWED_PUSH_REPOS 外 POST /git-receive-pack は default deny ----
step "case 3: octocat/Hello-World への POST /git-receive-pack → 403"
# allow_rules には smoke-org/repo の git-receive-pack しか無いので、octocat への push 本体は
# default deny に落ちる (= ALLOWED_PUSH_REPOS の実効的な強制点)。
code=$("${CURL_RAW[@]}" -X POST \
    -H "Content-Type: application/x-git-receive-pack-request" \
    --data-binary "" \
    "https://github.com/octocat/Hello-World.git/git-receive-pack")
[ "$code" = "403" ] || fail "push transfer returned $code, want 403"
pass "push transfer denied by default deny (HTTP $code)"

# ---- 4: github.com への GET / (non-git) は default deny ----
step "case 4: github.com GET / (non-git) → default deny (git transport のみ許可)"
# マクロは git transport (.git path) だけ allow し web ページは持たない。readonly_hosts にも
# github.com を入れていないので、非 git path の GET は default deny に落ちる。
code=$("${CURL_RAW[@]}" "https://github.com/")
[ "$code" = "403" ] || fail "GET / (non-git) returned $code, want 403 (web は scope 外)"
pass "GET / (non-git) denied (HTTP $code); マクロは git transport のみ許可"

# ---- 5: github.com への POST /random (non-git) は default deny ----
step "case 5: github.com POST /random (non-git) → default deny"
code=$("${CURL_RAW[@]}" -X POST --data "x" "https://github.com/random-path")
[ "$code" = "403" ] || fail "POST /random returned $code, want 403"
pass "POST /random denied by default deny (HTTP $code)"

# ---- 6: push 成功 (smoke-org/repo) ----
step "case 6: smoke-org/repo (ALLOWED_PUSH_REPOS) への push 成功 + ls-remote round-trip"
# 期待される性質:
#   - workspace の git CLI が proxy 経由で smoke-org/repo に push
#   - マクロが ALLOWED_PUSH_REPOS 内として allow + header_inject で PAT 注入
#   - mock の `/<repo>.git/*` 全件 PAT 必須を満たす Authorization で 200
#   - bare repo に feature/c1 が書き込まれ、proxy 経由の ls-remote で同 SHA が見える
#   - `git clone` が empty bare に対し `/HEAD` も追加 fetch するが、header_inject の `.git/**`
#     で `/HEAD` にも PAT が乗るため mock 全件 PAT 必須でも通る
# workspace は internal-net only で mock-upstream に直接届かないので、確認は proxy 経由
# (= fetch PAT 注入が同時に検証される副作用あり)。
WORK=/tmp/work-c6
rm -rf "$WORK"
# git clone で空 bare を取る (warning: empty repo は許容)。
git clone -q "https://github.com/smoke-org/repo.git" "$WORK" 2>/tmp/c6-clone.err || {
    cat /tmp/c6-clone.err
    fail "clone smoke-org/repo failed"
}
(
    cd "$WORK"
    export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@test
    export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@test
    # 空 bare からの初回 push なので unborn HEAD; orphan で feature branch を切る。
    git checkout -q --orphan feature/c1
    git rm -rfq . 2>/dev/null || true
    echo c1 > c1.txt
    git add c1.txt
    git commit -q -m c1
    git push -q origin feature/c1 || fail "push to smoke-org/repo failed (PAT 注入失敗 or ACL deny?)"
    sha_local=$(git rev-parse feature/c1)
    # proxy 経由で ls-remote (header_inject が fetch 経路でも PAT 注入する → mock 200)
    sha_remote=$(git ls-remote "https://github.com/smoke-org/repo.git" refs/heads/feature/c1 \
        2>/dev/null | awk '{print $1}')
    [ -n "$sha_remote" ] || fail "ls-remote returned empty (fetch PAT 注入失敗?)"
    [ "$sha_local" = "$sha_remote" ] || \
        fail "smoke-org/repo ref mismatch: local=$sha_local vs remote=$sha_remote"
)
pass "smoke-org/repo に push が反映され、ls-remote の SHA round-trip で PAT 注入を確認"

# ---- 7: workspace 側偽 Authorization を header_inject が上書き ----
step "case 7: smoke-org/repo に偽 Authorization → header_inject が上書き → mock 200 (不変条件)"
# 'wrong-pat' を base64 化した偽 Authorization を curl で proxy に投げる。header_inject が
# 自前 PAT で上書きせず透過させていたら mock は EXPECT_PAT_FOR_REPOS で 401 を返す。
# 200 が返ること = header_inject が Authorization を必ず上書きしている。
code=$("${CURL_RAW[@]}" \
    -H "Authorization: Basic d3JvbmctcGF0" \
    "https://github.com/smoke-org/repo.git/info/refs?service=git-upload-pack")
[ "$code" = "200" ] || \
    fail "case 7: header_inject が偽 Authorization を上書きするはずだが got $code (期待 200)"
pass "header_inject が client 側の偽 Authorization を PAT で上書き"

echo ""
echo "All smoke tests passed (7/7)."
