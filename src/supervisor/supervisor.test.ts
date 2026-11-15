import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cancel } from "./cancel";
import { reconcile } from "./reconcile";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRunDir, finalize, terminationFromEnv } from "./finalize";
import { ENV_ALLOWLIST, systemdRunArgv } from "./launch";
import { parseBatchSpec, SpecError } from "./spec";

const run = { cwd: "/tmp", context: "ctx", prompt: "hi" };

describe("parseBatchSpec", () => {
  test("accepts a minimal run and keeps optional fields", () => {
    const spec = parseBatchSpec({ runs: [run, { ...run, model: "m", timeoutSec: 5 }] });
    expect(spec.runs).toEqual([run, { ...run, model: "m", timeoutSec: 5 }]);
  });

  test("rejects the whole batch when any run is invalid", () => {
    expect(() => parseBatchSpec({ runs: [run, { ...run, cwd: "rel" }] })).toThrow(SpecError);
    expect(() => parseBatchSpec({ runs: [{ ...run, context: "" }] })).toThrow("context");
    expect(() => parseBatchSpec({ runs: [{ ...run, timeoutSec: 0 }] })).toThrow("timeoutSec");
    expect(() => parseBatchSpec({ runs: [{ ...run, extra: 1 }] })).toThrow("unknown field extra");
    expect(() => parseBatchSpec({ runs: [] })).toThrow(SpecError);
  });
});

describe("systemdRunArgv", () => {
  const argv = systemdRunArgv({
    runId: "r1",
    batchId: "b1",
    runDir: "/state/runs/r1",
    spec: { ...run, timeoutSec: 30 },
    sessionId: "sid",
    piPath: "/bin/pi",
    shPath: "/bin/sh",
    finalizeCommand: ["/bin/bun", "/src/cli.ts", "finalize", "/state/runs/r1"],
    env: { PATH: "/bin", GEMINI_API_KEY: "k", PI_SESSION_ID: "parent", SECRET: "x" },
  });

  test("names the unit and batch slice and runs in the run dir", () => {
    expect(argv).toContain("--unit=cue-run-r1.service");
    expect(argv).toContain("--slice=cue-runs-b1.slice");
    expect(argv).toContain("--working-directory=/state/runs/r1");
    expect(argv).toContain("--property=RuntimeMaxSec=30");
    expect(argv).toContain("--property=ExecStopPost=/bin/bun /src/cli.ts finalize /state/runs/r1");
  });

  test("forwards only allowlisted variables plus the run context", () => {
    const setenv = argv.filter((arg) => arg.startsWith("--setenv="));
    expect(setenv).toEqual(["--setenv=PATH", "--setenv=GEMINI_API_KEY", "--setenv=CUE_CONTEXT=ctx"]);
    expect(ENV_ALLOWLIST).not.toContain("PI_SESSION_ID");
  });

  test("execs pi in json mode with a per-run session after the caller cwd", () => {
    const tail = argv.slice(argv.indexOf("/bin/sh"));
    expect(tail[3]).toBe("/tmp");
    expect(tail.slice(4)).toEqual([
      "/bin/pi", "-p", "--mode", "json", "--model", "google/gemini-3.8-flash",
      "--session-dir", "/state/runs/r1/session", "--session-id", "sid", "hi",
    ]);
    expect(tail).not.toContain("-ne");
  });
});

describe("finalize", () => {
  const stop = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PONG" }] },
  });

  test("records termination evidence and derives the result", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    writeFileSync(join(dir, "events.jsonl"), stop + "\n");
    finalize(dir, { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 42);
    expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8"))).toEqual(
      terminationFromEnv({ SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 42),
    );
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("PONG");
  });

  test("never overwrites a recorded outcome and reads the cancel intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    finalize(dir, { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "TERM" }, 100);
    finalize(dir, { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 200);
    writeFileSync(join(dir, "cancel"), JSON.stringify({ requestedAt: 50 }));
    expect(deriveRunDir(dir).outcome).toBe("cancelled");
    expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")).finalizedAt).toBe(100);
  });
});

