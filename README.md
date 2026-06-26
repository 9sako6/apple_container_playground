# apple_container_playground

Apple `container` を Dev Container CLI から使う実験用リポジトリ。

Dev Container CLI は Docker CLI を呼ぶ前提で動く。Apple `container` 1.0.0 には Docker API や Docker Compose backend が見当たらないので、このリポジトリでは `--docker-path` に Bun 製の shim を渡す。

この shim が対応している範囲では Docker Desktop は不要。`docker` が `PATH` に無い状態でも、`devcontainer up` と `devcontainer exec ... bun test` が通ることを確認している。

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
