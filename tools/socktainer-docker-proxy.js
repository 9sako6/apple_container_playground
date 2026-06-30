#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const docker = process.env.SOCKTAINER_DOCKER_BIN ?? "/usr/local/bin/docker";
const dockerHost = process.env.SOCKTAINER_DOCKER_HOST ?? `unix://${process.env.HOME}/.socktainer/container.sock`;
const logPath = process.env.SOCKTAINER_PROXY_LOG ?? "/tmp/socktainer-docker-proxy.log";
const originalArgs = Bun.argv.slice(2);
const args = patchArgs(originalArgs);

function log(event, extra = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      args: originalArgs,
      patchedArgs: args,
      ...extra,
    })}\n`,
  );
}

log("start");

if (isStartEventsCommand(args)) {
  const status = fakeStartEvents();
  if (typeof status === "number") {
    process.exit(status);
  }
  await new Promise(() => {});
}

const result = spawnSync(docker, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    DOCKER_HOST: dockerHost,
  },
});

log("exit", {
  status: result.status,
  signal: result.signal,
  error: result.error?.message,
});

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);

function isStartEventsCommand(args) {
  return args[0] === "events" && args.includes("--filter") && args.includes("event=start");
}

function patchArgs(args) {
  if (args[0] !== "exec" || process.env.SOCKTAINER_KEEP_INTERACTIVE === "1") {
    return args;
  }
  if (isInteractiveShellServer(args)) {
    return args;
  }
  return args.filter((arg) => arg !== "-i" && arg !== "--interactive");
}

function isInteractiveShellServer(args) {
  const command = execCommand(args);
  return command.length === 1 && command[0] === "/bin/sh";
}

function execCommand(args) {
  for (let idx = 1; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg === "-i" || arg === "--interactive" || arg === "-t" || arg === "--tty") {
      continue;
    }
    if (["-u", "--user", "-e", "--env", "-w", "--workdir", "--cwd"].includes(arg)) {
      idx += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return args.slice(idx + 1);
  }
  return [];
}

function fakeStartEvents() {
  const target = process.env.SOCKTAINER_DEVCONTAINER_NAME ?? "acp-dev";
  const deadline = Date.now() + Number(process.env.SOCKTAINER_EVENTS_TIMEOUT_MS ?? "30000");

  while (Date.now() < deadline) {
    const inspected = inspectContainer(target);
    if (inspected?.State?.Running) {
      const now = Date.now();
      const event = {
        status: "start",
        id: inspected.Id,
        Type: "container",
        Action: "start",
        Actor: {
          ID: inspected.Id,
          Attributes: inspected.Config?.Labels ?? {},
        },
        time: Math.floor(now / 1000),
        timeNano: now * 1_000_000,
      };
      process.stdout.write(`${JSON.stringify(event)}\n`);
      log("fake-start-event", { container: target });
      keepAlive();
      return 0;
    }
    sleep(200);
  }

  log("fake-start-event-timeout", { container: target });
  return 1;
}

function inspectContainer(name) {
  const result = spawnSync(docker, ["inspect", "--type", "container", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      DOCKER_HOST: dockerHost,
    },
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout)[0] ?? null;
  } catch {
    return null;
  }
}

function keepAlive() {
  setInterval(() => {}, 60_000);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