describe("cancel", () => {
  function seed(runs: { runId: string; finished?: boolean; cancelledAt?: number }[]): string {
    const root = mkdtempSync(join(tmpdir(), "sup-root-"));
    mkdirSync(join(root, "batches"));
    writeFileSync(join(root, "batches", "b1.json"), JSON.stringify({ runIds: runs.map((r) => r.runId) }));
    for (const run of runs) {
      const dir = join(root, "runs", run.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.json"), JSON.stringify({ unit: `cue-run-${run.runId}.service`, slice: "cue-runs-b1.slice" }));
      if (run.finished) writeFileSync(join(dir, "outcome.json"), "{}");
      if (run.cancelledAt) writeFileSync(join(dir, "cancel"), JSON.stringify({ requestedAt: run.cancelledAt }));
    }
    return root;
  }

  test("a run cancel persists intent before stopping only that unit", () => {
    const root = seed([{ runId: "r1" }, { runId: "r2" }]);
    const stops: string[][] = [];
    const report = cancel(root, { kind: "run", runId: "r1" }, (units) => {
      expect(existsSync(join(root, "runs", "r1", "cancel"))).toBe(true);
      stops.push(units);
    }, 7);
    expect(stops).toEqual([["cue-run-r1.service"]]);
    expect(report.requested).toEqual(["r1"]);
    expect(JSON.parse(readFileSync(join(root, "runs", "r1", "cancel"), "utf8"))).toEqual({ requestedAt: 7 });
    expect(existsSync(join(root, "runs", "r2", "cancel"))).toBe(false);
  });

  test("a batch cancel stops the slice and skips finished runs", () => {
    const root = seed([{ runId: "r1", finished: true }, { runId: "r2" }]);
    const stops: string[][] = [];
    const report = cancel(root, { kind: "batch", batchId: "b1" }, (units) => stops.push(units), 7);
    expect(stops).toEqual([["cue-runs-b1.slice"]]);
    expect(report.alreadyFinished).toEqual(["r1"]);
    expect(existsSync(join(root, "runs", "r1", "cancel"))).toBe(false);
  });

  test("a repeated cancel keeps the first intent", () => {
    const root = seed([{ runId: "r1", cancelledAt: 3 }]);
    cancel(root, { kind: "run", runId: "r1" }, () => {}, 9);
    expect(JSON.parse(readFileSync(join(root, "runs", "r1", "cancel"), "utf8"))).toEqual({ requestedAt: 3 });
  });

  test("a batch with every run finished stops nothing", () => {
    const root = seed([{ runId: "r1", finished: true }]);
    const stops: string[][] = [];
    cancel(root, { kind: "batch", batchId: "b1" }, (units) => stops.push(units));
    expect(stops).toEqual([[]]);
  });
});

describe("reconcile", () => {
  function runDir(root: string, runId: string, files: Record<string, unknown>, acceptedAt = 0): string {
    const dir = join(root, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ unit: `u-${runId}`, acceptedAt }));
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
    }
    return dir;
  }

  test("settles each run by its evidence and never relaunches", () => {
    const root = mkdtempSync(join(tmpdir(), "sup-rec-"));
    runDir(root, "done", { "result.json": { outcome: "succeeded" } });
    const derived = runDir(root, "derived", {
      "outcome.json": { serviceResult: "success", exitCode: "exited", exitStatus: "0", finalizedAt: 5 },
    });
    runDir(root, "live", { "started.json": {} });
    runDir(root, "fresh", {}, 1_000);
    const lost = runDir(root, "lost", { "started.json": {}, "events.jsonl": "{\"type\":\"agent_start\"}\n" });
    const unlaunched = runDir(root, "unlaunched", {});

    const states = reconcile(root, (unit) => unit === "u-live", 1_500, 1_000);
    expect(states).toEqual({
      done: "finished",
      derived: "derived",
      live: "running",
      fresh: "pending",
      lost: "unknown",
      unlaunched: "unknown",
    });
    expect(JSON.parse(readFileSync(join(derived, "result.json"), "utf8")).outcome).toBe("failed");
    expect(JSON.parse(readFileSync(join(lost, "result.json"), "utf8")).outcome).toBe("unknown");
    expect(JSON.parse(readFileSync(join(unlaunched, "result.json"), "utf8")).partial).toBe(true);
    expect(existsSync(join(root, "runs", "live", "result.json"))).toBe(false);
    const before = readFileSync(join(lost, "result.json"), "utf8");
    expect(reconcile(root, () => false, 3_000, 1_000).fresh).toBe("unknown");
    expect(readFileSync(join(lost, "result.json"), "utf8")).toBe(before);
    expect(existsSync(join(unlaunched, "started.json"))).toBe(false);
  });

  test("recovers an outcome without a result and keeps partial text", () => {
    const root = mkdtempSync(join(tmpdir(), "sup-rec-"));
    const dir = runDir(root, "recovered", {
      "outcome.json": { serviceResult: "success", exitCode: "exited", exitStatus: "0", finalizedAt: 5 },
      "events.jsonl": JSON.stringify({ type: "message_end", message: {
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }],
      } }) + '\n{"type":',
    });
    expect(reconcile(root, () => false).recovered).toBe("derived");
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("recovered");
    expect(reconcile(root, () => false).recovered).toBe("finished");
  });
});
