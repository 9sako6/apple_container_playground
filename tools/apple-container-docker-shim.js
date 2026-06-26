#!/usr/bin/env bun
// Dev Container CLI を Apple container へ向けるための Docker CLI shim。
//
// 汎用 Docker 互換レイヤではない。Dev Container CLI がよく使う Docker CLI の
// 一部だけを受け、Apple `container` の build/run/exec に写像する。
// 対象は「dockerComposeFile を持つ、単一 service の devcontainer」。複数 service、
// depends_on、network、volume driver、Dev Container Features などはまだ扱わない。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const root = resolve(process.cwd());
const defaultStatePath = `/tmp/apple-container-devcontainer-${hashText(root)}.json`;
const statePath = process.env.APPLE_CONTAINER_SHIM_STATE ?? defaultStatePath;

// Dev Container CLI は Docker daemon の label 検索でコンテナを見つけ直す。
// Apple container には Docker daemon がないので、この shim が state file で覚える。
const devcontainer = readDevcontainerConfig();
const composeFiles = normalizeArray(devcontainer.dockerComposeFile ?? "compose.yaml").map((file) =>
  resolvePath(dirname(devcontainer.path), file),
);
const composeBase = dirname(composeFiles[0]);
const compose = readComposeConfig(composeFiles[0]);
const project = compose.name ?? basenameSafe(root);
const serviceName = devcontainer.service ?? firstKey(compose.services);
const service = compose.services[serviceName];

if (!service) {
  fail(`compose service not found: ${serviceName}`);
}

const image = service.image ?? `${project}-${serviceName}-devcontainer`;
const containerId = sanitizeContainerName(`${project}-${serviceName}-devcontainer`);
const workspaceFolder = devcontainer.workspaceFolder ?? firstContainerWorkspace(service.volumes) ?? "/workspace";
const configFile = devcontainer.path;

function readDevcontainerConfig() {
  const candidates = [join(root, ".devcontainer", "devcontainer.json"), join(root, ".devcontainer.json")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    fail("devcontainer.json not found");
  }
  return { ...JSON.parse(readFileSync(path, "utf8")), path };
}

function readComposeConfig(path) {
  if (!existsSync(path)) {
    fail(`compose file not found: ${path}`);
  }
  return parseSimpleYaml(readFileSync(path, "utf8"));
}

function parseSimpleYaml(text) {
  // Compose 全体を読む parser ではない。devcontainer でよく出る素直な YAML だけ読む。
  // 今扱う形は、mapping、list、list item 内の mapping、quoted scalar、inline array。
  const rootNode = {};
  const stack = [{ indent: -1, value: rootNode }];
  const lines = text.replaceAll("\t", "  ").split(/\r?\n/);

  for (const rawLine of lines) {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === "") {
      continue;
    }

    const indent = withoutComment.match(/^ */)[0].length;
    const line = withoutComment.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        fail(`unsupported YAML list placement near: ${rawLine}`);
      }
      const itemText = line.slice(2).trim();
      if (itemText.includes(": ")) {
        const [key, valueText] = splitOnce(itemText, ":");
        const item = { [key.trim()]: parseScalar(valueText.trim()) };
        parent.push(item);
        stack.push({ indent, value: item });
      } else {
        parent.push(parseScalar(itemText));
      }
      continue;
    }

    const [key, valueTextRaw] = splitOnce(line, ":");
    const keyText = key.trim();
    const valueText = valueTextRaw.trim();

    if (valueText !== "") {
      parent[keyText] = parseScalar(valueText);
      continue;
    }

    const nextContainer = nextMeaningfulLine(lines, rawLine);
    const value = nextContainer?.trim().startsWith("- ") ? [] : {};
    parent[keyText] = value;
    stack.push({ indent, value });
  }

  return rootNode;
}

function stripYamlComment(line) {
  let quote = null;
  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    if ((char === '"' || char === "'") && line[idx - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && quote === null) {
      return line.slice(0, idx);
    }
  }
  return line;
}

function nextMeaningfulLine(lines, currentRawLine) {
  const start = lines.indexOf(currentRawLine) + 1;
  for (const line of lines.slice(start)) {
    if (stripYamlComment(line).trim() !== "") {
      return stripYamlComment(line);
    }
  }
  return null;
}

