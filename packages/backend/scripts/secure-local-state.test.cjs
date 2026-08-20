const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "secure-local-state.cjs");

async function mode(filePath) {
  return (await stat(filePath)).mode & 0o777;
}

async function runSecureLocalState(home) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, HOME: home },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function withTemporaryHome(run) {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "audora-secure-state-"));
  const root = await realpath(createdRoot);
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  try {
    await run({ root, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createState(home) {
  const convexRoot = path.join(home, ".convex");
  const stateRoot = path.join(convexRoot, "anonymous-convex-backend-state");
  const nested = path.join(stateRoot, "deployment");
  const dataFile = path.join(nested, "data.sqlite3");
  await mkdir(nested, { recursive: true, mode: 0o755 });
  await writeFile(dataFile, "fixture", { mode: 0o644 });
  await chmod(convexRoot, 0o755);
  await chmod(stateRoot, 0o755);
  await chmod(nested, 0o755);
  await chmod(dataFile, 0o644);
  return { convexRoot, stateRoot, nested, dataFile };
}

test("repairs a fully validated anonymous state tree", async () => {
  await withTemporaryHome(async ({ home }) => {
    const paths = await createState(home);
    const result = await runSecureLocalState(home);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Secured anonymous Convex state/);
    assert.equal(await mode(paths.convexRoot), 0o755);
    assert.equal(await mode(paths.stateRoot), 0o700);
    assert.equal(await mode(paths.nested), 0o700);
    assert.equal(await mode(paths.dataFile), 0o600);
  });
});

test("refuses a linked .convex parent without changing its target", async () => {
  await withTemporaryHome(async ({ root, home }) => {
    const target = path.join(root, "linked-convex");
    const stateRoot = path.join(target, "anonymous-convex-backend-state");
    const dataFile = path.join(stateRoot, "data.sqlite3");
    await mkdir(stateRoot, { recursive: true, mode: 0o755 });
    await writeFile(dataFile, "fixture", { mode: 0o644 });
    await chmod(stateRoot, 0o755);
    await chmod(dataFile, 0o644);
    await symlink(target, path.join(home, ".convex"), "dir");

    const result = await runSecureLocalState(home);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a symbolic link/);
    assert.equal(await mode(stateRoot), 0o755);
    assert.equal(await mode(dataFile), 0o644);
  });
});

test("rejects hard-linked files before changing any mode", async () => {
  await withTemporaryHome(async ({ root, home }) => {
    const paths = await createState(home);
    const externalFile = path.join(root, "external.txt");
    const linkedFile = path.join(paths.stateRoot, "linked.txt");
    await writeFile(externalFile, "fixture", { mode: 0o644 });
    await chmod(externalFile, 0o644);
    await link(externalFile, linkedFile);

    const result = await runSecureLocalState(home);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /additional hard links/);
    assert.equal(await mode(paths.stateRoot), 0o755);
    assert.equal(await mode(paths.nested), 0o755);
    assert.equal(await mode(paths.dataFile), 0o644);
    assert.equal(await mode(externalFile), 0o644);
  });
});

test("rejects nested symbolic links before changing any mode", async () => {
  await withTemporaryHome(async ({ root, home }) => {
    const paths = await createState(home);
    const externalFile = path.join(root, "external.txt");
    await writeFile(externalFile, "fixture", { mode: 0o644 });
    await symlink(externalFile, path.join(paths.stateRoot, "linked.txt"), "file");

    const result = await runSecureLocalState(home);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refusing to follow symbolic link/);
    assert.equal(await mode(paths.stateRoot), 0o755);
    assert.equal(await mode(paths.nested), 0o755);
    assert.equal(await mode(paths.dataFile), 0o644);
    assert.equal(await mode(externalFile), 0o644);
  });
});
