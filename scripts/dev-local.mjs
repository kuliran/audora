#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));
const backendRoot = join(repositoryRoot, "packages", "backend");
const webRoot = join(repositoryRoot, "apps", "web");
const localToolchainRoot = join(repositoryRoot, ".audora-local", "toolchain");
const localNode = join(
  localToolchainRoot,
  "node_modules",
  "node",
  "bin",
  "node"
);
const localToolBin = join(
  localToolchainRoot,
  "node_modules",
  ".bin"
);
const webCli = join(webRoot, "node_modules", "@react-router", "dev", "bin.js");
const convexCli = join(backendRoot, "node_modules", "convex", "bin", "main.js");
const convexLauncher = join(backendRoot, "scripts", "convex-local-loopback.cjs");
const backendSelectorPath = join(backendRoot, ".env.local");
const backendFallbackEnvironmentPath = join(backendRoot, ".env");
const webEnvironmentCandidates = [
  { path: join(webRoot, ".env"), privateFile: false },
  { path: join(webRoot, ".env.local"), privateFile: true },
  { path: join(webRoot, ".env.development"), privateFile: false },
  { path: join(webRoot, ".env.development.local"), privateFile: true },
];
const anonymousStateRoot = join(
  homedir(),
  ".convex",
  "anonymous-convex-backend-state"
);
const globalConvexLoginConfigPath = join(homedir(), ".convex", "config.json");

process.umask(0o077);

const WEB_ORIGIN = "http://127.0.0.1:5173";
const CONVEX_URL = "http://127.0.0.1:3210";
const CONVEX_SITE_URL = "http://127.0.0.1:3211";
const CODEX_BRIDGE_URL = `${WEB_ORIGIN}/api/local-codex`;
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2_000;
const CONFIGURATION_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 4_000;
const TERMINATE_GRACE_MS = 2_000;
const FINAL_KILL_WAIT_MS = 1_000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const ALLOWED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const REQUIRED_PORTS = [
  { port: 5173, service: "web, JWT, and Codex bridge" },
  { port: 3210, service: "local Convex API" },
  { port: 3211, service: "local Convex HTTP actions" },
];
const SAFE_WEB_ENVIRONMENT = new Map([
  ["VITE_LOCAL_AUTH", "true"],
  ["VITE_CONVEX_URL", CONVEX_URL],
  ["VITE_CONVEX_SITE_URL", CONVEX_SITE_URL],
  ["VITE_CLERK_PUBLISHABLE_KEY", ""],
  ["VITE_CLERK_FRONTEND_API_URL", ""],
  ["CLERK_SECRET_KEY", ""],
]);
const CLOUD_ENVIRONMENT_PREFIXES = [
  "CLERK_",
  "NOTION_",
  "OPENAI_",
  "POLAR_",
  "SPEECHMATICS_",
  "VAPI_",
  "VITE_CLERK_",
  "ZEP_",
];

function supervisorLog(message = "") {
  process.stdout.write(message ? `[audora] ${message}\n` : "\n");
}

function supervisorError(message) {
  process.stderr.write(`[audora] ${message}\n`);
}

function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

async function requireLocalNode() {
  let expectedNode;
  try {
    const metadata = await lstat(localNode);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("unsafe runtime file");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("runtime owned by another user");
    }
    await access(localNode, fsConstants.X_OK);
    expectedNode = await realpath(localNode);
    const expectedToolchain = await realpath(localToolchainRoot);
    if (
      expectedToolchain !== localToolchainRoot ||
      !expectedNode.startsWith(`${expectedToolchain}${sep}`)
    ) {
      throw new Error("runtime escaped the private toolchain");
    }
  } catch {
    throw new Error(
      `The repository-local Node 24 runtime is missing at ${localNode}. ` +
        "Run the one-time local setup script first."
    );
  }

  const currentNode = await realpath(process.execPath);
  if (currentNode === expectedNode) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (nodeMajor !== 24) {
      throw new Error(
        `The repository-local runtime must be Node 24 (found ${process.versions.node}). ` +
          "Run the one-time local setup script again."
      );
    }
    return false;
  }

  const child = spawn(expectedNode, [scriptPath, ...process.argv.slice(2)], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  let forwardedSignal;
  const signalHandlers = new Map();
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = () => {
      forwardedSignal = signal;
      try {
        child.kill(signal);
      } catch {
        // The repository-local process may already have completed.
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  });

  process.exit(result.code ?? signalExitCode(result.signal ?? forwardedSignal));
}

