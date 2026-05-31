# alternatives/git-mitm-proxy-addon/ — mitm-proxy マクロで github.com の git を扱う軽量代替

`lib/mitm-proxy/` のベースイメージに github 用マクロを 1 つ載せて github.com の git smart-HTTP を扱う構成。`recipes/git-gateway/` の軽量代替で、ref 単位の ACL は持たない。

比較と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-git-mitm-proxy-addon.md](../../docs/appendix/alt-git-mitm-proxy-addon.md)

## 概要

- `GITHUB_PAT` / `ALLOWED_PUSH_REPOS` は mitm-github サービスの env_file でのみ保持
- 作業コンテナの git CLI はプロキシ経由で github.com を直接叩く (insteadOf 書き換えは不要)
- mitm-github がリクエスト転送時に Authorization を注入する

### Dockerfile の作り

lib 側アドオンを COPY した上に、レシピ固有の `macros/github.py` を重ねるだけ:

```dockerfile
FROM mitmproxy/mitmproxy@sha256:...
COPY lib/mitm-proxy/addons /addons
COPY alternatives/git-mitm-proxy-addon/macros/ /addons/
```

起動時に `POLICY_MACROS=github` を渡すとマクロが有効になり、生成されたルールが policy にマージされる。lib 側のコードは上書きしない。

## 動作確認

```sh
cd alternatives/git-mitm-proxy-addon && docker compose -f test/compose.yaml run --rm --build smoke
```

`test/smoke.sh` が 7 ケース (fetch 許可 / push 拒否 / readonly フォールバック / push 成功 / 偽 Authorization の上書き等) を通す。閉鎖環境で実 GitHub には到達しない。

## env_file の配置

```sh
mkdir -p ~/.config/devsbx
cp alternatives/git-mitm-proxy-addon/.env.example ~/.config/devsbx/mitm-github.env
chmod 600 ~/.config/devsbx/mitm-github.env
# 編集して GITHUB_PAT と ALLOWED_PUSH_REPOS を埋める
```

`required: false` で読むため、env_file 不在でも `docker compose up` は通る。

### GitHub PAT スコープの最小化

- Repository access: push 先リポジトリのみ
- Repository permissions: Contents read (or read+write)、Metadata read

PAT スコープと `ALLOWED_PUSH_REPOS` の両方で絞る。
