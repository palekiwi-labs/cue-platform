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
