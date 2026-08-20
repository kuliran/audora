const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const stateRoot = path.resolve(
  os.homedir(),
  ".convex",
  "anonymous-convex-backend-state"
);
const expectedParent = path.resolve(os.homedir(), ".convex");
const currentUid = typeof process.getuid === "function" ? process.getuid() : null;

if (
  path.dirname(stateRoot) !== expectedParent ||
  path.basename(stateRoot) !== "anonymous-convex-backend-state"
) {
  throw new Error("Refusing to change permissions outside anonymous Convex state");
}

function requireCurrentOwner(metadata, entryPath) {
  if (currentUid !== null && metadata.uid !== currentUid) {
    throw new Error(`Refusing entry not owned by the current user: ${entryPath}`);
  }
}

async function requireLiteralOwnedDirectory(directoryPath, label) {
  const metadata = await fs.lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a directory and not a symbolic link: ${directoryPath}`);
  }
  requireCurrentOwner(metadata, directoryPath);

  const resolvedPath = await fs.realpath(directoryPath);
  if (resolvedPath !== directoryPath) {
    throw new Error(`${label} must not contain symbolic-link path components: ${directoryPath}`);
  }
}

async function validateEntry(entryPath, entriesToSecure) {
  const metadata = await fs.lstat(entryPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link: ${entryPath}`);
  }
  requireCurrentOwner(metadata, entryPath);

  if (metadata.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await validateEntry(path.join(entryPath, entry), entriesToSecure);
    }
    entriesToSecure.push({ path: entryPath, mode: 0o700 });
    return;
  }

  if (metadata.isFile()) {
    if (metadata.nlink !== 1) {
      throw new Error(`Refusing file with additional hard links: ${entryPath}`);
    }
    entriesToSecure.push({ path: entryPath, mode: 0o600 });
    return;
  }

  throw new Error(`Refusing non-file, non-directory entry: ${entryPath}`);
}

async function secureAnonymousState() {
  let parentMetadata;
  try {
    parentMetadata = await fs.lstat(expectedParent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("No existing anonymous Convex state found; nothing to repair.");
      return false;
    }
    throw error;
  }

  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(
      `Convex state parent must be a directory and not a symbolic link: ${expectedParent}`
    );
  }
  requireCurrentOwner(parentMetadata, expectedParent);
  if ((await fs.realpath(expectedParent)) !== expectedParent) {
    throw new Error(
      `Convex state parent must not contain symbolic-link path components: ${expectedParent}`
    );
  }

  try {
    await fs.lstat(stateRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("No existing anonymous Convex state found; nothing to repair.");
      return false;
    }
    throw error;
  }

  await requireLiteralOwnedDirectory(stateRoot, "Anonymous Convex state root");

  // Validate the complete tree before changing any mode. This avoids partially
  // repairing an unsafe tree and prevents linked entries from changing files
  // outside the anonymous Convex state directory.
  const entriesToSecure = [];
  await validateEntry(stateRoot, entriesToSecure);

  for (const entry of entriesToSecure) {
    await fs.chmod(entry.path, entry.mode);
  }
  return true;
}

secureAnonymousState()
  .then((secured) => {
    if (secured) console.log(`Secured anonymous Convex state: ${stateRoot}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
