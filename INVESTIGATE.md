# Apple `container` でこの Dev Container を動かす調査

## 要約

このリポジトリの既存テストは、Apple `container` が管理しているコンテナに対して `devcontainer exec` 経由で実行できた。

ただし、Apple `container` が公式に Dev Container のバックエンドになったわけではない。今回通した経路は、Dev Container CLI の `--docker-path` に Bun 製の Docker CLI shim を渡すやり方。

```sh
devcontainer up \
  --workspace-folder . \
  --docker-path "$PWD/tools/apple-container-docker-shim.js" \
  --remove-existing-container

devcontainer exec \
  --workspace-folder . \
  --docker-path "$PWD/tools/apple-container-docker-shim.js" \
  bun test
```

確認した結果:

```text
bun test v1.3.12 (700fc117)

test/server.test.ts:
(pass) devcontainer sample server > serves the root endpoint
(pass) devcontainer sample server > serves a health check

 2 pass
 0 fail
 5 expect() calls
```

`docker` が `PATH` に無い状態でも同じ `devcontainer up` と `devcontainer exec ... bun test` が通った。つまり、この shim が対応している範囲では Docker Desktop は不要。もちろん、Dev Container CLI の全機能を Apple `container` で動かせる、という意味ではない。

## 一次情報

Dev Container CLI は `devcontainer.json` を読み、開発用コンテナを作って設定する参照実装。README の例では `docker build`、`docker run`、`devcontainer exec` のように Docker CLI を呼び出している。

参照: <https://github.com/devcontainers/cli>

手元の `devcontainer up --help` と `devcontainer exec --help` でも、`--docker-path` と `--docker-compose-path` を受け取ることを確認した。今回使ったのはこの `--docker-path`。

Apple `container` 1.0.0 は、macOS 上で Linux コンテナを軽量 VM として build/run/exec する CLI。ドキュメントでは OCI 互換イメージを扱うと説明されていて、コマンドリファレンスにも `container build`、`container run`、`container exec` がある。

参照:

- <https://github.com/apple/container>
- <https://raw.githubusercontent.com/apple/container/1.0.0/docs/technical-overview.md>
- <https://raw.githubusercontent.com/apple/container/1.0.0/docs/command-reference.md>

Apple `container` 1.0.0 が Docker API endpoint や Docker Compose backend を提供している、という公式情報は見つけられなかった。手元の `docker context ls` にも Apple `container` 用の context は出てこなかった。

## 直接実行で引っかかった点

普通に次のコマンドを実行すると成功する。

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bun test
```

でも、この経路は現在の Docker context を使う。検証した環境では `docker context show` が `desktop-linux` を返し、`docker version` の Server も Docker Desktop だった。つまり、この成功は Docker Desktop 経由の成功であって、Apple `container` 経由ではなかった。

Apple `container` だけでも、このリポジトリのイメージは動かせた。

```sh
container build -t apple-container-playground-test -f .devcontainer/Dockerfile .
container run --rm \
  --workdir /workspace \
  --mount type=bind,source="$PWD",target=/workspace \
  apple-container-playground-test \
  bun test
```

これも `2 pass / 0 fail` になった。ただし、このやり方は Dev Container CLI を通っていない。

## 今回の実験

`tools/apple-container-docker-shim.js` は、Dev Container CLI が呼ぶ Docker CLI の一部を Apple `container` に写像する shim。汎用の Docker 互換レイヤではない。

今は、単一 service の Compose devcontainer を主な対象にしている。`devcontainer.json` の `dockerComposeFile` と `service` を読み、Compose file から build/image/environment/ports/volumes/command を拾う。

この shim は、`@devcontainers/cli 0.87.0` がよく呼ぶ Docker CLI の一部だけを受ける。

- `docker compose config`
- `docker compose build`
- `docker compose up -d`
- `docker ps`
- `docker inspect --type image`
- `docker inspect --type container`
- `docker exec`
- 最低限の `docker build`
- 最低限の `docker run`
- `docker -v`、`docker version`、`docker buildx version` などの確認用コマンド

受けたコマンドは Apple `container` の操作に置き換える。

- `container build` で Compose の build 設定にある Dockerfile をビルドする。
- `container run -d` で service のコンテナを起動し、Compose の bind mount、ports、environment、command を渡す。
- Dev Container CLI の shell server と最後の `bun test` には `container exec -i` を使う。
- Dev Container CLI がコンテナを見つけられるように、Docker っぽい `ps` と `inspect` の JSON を返す。

これで、実際のコンテナの起動と実行は Apple `container` に任せたまま、Dev Container CLI の `devcontainer exec` 経由でテストを流せた。

## 制限

これはまだ実験コード。

Docker Compose の挙動を一般に実装しているわけではない。単一 service の devcontainer を想定している。複数 service、`depends_on`、Docker volume、複雑な network は扱っていない。

Dev Container Features も汎用対応していない。このリポジトリには Features が無いので、ここは未検証。

image inspect と container inspect も、Dev Container CLI が今回読んだ範囲だけを返している。

つまり、これは公式の Apple `container` backend ではない。標準的に使っている部分は Dev Container CLI の `--docker-path` と、Apple `container` の OCI build/run/exec。そこをつなぐ shim は実験用。

## 後片付け

検証後は、Apple `container` 側のコンテナと builder を止める。

```sh
container delete --force apple_container_playground-apple_container_playground-devcontain
container builder stop
```