function parseStrictEnvironment(contents, label) {
  const values = new Map();
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label} contains an unsupported entry on line ${index + 1}`);
    }

    const [, name, rawValue] = match;
    if (values.has(name)) {
      throw new Error(`${label} defines ${name} more than once`);
    }

    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }

  return values;
}

async function readPrivateRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing at ${path}`);
    }
    throw error;
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and must not be a symbolic link`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`${label} must not have additional hard links`);
  }
  if (metadata.size > 64 * 1024) {
    throw new Error(`${label} is unexpectedly large`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private (run: chmod 600 ${path})`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }

  const contents = await readFile(path, "utf8");
  if (contents.includes("\0")) {
    throw new Error(`${label} contains a NUL byte`);
  }
  return contents;
}

async function validateBackendSelector() {
  let contents;
  try {
    contents = await readPrivateRegularFile(
      backendSelectorPath,
      "The local Convex selector"
    );
  } catch (error) {
    if (String(error?.message).includes(" is missing at ")) {
      throw new Error(
        `${error.message}. Run the one-time local setup script before launching Audora.`
      );
    }
    throw error;
  }

  const values = parseStrictEnvironment(contents, "packages/backend/.env.local");
  const allowedNames = new Set(["CONVEX_DEPLOYMENT", "CONVEX_URL", "CONVEX_SITE_URL"]);
  for (const name of values.keys()) {
    if (!allowedNames.has(name)) {
      throw new Error(`packages/backend/.env.local contains unsupported assignment ${name}`);
    }
  }
  const deployment = values.get("CONVEX_DEPLOYMENT") ?? "";
  if (!/^anonymous:anonymous-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(deployment)) {
    throw new Error(
      "packages/backend/.env.local must select an anonymous local Convex deployment; " +
        "refusing to launch against a cloud or unknown deployment"
    );
  }
  if (values.get("CONVEX_URL") !== CONVEX_URL) {
    throw new Error(`packages/backend/.env.local must set CONVEX_URL exactly to ${CONVEX_URL}`);
  }
  if (
    values.has("CONVEX_SITE_URL") &&
    values.get("CONVEX_SITE_URL") !== CONVEX_SITE_URL
  ) {
    throw new Error(
      `packages/backend/.env.local must set CONVEX_SITE_URL exactly to ${CONVEX_SITE_URL}`
    );
  }
  return deployment.slice("anonymous:".length);
}

