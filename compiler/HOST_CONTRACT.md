# Script runner host contract

The compiler never evaluates user JavaScript in the long-lived circud package
runtime. For every Script stage the OpenWrt companion starts one fresh `cno`
process running `/usr/lib/io.cno.mihomo/script-runner.ts`, writes exactly one
bounded JSON request to stdin, closes stdin, and reads exactly one bounded JSON
envelope from stdout. The compiler protocol types remain authoritative for the
stage input and result; the privileged daemon translates them to this narrow
process envelope.

The host must enforce the following independently of JavaScript:

- terminate the child after `SCRIPT_RUNNER_LIMITS.watchdogMs` (8000 ms), then
  report `SCRIPT_FAILED` with a timeout message;
- cap captured stdout at 12 MiB and stderr at a small diagnostic allowance;
- treat malformed JSON, an invalid envelope, a signal, or an abnormal child
  exit as runner failure;
- close and reap the child on request cancellation or circud package shutdown;
- start the child without inherited network/file descriptors or secrets. The
  runner needs only piped stdin/stdout and its installed code.

The runner applies the documented public CNO process-runtime memory and stack
limits before creating its `CNO.Sandbox`. `Sandbox` currently has no public
per-context memory limit or interrupt handler. Consequently the host watchdog
is the authoritative CPU/infinite-loop boundary; no nonexistent CNO API is
assumed here.

The production runner constructs a fresh native Sandbox successfully and the
OpenWrt integration suite verifies execution, logging, JSON result validation,
and absence of Deno/network/filesystem globals. Replacing Sandbox with host
global `eval` would expose CNO capabilities to profile scripts and remains an
explicitly forbidden fallback.

`revision` is SHA-256 of the protocol name plus the canonical complete compile
request. `contentHash` is SHA-256 of the exact generated YAML bytes. The former
identifies compiler inputs; the latter identifies the artifact applied to
Mihomo.
