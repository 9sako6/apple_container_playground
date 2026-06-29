# apple_container_playground

Apple `container` を Dev Container CLI から使う実験用リポジトリ。

Dev Container CLI は Docker CLI を呼ぶ前提で動く。Apple `container` 1.0.0 には Docker API や Docker Compose backend が見当たらないので、このリポジトリでは `--docker-path` に Bun 製の shim を渡す。

この shim が対応している範囲では Docker Desktop は不要。`docker` が `PATH` に無い状態でも、`devcontainer up` と `devcontainer exec ... bun test` が通ることを確認している。

## socktainer 経由

自前 shim の代わりに、[socktainer](https://github.com/socktainer/socktainer) が提供する Docker 互換 API socket を使う経路も試している。

socktainer は起動時に `$HOME/.socktainer/container.sock` で Docker 互換 REST API を公開し、`socktainer` Docker context も登録する。Dev Container CLI は内部で `docker` / `docker compose` を呼ぶので、Docker CLI を socktainer の socket に向ければ、Compose の解釈や Docker API の細部をこのリポジトリ側で持たずに済む可能性がある。

確認済みの範囲では、socktainer v1.0.0 経由で Docker API、Compose 起動、`docker exec` は動く。ただし Dev Container CLI の `up` / `exec` は container 起動や exec 開始までは進むが、完了待ちで戻らない。

socktainer は release binary を使った。Homebrew では、この環境だと依存する `container` formula の source build に Xcode.app 26.0 が必要で止まった。

グローバルな Docker context を切り替えずに試す:

```sh
socktainer
```

別の shell で:

```sh
container build -t apple_container_playground-devcontainer -f .devcontainer/Dockerfile .

DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  docker compose \
    --project-name apple_container_playground \
    -f .devcontainer/compose.socktainer.yaml \
    up -d

DOCKER_HOST="unix://$HOME/.socktainer/container.sock" \
  docker exec acp-dev bun test
```

socktainer 用の Compose file は `.devcontainer/compose.socktainer.yaml`。Dev Container CLI の build 経路が Docker Compose v5 / buildx 経由で止まるため、image は先に `container build` で作る。

## 実行

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

## 後片付け

```sh
container delete --force apple_container_playground-apple_container_playground-devcontain
container builder stop
```

shim は単一 service の Compose devcontainer を主な対象にしている。複数 service、`depends_on`、Docker volume、複雑な network、Dev Container Features までは扱っていない。

詳しい調査メモは [INVESTIGATE.md](./INVESTIGATE.md) にある。
