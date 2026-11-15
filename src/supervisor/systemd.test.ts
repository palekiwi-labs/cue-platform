import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

const FAKE_PI = `#!/bin/sh
for last; do :; done
case "$last" in
  ok) echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"PONG"}]}}' ;;
  fail) echo out; echo err >&2; exit 3 ;;
  hang) sleep 30 ;;
  signal) kill -SEGV $$ ;;
  pwd) pwd >&2; echo "$CUE_CONTEXT" >&2 ;;
esac
`;

interface CliRun {
  exitCode: number;
  output: { batchId: string; runs: { runId: string; result: any }[] };
  root: string;
}

function runCli(runs: unknown[], extraEnv: Record<string, string> = {}): CliRun {
  const root = mkdtempSync(join(tmpdir(), "sup-state-"));
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({ runs }));
  const proc = Bun.spawnSync([process.execPath, CLI, "run", specPath], {
    env: { ...process.env, CUE_SUPERVISOR_STATE: root, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.stdout.length === 0) throw new Error(proc.stderr.toString());
  return { exitCode: proc.exitCode ?? -1, output: JSON.parse(proc.stdout.toString()), root };
}

describe.skipIf(!process.env.SUP_SYSTEMD)("systemd runs with a fake pi", () => {
  test("outcomes: success, failure, timeout, signal, bad cwd, missing executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-pi-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, FAKE_PI);
    chmodSync(fakePi, 0o755);
    const base = { cwd: dir, context: "test-ctx" };
    const { exitCode, output, root } = runCli(
      [
        { ...base, prompt: "ok" },
        { ...base, prompt: "fail" },
        { ...base, prompt: "hang", timeoutSec: 2 },
        { ...base, prompt: "signal" },
        { ...base, cwd: "/nonexistent", prompt: "ok" },
        { ...base, prompt: "pwd" },
      ],
      { CUE_SUPERVISOR_PI: fakePi },
    );
    expect(exitCode).toBe(1);
    const outcomes = output.runs.map((run) => run.result.outcome);
    expect(outcomes).toEqual(["succeeded", "failed", "timed_out", "failed", "launch_failed", "failed"]);
    expect(output.runs[0].result.text).toBe("PONG");
    const pwdRun = join(root, "runs", output.runs[5].runId);
    expect(readFileSync(join(pwdRun, "diagnostics.log"), "utf8")).toBe(`${dir}\ntest-ctx\n`);
    expect(existsSync(join(pwdRun, "started.json"))).toBe(true);
    expect(existsSync(join(pwdRun, "outcome.json"))).toBe(true);

    const missing = runCli([{ ...base, prompt: "ok" }], { CUE_SUPERVISOR_PI: join(dir, "absent") });
    expect(missing.output.runs[0].result.outcome).toBe("launch_failed");
  }, 60_000);
});

describe.skipIf(!process.env.SUP_PI)("systemd runs with real pi", () => {
  test("a real prompt succeeds and a bad model fails, sessions kept per run", () => {
    const base = { cwd: tmpdir(), context: "supervisor-design" };
    const { output, root } = runCli([
      { ...base, prompt: "Reply with exactly the word PONG and nothing else.", timeoutSec: 120 },
      { ...base, prompt: "Reply PONG.", model: "google/no-such-model", timeoutSec: 120 },
    ]);
    const [ok, bad] = output.runs;
    expect(ok.result.outcome).toBe("succeeded");
    expect(ok.result.text).toContain("PONG");
    expect(bad.result.outcome).not.toBe("succeeded");
    const sessionFiles = new Bun.Glob("**/*.jsonl").scanSync(join(root, "runs", ok.runId, "session"));
    expect(Array.from(sessionFiles).length).toBe(1);
  }, 180_000);
});

const FAKE_PI_CANCEL = `#!/bin/sh
for last; do :; done
case "$last" in
  ok) echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"PONG"}]}}' ;;
  hang) sleep 300 ;;
  stubborn) trap '' TERM; while :; do sleep 1; done ;;
  spawn)
    sleep 300 & echo $! >> "pids"
    nohup sleep 300 >/dev/null 2>&1 & echo $! >> "pids"
    setsid sleep 300 & echo $! >> "pids"
    sh -c 'sleep 300 & echo $! >> pids' &
    sleep 1; echo ready > spawned; sleep 300 ;;
esac
`;

