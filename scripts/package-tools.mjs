import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_ID = "io.cno.mihomo";
export const PACKAGE_PREFIX = "/io.cno.mihomo";
export const STATIC_URL_PREFIX = `${PACKAGE_PREFIX}/`;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_DEPLOYED_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRIES = 4096;
export const REPRODUCIBLE_MTIME = new Date("2000-01-01T00:00:00.000Z");

const manifestKeys = new Set([
  "schema",
  "id",
  "name",
  "version",
  "entry",
  "acceptPackageCalls",
  "shutdownTimeoutMs",
  "prefix",
  "permissions",
]);
const permissionKeys = new Set([
  "read",
  "write",
  "env",
  "net",
  "run",
  "ffi",
  "sys",
]);
const semver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeRelativePath(value, label = "path") {
  assert(
    typeof value === "string" && value.length > 0,
    `${label} must not be empty`,
  );
  assert(
    !isAbsolute(value) && !value.startsWith("/") && !value.startsWith("\\"),
    `${label} must be relative`,
  );
  assert(
    !value.includes("\\") && !value.includes("\0"),
    `${label} contains an unsafe separator`,
  );
  const parts = value.split("/");
  assert(
    parts.every((part) => part && part !== "." && part !== ".."),
    `${label} contains an unsafe segment`,
  );
  return parts.join("/");
}

export function validateManifest(value) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "meta.json must contain an object",
  );
  for (const key of Object.keys(value))
    assert(manifestKeys.has(key), `unknown meta.json field: ${key}`);
  assert(value.schema === 1, "meta.json schema must be 1");
  assert(value.id === PACKAGE_ID, `meta.json id must be ${PACKAGE_ID}`);
  assert(
    typeof value.name === "string" &&
      value.name.length > 0 &&
      value.name.length <= 128,
    "meta.json name must be 1..128 characters",
  );
  assert(
    typeof value.version === "string" &&
      value.version.length <= 128 &&
      semver.test(value.version),
    "meta.json version must be SemVer",
  );
  assert(
    value.prefix === PACKAGE_PREFIX,
    `meta.json prefix must be ${PACKAGE_PREFIX}`,
  );
  assert(
    typeof value.entry === "string" && value.entry.endsWith(".js"),
    "meta.json entry must be a relative .js path",
  );
  safeRelativePath(value.entry, "meta.json entry");
  assert(
    typeof value.acceptPackageCalls === "boolean",
    "meta.json acceptPackageCalls must be boolean",
  );
  assert(
    Number.isInteger(value.shutdownTimeoutMs) &&
      value.shutdownTimeoutMs >= 100 &&
      value.shutdownTimeoutMs <= 30000,
    "meta.json shutdownTimeoutMs must be 100..30000",
  );
  const permissions = value.permissions;
  assert(
    permissions &&
      typeof permissions === "object" &&
      !Array.isArray(permissions),
    "meta.json permissions must be an object",
  );
  for (const key of Object.keys(permissions))
    assert(permissionKeys.has(key), `unknown permissions field: ${key}`);
  for (const key of ["read", "write", "env"]) {
    assert(
      Array.isArray(permissions[key]) &&
        permissions[key].every((item) => typeof item === "string"),
      `permissions.${key} must be a string array`,
    );
  }
  for (const key of ["net", "run", "ffi", "sys"])
    assert(
      typeof permissions[key] === "boolean",
      `permissions.${key} must be boolean`,
    );
  return value;
}

async function walk(root, current = root, output = []) {
  const names = await readdir(current);
  names.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    const absolute = join(current, name);
    const item = await lstat(absolute);
    const archivePath = relative(root, absolute).split(sep).join("/");
    safeRelativePath(archivePath, "package path");
    assert(
      !item.isSymbolicLink(),
      `symbolic links are not allowed: ${archivePath}`,
    );
    if (item.isDirectory()) await walk(root, absolute, output);
    else {
      assert(item.isFile(), `only regular files are allowed: ${archivePath}`);
      output.push({ absolute, path: archivePath, size: item.size });
    }
  }
  return output;
}

function stripQueryAndFragment(value) {
  return value.split(/[?#]/, 1)[0];
}

export function staticReferences(html) {
  const values = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi))
    values.push(match[1]);
  return values;
}

