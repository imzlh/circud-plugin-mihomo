import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const manifest = JSON.parse(
  await readFile(new URL("../meta.json", import.meta.url), "utf8"),
);
const entry = new URL(`../${manifest.entry}`, import.meta.url);
const context = vm.createContext({
  AbortController,
  ArrayBuffer,
  Error,
  JSON,
  Map,
  Object,
  Promise,
  Set,
  String,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  URL,
  console,
});
const listeners = [];
const nativeModules = {
  evbus: {
    on(namespace, event, listener) {
      listeners.push({ namespace, event, listener });
    },
  },
  fs: {
    files: new Map(),
    exists() {
      return false;
    },
    readFile() {
      throw new Error("unexpected read");
    },
    writeFile(path, data) {
      this.files.set(path, data);
    },
    rename(from, to) {
      this.files.set(to, this.files.get(from));
      this.files.delete(from);
    },
    unlink(path) {
      this.files.delete(path);
    },
  },
  curl: {
    CURL: class {},
    ConnPool: class {
      close() {}
    },
  },
  process: {},
  crypto: {
    async sha256() {
      return new Uint8Array(32).buffer;
    },
  },
  text: { Encoder: TextEncoder, Decoder: TextDecoder },
};
const modules = new Map();

async function load(url) {
  const key = url.href;
  if (modules.has(key)) return modules.get(key);
  const source = await readFile(url, "utf8");
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: key,
    initializeImportMeta(meta) {
      meta.url = key;
      meta.use = (name) => {
        if (!(name in nativeModules))
          throw new Error(`unknown native module ${name}`);
        return nativeModules[name];
      };
    },
  });
  modules.set(key, module);
  await module.link(async (specifier, referencing) => {
    if (specifier === "circud") return circud;
    return load(new URL(specifier, referencing.identifier));
  });
  return module;
}

const circud = new vm.SyntheticModule(
  ["info"],
  function initialize() {
    this.setExport("info", () => ({
      packageId: "io.cno.mihomo",
      packageDir: "/package",
      dataDir: "/data",
    }));
  },
  { context, identifier: "circud" },
);

const module = await load(entry);
await module.evaluate();
assert.deepEqual(
  listeners.map(({ namespace, event }) => [namespace, event]),
  [
    ["circud.host", "endpoint"],
    ["circud.host", "call"],
  ],
);
