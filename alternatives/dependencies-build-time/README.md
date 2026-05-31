# alternatives/dependencies-build-time/ — ビルド時インストール + dep-update サイドカー

npm / pnpm の依存パッケージのインストールをビルド時に閉じ込めて作業コンテナの実行時のレジストリへの外向き通信を経路レベルでゼロにし、パッケージ追加・更新は profile で隔離したサイドカー経由に強制する構成。

主推奨 (`integrated/single-workspace/` + mitm の読み取り専用許可で実行時にインストールを許す) に対するトレードオフ (AI エージェントから依存変更権限を完全に取り上げる代わりに DX を一部諦める) と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-dependencies-build-time.md](../../docs/appendix/alt-dependencies-build-time.md) — 主推奨との比較と採用シナリオ

## 使い方

```sh
# 1. 初回 lockfile 生成
docker compose -f alternatives/dependencies-build-time/compose.yaml \
  --profile tools run --rm dep-update pnpm install --lockfile-only

# 2. 作業コンテナのイメージをビルド (RUN pnpm install --frozen-lockfile で焼き込む)
docker compose -f alternatives/dependencies-build-time/compose.yaml build workspace

# 3. smoke
docker compose -f alternatives/dependencies-build-time/compose.yaml run --rm smoke

# 4. devcontainer として起動 (VS Code / Cursor で Reopen in Container)
#    作業コンテナ内では pnpm install を打たない (internal: true で外向き通信なし、失敗する)

# 5. 依存パッケージ追加 (人間がホスト側で打つ低頻度操作)
docker compose -f alternatives/dependencies-build-time/compose.yaml \
  --profile tools run --rm dep-update pnpm add some-package
docker compose -f alternatives/dependencies-build-time/compose.yaml build workspace  # 再ビルド
```

`test/smoke.sh` が 3 ケース (`node_modules` のイメージへの焼き込み / `registry.npmjs.org` への直接の外向き通信が `internal: true` で塞がれている / 焼き込まれたパッケージが読み込み可能) を通す。

## 注意点

- **pnpm のアトミックな rename 制約**: pnpm は lockfile を `pnpm-lock.yaml.<rand>` → `pnpm-lock.yaml` のアトミックな rename で書く。dep-update に `package.json` / `pnpm-lock.yaml` を **個別ファイル** でバインドマウントすると rename が `EBUSY` で失敗するため、ディレクトリ単位のフルマウント (`.:/work:cached`) を採用している
- **ビルド時インストールの postinstall スクリプトは走る**: イメージビルド時に各パッケージの postinstall が実行されるため、新規依存採用時は人間レビューが前提
- **dep-update の外向き通信はレジストリ全域**: 攻撃者が dep-update を起動できれば任意パッケージを fetch して lockfile に書き込める。`profiles: [tools]` で通常起動から外して作業コンテナ内の AI からの起動経路を断っている前提

## 関連

- [`../../recipes/git-gateway/`](../../recipes/git-gateway/) — 同テンプレ (プロキシ群 + 作業コンテナ自身は認可を制御できない) の先行レシピ
- [`../../lib/mitm-proxy/`](../../lib/mitm-proxy/) — 主推奨 (`integrated/single-workspace/`) で採用される読み取り専用許可 (本レシピと競合する設計の代替)
- [`../simple-http-proxy/`](../simple-http-proxy/) — 一般の外向き通信用の補助層 (本レシピで dep-update の外向き通信を更に絞る組み合わせも可能)
