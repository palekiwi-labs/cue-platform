import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PREFIX } from "../src/supervisor/api";
import { connect } from "@nats-io/transport-node";

const root = mkdtempSync(join(tmpdir(), "sup-nats-"));
const executable = process.argv[2];
const cli = executable ? [executable] : [process.execPath, join(import.meta.dir, "../src/supervisor/cli.ts")];
const fake = join(root, "pi");
writeFileSync(fake, `#!/bin/sh
for last; do :; done
case "$last" in
  hang) sleep 60 ;;
  *) echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"PONG"}]}}' ;;
esac
`);
chmodSync(fake, 0o755);
const env = { ...process.env, CUE_SUPERVISOR_STATE: root, CUE_SUPERVISOR_PI: fake };
const batches: string[] = [];
let daemon: ReturnType<typeof Bun.spawn> | undefined;
function start() {
  daemon = Bun.spawn([...cli, "daemon"], { env, stdout: "ignore", stderr: Bun.file(join(root, "daemon.log")) });
}
async function stop() {
  daemon?.kill("SIGTERM");
  if (daemon) await daemon.exited;
}
function nats(args: string[]) {
  const proc = Bun.spawnSync(["nats", "--server", env.CUE_NATS_URL || "nats://127.0.0.1:4222", "--js-domain", env.CUE_NATS_JS_DOMAIN ?? "pale", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}
function request(op: string, value: unknown): any {
  return JSON.parse(nats(["request", `${API_PREFIX}.${op}`, JSON.stringify(value), "--raw", "--timeout", "2s"]));
}
async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const reply = request("status", { kind: "run", runId: "missing" });
      if (reply.error.code === "not_found") return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`daemon not ready: ${readFileSync(join(root, "daemon.log"), "utf8")}`);
}
async function result(runId: string, outcome: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const reply = request("result", { kind: "run", runId });
    if (reply.data?.runs[0]?.result?.outcome === outcome) return;
    await Bun.sleep(100);
  }
  throw new Error(`result did not become ${outcome}`);
}
try {
  start();
  await ready();
  const heartbeat = JSON.parse(nats(["kv", "get", "supervisors", "supervisor", "--raw"]));
  assert(Date.now() - heartbeat.updatedAt < 15_000);
  const input = { requestId: `cli-${Date.now()}`, spec: { runs: [
    { cwd: root, context: "supervisor-design", prompt: "ok" },
    { cwd: root, context: "supervisor-design", prompt: "hang" },
  ] } };
  const first = request("submit", input);
  assert.equal(first.ok, true);
  batches.push(first.data.batchId);
  const persisted = JSON.parse(readFileSync(join(root, "batches", `${first.data.batchId}.json`), "utf8"));
  assert.equal(persisted.requestId, input.requestId);
  assert.deepEqual(request("submit", input), first);
  assert.equal(request("submit", { ...input, spec: { runs: [input.spec.runs[0]] } }).error.code, "conflict");
  await result(first.data.runIds[0], "succeeded");
  assert.equal(request("status", { kind: "batch", batchId: first.data.batchId }).data.runs.length, 2);
  await stop();
  start();
  await ready();
  assert.deepEqual(request("submit", input), first);
  assert.equal(request("cancel", { kind: "run", runId: first.data.runIds[1] }).ok, true);
  await result(first.data.runIds[1], "cancelled");
  const second = request("submit", { ...input, requestId: `${input.requestId}-batch`, spec: { runs: [input.spec.runs[1], input.spec.runs[1]] } });
  batches.push(second.data.batchId);
  assert.equal(request("cancel", { kind: "batch", batchId: second.data.batchId }).ok, true);
  for (const runId of second.data.runIds) await result(runId, "cancelled");
  const nc = await connect({ servers: env.CUE_NATS_URL || "nats://127.0.0.1:4222", reconnect: false });
  const uncertain = { ...input, requestId: `${input.requestId}-timeout` };
  try {
    await assert.rejects(nc.request(`${API_PREFIX}.submit`, JSON.stringify(uncertain), { timeout: 1 }));
    await Bun.sleep(200);
    const retry = request("submit", uncertain);
    assert.equal(retry.ok, true);
    batches.push(retry.data.batchId);
    assert.deepEqual(request("submit", uncertain), retry);
    request("cancel", { kind: "batch", batchId: retry.data.batchId });
  } finally { await nc.close(); }
  await stop();
  const absent = Bun.spawnSync(["nats", "request", `${API_PREFIX}.status`, "{}", "--raw", "--timeout", "1s"], { stdout: "pipe", stderr: "pipe" });
  assert.match(absent.stderr.toString(), /No responders/i);
  assert.equal(absent.stdout.toString().trim(), "");
  console.log(JSON.stringify({ root, batches, checks: "CLI submit/dedup/conflict/restart/status/result/run+batch cancel/heartbeat/no responders passed" }));
} finally {
  await stop();
  for (const batch of batches) Bun.spawnSync(["systemctl", "--user", "stop", `cue-runs-${batch}.slice`], { stdout: "ignore", stderr: "ignore" });
}