function cli(root: string, args: string[], extraEnv: Record<string, string> = {}): any {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, CUE_SUPERVISOR_STATE: root, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

async function waitFor(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(200);
  }
}

function alive(pid: number): boolean {
  return existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
}

function unitActive(unit: string): boolean {
  return Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", unit]).exitCode === 0;
}

describe.skipIf(!process.env.SUP_SYSTEMD)("systemd cancellation", () => {
  function setup(prompts: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "sup-cancel-"));
    const root = join(dir, "state");
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, FAKE_PI_CANCEL);
    chmodSync(fakePi, 0o755);
    const runs = prompts.map((prompt) => ({ cwd: dir, context: "test-ctx", prompt }));
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify({ runs }));
    const launched = cli(root, ["run", "--detach", specPath], { CUE_SUPERVISOR_PI: fakePi });
    const runDir = (i: number) => join(root, "runs", launched.runIds[i]);
    const result = (i: number) => JSON.parse(readFileSync(join(runDir(i), "result.json"), "utf8"));
    return { dir, root, launched, runDir, result };
  }

  test("cancelling one run kills its whole process tree and spares siblings", async () => {
    const { dir, root, launched, runDir, result } = setup(["spawn", "hang"]);
    await waitFor(join(dir, "spawned"));
    const pids = readFileSync(join(dir, "pids"), "utf8").trim().split("\n").map(Number);
    expect(pids.length).toBe(4);
    expect(pids.every(alive)).toBe(true);

    const report = cli(root, ["cancel", "run", launched.runIds[0]]);
    expect(report.stopped).toEqual([`cue-run-${launched.runIds[0]}.service`]);
    await waitFor(join(runDir(0), "result.json"));
    expect(result(0).outcome).toBe("cancelled");
    expect(pids.filter(alive)).toEqual([]);
    expect(unitActive(`cue-run-${launched.runIds[1]}.service`)).toBe(true);

    cli(root, ["cancel", "batch", launched.batchId]);
    await waitFor(join(runDir(1), "result.json"));
    expect(result(1).outcome).toBe("cancelled");
  }, 60_000);

  test("a slice stop finalizes every unit, escalates stubborn ones, keeps finished results", async () => {
    const { root, launched, runDir, result } = setup(["ok", "hang", "stubborn", "hang"]);
    await waitFor(join(runDir(0), "result.json"));
    for (const i of [1, 2, 3]) await waitFor(join(runDir(i), "started.json"));

    const report = cli(root, ["cancel", "batch", launched.batchId]);
    expect(report.alreadyFinished).toEqual([launched.runIds[0]]);
    expect(report.stopped).toEqual([`cue-runs-${launched.batchId}.slice`]);
    for (const i of [1, 2, 3]) await waitFor(join(runDir(i), "result.json"));

    expect(result(0).outcome).toBe("succeeded");
    expect(existsSync(join(runDir(0), "cancel"))).toBe(false);
    for (const i of [1, 2, 3]) {
      expect(existsSync(join(runDir(i), "outcome.json"))).toBe(true);
      expect(result(i).outcome).toBe("cancelled");
    }
    expect(result(2).termination.exitStatus).toBe("KILL");
  }, 60_000);
});

describe.skipIf(!process.env.SUP_PI)("cancelling a real pi run", () => {
  test("cancel mid-tool ends cancelled with the session kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-picancel-"));
    const root = join(dir, "state");
    const specPath = join(dir, "spec.json");
    const prompt = "Use the bash tool to run: sleep 120. Then reply DONE.";
    writeFileSync(specPath, JSON.stringify({ runs: [{ cwd: dir, context: "supervisor-design", prompt }] }));
    const launched = cli(root, ["run", "--detach", specPath]);
    const runDir = join(root, "runs", launched.runIds[0]);
    const deadline = Date.now() + 60_000;
    const events = join(runDir, "events.jsonl");
    while (!existsSync(events) || !readFileSync(events, "utf8").includes("tool_execution_start")) {
      if (Date.now() > deadline) throw new Error("tool never started");
      await Bun.sleep(500);
    }
    cli(root, ["cancel", "run", launched.runIds[0]]);
    await waitFor(join(runDir, "result.json"));
    const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    expect(result.outcome).toBe("cancelled");
    expect(result.partial).toBe(true);
    const sessions = Array.from(new Bun.Glob("**/*.jsonl").scanSync(join(runDir, "session")));
    expect(sessions.length).toBe(1);
  }, 120_000);
});