function parseScalar(value) {
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((part) => parseScalar(part.trim()))
      .filter((part) => part !== "");
  }
  return value;
}

function runContainer(args, options = {}) {
  // `container build` のログはそのまま見せる。失敗時の原因がここに出るため。
  const result = spawnSync("container", args, {
    stdio: options.stdio ?? "inherit",
    input: options.input,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function captureContainer(args) {
  return spawnSync("container", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function loadState() {
  if (!existsSync(statePath)) {
    return {};
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function labels() {
  return {
    "devcontainer.local_folder": root,
    "devcontainer.config_file": configFile,
    "com.docker.compose.project": project,
    "com.docker.compose.service": serviceName,
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function composeConfig() {
  // Docker Compose の正規化 YAML を完全再現する必要はない。Dev Container CLI が読む
  // service、build、image、env、ports、volumes、command が分かる形にして返す。
  process.stdout.write(`name: ${project}\nservices:\n`);
  process.stdout.write(renderServiceConfig(serviceName, normalizedService()));
  process.stdout.write(`networks:\n  default:\n    name: ${project}_default\n`);
}

function normalizedService() {
  const build = normalizeBuild(service.build);
  const environment = normalizeEnvironment(service.environment);
  const ports = normalizePorts(service.ports);
  const volumes = normalizeVolumes(service.volumes);
  const command = normalizeCommand(service.command);
  return { build, environment, ports, volumes, command, image };
}

function renderServiceConfig(name, normalized) {
  const lines = [`  ${name}:`];
  if (normalized.build) {
    lines.push("    build:");
    lines.push(`      context: ${normalized.build.context}`);
    lines.push(`      dockerfile: ${normalized.build.dockerfile}`);
  }
  if (normalized.command.length > 0) {
    lines.push("    command:");
    for (const part of normalized.command) lines.push(`      - ${part}`);
  }
  if (Object.keys(normalized.environment).length > 0) {
    lines.push("    environment:");
    for (const [key, value] of Object.entries(normalized.environment)) lines.push(`      ${key}: "${value}"`);
  }
  lines.push(`    image: ${normalized.image}`);
  lines.push("    networks:");
  lines.push("      default: null");
  if (normalized.ports.length > 0) {
    lines.push("    ports:");
    for (const port of normalized.ports) {
      lines.push("      - mode: ingress");
      lines.push(`        target: ${port.container}`);
      lines.push(`        published: "${port.host}"`);
      lines.push(`        protocol: ${port.protocol}`);
    }
  }
  if (normalized.volumes.length > 0) {
    lines.push("    volumes:");
    for (const volume of normalized.volumes) {
      lines.push("      - type: bind");
      lines.push(`        source: ${volume.source}`);
      lines.push(`        target: ${volume.target}`);
      lines.push("        bind: {}");
    }
  }
  return `${lines.join("\n")}\n`;
}

function composeBuild() {
  const build = normalizeBuild(service.build);
  if (!build) {
    return;
  }
  runContainer(["build", "-t", image, "-f", build.dockerfile, build.context]);
}

function composeUp() {
  const normalized = normalizedService();
  captureContainer(["delete", "--force", containerId]);

  const args = ["run", "-d", "--name", containerId];
  for (const [key, value] of Object.entries(labels())) args.push("-l", `${key}=${value}`);
  for (const [key, value] of Object.entries(normalized.environment)) args.push("-e", `${key}=${value}`);
  for (const port of normalized.ports) args.push("-p", `${port.host}:${port.container}/${port.protocol}`);
  for (const volume of normalized.volumes) args.push("--mount", `type=bind,source=${volume.source},target=${volume.target}`);
  args.push("--workdir", workspaceFolder, image, ...normalized.command);

  runContainer(args);
  saveState({
    id: containerId,
    created: new Date().toISOString(),
    image,
    command: normalized.command,
    environment: normalized.environment,
    ports: normalized.ports,
    volumes: normalized.volumes,
    workspaceFolder,
  });
}

function imageInspect(name) {
  const normalized = normalizedService();
  return [
    {
      Id: `sha256:${name}`,
      RepoTags: [name],
      Architecture: "arm64",
      Os: "linux",
      Config: {
        User: "",
        Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        Entrypoint: null,
        Cmd: normalized.command,
        WorkingDir: workspaceFolder,
        Labels: {},
      },
    },
  ];
}

function containerInspect(target) {
  const state = loadState();
  if (target !== containerId && target !== state.id) {
    return [];
  }
  const env = {
    ...state.environment,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin",
    LANG: "C.UTF-8",
    HOME: "/root",
  };
  return [
    {
      Id: containerId,
      Name: `/${containerId}`,
      Created: state.created ?? new Date().toISOString(),
      Path: state.command?.[0] ?? "sh",
      Args: state.command?.slice(1) ?? [],
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        OOMKilled: false,
        Dead: false,
        Pid: 1,
        ExitCode: 0,
      },
      Config: {
        Hostname: containerId.slice(0, 12),
        User: "",
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Cmd: state.command ?? [],
        Image: state.image ?? image,
        WorkingDir: state.workspaceFolder ?? workspaceFolder,
        Entrypoint: null,
        Labels: labels(),
      },
      NetworkSettings: {
        Ports: Object.fromEntries(
          (state.ports ?? []).map((port) => [`${port.container}/${port.protocol}`, [{ HostIp: "0.0.0.0", HostPort: String(port.host) }]]),
        ),
      },
      Mounts: (state.volumes ?? []).map((volume) => ({
        Type: "bind",
        Source: volume.source,
        Destination: volume.target,
        Mode: volume.mode ?? "",
        RW: !volume.readonly,
      })),
    },
  ];
}

function dockerPs() {
  if (loadState().id === containerId) {
    process.stdout.write(`${containerId}\n`);
  }
}

function dockerBuild(args) {
  let tag = image;
  let file = join(root, ".devcontainer", "Dockerfile");
  let context = root;
  for (let idx = 0; idx < args.length; idx += 1) {
    if (args[idx] === "-t" || args[idx] === "--tag") tag = args[++idx];
    else if (args[idx] === "-f" || args[idx] === "--file") file = resolvePath(root, args[++idx]);
    else if (!args[idx].startsWith("-")) context = resolvePath(root, args[idx]);
    else if (["--build-arg", "--target", "--cache-from", "--cache-to", "--label"].includes(args[idx])) idx += 1;
  }
  runContainer(["build", "-t", tag, "-f", file, context]);
}

function dockerRun(args) {
  // 非 Compose 型 devcontainer の最低限の逃げ道。Dev Container CLI が docker run を
  // 使う設定でも、よくある -d/-e/-v/-w/--name だけ Apple container に渡す。
  const mapped = ["run"];
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (["-d", "--rm", "-i", "-t"].includes(arg)) mapped.push(arg);
    else if (["--name", "-e", "--env", "-p", "--publish", "--workdir", "-w", "--user", "-u", "-l", "--label", "--mount"].includes(arg)) {
      mapped.push(arg, args[++idx]);
    } else if (arg === "-v" || arg === "--volume") {
      mapped.push("--mount", volumeFlagToMount(args[++idx]));
    } else {
      mapped.push(...args.slice(idx));
      break;
    }
  }
  runContainer(mapped);
}

function dockerExec(args) {
  const passthrough = [];
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx];
    if (arg === "-i" || arg === "--interactive") {
      passthrough.push("-i");
      idx += 1;
    } else if (arg === "-u" || arg === "--user") {
      passthrough.push("--user", args[idx + 1]);
      idx += 2;
    } else if (arg === "-w" || arg === "--workdir" || arg === "--cwd") {
      passthrough.push("--workdir", args[idx + 1]);
      idx += 2;
    } else if (arg === "-e" || arg === "--env") {
      passthrough.push("-e", args[idx + 1]);
      idx += 2;
    } else if (arg.startsWith("-")) {
      idx += 1;
    } else {
      break;
    }
  }
  if (idx >= args.length) return 1;
  const target = args[idx];
  const command = args.slice(idx + 1);
  const result = spawnSync("container", ["exec", ...passthrough, target, ...command], { stdio: "inherit" });
  return result.status ?? 1;
}

function normalizeBuild(build) {
  if (!build) return null;
  if (typeof build === "string") {
    const context = resolvePath(composeBase, build);
    return { context, dockerfile: join(context, "Dockerfile") };
  }
  const context = resolvePath(composeBase, build.context ?? ".");
  return { context, dockerfile: resolvePath(context, build.dockerfile ?? "Dockerfile") };
}

function normalizeCommand(command) {
  if (Array.isArray(command)) return command.map(String);
  if (typeof command === "string") return command.split(/\s+/).filter(Boolean);
  return [];
}

function normalizeEnvironment(environment) {
  if (!environment) return {};
  if (Array.isArray(environment)) {
    return Object.fromEntries(environment.map((entry) => splitOnce(String(entry), "=")).map(([key, value]) => [key, value ?? ""]));
  }
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, String(value)]));
}

function normalizePorts(ports) {
  if (!ports) return [];
  return ports.map((port) => {
    if (typeof port === "object") {
      return { host: String(port.published ?? port.target), container: String(port.target), protocol: port.protocol ?? "tcp" };
    }
    const [hostAndContainer, protocol = "tcp"] = String(port).split("/");
    const parts = hostAndContainer.split(":");
    const container = parts.at(-1);
    const host = parts.length > 1 ? parts.at(-2) : container;
    return { host, container, protocol };
  });
}

function normalizeVolumes(volumes) {
  if (!volumes) return [];
  return volumes.map((volume) => {
    if (typeof volume === "object") {
      return { source: resolvePath(composeBase, volume.source), target: volume.target, readonly: volume.read_only ?? volume.readonly ?? false };
    }
    const [source, target, mode = ""] = String(volume).split(":");
    return { source: resolvePath(composeBase, source), target, mode, readonly: mode.includes("ro") };
  });
}

function firstContainerWorkspace(volumes) {
  return normalizeVolumes(volumes).find((volume) => volume.source === root)?.target;
}

function volumeFlagToMount(value) {
  const [source, target, mode = ""] = String(value).split(":");
  const readonly = mode.includes("ro") ? ",readonly" : "";
  return `type=bind,source=${resolvePath(root, source)},target=${target}${readonly}`;
}

function main(args) {
  if (args.length === 0) return 0;

  if (args.length === 2 && args[0] === "buildx" && args[1] === "version") {
    console.log("github.com/docker/buildx v0.0.0");
    return 0;
  }
  if (args[0] === "version") {
    console.log(args.includes("--format") ? "29.0.0" : "Docker version 29.0.0, build apple-container-shim");
    return 0;
  }
  if (args.length === 1 && args[0] === "-v") {
    console.log("Docker version 29.0.0, build apple-container-shim");
    return 0;
  }
  if (args[0] === "compose" && args[1] === "version") {
    console.log("2.0.0");
    return 0;
  }
  if (args[0] === "compose") {
    if (args.includes("config")) return runAndReturn(composeConfig);
    if (args.includes("build")) return runAndReturn(composeBuild);
    if (args.includes("up")) return runAndReturn(composeUp);
  }
  if (args[0] === "events") return 0;
  if (args[0] === "ps") return runAndReturn(dockerPs);
  if (args[0] === "build") return runAndReturn(() => dockerBuild(args.slice(1)));
  if (args[0] === "run") return runAndReturn(() => dockerRun(args.slice(1)));
  if (args[0] === "inspect") return dockerInspect(args.slice(1));
  if (args[0] === "exec") return dockerExec(args.slice(1));

  console.error(`unsupported docker shim command: ${JSON.stringify(args)}`);
  return 1;
}

function dockerInspect(args) {
  let type = null;
  const targets = [];
  for (let idx = 0; idx < args.length; idx += 1) {
    if (args[idx] === "--type") type = args[++idx];
    else targets.push(args[idx]);
  }
  const target = targets.at(-1) ?? "";
  if (type === "image") return runAndReturn(() => printJson(imageInspect(target)));
  if (type === "container") {
    const inspected = containerInspect(target);
    if (inspected.length === 0) return 1;
    printJson(inspected);
    return 0;
  }
  return 1;
}

function runAndReturn(fn) {
  fn();
  return 0;
}

function resolvePath(base, path) {
  if (!path || path === ".") return base;
  if (path === "..") return dirname(base);
  return isAbsolute(path) ? path : resolve(base, path);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [value];
}

function firstKey(object) {
  return Object.keys(object ?? {})[0];
}

function basenameSafe(path) {
  return path.split("/").filter(Boolean).at(-1) ?? "devcontainer";
}

function sanitizeContainerName(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function hashText(value) {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

process.exit(main(Bun.argv.slice(2)));
