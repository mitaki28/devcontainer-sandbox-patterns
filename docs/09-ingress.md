# レシピ: 開発サーバをホストブラウザに見せる

ここまでは外向き通信 (作業コンテナ → 外) のレシピだった。本章は内向き通信 — 作業コンテナ内の開発サーバ (`pnpm dev` の `:3000` 等) をホストブラウザから見る経路 — を扱う。

## 1. 章のスコープ

本章では経路の作り方と内向き通信の位置付けを整理する。個別実装の詳細は各レシピに譲る。

## 2. なぜリバースプロキシ層が要るか

`internal: true` は外向き通信だけでなくホスト側からのポート公開も無効化する ([03-foundation.md](./03-foundation.md))。そのため、内向き通信にも別コンテナのリバースプロキシ (Caddy) を立て、そこだけがホストへのポート公開を担う形にする。ホストブラウザは `127.0.0.1:8080` 経由でリバースプロキシに接続し、`Host` ヘッダで作業コンテナのポートにルーティングされる。

実装は単独起動と並列起動の 2 つに分かれる:

- [`recipes/ingress-single-workspace/`](../recipes/ingress-single-workspace/) — 単独起動の最小構成
- [`recipes/ingress-multi-workspace/`](../recipes/ingress-multi-workspace/) — 並列起動向け (詳細は [11-multi-workspace.md](./11-multi-workspace.md))

> [!NOTE]
> IDE 内蔵の port forward (`forwardPorts`) で済ませる選択肢もあるが、本書では外向き通信と対称に別コンテナのリバースプロキシで構成する。IDE 非依存で `compose.yaml` 単体でも動く形を優先するため。port forward で済ませる場合、本章以降の内向き通信は読み飛ばして問題ない

なお、本書が扱うのは外向き通信の制御 ([02-design.md](./02-design.md) §1) なので、内向き通信は脅威対策ではなく到達経路を作るための章である。

## 3. 次の章への接続

次章以降は、これまでのレシピを組み合わせた統合構成を扱う。

- [10-single-workspace.md](./10-single-workspace.md) — 作業コンテナ単独起動向けの構成
- [11-multi-workspace.md](./11-multi-workspace.md) — 作業コンテナ並列起動向けの構成
