import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.env.AUDORA_PNPM_BIN?.trim() || "pnpm";
const bridgeToken = randomBytes(32).toString("hex");
const model = process.env.AUDORA_CODEX_MODEL?.trim() || "gpt-5.5";
const reasoningEffort =
  process.env.AUDORA_CODEX_REASONING_EFFORT?.trim() || "medium";
const children = new Set();
let shuttingDown = false;

function startService(name, args, extraEnv = {}, interactive = false) {
  const child = spawn(pnpm, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnv },
    stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(
        `${name} stopped unexpectedly${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}`
      );
      shutdown(code ?? 1);
    }
  });
  child.once("error", (error) => {
    console.error(`Could not start ${name}:`, error.message);
    shutdown(1);
  });
  return child;
}

function waitForServiceOutput(child, pattern, label) {
  return new Promise((resolve, reject) => {
    let recentOutput = "";
    const inspect = (chunk) => {
      recentOutput = `${recentOutput}${chunk}`.slice(-4_096);
      if (pattern.test(recentOutput)) {
        cleanup();
        resolve();
      }
    };
    const stopped = (code) => {
      cleanup();
      reject(new Error(`${label} stopped before becoming ready (exit ${code ?? 1})`));
    };
    const cleanup = () => {
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", stopped);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", stopped);
  });
}

function stopService(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      const descendants = [];
      const visit = (parentPid) => {
        const result = spawnSync("pgrep", ["-P", String(parentPid)], {
          encoding: "utf8",
        });
        for (const value of result.stdout.trim().split(/\s+/).filter(Boolean)) {
          const pid = Number(value);
          if (!Number.isInteger(pid)) continue;
          visit(pid);
          descendants.push(pid);
        }
      };
      visit(child.pid);
      for (const pid of descendants) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    stopService(child, "SIGINT");
  }
  const forceTimer = setTimeout(() => {
    for (const child of children) stopService(child, "SIGTERM");
  }, 3_000);
  forceTimer.unref();
  setTimeout(() => process.exit(exitCode), 3_500).unref();
}

async function waitFor(url, label) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error" });
      if (response.ok) return;
    } catch {
      // The first local Convex launch can pause for its no-account prompt.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function waitForConvexSelector() {
  const selectorPath = fileURLToPath(
    new URL("../packages/backend/.env.local", import.meta.url)
  );
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const contents = await readFile(selectorPath, "utf8");
      if (/^CONVEX_DEPLOYMENT=.+$/m.test(contents)) return;
    } catch {
      // Convex writes this after the first no-account project selection.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Convex did not write packages/backend/.env.local");
}

function setConvexEnvironment(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pnpm,
      ["--dir", "packages/backend", "exec", "convex", "env", "set", name],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ["pipe", "inherit", "inherit"],
      }
    );
    child.stdin.end(value);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not configure ${name} (exit ${code ?? 1})`));
    });
  });
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

console.log(`Starting Audora locally with ${model} at ${reasoningEffort} reasoning.`);
console.log("Codex limit: 5 admitted requests per rolling 5 minutes.");

startService(
  "web/JWT service",
  ["--dir", "apps/web", "dev"],
  {
    VITE_LOCAL_AUTH: "true",
    VITE_CONVEX_URL: "http://127.0.0.1:3210",
    VITE_CONVEX_SITE_URL: "http://127.0.0.1:3211",
    AUDORA_CODEX_BRIDGE_TOKEN: bridgeToken,
    AUDORA_CODEX_MODEL: model,
    AUDORA_CODEX_REASONING_EFFORT: reasoningEffort,
  }
);
const convexService = startService(
  "local Convex",
  ["--dir", "packages/backend", "dev:local"],
  {},
  true
);
const convexFunctionsReady = waitForServiceOutput(
  convexService,
  /Convex functions ready!|Convex functions are ready!|Convex functions ready\b/,
  "Convex functions"
);

try {
  await Promise.all([
    waitFor("http://127.0.0.1:5173/.well-known/jwks.json", "web/JWT service"),
    waitFor("http://127.0.0.1:3210/version", "local Convex"),
    waitForConvexSelector(),
  ]);
  await convexFunctionsReady;
  await setConvexEnvironment("AUDORA_CODEX_BRIDGE_TOKEN", bridgeToken);
  console.log("\nAudora local services are ready:");
  console.log("  App:     http://127.0.0.1:5173/dashboard");
  console.log("  Convex:  http://127.0.0.1:3210");
  console.log("Press Ctrl+C to stop both services.\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
