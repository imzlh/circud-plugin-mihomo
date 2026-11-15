#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  assemblePackage,
  commandExists,
  formatBytes,
  MAX_ARCHIVE_BYTES,
  MAX_DEPLOYED_BYTES,
} from "./package-tools.mjs";

function usage() {
  console.log(`Usage: node scripts/build-package.mjs [options]

Options:
  --skip-ui-build       Reuse an existing dist/ directory
  --package-dir PATH    Backend source directory (default: package)
  --dist-dir PATH       Vite output directory (default: dist)
  --output PATH         Release ZIP (default: artifacts/io.cno.mihomo.zip)
  -h, --help            Show this help

Deployment budgets:
  compressed ZIP        ${formatBytes(MAX_ARCHIVE_BYTES)}
  extracted regular files ${formatBytes(MAX_DEPLOYED_BYTES)}
`);
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
          ),
        );
    });
  });
}

function options(argv) {
  const result = {
    buildUi: true,
    packageDir: "package",
    distDir: "dist",
    output: "artifacts/io.cno.mihomo.zip",
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--skip-ui-build") result.buildUi = false;
    else if (argument === "-h" || argument === "--help") result.help = true;
    else if (
      argument === "--package-dir" ||
      argument === "--dist-dir" ||
      argument === "--output"
    ) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === "--package-dir") result.packageDir = value;
      else if (argument === "--dist-dir") result.distDir = value;
      else result.output = value;
    } else throw new Error(`unknown option: ${argument}`);
  }
  return result;
}

async function main() {
  const selected = options(process.argv.slice(2));
  if (selected.help) return usage();
  for (const command of ["zip", "unzip"]) {
    if (!(await commandExists(command)))
      throw new Error(`required command is unavailable: ${command}`);
  }
  console.log("[package] building the authoritative profile compiler");
  await run("pnpm", ["--dir", "compiler", "build"]);
  if (selected.buildUi) {
    console.log("[package] building the managed Web UI");
    await run("pnpm", ["build"]);
  }
  console.log("[package] validating and assembling circud release");
  const result = await assemblePackage({
    packageDir: resolve(selected.packageDir),
    distDir: resolve(selected.distDir),
    output: resolve(selected.output),
  });
  console.log(`[package] ${result.output}`);
  console.log(
    `[package] ${result.entries} files, ZIP ${formatBytes(result.archiveBytes)}, deployed ${formatBytes(result.deployedBytes)}`,
  );
  console.log(`[package] sha256 ${result.sha256}`);
}

main().catch((error) => {
  console.error(
    `[package] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