async function validatePrivateDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing at ${path}`);
    }
    throw error;
  }

  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a directory and not a symbolic link`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`${label} path must not contain symbolic links`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private (run: chmod 700 ${path})`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

async function validateAnonymousState(deploymentName) {
  const deploymentDirectory = join(anonymousStateRoot, deploymentName);
  await validatePrivateDirectory(anonymousStateRoot, "The anonymous Convex state root");
  await validatePrivateDirectory(
    deploymentDirectory,
    `The anonymous Convex deployment ${deploymentName}`
  );

  const configPath = join(deploymentDirectory, "config.json");
  const contents = await readPrivateRegularFile(
    configPath,
    `The anonymous Convex deployment config for ${deploymentName}`
  );
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new Error(`The anonymous Convex deployment config for ${deploymentName} is invalid`);
  }
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    config?.ports?.cloud !== 3210 ||
    config?.ports?.site !== 3211 ||
    config.backendVersion !== "precompiled-2026-08-10-c0cb7ae" ||
    typeof config.adminKey !== "string" ||
    !config.adminKey.startsWith(`${deploymentName}|`) ||
    !/^[a-f0-9]{64,512}$/.test(config.adminKey.slice(deploymentName.length + 1)) ||
    typeof config.instanceSecret !== "string" ||
    !/^[a-f0-9]{64,512}$/.test(config.instanceSecret)
  ) {
    throw new Error(
      `The anonymous Convex deployment config for ${deploymentName} does not match this launcher`
    );
  }
}

async function refuseGlobalConvexLogin() {
  try {
    await lstat(globalConvexLoginConfigPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `A Convex account login is present at ${globalConvexLoginConfigPath}. ` +
      "Log out of the Convex CLI before launching this anonymous local-only deployment."
  );
}

async function validateBackendFallbackEnvironment() {
  let metadata;
  try {
    metadata = await lstat(backendFallbackEnvironmentPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error("packages/backend/.env must be a regular file without additional links");
  }
  if (metadata.size > 64 * 1024 || (metadata.mode & 0o022) !== 0) {
    throw new Error("packages/backend/.env has unsafe size or write permissions");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("packages/backend/.env must be owned by the current user");
  }
  const contents = await readFile(backendFallbackEnvironmentPath, "utf8");
  if (contents.includes("\0")) {
    throw new Error("packages/backend/.env contains a NUL byte");
  }
  const values = parseStrictEnvironment(contents, "packages/backend/.env");
  if (values.size > 0) {
    throw new Error(
      "packages/backend/.env must not contain assignments in the fixed local setup"
    );
  }
}

async function validateWebEnvironment() {
  for (const candidate of webEnvironmentCandidates) {
    let metadata;
    try {
      metadata = await lstat(candidate.path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const label = candidate.path.slice(repositoryRoot.length + 1);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${label} must be a regular file without additional links`);
    }
    if (metadata.size > 64 * 1024 || (metadata.mode & 0o022) !== 0) {
      throw new Error(`${label} has unsafe size or write permissions`);
    }
    if (candidate.privateFile && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must be private (run: chmod 600 ${candidate.path})`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }

    const contents = await readFile(candidate.path, "utf8");
    if (contents.includes("\0")) {
      throw new Error(`${label} contains a NUL byte`);
    }
    const values = parseStrictEnvironment(contents, label);
    for (const [name, value] of values) {
      const expectedValue = SAFE_WEB_ENVIRONMENT.get(name);
      if (expectedValue === undefined || value !== expectedValue) {
        throw new Error(
          `${label} contains ${name}, which is not part of the fixed local setup. ` +
            "Remove that entry and pass supported Codex overrides in the launch command instead."
        );
      }
    }
  }
}

async function requireInstalledDependencies() {
  const paths = [webCli, convexCli, convexLauncher];
  for (const path of paths) {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(
        `A required local dependency is missing at ${path}. ` +
          "Run the one-time local setup script again."
      );
    }
  }
}

async function assertPortAvailable({ port, service }) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    const cleanup = () => {
      server.removeAllListeners();
    };
    server.once("error", (error) => {
      cleanup();
      if (error?.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} required by ${service} is already in use. ` +
              `Stop the existing process and inspect it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`
          )
        );
        return;
      }
      reject(new Error(`Could not reserve 127.0.0.1:${port}: ${error.message}`));
    });
    server.once("listening", () => {
      server.close((error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      });
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function preflightPorts() {
  for (const requiredPort of REQUIRED_PORTS) {
    await assertPortAvailable(requiredPort);
  }
}

function sanitizedLocalEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("VITE_") ||
      CLOUD_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }

  for (const name of [
    "AUDORA_AI_PROVIDER",
    "AUDORA_CODEX_BRIDGE_TOKEN",
    "AUDORA_CODEX_BRIDGE_URL",
    "CONVEX_AGENT_MODE",
    "CONVEX_ALLOW_ANONYMOUS",
    "CONVEX_CLOUD_URL",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT",
    "CONVEX_OVERRIDE_ACCESS_TOKEN",
    "CONVEX_PROVISION_HOST",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SITE_URL",
    "CONVEX_URL",
    "FRONTEND_URL",
  ]) {
    delete environment[name];
  }

  return {
    ...environment,
    CI: "1",
    PATH: [dirname(localNode), localToolBin, environment.PATH]
      .filter(Boolean)
      .join(delimiter),
    SENTRY_DSN: "",
    ...overrides,
  };
}