export async function validatePackageTree(root) {
  const files = await walk(root);
  assert(files.length > 0, "package staging tree is empty");
  assert(
    files.length <= MAX_ENTRIES,
    `package has ${files.length} files; maximum is ${MAX_ENTRIES}`,
  );
  const deployedBytes = files.reduce((total, item) => total + item.size, 0);
  assert(
    deployedBytes <= MAX_DEPLOYED_BYTES,
    `deployed package is ${formatBytes(deployedBytes)}; maximum is ${formatBytes(MAX_DEPLOYED_BYTES)}`,
  );
  for (const item of files)
    assert(
      item.size <= MAX_DEPLOYED_BYTES,
      `${item.path} exceeds the 16 MiB per-file deployment budget`,
    );

  const paths = new Set(files.map((item) => item.path));
  assert(paths.has("meta.json"), "package root must contain meta.json");
  assert(
    paths.has("static/index.html"),
    "package root must contain static/index.html",
  );
  const metaText = await readFile(join(root, "meta.json"), "utf8");
  assert(Buffer.byteLength(metaText) <= 64 * 1024, "meta.json exceeds 64 KiB");
  let manifest;
  try {
    manifest = JSON.parse(metaText);
  } catch (error) {
    throw new Error(
      `meta.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateManifest(manifest);
  assert(
    paths.has(manifest.entry),
    `package entry does not exist: ${manifest.entry}`,
  );

  const html = await readFile(join(root, "static/index.html"), "utf8");
  for (const rawReference of staticReferences(html)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rawReference)) continue;
    const clean = stripQueryAndFragment(rawReference);
    if (!clean) continue;
    assert(
      clean.startsWith(STATIC_URL_PREFIX),
      `static/index.html local references must use ${STATIC_URL_PREFIX}: ${rawReference}`,
    );
    let decoded;
    try {
      decoded = decodeURIComponent(clean.slice(STATIC_URL_PREFIX.length));
    } catch {
      throw new Error(
        `static/index.html contains invalid URL encoding: ${rawReference}`,
      );
    }
    if (!decoded) decoded = "index.html";
    const normalized = posix.normalize(posix.join("static", decoded));
    safeRelativePath(normalized, `static reference ${rawReference}`);
    assert(
      normalized === "static" || normalized.startsWith("static/"),
      `static reference escapes static/: ${rawReference}`,
    );
    assert(
      paths.has(normalized),
      `static reference is missing from package: ${rawReference}`,
    );
  }
  return { files, manifest, deployedBytes };
}

async function copyPackageSource(packageDir, stageDir) {
  const sourceFiles = await walk(packageDir);
  assert(
    !sourceFiles.some(
      (item) => item.path === "static" || item.path.startsWith("static/"),
    ),
    "package/ must not contain static/; it is generated from dist/",
  );
  const metaItem = sourceFiles.find((item) => item.path === "meta.json");
  assert(metaItem, "package/ must contain meta.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(metaItem.absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `meta.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateManifest(manifest);
  const releaseFiles = new Set(["meta.json", manifest.entry]);
  for (const item of sourceFiles) {
    if (!releaseFiles.has(item.path)) continue;
    const destination = join(stageDir, ...item.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(item.absolute, destination, { force: false, errorOnExist: true });
  }
}

async function copyUi(distDir, stageDir) {
  const uiFiles = await walk(distDir);
  assert(
    uiFiles.some((item) => item.path === "index.html"),
    "dist/ must contain index.html",
  );
  for (const item of uiFiles) {
    const destination = join(stageDir, "static", ...item.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(item.absolute, destination, { force: false, errorOnExist: true });
  }
}

async function normalizeTree(files) {
  for (const item of files) {
    await chmod(item.absolute, 0o644);
    await utimes(item.absolute, REPRODUCIBLE_MTIME, REPRODUCIBLE_MTIME);
  }
}

export async function assemblePackage({ packageDir, distDir, output }) {
  const resolvedPackage = resolve(packageDir);
  const resolvedDist = resolve(distDir);
  const resolvedOutput = resolve(output);
  assert(
    (await stat(resolvedPackage)).isDirectory(),
    `package source directory does not exist: ${resolvedPackage}`,
  );
  assert(
    (await stat(resolvedDist)).isDirectory(),
    `UI dist directory does not exist: ${resolvedDist}`,
  );
  const temporary = await mkdtemp(join(tmpdir(), "io.cno.mihomo-package-"));
  const stage = join(temporary, "stage");
  try {
    await mkdir(stage);
    await copyPackageSource(resolvedPackage, stage);
    await copyUi(resolvedDist, stage);
    const validation = await validatePackageTree(stage);
    await normalizeTree(validation.files);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await rm(resolvedOutput, { force: true });
    const archiveEntries = validation.files
      .map((item) => item.path)
      .sort((left, right) => left.localeCompare(right, "en"));
    await execFileAsync(
      "zip",
      ["-X", "-q", "-9", resolvedOutput, ...archiveEntries],
      {
        cwd: stage,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await execFileAsync("unzip", ["-tqq", resolvedOutput], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const archive = await readFile(resolvedOutput);
    assert(
      archive.byteLength <= MAX_ARCHIVE_BYTES,
      `release ZIP is ${formatBytes(archive.byteLength)}; maximum is ${formatBytes(MAX_ARCHIVE_BYTES)}`,
    );
    const digest = createHash("sha256").update(archive).digest("hex");
    return {
      output: resolvedOutput,
      archiveBytes: archive.byteLength,
      deployedBytes: validation.deployedBytes,
      entries: validation.files.length,
      manifest: validation.manifest,
      sha256: digest,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export async function commandExists(command) {
  try {
    await execFileAsync(command, ["-v"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function createEmptyFile(path) {
  const handle = await open(path, "w");
  await handle.close();
}

export function outputName(path) {
  return basename(path);
}
