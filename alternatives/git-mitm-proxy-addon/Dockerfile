# alternatives/git-mitm-proxy-addon/ image:
# mitmproxy 公式 image をベースに、lib/mitm-proxy/addons/ + recipe 固有の
# github.py を /addons に重ねて MITM_EXTRA_ADDONS=github で enable する構成。
#
# build context は repo root (compose.yaml で `context: ../../..` を指定):
#   - lib/mitm-proxy/addons/ から default addons を COPY
#   - alternatives/git-mitm-proxy-addon/extra-addons/ から recipe 固有 addon (github.py) を上書き COPY

# digest pin は lib/mitm-proxy/compose.yaml と同じ image を使う。更新時は同期する。
FROM mitmproxy/mitmproxy@sha256:f4f0f41f5278f284fcc0a306f82849f38ab2e133c1d71d25a42bd06d7ff6928b

# lib/mitm-proxy/ の default addons (CommonPolicy / HeaderInjector / AccessLog +
# 共通 helpers: rules / audit / config / access_log) を COPY。
COPY lib/mitm-proxy/addons /addons

# recipe 固有 addon: github.py を上書き COPY (同名ファイルがあれば上書き、無ければ追加)。
# lib 側 addons/ には github.py は無いので新規追加。
COPY alternatives/git-mitm-proxy-addon/extra-addons/ /addons/

# CMD は compose.yaml 側で渡す (lib/mitm-proxy/ と統一)。