function prefixOutput(stream, label, destination) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let swallowLeadingLineFeed = false;

  const writeLine = () => {
    destination.write(`[${label}]${pending ? ` ${pending}` : ""}\n`);
    pending = "";
  };
  const consume = (text) => {
    for (const character of text) {
      if (swallowLeadingLineFeed) {
        swallowLeadingLineFeed = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        writeLine();
        swallowLeadingLineFeed = true;
      } else if (character === "\n") {
        writeLine();
      } else {
        pending += character;
      }
    }
  };

  stream.on("data", (chunk) => consume(decoder.write(chunk)));
  stream.once("end", () => {
    consume(decoder.end());
    if (pending) writeLine();
  });
}

const managedProcesses = new Set();
const readinessController = new AbortController();
let stopping = false;
let shutdownPromise;
let finishLifetime;
const lifetime = new Promise((resolve) => {
  finishLifetime = resolve;
});

function signalProcess(record, signal) {
  const { child } = record;
  if (child.pid === undefined) return;

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      supervisorError(`Could not send ${signal} to ${record.label}: ${error.message}`);
    }
  }
}

function spawnManaged({ label, binary, args, cwd, env, longLived, stdin }) {
  if (stopping) {
    throw new Error(`Refusing to start ${label} while local services are stopping`);
  }

  const child = spawn(binary, args, {
    cwd,
    detached: process.platform !== "win32",
    env,
    shell: false,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const record = {
    label,
    child,
    longLived,
    exited: false,
    closed: false,
    closePromise: undefined,
  };
  record.closePromise = new Promise((resolve) => {
    record.resolveClose = resolve;
  });
  managedProcesses.add(record);
  prefixOutput(child.stdout, label, process.stdout);
  prefixOutput(child.stderr, label, process.stderr);

  child.once("error", (error) => {
    supervisorError(`Could not start ${label}: ${error.message}`);
    if (!stopping) void beginShutdown(1, "SIGINT");
  });
  child.once("exit", (code, signal) => {
    record.exited = true;
    record.code = code;
    record.signal = signal;
    if (longLived && !stopping) {
      const description = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
      supervisorError(`${label} stopped unexpectedly (${description})`);
      void beginShutdown(code !== null && code !== 0 ? code : 1, "SIGINT");
    }
  });
  child.once("close", () => {
    record.closed = true;
    managedProcesses.delete(record);
    record.resolveClose();
  });

  if (stdin !== undefined) {
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE" && !stopping) {
        supervisorError(`Could not write configuration for ${label}: ${error.message}`);
      }
    });
    child.stdin.end(stdin);
  }

  return record;
}

