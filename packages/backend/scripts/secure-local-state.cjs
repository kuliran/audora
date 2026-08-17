const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const stateRoot = path.resolve(
  os.homedir(),
  ".convex",
  "anonymous-convex-backend-state"
);
const expectedParent = path.resolve(os.homedir(), ".convex");

if (
  path.dirname(stateRoot) !== expectedParent ||
  path.basename(stateRoot) !== "anonymous-convex-backend-state"
) {
  throw new Error("Refusing to change permissions outside anonymous Convex state");
}

async function secureEntry(entryPath) {
  const metadata = await fs.lstat(entryPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link: ${entryPath}`);
  }

  if (metadata.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await secureEntry(path.join(entryPath, entry));
    }
    await fs.chmod(entryPath, 0o700);
    return;
  }

  if (metadata.isFile()) {
    await fs.chmod(entryPath, 0o600);
  }
}

fs.lstat(stateRoot)
  .then(() => secureEntry(stateRoot))
  .then(() => {
    console.log(`Secured anonymous Convex state: ${stateRoot}`);
  })
  .catch((error) => {
    if (error?.code === "ENOENT") {
      console.log("No existing anonymous Convex state found; nothing to repair.");
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
