import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [unitDir, telemetryPlatform] = process.argv.slice(2);
assert(unitDir && telemetryPlatform, "usage: bun tests/supervisor-service.ts <unit-dir> <telemetry-platform>");
assert.equal(readFileSync("/etc/palekiwi/machine-role", "utf8").trim(), "vm");
const unit = readFileSync(join(unitDir, "cue-supervisor.service"), "utf8");
const executable = unit.match(/^ExecStart=(\S+) daemon$/m)?.[1];
assert(executable, "unit must start the packaged daemon directly");
const root = mkdtempSync("/tmp/sup-service-");
const tag = `cue-supervisor-qa-${crypto.randomUUID()}`;
const daemon = `${tag}.service`;
const launcher = `${tag}-launch.service`;
const unitRoot = join(process.env.XDG_RUNTIME_DIR!, "systemd", "user");
mkdirSync(unitRoot, { recursive: true });
const files = [daemon, launcher].map((name) => join(unitRoot, name));
const specPath = join(root, "spec.json");
let runUnit: string | undefined;
let runSlice: string | undefined;
let monitor: any;

function systemctl(...args: string[]): string {
  const proc = Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(proc.exitCode, 0, proc.stderr.toString());
  return proc.stdout.toString().trim();
}

async function until(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(100);
  }
}

async function envOf(pid: string | number): Promise<Record<string, string>> {
  let env: Record<string, string> | undefined;
  await until(() => {
    try {
      env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => {
        const at = entry.indexOf("=");
        return [entry.slice(0, at), entry.slice(at + 1)];
      }));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      return false;
    }
  }, "process environment readable after exec");
  return env!;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  const { openMonitorSource } = await import(join(telemetryPlatform, "src/nats/monitor-source.ts"));
  const { runViews } = await import(join(telemetryPlatform, "src/nats/monitor-model.ts"));
  monitor = await openMonitorSource({ url: "nats://127.0.0.1:4222", domain: "pale" });
  const isolated = unit + `\n[Service]\nEnvironment=CUE_SUPERVISOR_STATE=${root}\nEnvironment=CUE_SUPERVISOR_RECONCILE_MS=100\n`;
  writeFileSync(files[0], isolated);
  writeFileSync(specPath, JSON.stringify({ runs: [{
    cwd: root,
    context: "supervisor-design",
    model: "google/gemini-3.8-flash",
    timeoutSec: 120,
    prompt: "Use the bash tool to run exactly: sleep 10. Then reply with exactly PONG. Do not edit any files.",
  }] }));
  writeFileSync(files[1], isolated.replace(`${executable} daemon`, `${executable} run --detach ${specPath}`) + "\n[Service]\nType=oneshot\nRestart=no\n");
  systemctl("daemon-reload");
  systemctl("start", daemon);
  const daemonEnv = await envOf(systemctl("show", daemon, "--property=MainPID", "--value"));
  const required = ["PATH", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "GEMINI_API_KEY", "NIX_PATH",
    "NIX_PROFILES", "NIX_USER_PROFILE_DIR", "NIX_SSL_CERT_FILE", "SSL_CERT_FILE", "CUE_STORE",
    "CUE_NATS_URL", "CUE_NATS_JS_DOMAIN", "TYPESAFE_API_KEY"];
  for (const name of required) assert(daemonEnv[name], `service environment missing ${name}`);
  assert.equal(daemonEnv.CUE_SUPERVISOR_STATE, root);
  console.log(JSON.stringify({ serviceEnvironmentVerified: required }));

  const orphan = join(root, "runs", "qa-unknown");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "run.json"), JSON.stringify({ unit: `${tag}-absent.service`, acceptedAt: 0 }));
  await until(() => existsSync(join(orphan, "result.json")), "periodic reconciliation");
  assert.equal(readJson(join(orphan, "result.json")).outcome, "unknown");
  systemctl("start", launcher);
  const batches = new Bun.Glob("*.json").scanSync(join(root, "batches"));
  const batch = readJson(join(root, "batches", [...batches][0]));
  const runId = batch.runIds[0];
  const runDir = join(root, "runs", runId);
  const record = readJson(join(runDir, "run.json"));
  runUnit = record.unit;
  runSlice = record.slice;
  assert.equal(record.sessionId, runId);
  monitor.select(record.sessionId);
  await until(() => existsSync(join(runDir, "started.json")), "run started");
  const runEnv = await envOf(readJson(join(runDir, "started.json")).pid);
  for (const name of required) {
    if (name === "PATH") assert(runEnv.PATH.includes(daemonEnv.PATH), "packaged launcher must retain service PATH");
    else assert(runEnv[name] === daemonEnv[name], `run environment differs: ${name}`);
  }
  assert.equal(runEnv.CUE_CONTEXT, "supervisor-design");
  await until(() => runViews(monitor.history(), monitor.rows(), Date.now()).some((view: any) => view.id.runId === runId && view.live), "live monitor run");
  await until(() => readFileSync(join(runDir, "events.jsonl"), "utf8").includes("tool_execution_start"), "real pi tool started");
  await until(() => monitor.activity().items.some((item: any) => item.kind === "tool" && item.tool === "bash" && item.status === "running"), "live NATS tool event");
  console.log(JSON.stringify({ liveRun: runId, model: "google/gemini-3.8-flash", state: "busy", liveToolEvent: "bash" }));

  systemctl("stop", daemon);
  assert.equal(systemctl("is-active", runUnit), "active");
  await until(() => existsSync(join(runDir, "result.json")), "independent run finalizer", 120_000);
  assert.equal(readJson(join(runDir, "result.json")).outcome, "succeeded");
  assert(readJson(join(runDir, "result.json")).text.includes("PONG"));
  rmSync(join(runDir, "result.json"));
  systemctl("start", daemon);
  await until(() => existsSync(join(runDir, "result.json")), "startup recovery");
  assert.equal(readJson(join(runDir, "result.json")).outcome, "succeeded");
  const sessions = [...new Bun.Glob("**/*.jsonl").scanSync(join(runDir, "session"))];
  assert.equal(sessions.length, 1);
  console.log(JSON.stringify({ periodicReconciliation: "unknown", startupRecovery: "succeeded", sessionFiles: 1,
    serviceStopSparedRun: true, evidence: root }));
} finally {
  if (runUnit) Bun.spawnSync(["systemctl", "--user", "stop", runUnit]);
  if (runSlice) Bun.spawnSync(["systemctl", "--user", "stop", runSlice]);
  for (const name of [launcher, daemon]) {
    Bun.spawnSync(["systemctl", "--user", "stop", name]);
    Bun.spawnSync(["systemctl", "--user", "reset-failed", name]);
  }
  for (const file of files) rmSync(file, { force: true });
  systemctl("daemon-reload");
  await monitor?.close();
}