async function waitForRecords(records, milliseconds) {
  if (records.every((record) => record.closed)) return;
  let timeout;
  try {
    await Promise.race([
      Promise.all(records.map((record) => record.closePromise)),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function beginShutdown(exitCode, firstSignal) {
  if (shutdownPromise) {
    for (const record of managedProcesses) signalProcess(record, "SIGKILL");
    return shutdownPromise;
  }

  stopping = true;
  process.exitCode = exitCode;
  readinessController.abort();
  shutdownPromise = (async () => {
    const records = [...managedProcesses];
    if (records.length > 0) {
      supervisorLog("Stopping local services...");
      for (const record of records) signalProcess(record, firstSignal);
      await waitForRecords(records, SHUTDOWN_GRACE_MS);

      const remainingAfterGrace = records.filter((record) => !record.closed);
      for (const record of remainingAfterGrace) signalProcess(record, "SIGTERM");
      await waitForRecords(remainingAfterGrace, TERMINATE_GRACE_MS);

      const remainingAfterTerminate = records.filter((record) => !record.closed);
      for (const record of remainingAfterTerminate) signalProcess(record, "SIGKILL");
      await waitForRecords(remainingAfterTerminate, FINAL_KILL_WAIT_MS);

      for (const record of records.filter((candidate) => !candidate.closed)) {
        record.child.stdout.destroy();
        record.child.stderr.destroy();
        record.child.unref();
      }
    }
    finishLifetime();
  })();
  return shutdownPromise;
}

async function abortableDelay(milliseconds, signal) {
  if (signal.aborted) throw signal.reason ?? new Error("Startup cancelled");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abortHandler);
      resolve();
    }, milliseconds);
    const abortHandler = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Startup cancelled"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

async function waitForHttp({
  url,
  label,
  expectedStatus,
  method = "GET",
  headers,
  body,
  validate,
}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastResult = "no response";

  while (!readinessController.signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([
          readinessController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      lastResult = `HTTP ${response.status}`;
      const ready =
        response.status === expectedStatus && (!validate || (await validate(response)));
      if (ready) {
        return;
      }
      if (response.body && !response.bodyUsed) {
        await response.body.cancel();
      }
    } catch (error) {
      if (readinessController.signal.aborted) {
        throw new Error(`${label} startup was cancelled`);
      }
      lastResult = error instanceof Error ? error.message : String(error);
    }
    await abortableDelay(400, readinessController.signal);
  }

  if (readinessController.signal.aborted) {
    throw new Error(`${label} startup was cancelled`);
  }
  throw new Error(`${label} did not become ready at ${url} (${lastResult})`);
}

async function waitForWeb() {
  await Promise.all([
    waitForHttp({
      url: `${WEB_ORIGIN}/.well-known/jwks.json`,
      label: "web/JWKS service",
      expectedStatus: 200,
      validate: async (response) => {
        try {
          const body = await response.json();
          return (
            Array.isArray(body?.keys) &&
            body.keys.some(
              (key) => key?.kty === "RSA" && key?.alg === "RS256" && key?.use === "sig"
            )
          );
        } catch {
          return false;
        }
      },
    }),
    waitForHttp({
      url: `${WEB_ORIGIN}/api/local-auth-token`,
      label: "local JWT issuer",
      expectedStatus: 200,
      validate: async (response) => {
        try {
          const body = await response.json();
          return (
            typeof body?.token === "string" &&
            body.token.split(".").length === 3 &&
            typeof body?.expiresAt === "number"
          );
        } catch {
          return false;
        }
      },
    }),
    waitForHttp({
      url: CODEX_BRIDGE_URL,
      label: "local Codex bridge",
      expectedStatus: 401,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "chat", prompt: "readiness" }),
    }),
  ]);
}

async function runConvexEnvironmentSetter(name, value) {
  const record = spawnManaged({
    label: "config",
    binary: process.execPath,
    args: [
      convexCli,
      "env",
      "set",
      name,
      "--env-file",
      backendSelectorPath,
    ],
    cwd: backendRoot,
    env: sanitizedLocalEnvironment(),
    longLived: false,
    stdin: value,
  });
  let timeout;
  const timedOut = await Promise.race([
    record.closePromise.then(() => false),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(true), CONFIGURATION_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error(`Timed out while configuring ${name}`);
  }
  if (stopping) throw new Error("Local configuration was cancelled");
  if (record.code !== 0) {
    const detail = record.signal ? `signal ${record.signal}` : `exit ${record.code ?? 1}`;
    throw new Error(`Could not configure ${name} (${detail})`);
  }
}

async function configureConvex(bridgeToken) {
  for (const [name, value] of [
    ["AUDORA_AI_PROVIDER", "codex"],
    ["AUDORA_CODEX_BRIDGE_URL", CODEX_BRIDGE_URL],
    ["FRONTEND_URL", WEB_ORIGIN],
    ["AUDORA_CODEX_BRIDGE_TOKEN", bridgeToken],
  ]) {
    await runConvexEnvironmentSetter(name, value);
  }
}

function installSignalHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      void beginShutdown(signalExitCode(signal), signal);
    });
  }
}

