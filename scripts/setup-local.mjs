#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_MAJOR_VERSION = 24;
const PNPM_VERSION = "10.29.1";
const MINIMUM_CODEX_VERSION = [0, 143, 0];
const CONVEX_BACKEND_VERSION = "precompiled-2026-08-10-c0cb7ae";
const CONVEX_URL = "http://127.0.0.1:3210";
const CONVEX_SITE_URL = "http://127.0.0.1:3211";
const FRONTEND_URL = "http://127.0.0.1:5173";
const CODEX_BRIDGE_URL = `${FRONTEND_URL}/api/local-codex`;
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const MAC_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_PREPARATION_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_PREPARATION_ARGUMENT = "--prepare-local-models-and-exit";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const backendRoot = join(repositoryRoot, "packages", "backend");
const backendEnvironmentPath = join(backendRoot, ".env.local");
const backendFallbackEnvironmentPath = join(backendRoot, ".env");
const backendConvexProjectPath = join(backendRoot, "convex.json");
const localStateRoot = join(repositoryRoot, ".audora-local");
const toolchainRoot = join(localStateRoot, "toolchain");
const macOSRoot = join(repositoryRoot, "apps", "macos");
const macDerivedDataRoot = join(localStateRoot, "macos-derived-data");
const localMacApp = join(
  macDerivedDataRoot,
  "Build",
  "Products",
  "Release",
  "audora.app"
);
const localMacExecutable = join(localMacApp, "Contents", "MacOS", "audora");
const localNode = join(toolchainRoot, "node_modules", "node", "bin", "node");
const localPnpm = join(toolchainRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const convexUserRoot = join(homedir(), ".convex");
const convexCloudConfigPath = join(convexUserRoot, "config.json");
const anonymousStateRoot = join(convexUserRoot, "anonymous-convex-backend-state");

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
const EXTERNAL_PROVIDER_ENVIRONMENT_NAMES = [
  "CLERK_SECRET_KEY",
  "NOTION_API_KEY",
  "NOTION_TOKEN",
  "NOTION_WAITLIST_DATASOURCE_ID",
  "OPENAI_API_KEY",
  "POLAR_ACCESS_TOKEN",
  "POLAR_ORGANIZATION_ID",
  "POLAR_SERVER",
  "POLAR_WEBHOOK_SECRET",
  "SPEECHMATICS_API_KEY",
  "VAPI_API_KEY",
  "VAPI_PHONE_NUMBER_ID",
  "VAPI_PRIVATE_KEY",
  "VAPI_WORKFLOW_ID",
  "VITE_CLERK_FRONTEND_API_URL",
  "ZEP_API_KEY",
  "ZEP_GRAPH_ID",
];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

process.umask(0o077);

class SetupError extends Error {}
class InterruptedError extends Error {}

const ownedChildren = new Map();
let interruptedSignal = null;
let interruptCleanupPromise = null;

function exitCodeForSignal(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

function signalOwnedChild(child, signal, processGroup) {
  if (child.pid === undefined) return;
  if (!processGroup && (child.exitCode !== null || child.signalCode !== null)) return;
  try {
    if (processGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processTargetExited(child, processGroup) {
  if (!processGroup || child.pid === undefined) {
    return child.exitCode !== null || child.signalCode !== null;
  }
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

function waitForExit(child, timeoutMs, processGroup = false) {
  if (processTargetExited(child, processGroup)) return Promise.resolve(true);
  if (processGroup) {
    return new Promise((resolvePromise, rejectPromise) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        try {
          if (processTargetExited(child, true)) {
            resolvePromise(true);
          } else if (Date.now() >= deadline) {
            resolvePromise(false);
          } else {
            setTimeout(poll, Math.min(50, deadline - Date.now()));
          }
        } catch (error) {
          rejectPromise(error);
        }
      };
      poll();
    });
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", exited);
      child.off("close", exited);
      resolvePromise(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("close", exited);
      resolvePromise(true);
    };
    child.once("exit", exited);
    child.once("close", exited);
  });
}

function stopOwnedChild(child, firstSignal = "SIGINT", timings = {}) {
  const record = ownedChildren.get(child);
  if (!record) return Promise.resolve();
  if (record.stopPromise) return record.stopPromise;

  const {
    gracefulMs = 4_000,
    terminateMs = 2_000,
    killMs = 1_000,
  } = timings;
  record.stopPromise = (async () => {
    if (await waitForExit(child, 0, record.processGroup)) return;
    signalOwnedChild(child, firstSignal, record.processGroup);
    if (await waitForExit(child, gracefulMs, record.processGroup)) return;
    signalOwnedChild(child, "SIGTERM", record.processGroup);
    if (await waitForExit(child, terminateMs, record.processGroup)) return;
    signalOwnedChild(child, "SIGKILL", record.processGroup);
    if (!(await waitForExit(child, killMs, record.processGroup))) {
      throw new SetupError(`A child process group remained after SIGKILL (pid ${child.pid}).`);
    }
  })();
  return record.stopPromise;
}

function includeInterruptCleanup(promise) {
  interruptCleanupPromise = interruptCleanupPromise
    ? Promise.all([interruptCleanupPromise, promise])
    : promise;
}

function handleSignal(signal) {
  if (interruptedSignal) {
    for (const [child, { processGroup }] of ownedChildren) {
      try {
        signalOwnedChild(child, "SIGKILL", processGroup);
      } catch {
        // The normal cleanup promise reports failures after the child settles.
      }
    }
    return;
  }
  interruptedSignal = signal;
  includeInterruptCleanup(
    Promise.all([...ownedChildren].map(([child]) => stopOwnedChild(child, signal)))
  );
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => handleSignal(signal));
}

function assertNotInterrupted() {
  if (interruptedSignal) throw new InterruptedError(`Interrupted by ${interruptedSignal}`);
}

function commandLabel(binary, args) {
  return [binary, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function registerChild(child, processGroup = false) {
  const record = { processGroup, stopPromise: null };
  ownedChildren.set(child, record);
  child.once("close", () => {
    if (record.stopPromise) {
      void record.stopPromise.then(
        () => ownedChildren.delete(child),
        () => ownedChildren.delete(child)
      );
    } else {
      ownedChildren.delete(child);
    }
  });
  if (interruptedSignal) {
    includeInterruptCleanup(stopOwnedChild(child, interruptedSignal));
  }
}

function boundedText(chunks, maximumBytes = 1024 * 1024) {
  const buffer = Buffer.concat(chunks);
  if (buffer.byteLength <= maximumBytes) return buffer.toString("utf8");
  return buffer.subarray(buffer.byteLength - maximumBytes).toString("utf8");
}

async function runCaptured(binary, args, options = {}) {
  assertNotInterrupted();
  const processGroup = process.platform !== "win32";
  const child = spawn(binary, args, {
    cwd: options.cwd ?? repositoryRoot,
    detached: processGroup,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerChild(child, processGroup);

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      resolvePromise({
        code,
        signal,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
      });
    });
  });

  assertNotInterrupted();
  return result;
}

async function runCheckedCaptured(binary, args, options = {}) {
  const result = await runCaptured(binary, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-2_000);
    throw new SetupError(
      `${options.label ?? commandLabel(binary, args)} failed${detail ? `:\n${detail}` : ""}`
    );
  }
  return result;
}

async function runStreaming(binary, args, options = {}) {
  assertNotInterrupted();
  const interactive = options.interactive ?? true;
  const hasInput = options.input !== undefined;
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new SetupError("A streaming command timeout must be a positive number of milliseconds.");
  }
  const processGroup = process.platform !== "win32";
  const child = spawn(binary, args, {
    cwd: options.cwd ?? repositoryRoot,
    detached: processGroup,
    env: options.env ?? process.env,
    shell: false,
    stdio: [hasInput ? "pipe" : interactive ? "inherit" : "ignore", "inherit", "inherit"],
  });
  registerChild(child, processGroup);
  if (hasInput) child.stdin.end(options.input);

  let timedOut = false;
  let timeoutStopPromise = null;
  const timeout = timeoutMs === undefined
    ? null
    : setTimeout(() => {
        timedOut = true;
        timeoutStopPromise = stopOwnedChild(child, "SIGTERM", {
          gracefulMs: 4_000,
          terminateMs: 2_000,
          killMs: 1_000,
        });
        // The promise is awaited after the exit event; attach a handler now so
        // an unusually fast rejection cannot become an unhandled rejection.
        void timeoutStopPromise.catch(() => {});
      }, timeoutMs);
  timeout?.unref();

  let result;
  try {
    result = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assertNotInterrupted();
  if (timedOut) {
    if (timeoutStopPromise) await timeoutStopPromise;
    const seconds = Math.ceil(timeoutMs / 1_000);
    throw new SetupError(
      `${options.label ?? commandLabel(binary, args)} timed out after ${seconds} seconds.`
    );
  }
  if (result.code !== 0) {
    throw new SetupError(
      `${options.label ?? commandLabel(binary, args)} failed` +
        `${result.signal ? ` (${result.signal})` : ` (exit ${result.code ?? 1})`}`
    );
  }
}

async function findExecutable(name) {
  if (name.includes(sep) || isAbsolute(name)) {
    await access(name, fsConstants.X_OK);
    return realpath(name);
  }

  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const candidate = join(pathEntry, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next explicit PATH entry.
    }
  }
  throw new SetupError(`${name} was not found on PATH`);
}

