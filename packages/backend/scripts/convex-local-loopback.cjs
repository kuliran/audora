const childProcess = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Keep local deployment credentials, SQLite data, and transcripts private on
// shared machines. This affects files created by this process and its children.
process.umask(0o077);

const cliArgs = process.argv.slice(2);
if (cliArgs[0] !== "dev" || !cliArgs.includes("--local")) {
  throw new Error("This launcher only supports `convex dev --local`");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (![20, 22, 24].includes(nodeMajor)) {
  throw new Error(
    `Convex local actions require Node 20, 22, or 24 (found ${process.versions.node}). ` +
      "Install Node 24 or run `npm run dev:local:node24`."
  );
}

// Convex enables CLI Sentry unless it detects CI. This launcher is local-only,
// so suppress CLI error uploads without changing Convex's normal cloud command.
process.env.CI = "1";
delete process.env.VERCEL;

// Avoid routine update and dashboard-beacon requests. Bootstrap, deploy, and
// application provider requests continue through the native fetch unchanged.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const value = input instanceof Request ? input.url : String(input);

  try {
    const url = new URL(value);
    if (url.hostname === "version.convex.dev") {
      return Promise.resolve(
        Response.json({ cursorRulesHash: null, message: null })
      );
    }
    if (
      url.hostname === "api.convex.dev" &&
      url.pathname.endsWith("/self_hosted_event")
    ) {
      return Promise.resolve(Response.json({}));
    }
  } catch {
    // Preserve the CLI's native error handling for non-URL fetch inputs.
  }

  return nativeFetch(input, init);
};

// The pinned CLI's dashboard credentials endpoint otherwise sends CORS `*`.
// Restrict browser reads to another loopback page (the local dashboard itself).
const nativeSetHeader = http.ServerResponse.prototype.setHeader;
http.ServerResponse.prototype.setHeader = function setHeader(name, value) {
  const headerName = String(name).toLowerCase();
  const origin = this.req?.headers?.origin;
  let loopbackOrigin = false;

  if (typeof origin === "string") {
    try {
      const url = new URL(origin);
      loopbackOrigin = url.protocol === "http:" && url.hostname === "127.0.0.1";
    } catch {
      loopbackOrigin = false;
    }
  }

  if (headerName === "access-control-allow-origin" && value === "*") {
    return nativeSetHeader.call(this, name, loopbackOrigin ? origin : "null");
  }
  if (headerName === "access-control-allow-private-network" && !loopbackOrigin) {
    return this;
  }
  return nativeSetHeader.call(this, name, value);
};

function isLocalBackendCommand(command) {
  return (
    path.basename(String(command)).replace(/\.exe$/i, "") ===
    "convex-local-backend"
  );
}

function withLocalBackendHardening(command, args) {
  if (!Array.isArray(args) || !isLocalBackendCommand(command)) {
    return args;
  }

  const hardenedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--interface") {
      index += 1;
      continue;
    }
    if (
      String(arg).startsWith("--interface=") ||
      arg === "--disable-beacon" ||
      arg === "--redact-logs-to-client"
    ) {
      continue;
    }
    hardenedArgs.push(arg);
  }

  return [
    "--interface",
    "127.0.0.1",
    "--disable-beacon",
    "--redact-logs-to-client",
    ...hardenedArgs,
  ];
}

function withoutBackendTelemetry(command, options) {
  if (!isLocalBackendCommand(command)) return options;

  return {
    ...options,
    env: {
      ...process.env,
      ...options?.env,
      SENTRY_DSN: "",
    },
  };
}

const originalSpawn = childProcess.spawn;
childProcess.spawn = function spawn(command, args, options) {
  return originalSpawn.call(
    childProcess,
    command,
    withLocalBackendHardening(command, args),
    withoutBackendTelemetry(command, options)
  );
};

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function spawnSync(command, args, options) {
  return originalSpawnSync.call(
    childProcess,
    command,
    withLocalBackendHardening(command, args),
    withoutBackendTelemetry(command, options)
  );
};

const convexPackageJson = require.resolve("convex/package.json", {
  paths: [path.join(__dirname, "..")],
});
const convexRoot = path.dirname(convexPackageJson);
const convexBin = path.join(convexRoot, "bin", "main.js");
const cliBundle = path.join(convexRoot, "dist", "cli.bundle.cjs");

process.argv = [process.argv[0], convexBin, ...cliArgs];
import(pathToFileURL(cliBundle).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