async function main() {
  if (await requireLocalNode()) return;
  installSignalHandlers();

  const model = process.env.AUDORA_CODEX_MODEL?.trim() || "gpt-5.5";
  const reasoningEffort =
    process.env.AUDORA_CODEX_REASONING_EFFORT?.trim() || "medium";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model)) {
    throw new Error("AUDORA_CODEX_MODEL contains an invalid model name");
  }
  if (!ALLOWED_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      "AUDORA_CODEX_REASONING_EFFORT must be one of low, medium, high, or xhigh"
    );
  }
  const configuredCodexBinary = process.env.AUDORA_CODEX_BIN?.trim();
  if (configuredCodexBinary && !isAbsolute(configuredCodexBinary)) {
    throw new Error("AUDORA_CODEX_BIN must be an absolute path when it is set");
  }

  const deploymentName = await validateBackendSelector();
  await validateBackendFallbackEnvironment();
  await refuseGlobalConvexLogin();
  await validateAnonymousState(deploymentName);
  await validateWebEnvironment();
  await requireInstalledDependencies();
  await preflightPorts();

  const bridgeToken = randomBytes(32).toString("hex");
  supervisorLog(`Starting Audora locally with ${model} at ${reasoningEffort} reasoning.`);
  supervisorLog("Codex limit: 5 admitted requests per rolling 5 minutes.");

  spawnManaged({
    label: "web",
    binary: process.execPath,
    args: [webCli, "dev"],
    cwd: webRoot,
    env: sanitizedLocalEnvironment({
      VITE_LOCAL_AUTH: "true",
      VITE_CONVEX_URL: CONVEX_URL,
      VITE_CONVEX_SITE_URL: CONVEX_SITE_URL,
      FRONTEND_URL: WEB_ORIGIN,
      AUDORA_CODEX_BRIDGE_TOKEN: bridgeToken,
      AUDORA_CODEX_MODEL: model,
      AUDORA_CODEX_REASONING_EFFORT: reasoningEffort,
      ...(configuredCodexBinary ? { AUDORA_CODEX_BIN: configuredCodexBinary } : {}),
    }),
    longLived: true,
  });
  await waitForWeb();

  spawnManaged({
    label: "convex",
    binary: process.execPath,
    args: [
      convexLauncher,
      "dev",
      "--local",
      "--local-cloud-port",
      "3210",
      "--local-site-port",
      "3211",
      "--local-backend-version",
      "precompiled-2026-08-10-c0cb7ae",
      "--env-file",
      backendSelectorPath,
    ],
    cwd: backendRoot,
    env: sanitizedLocalEnvironment(),
    longLived: true,
  });
  await waitForHttp({
    url: `${CONVEX_URL}/version`,
    label: "local Convex API",
    expectedStatus: 200,
  });

  await configureConvex(bridgeToken);
  await waitForHttp({
    url: `${CONVEX_SITE_URL}/api/chat`,
    label: "local Convex functions",
    expectedStatus: 401,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });

  if (stopping) {
    await shutdownPromise;
    return;
  }

  supervisorLog("");
  supervisorLog("Audora local services are ready:");
  supervisorLog(`App:     ${WEB_ORIGIN}/dashboard`);
  supervisorLog(`Convex:  ${CONVEX_URL}`);
  supervisorLog("Press Ctrl+C to stop every local service.");
  supervisorLog("");
  await lifetime;
}

try {
  await main();
} catch (error) {
  if (!stopping) {
    supervisorError(error instanceof Error ? error.message : String(error));
    await beginShutdown(1, "SIGINT");
  } else if (shutdownPromise) {
    await shutdownPromise;
  }
}
