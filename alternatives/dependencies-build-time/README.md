# alternatives/dependencies-build-time/ — ビルド時インストール + dep-update サイドカー

依存パッケージのインストールをビルド時に閉じ込め、作業コンテナの実行時にレジストリへの通信を不要にする構成。パッケージ追加は `profiles: [tools]` で隔離した dep-update サイドカー経由で行う。

比較と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-dependencies-build-time.md](../../docs/appendix/alt-dependencies-build-time.md)

## 使い方

```sh
# 1. 初回 lockfile 生成
docker compose -f alternatives/dependencies-build-time/compose.yaml \
  --profile tools run --rm dep-update pnpm install --lockfile-only

# 2. 作業コンテナのイメージをビルド
docker compose -f alternatives/dependencies-build-time/compose.yaml build workspace

# 3. smoke
docker compose -f alternatives/dependencies-build-time/compose.yaml run --rm smoke

# 4. devcontainer として起動 (VS Code / Cursor で Reopen in Container)

# 5. 依存パッケージ追加
docker compose -f alternatives/dependencies-build-time/compose.yaml \
  --profile tools run --rm dep-update pnpm add some-package
docker compose -f alternatives/dependencies-build-time/compose.yaml build workspace  # 再ビルド
```

## 実装の罠

- **pnpm の rename 制約**: pnpm は lockfile をアトミックな rename で書くため、`package.json` / `pnpm-lock.yaml` を個別ファイルでバインドマウントすると `EBUSY` で失敗する。ディレクトリ単位のマウント (`.:/work:cached`) が必要
