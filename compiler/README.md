# Mihomo profile compiler assets

This directory is independent of the browser UI. `src/compiler.ts` implements
the authoritative Merge/Seq/Script pipeline, deterministic revision hashes and
artifact hashes. Script execution is injected through the `ScriptRunner`
interface so the long-lived circud package never evaluates profile code.

```sh
pnpm build
pnpm test
pnpm typecheck
```

The build produces compiler development assets:

- `dist/profile-compiler.js`: bundled compiler and public protocol exports;
- `dist/cno-script-runner.js`: protocol-compatible runner used by compiler
  tests. The OpenWrt package installs its reviewed production runner from
  `openwrt/files/usr/lib/io.cno.mihomo/script-runner.ts`.

See `HOST_CONTRACT.md` before wiring the companion process into circud. Merge
and Seq execute in the package compiler. Script stages use the one-request CNO
companion process, which constructs a fresh native `CNO.Sandbox` with bounded
memory, stack, logs, input/output and watchdog time for every invocation.