function parseVersion(value, label) {
  const match = value.match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (!match) throw new SetupError(`Could not parse ${label} version from: ${value.trim()}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function isStrictlyContained(path, parent) {
  const pathFromParent = relative(parent, path);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function scrubCloudEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("VITE_") ||
      name.startsWith("CONVEX_") ||
      CLOUD_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }
  for (const name of [
    "AUDORA_AI_PROVIDER",
    "AUDORA_CODEX_BRIDGE_TOKEN",
    "AUDORA_CODEX_BRIDGE_URL",
    "FRONTEND_URL",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function ensurePrivateDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SetupError(`Refusing unsafe local state path: ${path}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new SetupError(`Local state is not owned by the current user: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
  }
  await chmod(path, 0o700);
  if ((await realpath(path)) !== path) {
    throw new SetupError(`Local state path contains a symbolic-link component: ${path}`);
  }
}

async function validateOptionalToolchainPackageDirectory(packageName) {
  const packagePath = join(toolchainRoot, "node_modules", packageName);
  let metadata;
  try {
    metadata = await lstat(packagePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SetupError(`Refusing unsafe private tool package directory: ${packagePath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SetupError(`Private tool package is not owned by the current user: ${packagePath}`);
  }
  const [resolvedPackage, resolvedToolchain] = await Promise.all([
    realpath(packagePath),
    realpath(toolchainRoot),
  ]);
  if (!isStrictlyContained(resolvedPackage, resolvedToolchain)) {
    throw new SetupError(`Private tool package escapes .audora-local/toolchain: ${packagePath}`);
  }
}

async function validateHost() {
  if (process.platform !== "darwin") {
    throw new SetupError("The local Parakeet setup supports macOS only.");
  }

  const uname = await findExecutable("uname");
  const swVers = await findExecutable("sw_vers");
  const xcodeSelect = await findExecutable("xcode-select");
  const xcodebuild = await findExecutable("xcodebuild");

  const architecture = (await runCheckedCaptured(uname, ["-m"], { label: "uname" })).stdout.trim();
  if (architecture !== "arm64") {
    throw new SetupError(`Apple Silicon arm64 is required (found ${architecture || "unknown"}).`);
  }

  const macOSVersion = (
    await runCheckedCaptured(swVers, ["-productVersion"], { label: "macOS version check" })
  ).stdout.trim();
  const [macOSMajor] = parseVersion(macOSVersion, "macOS");
  if (macOSMajor < 15) {
    throw new SetupError(`macOS 15 or later is required (found ${macOSVersion}).`);
  }

  const developerDirectory = (
    await runCheckedCaptured(xcodeSelect, ["-p"], { label: "Xcode selection check" })
  ).stdout.trim();
  let resolvedDeveloperDirectory;
  try {
    resolvedDeveloperDirectory = await realpath(developerDirectory);
  } catch {
    throw new SetupError(
      `The selected Xcode developer directory does not exist: ${developerDirectory}`
    );
  }
  if (!/\.app\/Contents\/Developer$/.test(resolvedDeveloperDirectory)) {
    throw new SetupError(
      "Full Xcode is required. Install it, launch it once, then select it with " +
        "`sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`."
    );
  }

  await runCheckedCaptured(xcodebuild, ["-version"], { label: "Xcode version check" });
  await runCheckedCaptured(xcodebuild, ["-checkFirstLaunchStatus"], {
    label: "Xcode first-launch check (open Xcode once if this fails)",
  });
  await runCheckedCaptured(xcodebuild, ["-license", "check"], {
    label: "Xcode license check (open Xcode and accept its license if this fails)",
  });

  console.log(`Host ready: macOS ${macOSVersion}, arm64, full Xcode selected.`);
}

async function validateRepository(git) {
  const topLevel = (
    await runCheckedCaptured(git, ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], {
      label: "Git repository check",
    })
  ).stdout.trim();
  if ((await realpath(topLevel)) !== (await realpath(repositoryRoot))) {
    throw new SetupError(
      `Run the checked-out Audora repository, not a nested or unrelated worktree.`
    );
  }

  const trackedLocalState = await runCaptured(git, [
    "-C",
    repositoryRoot,
    "ls-files",
    "--",
    ".audora-local",
  ]);
  if (trackedLocalState.code !== 0 || trackedLocalState.stdout.trim()) {
    throw new SetupError(".audora-local must be untracked before local tools can be installed.");
  }

  const ignored = await runCaptured(git, [
    "-C",
    repositoryRoot,
    "check-ignore",
    "-q",
    "--",
    ".audora-local/setup-probe",
  ]);
  if (ignored.code !== 0) {
    throw new SetupError(
      "Refusing to install tools because /.audora-local/ is not ignored by Git."
    );
  }
}

async function installToolchain(npm) {
  await ensurePrivateDirectory(localStateRoot);
  await ensurePrivateDirectory(toolchainRoot);
  await ensurePrivateDirectory(join(toolchainRoot, "node_modules"));
  await Promise.all([
    validateOptionalToolchainPackageDirectory("node"),
    validateOptionalToolchainPackageDirectory("pnpm"),
  ]);

  const existingToolchain = await inspectToolchain();
  if (existingToolchain) {
    console.log(
      `Reusing private Node ${existingToolchain.nodeVersion} and pnpm ${PNPM_VERSION} toolchain.`
    );
    return;
  }

  console.log(`Installing private Node 24 and pnpm ${PNPM_VERSION} toolchain...`);
  await runStreaming(
    npm,
    [
      "install",
      "--prefix",
      toolchainRoot,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "node@24",
      `pnpm@${PNPM_VERSION}`,
    ],
    {
      env: {
        ...scrubCloudEnvironment(),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "false",
        npm_config_package_lock: "false",
      },
      label: "private toolchain installation",
    }
  );

  const installedToolchain = await inspectToolchain();
  if (!installedToolchain) {
    throw new SetupError("The private Node/pnpm toolchain did not pass version verification.");
  }
  console.log(`Installed private Node ${installedToolchain.nodeVersion}.`);
  await chmod(localStateRoot, 0o700);
  await chmod(toolchainRoot, 0o700);
}

async function inspectToolchain() {
  try {
    const [nodeMetadata, pnpmMetadata] = await Promise.all([lstat(localNode), lstat(localPnpm)]);
    if (
      nodeMetadata.isSymbolicLink() ||
      !nodeMetadata.isFile() ||
      pnpmMetadata.isSymbolicLink() ||
      !pnpmMetadata.isFile()
    ) {
      throw new SetupError("Refusing a linked or non-regular private Node/pnpm runtime.");
    }
    if (
      typeof process.getuid === "function" &&
      (nodeMetadata.uid !== process.getuid() || pnpmMetadata.uid !== process.getuid())
    ) {
      throw new SetupError("The private Node/pnpm runtime is not owned by the current user.");
    }
    const [resolvedToolchainRoot, resolvedNode, resolvedPnpm] = await Promise.all([
      realpath(toolchainRoot),
      realpath(localNode),
      realpath(localPnpm),
    ]);
    if (
      resolvedToolchainRoot !== toolchainRoot ||
      !isStrictlyContained(resolvedNode, resolvedToolchainRoot) ||
      !isStrictlyContained(resolvedPnpm, resolvedToolchainRoot)
    ) {
      throw new SetupError("The private Node/pnpm runtime escapes .audora-local/toolchain.");
    }
    await access(localNode, fsConstants.X_OK);
    const nodeResult = await runCaptured(localNode, ["--version"]);
    const pnpmResult = await runCaptured(localNode, [localPnpm, "--version"]);
    if (nodeResult.code !== 0 || pnpmResult.code !== 0) {
      throw new SetupError("The private Node/pnpm runtime could not report its version.");
    }
    const nodeVersion = nodeResult.stdout.trim();
    const pnpmVersion = pnpmResult.stdout.trim();
    const [nodeMajor] = parseVersion(nodeVersion, "private Node");
    if (nodeMajor !== NODE_MAJOR_VERSION || pnpmVersion !== PNPM_VERSION) return null;
    return { nodeVersion: nodeVersion.replace(/^v/, ""), pnpmVersion };
  } catch (error) {
    if (interruptedSignal) throw new InterruptedError(`Interrupted by ${interruptedSignal}`);
    if (error?.code === "ENOENT") return null;
    if (error instanceof SetupError) throw error;
    throw new SetupError(
      `Could not validate the private Node/pnpm runtime: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function toolEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    PATH: [dirname(localNode), join(toolchainRoot, "node_modules", ".bin"), baseEnvironment.PATH]
      .filter(Boolean)
      .join(delimiter),
  };
}

async function ensureCodexLogin(codex) {
  const versionResult = await runCheckedCaptured(codex, ["--version"], {
    label: "Codex version check",
  });
  const codexVersion = parseVersion(
    `${versionResult.stdout}\n${versionResult.stderr}`,
    "Codex CLI"
  );
  if (!versionAtLeast(codexVersion, MINIMUM_CODEX_VERSION)) {
    throw new SetupError(
      `Codex CLI 0.143.0 or later is required (found ${codexVersion.join(".")}).`
    );
  }

  let status = await runCaptured(codex, ["login", "status"]);
  let statusText = `${status.stdout}\n${status.stderr}`;
  if (status.code !== 0 || !/logged in using chatgpt/i.test(statusText)) {
    console.log("Codex needs ChatGPT authentication. Opening the official login flow...");
    await runStreaming(codex, ["login"], { label: "Codex ChatGPT login" });
    status = await runCaptured(codex, ["login", "status"]);
    statusText = `${status.stdout}\n${status.stderr}`;
  }

  if (status.code !== 0 || !/logged in using chatgpt/i.test(statusText)) {
    throw new SetupError(
      "Codex is not logged in with ChatGPT. API-key login is not accepted by this local bridge."
    );
  }
  console.log(`Codex ready: ${codexVersion.join(".")}, authenticated with ChatGPT.`);
}

async function initializeSubmodule(git) {
  let status = await runCheckedCaptured(
    git,
    ["-C", repositoryRoot, "submodule", "status", "apps/macos"],
    { label: "macOS submodule verification" }
  );
  if (status.stdout.startsWith("-")) {
    console.log("Initializing the pinned macOS submodule...");
    await runStreaming(
      git,
      ["-C", repositoryRoot, "submodule", "update", "--init", "apps/macos"],
      { label: "macOS submodule initialization" }
    );
    status = await runCheckedCaptured(
      git,
      ["-C", repositoryRoot, "submodule", "status", "apps/macos"],
      { label: "macOS submodule verification" }
    );
  }
  if (!/^ [0-9a-f]{40} apps\/macos(?:\s|$)/m.test(status.stdout)) {
    throw new SetupError(
      `The macOS submodule is not at the pinned clean revision:\n${status.stdout.trim()}`
    );
  }

  const expectedRevision = (
    await runCheckedCaptured(git, ["-C", repositoryRoot, "ls-tree", "HEAD", "apps/macos"], {
      label: "macOS gitlink verification",
    })
  ).stdout.match(/^160000 commit ([0-9a-f]{40})\s+apps\/macos$/m)?.[1];
  const actualRevision = (
    await runCheckedCaptured(
      git,
      ["-C", join(repositoryRoot, "apps", "macos"), "rev-parse", "HEAD"],
      { label: "macOS revision verification" }
    )
  ).stdout.trim();
  const dirty = await runCheckedCaptured(
    git,
    ["-C", join(repositoryRoot, "apps", "macos"), "status", "--porcelain"],
    { label: "macOS worktree verification" }
  );
  if (!expectedRevision || actualRevision !== expectedRevision || dirty.stdout.trim()) {
    throw new SetupError(
      "The initialized macOS submodule must be clean and at the revision pinned by this checkout."
    );
  }
}

async function installRepositoryDependencies() {
  console.log("Installing the frozen web/backend dependency subset...");
  await runStreaming(
    localNode,
    [
      localPnpm,
      "--filter",
      "{./apps/web}...",
      "--filter",
      "{./packages/backend}...",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
    ],
    {
      cwd: repositoryRoot,
      env: toolEnvironment(scrubCloudEnvironment()),
      label: "frozen pnpm dependency installation",
    }
  );
}

async function validateBuiltMacApp(codesign) {
  const [appMetadata, executableMetadata] = await Promise.all([
    lstat(localMacApp),
    lstat(localMacExecutable),
  ]);
  if (appMetadata.isSymbolicLink() || !appMetadata.isDirectory()) {
    throw new SetupError(`The built Mac application is not a regular bundle: ${localMacApp}`);
  }
  if (
    executableMetadata.isSymbolicLink() ||
    !executableMetadata.isFile() ||
    executableMetadata.nlink !== 1
  ) {
    throw new SetupError(`The built Mac executable is linked or not a regular file.`);
  }
  if (
    typeof process.getuid === "function" &&
    (appMetadata.uid !== process.getuid() || executableMetadata.uid !== process.getuid())
  ) {
    throw new SetupError("The built Mac application is not owned by the current user.");
  }

  const [resolvedDerivedData, resolvedApp, resolvedExecutable] = await Promise.all([
    realpath(macDerivedDataRoot),
    realpath(localMacApp),
    realpath(localMacExecutable),
  ]);
  if (
    !isStrictlyContained(resolvedApp, resolvedDerivedData) ||
    !isStrictlyContained(resolvedExecutable, resolvedApp)
  ) {
    throw new SetupError("The built Mac application escapes its private DerivedData directory.");
  }
  await access(localMacExecutable, fsConstants.X_OK);

  await runCheckedCaptured(codesign, ["--verify", "--deep", "--strict", localMacApp], {
    label: "local Mac application signature verification",
  });
  const entitlements = await runCheckedCaptured(
    codesign,
    ["--display", "--entitlements", "-", localMacApp],
    { label: "local Mac application entitlement verification" }
  );
  const entitlementText = `${entitlements.stdout}\n${entitlements.stderr}`;
  const hasXMLSandboxEntitlement =
    /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/.test(entitlementText);
  const decodedEntitlementLines = entitlementText.split(/\r?\n/).map((line) => line.trim());
  const decodedSandboxKeyIndex = decodedEntitlementLines.indexOf(
    "[Key] com.apple.security.app-sandbox"
  );
  const hasDecodedSandboxEntitlement =
    decodedSandboxKeyIndex >= 0 &&
    decodedEntitlementLines
      .slice(decodedSandboxKeyIndex + 1, decodedSandboxKeyIndex + 4)
      .includes("[Bool] true");
  if (!hasXMLSandboxEntitlement && !hasDecodedSandboxEntitlement) {
    throw new SetupError("The built Mac application is signed without the App Sandbox entitlement.");
  }
}

async function prepareLocalTranscriptionModels(xcodebuild, codesign) {
  await ensurePrivateDirectory(macDerivedDataRoot);

  console.log("Building the optimized local Mac app (incremental, signed to run locally)...");
  try {
    await runStreaming(
      xcodebuild,
      [
        "-project",
        join(macOSRoot, "audora.xcodeproj"),
        "-scheme",
        "Audora",
        "-configuration",
        "Release",
        "-destination",
        "platform=macOS,arch=arm64",
        "-derivedDataPath",
        macDerivedDataRoot,
        "-disableAutomaticPackageResolution",
        "-onlyUsePackageVersionsFromResolvedFile",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGN_STYLE=Manual",
        "DEVELOPMENT_TEAM=",
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGNING_REQUIRED=YES",
        "build",
      ],
      {
        cwd: macOSRoot,
        env: scrubCloudEnvironment(),
        interactive: false,
        timeoutMs: MAC_BUILD_TIMEOUT_MS,
        label: "optimized local Mac application build",
      }
    );
  } catch (error) {
    throw new SetupError(
      "Could not build the local Mac app with its sandboxed sign-to-run-locally signature. " +
        `Review the Xcode output above and rerun setup. ${
          error instanceof Error ? error.message : String(error)
        }`
    );
  }

  await validateBuiltMacApp(codesign);

  console.log(
    "Preparing Parakeet TDT v3 and Silero VAD inside the Audora sandbox; " +
      "the first run can take several minutes..."
  );
  try {
    await runStreaming(localMacExecutable, [MODEL_PREPARATION_ARGUMENT], {
      cwd: macOSRoot,
      env: {
        ...scrubCloudEnvironment(),
        NSUnbufferedIO: "YES",
      },
      interactive: false,
      timeoutMs: MODEL_PREPARATION_TIMEOUT_MS,
      label: "local transcription model preparation",
    });
  } catch (error) {
    throw new SetupError(
      "The signed Mac app could not prepare its local transcription models. " +
        "Check access to FluidAudio's model host, then rerun setup; a valid existing cache " +
        `will be reused. ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log("Local transcription models validated in the Audora App Sandbox cache.");
}

function parseAllowlistedEnvironment(contents, label, allowedNames) {
  const allowed = new Set(allowedNames);
  const values = new Map();
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new SetupError(`${label} contains an unsupported entry on line ${index + 1}.`);
    }
    const [, name, value] = match;
    if (!allowed.has(name)) {
      throw new SetupError(`${label} contains disallowed variable ${name}.`);
    }
    if (values.has(name)) {
      throw new SetupError(`${label} defines ${name} more than once.`);
    }
    values.set(name, value);
  }

  return values;
}

async function readOwnedRegularFile(path, label, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw error;
  }

  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new SetupError(`${label} must be a regular file without symbolic or hard links.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SetupError(`${label} must be owned by the current user.`);
  }
  if (metadata.size > 64 * 1024) {
    throw new SetupError(`${label} is unexpectedly large.`);
  }

  const contents = await readFile(path, "utf8");
  if (contents.includes("\0")) throw new SetupError(`${label} contains a NUL byte.`);
  return { contents, metadata };
}

async function validateBackendSelector({ allowMissingFile = false } = {}) {
  const file = await readOwnedRegularFile(
    backendEnvironmentPath,
    "packages/backend/.env.local",
    { allowMissing: allowMissingFile }
  );
  if (!file) return null;

  const values = parseAllowlistedEnvironment(
    file.contents,
    "packages/backend/.env.local",
    ["CONVEX_DEPLOYMENT", "CONVEX_URL", "CONVEX_SITE_URL"]
  );
  const deployment = values.get("CONVEX_DEPLOYMENT") ?? "";
  if (!/^anonymous:anonymous-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(deployment)) {
    throw new SetupError(
      "packages/backend/.env.local must select an anonymous local Convex deployment. " +
        "Refusing cloud, self-hosted, or unknown configuration."
    );
  }
  if (values.get("CONVEX_URL") !== CONVEX_URL) {
    throw new SetupError(`packages/backend/.env.local must set CONVEX_URL exactly to ${CONVEX_URL}.`);
  }
  if (values.has("CONVEX_SITE_URL") && values.get("CONVEX_SITE_URL") !== CONVEX_SITE_URL) {
    throw new SetupError(
      `packages/backend/.env.local must set CONVEX_SITE_URL exactly to ${CONVEX_SITE_URL}.`
    );
  }

  // Only repair permissions after the complete file has passed the allowlist.
  await chmod(backendEnvironmentPath, 0o600);
  return {
    deployment,
    deploymentName: deployment.slice("anonymous:".length),
    url: values.get("CONVEX_URL"),
    siteUrl: values.get("CONVEX_SITE_URL"),
  };
}

async function validateBackendFallbackEnvironment() {
  const file = await readOwnedRegularFile(
    backendFallbackEnvironmentPath,
    "packages/backend/.env",
    { allowMissing: true }
  );
  if (!file) return;

  for (const [index, rawLine] of file.contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    throw new SetupError(
      `packages/backend/.env contains an entry on line ${index + 1}. ` +
        "Move it aside before local setup; only the validated .env.local selector is allowed."
    );
  }
}

async function refuseBackendConvexProjectFile() {
  try {
    await lstat(backendConvexProjectPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new SetupError(
    "Refusing a fresh anonymous bootstrap while packages/backend/convex.json exists. " +
      "Move the hosted team/project selector aside before continuing."
  );
}

async function refuseConvexCloudLogin() {
  try {
    await lstat(convexCloudConfigPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new SetupError(
    `Refusing anonymous setup while ${convexCloudConfigPath} exists. ` +
      "This script will not read or overwrite a Convex cloud login; move that file aside or " +
      "use a separate OS account before continuing."
  );
}

async function requirePrivateOwnedDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SetupError(`${label} is missing at ${path}.`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SetupError(`${label} must be a directory and not a symbolic link.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SetupError(`${label} must be owned by the current user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new SetupError(`${label} must be private (mode 0700).`);
  }
  if ((await realpath(path)) !== path) {
    throw new SetupError(`${label} must not be reached through symbolic-link path components.`);
  }
}

async function validateExistingAnonymousState(selector, { requirePinnedRuntime = false } = {}) {
  await requirePrivateOwnedDirectory(anonymousStateRoot, "Anonymous Convex state root");
  const deploymentRoot = join(anonymousStateRoot, selector.deploymentName);
  await requirePrivateOwnedDirectory(deploymentRoot, "Selected anonymous Convex deployment state");

  const configPath = join(deploymentRoot, "config.json");
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SetupError(
        `The selector names ${selector.deployment}, but its local state is missing at ${configPath}. ` +
          "Restore the matching state or restore the selector for an existing anonymous deployment."
      );
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new SetupError("The selected anonymous Convex config must be a regular unlinked file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SetupError("The selected anonymous Convex config must be owned by the current user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new SetupError("The selected anonymous Convex config must be private (mode 0600).");
  }
  if (metadata.size > 64 * 1024) {
    throw new SetupError("The selected anonymous Convex config is unexpectedly large.");
  }
  const resolvedConfig = await realpath(configPath);
  const resolvedDeploymentRoot = await realpath(deploymentRoot);
  if (!isStrictlyContained(resolvedConfig, resolvedDeploymentRoot)) {
    throw new SetupError("The selected anonymous Convex config escapes its deployment state.");
  }

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new SetupError("The selected anonymous Convex config is not valid JSON.");
  }
  const safeCredential = (value) =>
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const safePort = (value) => Number.isInteger(value) && value > 0 && value <= 65_535;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.ports === null ||
    typeof config.ports !== "object" ||
    Array.isArray(config.ports) ||
    !safePort(config.ports.cloud) ||
    !safePort(config.ports.site) ||
    config.ports.cloud === config.ports.site ||
    typeof config.backendVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.backendVersion) ||
    !safeCredential(config.adminKey) ||
    !safeCredential(config.instanceSecret)
  ) {
    throw new SetupError("The selected anonymous Convex config has an unsafe credential shape.");
  }
  if (
    requirePinnedRuntime &&
    (config.backendVersion !== CONVEX_BACKEND_VERSION ||
      config.ports.cloud !== 3210 ||
      config.ports.site !== 3211)
  ) {
    throw new SetupError(
      "Convex did not persist the pinned backend version and exact loopback ports."
    );
  }
}

async function refuseExistingAnonymousDeploymentsWithoutSelector() {
  let metadata;
  try {
    metadata = await lstat(anonymousStateRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SetupError("The anonymous Convex state root is unsafe.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new SetupError("The anonymous Convex state root is not owned by the current user.");
  }
  if ((metadata.mode & 0o077) !== 0 || (await realpath(anonymousStateRoot)) !== anonymousStateRoot) {
    throw new SetupError("The anonymous Convex state root must be a private, non-linked directory.");
  }

  const entries = await readdir(anonymousStateRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new SetupError("The anonymous Convex state root contains a symbolic link.");
  }
  if (entries.some((entry) => entry.isDirectory())) {
    throw new SetupError(
      "packages/backend/.env.local is missing, but anonymous Convex deployment state already " +
        "exists. Restore the selector for that deployment instead of creating a blank duplicate."
    );
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        rejectPromise(
          new SetupError(
            `Port ${port} is already in use. Stop the existing Audora/local service and ` +
              "rerun setup."
          )
        );
      } else {
        rejectPromise(error);
      }
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(resolvePromise);
    });
  });
}

function convexEnvironment() {
  return {
    ...toolEnvironment(scrubCloudEnvironment()),
    CONVEX_AGENT_MODE: "anonymous",
    CONVEX_ALLOW_ANONYMOUS: "true",
    CI: "1",
    SENTRY_DSN: "",
  };
}

async function stopConvex(child) {
  await stopOwnedChild(child, "SIGINT", {
    gracefulMs: 8_000,
    terminateMs: 4_000,
    killMs: 2_000,
  });
}

async function startConvex(existingSelector) {
  const wrapper = join(backendRoot, "scripts", "convex-local-loopback.cjs");
  const args = [
    wrapper,
    "dev",
    "--local",
    "--local-cloud-port",
    "3210",
    "--local-site-port",
    "3211",
    "--local-backend-version",
    CONVEX_BACKEND_VERSION,
  ];
  if (existingSelector) args.push("--env-file", backendEnvironmentPath);
  const processGroup = process.platform !== "win32";
  const child = spawn(localNode, args, {
    cwd: backendRoot,
    detached: processGroup,
    env: convexEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerChild(child, processGroup);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let recentOutput = "";
  const inspect = (chunk) => {
    recentOutput = `${recentOutput}${chunk}`.slice(-16_384);
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);

  const ready = new Promise((resolvePromise, rejectPromise) => {
    const deadline = setTimeout(() => {
      cleanup();
      rejectPromise(new SetupError("Local Convex did not become ready within 10 minutes."));
    }, READY_TIMEOUT_MS);
    deadline.unref();

    const check = () => {
      if (/Convex functions (?:are )?ready!|Convex functions ready\b/.test(recentOutput)) {
        cleanup();
        resolvePromise();
      }
    };
    const exited = (code, signal) => {
      cleanup();
      rejectPromise(
        new SetupError(
          `Local Convex stopped before becoming ready${
            signal ? ` (${signal})` : ` (exit ${code ?? 1})`
          }.`
        )
      );
    };
    const failed = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      clearTimeout(deadline);
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("exit", exited);
      child.off("error", failed);
    };

    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", exited);
    child.once("error", failed);
  });

  return { child, ready };
}

async function setConvexEnvironment(name, value) {
  await runStreaming(
    localNode,
    [
      localPnpm,
      "--dir",
      backendRoot,
      "exec",
      "convex",
      "env",
      "--env-file",
      backendEnvironmentPath,
      "set",
      name,
    ],
    {
      cwd: repositoryRoot,
      env: convexEnvironment(),
      input: value,
      label: `local Convex environment setting ${name}`,
    }
  );
}

async function removeConvexEnvironment(name) {
  await runStreaming(
    localNode,
    [
      localPnpm,
      "--dir",
      backendRoot,
      "exec",
      "convex",
      "env",
      "--env-file",
      backendEnvironmentPath,
      "remove",
      name,
    ],
    {
      cwd: repositoryRoot,
      env: convexEnvironment(),
      interactive: false,
      label: `local Convex environment removal ${name}`,
    }
  );
}

async function secureAnonymousState() {
  await runStreaming(
    localNode,
    [localPnpm, "--dir", backendRoot, "run", "secure:local-state"],
    {
      cwd: repositoryRoot,
      env: convexEnvironment(),
      label: "anonymous Convex state permission repair",
    }
  );
}

async function bootstrapConvex() {
  await refuseConvexCloudLogin();
  await validateBackendFallbackEnvironment();
  const existingSelector = await validateBackendSelector({ allowMissingFile: true });
  if (!existingSelector) await refuseBackendConvexProjectFile();
  await secureAnonymousState();
  if (existingSelector) await validateExistingAnonymousState(existingSelector);
  else await refuseExistingAnonymousDeploymentsWithoutSelector();
  await Promise.all([assertPortAvailable(3210), assertPortAvailable(3211)]);

  let convex;
  try {
    console.log("Bootstrapping the hardened anonymous local Convex deployment...");
    convex = await startConvex(existingSelector);
    await convex.ready;
    assertNotInterrupted();

    const selector = await validateBackendSelector();
    await validateExistingAnonymousState(selector, { requirePinnedRuntime: true });
    console.log("Clearing external-provider configuration from local Convex...");
    for (const name of EXTERNAL_PROVIDER_ENVIRONMENT_NAMES) {
      await removeConvexEnvironment(name);
    }
    await setConvexEnvironment("FRONTEND_URL", FRONTEND_URL);
    await setConvexEnvironment("AUDORA_AI_PROVIDER", "codex");
    await setConvexEnvironment("AUDORA_CODEX_BRIDGE_URL", CODEX_BRIDGE_URL);
  } finally {
    if (convex?.child) await stopConvex(convex.child);
  }

  await secureAnonymousState();
  const selector = await validateBackendSelector();
  await validateExistingAnonymousState(selector, { requirePinnedRuntime: true });
}

async function main() {
  console.log("Audora local one-time setup\n");
  const [git, npm, codex, xcodebuild, codesign] = await Promise.all([
    findExecutable("git"),
    findExecutable("npm"),
    findExecutable("codex"),
    findExecutable("xcodebuild"),
    findExecutable("codesign"),
  ]);

  await validateHost();
  await validateRepository(git);
  await installToolchain(npm);
  await ensureCodexLogin(codex);
  await initializeSubmodule(git);
  await installRepositoryDependencies();
  await prepareLocalTranscriptionModels(xcodebuild, codesign);
  await bootstrapConvex();

  console.log("\nLocal setup is complete.");
  console.log(`  Convex: anonymous data at ${CONVEX_URL} and ${CONVEX_SITE_URL} when launched`);
  console.log(`  Web/JWT: ${FRONTEND_URL} when launched`);
  console.log(`  Mac app: ${localMacApp}`);
  console.log("  Parakeet/VAD: cached and validated in the app sandbox");
  console.log("  Cloud provider keys: not required");
  console.log("Run the foreground launcher next and leave it open while using the Mac app.");
}

try {
  await main();
} catch (error) {
  if (interruptCleanupPromise) {
    try {
      await interruptCleanupPromise;
    } catch (cleanupError) {
      console.error(
        `\nA child process could not be stopped cleanly: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`
      );
    }
  }
  if (error instanceof InterruptedError || interruptedSignal) {
    console.error(`\nSetup interrupted${interruptedSignal ? ` (${interruptedSignal})` : ""}.`);
    process.exitCode = exitCodeForSignal(interruptedSignal ?? "SIGINT");
  } else {
    console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
