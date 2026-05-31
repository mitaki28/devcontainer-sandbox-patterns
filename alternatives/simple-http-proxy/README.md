# alternatives/simple-http-proxy/ — Squid によるホスト名許可リスト (独自 CA 不要)

Squid の `ssl_bump peek + splice` でホスト名の許可リストだけ通す構成。TLS 復号しないため独自 CA の配布が不要。`lib/mitm-proxy/` より軽量だが ACL 粒度はホスト名まで。

比較と採用シナリオは docs 付録で扱う:

- [docs/appendix/alt-simple-http-proxy.md](../../docs/appendix/alt-simple-http-proxy.md)

## 使い方

### smoke で疎通確認

```sh
docker compose -f test/compose.yaml up --build --abort-on-container-exit smoke
```

4 ケース (許可ホストへの HTTPS / 未許可ホストの拒否 / 直接 TCP の失敗 / CONNECT 詐称の遮断) を通す。閉鎖環境で外部には到達しない。

### devcontainer として起動

VS Code / Cursor で開いて「Reopen in Container」。`HTTP(S)_PROXY` が環境変数で渡るので、プロキシ対応の CLI はそのまま動く。

## 実装の罠

### Squid の二重 ACL (dstdomain + ssl::server_name)

CONNECT 行と ClientHello SNI の両方を独立に検査する:

- `dstdomain` で CONNECT 行のホスト名を照合。合致しなければ 403
- `ssl_bump peek + splice/terminate` で SNI を照合。合致しなければ TCP 切断。CONNECT 詐称 (許可ホストの IP 経由で別 tenant に飛ぶ) を塞ぐ

### 許可リストの単一ソース化

dstdomain と ssl::server_name は同じ `allowed-hosts.txt` を参照する。編集箇所が 1 つになり、両者のずれを防げる。

### `ssl::server_name --client-requested`

`ssl::server_name` はデフォルトで CONNECT URI / SNI / サーバ証明書の OR でマッチするため、CONNECT URI と重複して SNI 検査の意味がなくなる。`--client-requested` で SNI 値のみに限定する。

### `squid-openssl` パッケージ

`ssl_bump` には `squid-openssl` パッケージが必要。Dockerfile で内部用 CA を生成しているが、splice-only ではクライアントに提示されない (CA 配布不要)。
