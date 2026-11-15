import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
  legalComments: "none",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/profile-compiler.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "../package/lib/profile-compiler.js",
    sourcemap: false,
  }),
  build({
    ...shared,
    entryPoints: ["src/cno-script-runner.ts"],
    outfile: "dist/cno-script-runner.js",
  }),
  build({
    ...shared,
    entryPoints: ["../package/management.js"],
    outfile: "../package/management.bundle.min.js",
    external: ["circud"],
    minify: true,
    sourcemap: false,
  }),
]);
