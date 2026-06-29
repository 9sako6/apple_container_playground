# Apple `container` でこの Dev Container を動かす調査

## 要約

このリポジトリの既存テストは、Apple `container` が管理しているコンテナに対して `devcontainer exec` 経由で実行できた。

ただし、Apple `container` が公式に Dev Container のバックエンドになったわけではない。今回通した経路は、Dev Container CLI の `--docker-path` に Bun 製の Docker CLI shim を渡すやり方。

自前 shim 以外の本命候補として、socktainer 経由も検討する価値がある。socktainer は Apple containerization libraries の上に Docker 互換 REST API を公開する daemon で、Docker CLI / Compose / Dev Container CLI を Docker API client としてそのまま使える可能性がある。

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

socktainer は Docker Engine API v1.51 互換を目標にした daemon。README では、Unix domain socket `$HOME/.socktainer/container.sock` で Docker 互換 REST API を公開し、起動時に `socktainer` Docker context を自動登録すると説明している。

参照:

- <https://github.com/socktainer/socktainer>
- <https://github.com/socktainer/socktainer/issues/14>
- <https://github.com/socktainer/socktainer/issues/90>

socktainer の互換性は partial。issue #14 の API parity table では、Dev Container CLI / Compose が使いそうな `/containers/json`、`/containers/create`、`/containers/{id}/json`、`/containers/{id}/start`、`/containers/{id}/stop`、`/containers/{id}/exec`、`/exec/{id}/start`、`/images/json`、`/build`、`/images/create`、`/volumes`、`/networks`、`/_ping`、`/version` は実装済みになっている。一方で、events parity は issue #90 で追跡されていて、全イベントが Docker と同じではない。

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

## socktainer 経由の検証

socktainer v1.0.0 を release binary で取得して検証した。Homebrew では、この環境だと `socktainer` 自体に bottle がなく、依存する `container` formula の source build が Xcode.app 26.0 要求で止まった。

release の `socktainer` asset は、GitHub API が返した digest と手元の `shasum -a 256` が一致した。

```text
8e41e8a75aaf9cb2fa938a7493bbc504d93bfbd14fbf09826d4c57d2150bd020
```

socktainer daemon は Apple Container 1.0.0 との互換チェックに通り、Docker API socket を起動できた。

```text
Server started on http+unix: $HOME/.socktainer/container.sock
```

Docker CLI からも socktainer server として見えた。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" docker version
```

確認結果:

```text
Server: socktainer
  Version: v1.0.0
  API version: v1.51
```

`docker ps`、`docker images`、`docker compose version` も通った。`docker compose version` は v5.1.1。

### 通った経路

Dev Container CLI の build 経路は使わず、Apple `container build` で image を事前に作る。

```sh
container build -t apple_container_playground-devcontainer -f .devcontainer/Dockerfile .
```

socktainer 用に `.devcontainer/compose.socktainer.yaml` と `.devcontainer/socktainer/devcontainer.json` を追加した。ポイントは次の3つ。

- Compose file から `build` を外し、事前 build した image を使う
- socktainer の既存 `default` network を external network として使う
- container ID の短縮表示を Dev Container CLI が inspect して失敗しないよう、`container_name: acp-dev` にする

この Compose 起動は通った。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  docker compose \
    --project-name apple_container_playground \
    -f .devcontainer/compose.socktainer.yaml \
    up -d
```

起動した container に対する `docker exec` も通った。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" docker exec acp-dev bun test
```

確認結果:

```text
test/server.test.ts:
(pass) devcontainer sample server > serves the root endpoint
(pass) devcontainer sample server > serves a health check

 2 pass
 0 fail
 5 expect() calls
```

### まだ通らない経路

既存 `.devcontainer/devcontainer.json` のまま、Dev Container CLI を socktainer socket に向けると build で止まる。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  devcontainer up --workspace-folder . --remove-existing-container
```

`--buildkit never` を付けても、Docker Compose v5.1.1 は buildx / BuildKit を起動し、`moby/buildkit:buildx-stable-1` を pull する経路に入った。socktainer 側では `/grpc` と `buildx_buildkit_default` inspect が見えて、ここで進まなかった。

socktainer 用 config で build を外しても、Dev Container CLI の `up` は container 起動後に戻らなかった。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  devcontainer up \
    --workspace-folder . \
    --config .devcontainer/socktainer/devcontainer.json \
    --remove-existing-container
```

socktainer 側では `acp-dev` の create/start まで到達していた。別 shell の `docker ps` でも `acp-dev` は running だった。

同じく Dev Container CLI の `exec` も、socktainer 側で `/containers/acp-dev/exec` と `/exec/.../start` までは到達するが戻らなかった。

```sh
DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  devcontainer exec \
    --workspace-folder . \
    --config .devcontainer/socktainer/devcontainer.json \
    bun test
```

一方で、直接の `docker exec acp-dev bun test` は成功する。したがって、現時点で確認できた実用経路は「socktainer + Docker Compose + Docker exec」であり、「socktainer + Dev Container CLI」はまだ完遂していない。

### 判断

自前 shim より socktainer 経由を優先したい理由は明確:

- Compose file の解釈をこのリポジトリで持たずに済む
- Dev Container CLI が期待する Docker API surface に近い
- `docker` が `PATH` にある普通の環境と同じ操作になる
- 複数 service、network、volume などを自前で再実装する圧力を避けられる

ただし、2026-06-30 時点のこの環境では Dev Container CLI まで socktainer に完全移行できていない。失敗点はこのリポジトリ側の Compose 解釈ではなく、Docker CLI / Compose / Dev Container CLI が socktainer に投げる Docker API の互換面にある。shim を拡張して追うより、socktainer 側に最小再現を寄せるほうが保守上は筋がよい。

## 制限

これはまだ実験コード。

Docker Compose の挙動を一般に実装しているわけではない。単一 service の devcontainer を想定している。複数 service、`depends_on`、Docker volume、複雑な network は扱っていない。

Dev Container Features も汎用対応していない。このリポジトリには Features が無いので、ここは未検証。

image inspect と container inspect も、Dev Container CLI が今回読んだ範囲だけを返している。

つまり、これは公式の Apple `container` backend ではない。標準的に使っている部分は Dev Container CLI の `--docker-path` と、Apple `container` の OCI build/run/exec。そこをつなぐ shim は実験用。

socktainer 経由がこの devcontainer で通るなら、shim は積極的に育てない。残すとしても「Docker CLI が無い、または socktainer が未導入の環境で単一 service を試すための最小 fallback」という位置づけにする。

## 後片付け

検証後は、Apple `container` 側のコンテナと builder を止める。

```sh
container delete --force apple_container_playground-apple_container_playground-devcontain
container builder stop
```
