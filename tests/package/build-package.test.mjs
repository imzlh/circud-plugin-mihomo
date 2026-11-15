import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assemblePackage,
  MAX_ARCHIVE_BYTES,
  MAX_DEPLOYED_BYTES,
  validateManifest,
  validatePackageTree,
} from "../../scripts/package-tools.mjs";

const execFileAsync = promisify(execFile);

const validMeta = {
  schema: 1,
  id: "io.cno.mihomo",
  name: "CNO Mihomo Manager",
  version: "0.1.0",
  entry: "management.js",
  acceptPackageCalls: false,
  shutdownTimeoutMs: 5000,
  prefix: "/io.cno.mihomo",
  permissions: {
    read: [],
    write: [],
    env: [],
    net: true,
    run: false,
    ffi: false,
    sys: false,
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mihomo-package-test-"));
  const packageDir = join(root, "package");
  const distDir = join(root, "dist");
  await mkdir(join(packageDir, "lib"), { recursive: true });
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(
    join(packageDir, "meta.json"),
    `${JSON.stringify(validMeta, null, 2)}\n`,
  );
  await writeFile(
    join(packageDir, "management.js"),
    "import './lib/router.js';\n",
  );
  await writeFile(
    join(packageDir, "lib/router.js"),
    "export const router = true;\n",
  );
  await mkdir(join(packageDir, "tests"), { recursive: true });
  await writeFile(join(packageDir, "README.md"), "development notes\n");
  await writeFile(join(packageDir, "tests/modules.test.mjs"), "export {};\n");
  await writeFile(
    join(distDir, "index.html"),
    '<link rel="stylesheet" href="/io.cno.mihomo/assets/app.css"><script src="/io.cno.mihomo/assets/app.js"></script>',
  );
  await writeFile(join(distDir, "assets/app.css"), "body{}\n");
  await writeFile(join(distDir, "assets/app.js"), 'console.log("ok");\n');
  return { root, packageDir, distDir };
}

test("strict manifest accepts the release contract and rejects drift", () => {
  assert.equal(
    validateManifest(structuredClone(validMeta)).id,
    "io.cno.mihomo",
  );
  assert.throws(
    () => validateManifest({ ...validMeta, id: "io.example.other" }),
    /id must be/,
  );
  assert.throws(
    () => validateManifest({ ...validMeta, prefix: "/other" }),
    /prefix must be/,
  );
  assert.throws(
    () => validateManifest({ ...validMeta, extra: true }),
    /unknown meta.json field/,
  );
});

test("tree validation enforces the circud prefix and rejects invalid static assets", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const stage = join(item.root, "stage");
  await mkdir(join(stage, "static"), { recursive: true });
  await writeFile(join(stage, "meta.json"), JSON.stringify(validMeta));
  await writeFile(join(stage, "management.js"), "export {};");
  await writeFile(
    join(stage, "static/index.html"),
    '<script src="./assets/app.js"></script>',
  );
  await assert.rejects(
    validatePackageTree(stage),
    /local references must use \/io\.cno\.mihomo\//,
  );
  await writeFile(
    join(stage, "static/index.html"),
    '<script src="/io.cno.mihomo/assets/missing.js"></script>',
  );
  await assert.rejects(
    validatePackageTree(stage),
    /static reference is missing/,
  );
  await writeFile(
    join(stage, "static/index.html"),
    '<script src="/io.cno.mihomo/../management.js"></script>',
  );
  await assert.rejects(validatePackageTree(stage), /escapes static/);
});

test("tree validation rejects symbolic links", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await symlink("../management.js", join(item.packageDir, "lib/link.js"));
  await assert.rejects(
    assemblePackage({
      packageDir: item.packageDir,
      distDir: item.distDir,
      output: join(item.root, "bad.zip"),
    }),
    /symbolic links are not allowed/,
  );
});

test("build creates a flat, reproducible circud ZIP within deployment budgets", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const first = join(item.root, "first.zip");
  const second = join(item.root, "second.zip");
  const one = await assemblePackage({
    packageDir: item.packageDir,
    distDir: item.distDir,
    output: first,
  });
  const two = await assemblePackage({
    packageDir: item.packageDir,
    distDir: item.distDir,
    output: second,
  });
  assert.equal(one.manifest.id, "io.cno.mihomo");
  assert.ok(one.archiveBytes <= MAX_ARCHIVE_BYTES);
  assert.ok(one.deployedBytes <= MAX_DEPLOYED_BYTES);
  assert.equal(one.sha256, two.sha256);
  const digest = createHash("sha256")
    .update(await readFile(first))
    .digest("hex");
  assert.equal(digest, one.sha256);
  const { stdout } = await execFileAsync("unzip", ["-Z1", first]);
  const archivePaths = stdout.trim().split("\n");
  assert.ok(!archivePaths.includes("README.md"));
  assert.ok(!archivePaths.some((path) => path.startsWith("tests/")));
  assert.ok(!archivePaths.some((path) => path.startsWith("lib/")));
  assert.deepEqual(
    archivePaths.filter((path) => !path.startsWith("static/")),
    ["management.js", "meta.json"],
  );
});

test("tree validation rejects more than 16 MiB of deployed files", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await writeFile(join(item.packageDir, "management.js"), "");
  await truncate(
    join(item.packageDir, "management.js"),
    MAX_DEPLOYED_BYTES + 1,
  );
  await assert.rejects(
    assemblePackage({
      packageDir: item.packageDir,
      distDir: item.distDir,
      output: join(item.root, "bad.zip"),
    }),
    /deployed package is .* maximum is 16\.00 MiB/,
  );
});

test("archive validation rejects an incompressible ZIP larger than 8 MiB", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await writeFile(
    join(item.packageDir, "management.js"),
    randomBytes(MAX_ARCHIVE_BYTES),
  );
  await assert.rejects(
    assemblePackage({
      packageDir: item.packageDir,
      distDir: item.distDir,
      output: join(item.root, "bad.zip"),
    }),
    /release ZIP is .* maximum is 8\.00 MiB/,
  );
});
