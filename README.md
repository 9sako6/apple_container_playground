# apple_container_playground

Tiny Bun server for checking whether a Docker Compose based Dev Container can
run under different container runtimes.

## Local

```sh
bun test
bun run dev
```

## Docker Compose

```sh
docker compose -f .devcontainer/compose.yaml up --build
curl http://127.0.0.1:3000/healthz
```

## Dev Container CLI

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bun test
```
